import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { executeDelivery, prepareDelivery, type PreparedDelivery } from "../src/core/workflows/delivery.js";
import { classifyRemoteFailure, internalPath, looksSecret } from "../src/core/workflows/delivery-git.js";
import {
  githubPullRequests,
  type PullRequest,
  PullRequestError,
  type PullRequestDraft,
  type PullRequestProvider,
  repositoryOnHost,
} from "../src/core/workflows/delivery-provider.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { migration001 } from "../src/core/workflows/migrations/001.js";
import { migration002 } from "../src/core/workflows/migrations/002.js";
import { newId, WorkflowStore } from "../src/core/workflows/store.js";
import { parseWorkflowArgs, workflowHelp } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

type Fixture = ReturnType<typeof workflowFixture>;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

class FakePullRequests implements PullRequestProvider {
  readonly name = "fake";
  pulls: (PullRequest & PullRequestDraft)[] = [];
  creates = 0;
  token = true;
  loseNextResponse = false;
  failLookups = false;
  repository(): string {
    return "acme/widget";
  }
  unavailable(): string | null {
    return this.token ? null : "Missing auth: set GITHUB_TOKEN to a GitHub token";
  }
  async findByHead(_repository: string, branch: string): Promise<PullRequest | null> {
    if (this.failLookups) throw new PullRequestError("unknown", "network down");
    const found = this.pulls.find((p) => p.head === branch);
    return found ? { number: found.number, url: found.url } : null;
  }
  async create(_repository: string, draft: PullRequestDraft): Promise<PullRequest> {
    this.creates++;
    if (this.pulls.some((p) => p.head === draft.head))
      throw new PullRequestError("rejected", "GitHub answered 422: A pull request already exists");
    const number = this.pulls.length + 1;
    const pull = { ...draft, number, url: `https://example.test/acme/widget/pull/${number}` };
    this.pulls.push(pull);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new PullRequestError("unknown", "socket hang up");
    }
    return { number, url: pull.url };
  }
}

interface Scenario {
  fx: Fixture;
  root: string;
  remote: string;
  runId: string;
  provider: FakePullRequests;
}

/** A completed run in a Git repository with a bare remote; optional user changes before the run. */
async function completedRun(
  options: { repository?: boolean; userChanges?: boolean } = {},
): Promise<Scenario> {
  const fx = workflowFixture();
  const remote = mkdtempSync(join(tmpdir(), "baked-delivery-remote-"));
  cleanups.push(() => {
    fx.dispose();
    rmSync(remote, { recursive: true, force: true });
  });
  const root = fx.root;
  if (options.repository !== false) {
    git(remote, "init", "--bare", "-q", "-b", "main");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    writeFileSync(join(root, "README.md"), "# Project\n");
    writeFileSync(join(root, "user.txt"), "original\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "origin", "main");
  }
  if (options.userChanges) {
    writeFileSync(join(root, "user.txt"), "user edit\n");
    writeFileSync(join(root, "notes.txt"), "user notes\n");
  }
  const run = await fx.start();
  await fx.service.drive(run.runId, new AbortController().signal);
  await fx.approve(run.runId);
  const done = await fx.service.drive(run.runId, new AbortController().signal);
  if (done.status !== "completed") throw new Error(`Fixture run ended ${done.status}`);
  return { fx, root, remote, runId: run.runId, provider: new FakePullRequests() };
}

const prepare = (s: Scenario, options: Parameters<typeof prepareDelivery>[3] = {}) =>
  prepareDelivery(s.fx.service.store, s.fx.config, s.runId, {
    provider: s.provider,
    now: 1700000000,
    ...options,
  });
async function approve(s: Scenario, prepared: PreparedDelivery) {
  return s.fx.service.decide(
    s.runId,
    { commandId: newId(), expectedRevision: s.fx.service.store.run(s.runId).revision },
    { kind: "approve", requestId: prepared.requestId, digest: prepared.digest },
  );
}
const execute = (s: Scenario, provider: PullRequestProvider | null = s.provider) =>
  executeDelivery(s.fx.service.store, s.fx.config, s.runId, {
    expectedRevision: s.fx.service.store.run(s.runId).revision,
    provider,
  });
async function refusal(action: Promise<unknown>): Promise<WorkflowFault> {
  try {
    await action;
  } catch (error) {
    if (error instanceof WorkflowFault) return error;
    throw error;
  }
  throw new Error("Expected the delivery to be refused");
}
const deliveryEffects = (s: Scenario) =>
  s.fx.service.store
    .effects(s.runId)
    .filter((e) => e.kind === "delivery")
    .map((e) => ({ status: e.status, operation: (JSON.parse(e.intent_json) as { operation: string }).operation, id: e.id }));
const remoteHead = (s: Scenario, branch: string) => {
  const result = Bun.spawnSync(["git", "--git-dir", s.remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { stdout: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
};

describe("Git delivery", () => {
  test("delivers only the run's files to a branch, a push and a pull request with evidence", async () => {
    const s = await completedRun({ userChanges: true });
    const headBefore = git(s.root, "rev-parse", "HEAD");
    const prepared = await prepare(s, { draft: true });
    const plan = prepared.plan;
    expect(plan.operations).toEqual(["commit", "push", "pull_request"]);
    expect(plan.branch).toBe(`baked/fixture-${s.runId.slice(0, 8)}`);
    expect(plan.base).toEqual({ commit: headBefore, branch: "main" });
    expect(plan.files.map((f) => f.path)).toContain("value.txt");
    expect(plan.files.find((f) => f.path === "value.txt")).toMatchObject({ action: "add", hash: hashBytes("ready") });
    expect(plan.files.every((f) => f.path === "value.txt" || f.path.startsWith("specs/fixture/"))).toBe(true);
    expect(plan.userChanges.sort()).toEqual(["notes.txt", "user.txt"]);
    expect(prepared.diff).toContain("+ready");
    expect(prepared.diff).not.toContain("user edit");
    expect(plan.commitMessage).toContain(`Baked-Run: ${s.runId}`);
    expect(plan.pullRequest).toMatchObject({ repository: "acme/widget", base: "main", draft: true });
    expect(plan.pullRequest?.body).toContain("`check`: passed");
    expect(plan.pullRequest?.body).toContain("AC-001: pass");
    const request = s.fx.service.store.requests(s.runId).find((r) => r.id === prepared.requestId);
    expect(request).toMatchObject({ kind: "delivery", status: "pending", digest: prepared.digest });

    await approve(s, prepared);
    expect(s.fx.service.store.requests(s.runId).find((r) => r.id === prepared.requestId)).toMatchObject({ status: "accepted", actor: "user" });
    const result = await execute(s);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(remoteHead(s, plan.branch)).toBe(result.commit);
    expect(git(s.root, "rev-parse", `refs/heads/${plan.branch}`)).toBe(result.commit as string);
    expect(result.pullRequest).toMatchObject({ number: 1, recordedBy: "provider" });
    expect(s.provider.pulls[0]).toMatchObject({ head: plan.branch, base: "main", draft: true });
    expect(result).toMatchObject({ runId: s.runId, snapshotId: plan.snapshotId, digest: prepared.digest });

    const tree = git(s.root, "ls-tree", "-r", "--name-only", result.commit as string).split("\n");
    expect(tree).toContain("value.txt");
    expect(tree).not.toContain("notes.txt");
    expect(git(s.root, "show", `${result.commit}:user.txt`)).toBe("original");
    expect(git(s.root, "show", `${result.commit}:value.txt`)).toBe("ready");
    expect(git(s.root, "log", "-1", "--format=%B", result.commit as string)).toContain(`Baked-Delivery: ${plan.planId}`);
    expect(git(s.root, "log", "-1", "--format=%P", result.commit as string)).toBe(headBefore);

    // The user's checkout is untouched: same HEAD and branch, nothing staged, their edits kept.
    expect(git(s.root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(s.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(s.root, "diff", "--cached", "--name-only")).toBe("");
    expect(readFileSync(join(s.root, "user.txt"), "utf8")).toBe("user edit\n");
    expect(readFileSync(join(s.root, "notes.txt"), "utf8")).toBe("user notes\n");
    expect(s.fx.service.store.run(s.runId).status).toBe("completed");
    expect(deliveryEffects(s).map((e) => [e.operation, e.status])).toEqual([
      ["commit", "applied"],
      ["push", "applied"],
      ["pull_request", "applied"],
    ]);
    expect(s.fx.service.store.latestArtifact(s.runId, `delivery/${plan.planId}/result.json`)).not.toBeNull();
  });

  test("a repeated execute creates no duplicate commit, push or pull request", async () => {
    const s = await completedRun();
    const prepared = await prepare(s);
    await approve(s, prepared);
    const first = await execute(s);
    const second = await execute(s);
    expect(second).toEqual(first);
    expect(s.provider.creates).toBe(1);
    expect(deliveryEffects(s)).toHaveLength(3);
    expect(remoteHead(s, prepared.plan.branch)).toBe(first.commit);
  });

  test("the CLI prepares, approves by digest and executes the plan", async () => {
    const s = await completedRun();
    const signal = new AbortController().signal;
    const cli = (argv: string[]) => executeWorkflowCommand(s.fx.service, parseWorkflowArgs(argv), signal, undefined, { pullRequests: s.provider });
    expect(workflowHelp).toContain("deliver RUN_ID --execute --expected-revision N");
    expect(() => parseWorkflowArgs(["deliver", s.runId, "--execute"])).toThrow("--expected-revision");
    expect(() => parseWorkflowArgs(["deliver", s.runId, "--execute", "--expected-revision", "1", "--branch", "x"])).toThrow("belongs to the plan");
    const prepared = (await cli(["deliver", s.runId, "--branch", "feature/value", "--no-pr"])) as PreparedDelivery & { next: string };
    expect(prepared.plan.operations).toEqual(["commit", "push"]);
    expect(prepared.next).toContain(`--digest ${prepared.digest}`);
    await expect(cli(["deliver", s.runId, "--execute", "--expected-revision", String(prepared.revision)])).rejects.toThrow("No approved delivery plan");
    await cli(["approve", s.runId, "--request", prepared.requestId, "--digest", prepared.digest, "--expected-revision", String(s.fx.service.store.run(s.runId).revision)]);
    const result = (await cli(["deliver", s.runId, "--execute", "--expected-revision", String(s.fx.service.store.run(s.runId).revision)])) as { commit: string; pullRequest: unknown };
    expect(remoteHead(s, "feature/value")).toBe(result.commit);
    expect(result.pullRequest).toBeNull();
    expect(s.provider.creates).toBe(0);
  });

  test("only the exact approved plan runs; a new plan supersedes the old request", async () => {
    const s = await completedRun();
    const first = await prepare(s);
    const wrong = await refusal(
      s.fx.service.decide(s.runId, { commandId: newId(), expectedRevision: s.fx.service.store.run(s.runId).revision }, { kind: "approve", requestId: first.requestId, digest: "0".repeat(64) }),
    );
    expect(wrong.code).toBe("STALE_DECISION");
    const second = await prepare(s, { branch: "other" });
    expect(s.fx.service.store.requests(s.runId).find((r) => r.id === first.requestId)?.status).toBe("superseded");
    expect((await refusal(approve(s, first))).code).toBe("STALE_DECISION");
    expect((await refusal(execute(s))).details.reason).toBe("not_approved");
    await s.fx.service.decide(s.runId, { commandId: newId(), expectedRevision: s.fx.service.store.run(s.runId).revision }, { kind: "reject", requestId: second.requestId, explanation: "Not now" });
    expect((await refusal(execute(s))).details.reason).toBe("not_approved");
    expect(deliveryEffects(s)).toHaveLength(0);
  });

  test("a workspace without Git gets an explicit message", async () => {
    const s = await completedRun({ repository: false });
    const fault = await refusal(prepare(s));
    expect(fault.code).toBe("CAPABILITY_DENIED");
    expect(fault.details.reason).toBe("git_required");
    expect(fault.message).toContain("requires a Git repository");
  });

  test("files changed since the verified snapshot are refused, before and after approval", async () => {
    const s = await completedRun();
    writeFileSync(join(s.root, "value.txt"), "edited");
    const before = await refusal(prepare(s));
    expect(before.details).toMatchObject({ reason: "dirty_files", files: ["value.txt"] });
    writeFileSync(join(s.root, "value.txt"), "ready");
    const prepared = await prepare(s);
    await approve(s, prepared);
    writeFileSync(join(s.root, "value.txt"), "edited again");
    const after = await refusal(execute(s));
    expect(after.details).toMatchObject({ reason: "dirty_files" });
    expect(deliveryEffects(s)).toHaveLength(0);
    expect(remoteHead(s, prepared.plan.branch)).toBeNull();
  });

  test("a moved HEAD is allowed when unrelated, refused when it touches the run's files or after approval", async () => {
    const s = await completedRun();
    writeFileSync(join(s.root, "other.txt"), "other\n");
    git(s.root, "add", "other.txt");
    git(s.root, "commit", "-q", "-m", "Unrelated");
    const prepared = await prepare(s);
    expect(prepared.plan.headMoved).toBe(true);
    await approve(s, prepared);
    writeFileSync(join(s.root, "another.txt"), "x\n");
    git(s.root, "add", "another.txt");
    git(s.root, "commit", "-q", "-m", "Moved after approval");
    expect((await refusal(execute(s))).details.reason).toBe("head_moved");
    expect(deliveryEffects(s)).toHaveLength(0);

    writeFileSync(join(s.root, "value.txt"), "theirs");
    git(s.root, "add", "value.txt");
    git(s.root, "commit", "-q", "-m", "Conflicting value");
    writeFileSync(join(s.root, "value.txt"), "ready");
    const conflict = await refusal(prepare(s));
    expect(conflict.details.reason).toBe("base_mismatch");
    expect(conflict.message).toContain("changed at HEAD after the run started");
  });

  test("a file with the user's uncommitted changes from before the run is not mixed into the commit", async () => {
    const s = await completedRun({ userChanges: true });
    const store = s.fx.service.store;
    // The run's journal records a write to user.txt, which the user had edited before it started.
    const { attemptId } = store.transaction(() => store.beginExternalAttempt(s.runId, "fixture"));
    store.transaction(() => {
      const edited = hashBytes("user edit\n");
      const id = store.prepareEffect(s.runId, attemptId, "file_patch", { path: "user.txt" }, edited, edited);
      store.effectStatus(s.runId, id, "applied");
    });
    const fault = await refusal(prepare(s));
    expect(fault.details.reason).toBe("base_mismatch");
    expect(fault.message).toContain("user.txt had uncommitted changes before the run started");
    expect(readFileSync(join(s.root, "user.txt"), "utf8")).toBe("user edit\n");
  });

  test("secrets and internal files the run wrote are reported and never committed", async () => {
    const s = await completedRun();
    const store = s.fx.service.store;
    const { attemptId } = store.transaction(() => store.beginExternalAttempt(s.runId, "fixture"));
    for (const [path, content] of [
      [".env", "TOKEN=secret\n"],
      ["deploy.txt", "-----BEGIN RSA PRIVATE KEY-----\nabc\n"],
      ["certs/server.pem", "certificate\n"],
    ] as const) {
      Bun.spawnSync(["mkdir", "-p", join(s.root, "certs")]);
      writeFileSync(join(s.root, path), content);
      store.transaction(() => {
        const id = store.prepareEffect(s.runId, attemptId, "file_patch", { path }, null, hashBytes(content));
        store.effectStatus(s.runId, id, "applied");
      });
    }
    const prepared = await prepare(s);
    expect(prepared.plan.files.map((f) => f.path)).not.toContain(".env");
    expect(prepared.plan.excluded).toEqual(
      expect.arrayContaining([
        { path: ".env", reason: "secret" },
        { path: "certs/server.pem", reason: "secret" },
        { path: "deploy.txt", reason: "secret" },
      ]),
    );
    expect(prepared.diff).not.toContain("TOKEN=secret");
    expect(looksSecret("config/.env.production")).toBe(true);
    expect(looksSecret("keys/id_ed25519")).toBe(true);
    expect(looksSecret("src/index.ts", new TextEncoder().encode("export {}"))).toBe(false);
    expect(internalPath(".baked/workflows.sqlite")).toBe(true);
    expect(internalPath(".github/workflows/ci.yml")).toBe(false);
  });

  test("a missing remote, a missing token and an existing branch are refused before any effect", async () => {
    const s = await completedRun();
    expect((await refusal(prepare(s, { remote: "upstream" }))).details.reason).toBe("missing_remote");
    s.provider.token = false;
    const auth = await refusal(prepare(s));
    expect(auth.details.reason).toBe("missing_auth");
    expect(auth.message).toContain("GITHUB_TOKEN");
    expect((await prepare(s, { pullRequest: false })).plan.operations).toEqual(["commit", "push"]);
    s.provider.token = true;
    const prepared = await prepare(s);
    await approve(s, prepared);
    s.provider.token = false;
    expect((await refusal(execute(s))).details.reason).toBe("missing_auth");
    expect(deliveryEffects(s)).toHaveLength(0);
    s.provider.token = true;
    git(s.root, "branch", "taken");
    expect((await refusal(prepare(s, { branch: "taken" }))).details.reason).toBe("branch_exists");
  });

  test("a non-fast-forward push is rejected and never forced", async () => {
    const s = await completedRun();
    const prepared = await prepare(s);
    await approve(s, prepared);
    // Someone else creates the same branch on the remote after the plan was approved.
    const other = mkdtempSync(join(tmpdir(), "baked-delivery-other-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    git(other, "clone", "-q", s.remote, ".");
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.test");
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "Theirs");
    git(other, "push", "-q", "origin", `HEAD:refs/heads/${prepared.plan.branch}`);
    const theirs = remoteHead(s, prepared.plan.branch);
    const fault = await refusal(execute(s));
    expect(fault.details.reason).toBe("non_fast_forward");
    expect(fault.message).toContain("never force-pushes");
    expect(remoteHead(s, prepared.plan.branch)).toBe(theirs);
    expect(deliveryEffects(s).map((e) => [e.operation, e.status])).toEqual([["commit", "applied"], ["push", "failed"]]);
    expect(s.provider.creates).toBe(0);
  });

  test("a hook that rejects the push stops delivery with its reason", async () => {
    const s = await completedRun();
    const hook = join(s.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'policy: deliveries need review' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const prepared = await prepare(s);
    await approve(s, prepared);
    const fault = await refusal(execute(s));
    expect(fault.details.reason).toBe("hook_rejected");
    expect(fault.message).toContain("policy: deliveries need review");
    expect(remoteHead(s, prepared.plan.branch)).toBeNull();
    rmSync(hook);
    const result = await execute(s);
    expect(remoteHead(s, prepared.plan.branch)).toBe(result.commit);
    expect(deliveryEffects(s).filter((e) => e.operation === "commit")).toHaveLength(1);
  });

  test("a failed push to an unreachable remote is retried without a second commit", async () => {
    const s = await completedRun();
    const prepared = await prepare(s);
    await approve(s, prepared);
    const moved = `${s.remote}-away`;
    renameSync(s.remote, moved);
    const fault = await refusal(execute(s));
    expect(fault.details.reason).toBe("remote_unreachable");
    renameSync(moved, s.remote);
    const result = await execute(s);
    expect(remoteHead(s, prepared.plan.branch)).toBe(result.commit);
    expect(deliveryEffects(s).map((e) => [e.operation, e.status])).toEqual([
      ["commit", "applied"],
      ["push", "failed"],
      ["push", "applied"],
      ["pull_request", "applied"],
    ]);
  });

  test("a push whose outcome was lost is probed, and an unanswerable probe becomes a recovery request", async () => {
    const s = await completedRun();
    const store = s.fx.service.store;
    const prepared = await prepare(s);
    await approve(s, prepared);
    // First execute stops after the commit: a hook rejects the push.
    const hook = join(s.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    await refusal(execute(s));
    rmSync(hook);
    const commit = git(s.root, "rev-parse", `refs/heads/${prepared.plan.branch}`);
    // A crash after the push reached the remote but before the journal recorded it.
    const { attemptId } = store.transaction(() => store.beginExternalAttempt(s.runId, "delivery"));
    const lost = store.transaction(() =>
      store.prepareEffect(s.runId, attemptId, "delivery", { planId: prepared.planId, operation: "push", branch: prepared.plan.branch, commit, remote: "origin", url: s.remote }, null, null),
    );
    git(s.root, "push", "-q", "origin", `${commit}:refs/heads/${prepared.plan.branch}`);
    const moved = `${s.remote}-away`;
    renameSync(s.remote, moved);
    const fault = await refusal(execute(s));
    expect(fault.code).toBe("RECOVERY_REQUIRED");
    const recovery = store.requests(s.runId).find((r) => r.kind === "recovery");
    expect(recovery?.status).toBe("pending");
    expect(JSON.parse(recovery?.body_json ?? "{}")).toMatchObject({ effectId: lost, delivery: true });
    expect(store.run(s.runId).status).toBe("completed");
    renameSync(moved, s.remote);
    const result = await execute(s);
    expect(store.effects(s.runId).find((e) => e.id === lost)?.status).toBe("reconciled");
    expect(store.requests(s.runId).find((r) => r.id === recovery?.id)?.status).toBe("superseded");
    expect(deliveryEffects(s).filter((e) => e.operation === "push" && e.status === "applied")).toHaveLength(0);
    expect(result.pullRequest?.number).toBe(1);
  });

  test("a lost pull request response is found by its head branch instead of creating a duplicate", async () => {
    const s = await completedRun();
    const prepared = await prepare(s);
    await approve(s, prepared);
    s.provider.loseNextResponse = true;
    const result = await execute(s);
    expect(result.pullRequest).toMatchObject({ number: 1, recordedBy: "provider" });
    expect(s.provider.creates).toBe(1);
    expect(deliveryEffects(s).find((e) => e.operation === "pull_request")?.status).toBe("reconciled");
  });

  test("an unknown pull request outcome waits for a person when the host cannot be asked", async () => {
    const s = await completedRun();
    const store = s.fx.service.store;
    const prepared = await prepare(s);
    await approve(s, prepared);
    s.provider.loseNextResponse = true;
    s.provider.failLookups = true;
    const fault = await refusal(execute(s));
    expect(fault.code).toBe("RECOVERY_REQUIRED");
    expect((await refusal(execute(s))).code).toBe("RECOVERY_REQUIRED");
    expect(s.provider.creates).toBe(1);
    const recovery = store.requests(s.runId).filter((r) => r.kind === "recovery" && r.status === "pending");
    expect(recovery).toHaveLength(1);
    const effectId = (JSON.parse(recovery[0]?.body_json ?? "{}") as { effectId: string }).effectId;
    await s.fx.service.decide(
      s.runId,
      { commandId: newId(), expectedRevision: store.run(s.runId).revision },
      { kind: "recovery", requestId: recovery[0]?.id ?? "", effectId, resolution: "record-applied", evidence: "Pull request 1 exists in the web UI" },
    );
    const result = await execute(s);
    expect(result.pullRequest).toMatchObject({ recordedBy: "user" });
    expect(s.provider.creates).toBe(1);
    expect(store.run(s.runId).status).toBe("completed");
  });
});

describe("delivery building blocks", () => {
  test("GitHub provider calls the REST API with the token and classifies failures", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let answer: Response = new Response(JSON.stringify([]), { status: 200 });
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return answer;
    }) as typeof fetch;
    const provider = githubPullRequests({ token: "t0k", tokenEnv: "GITHUB_TOKEN", apiUrl: "https://api.github.com", fetch: fetcher });
    expect(provider.repository("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(provider.repository("https://github.com/acme/widget")).toBe("acme/widget");
    expect(provider.repository("https://gitlab.com/acme/widget.git")).toBeNull();
    expect(await provider.findByHead("acme/widget", "baked/x")).toBeNull();
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/widget/pulls?state=all&per_page=1&head=acme%3Abaked%2Fx");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer t0k");
    answer = new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme/widget/pull/7" }), { status: 201 });
    expect(await provider.create("acme/widget", { base: "main", head: "baked/x", title: "T", body: "B", draft: false })).toEqual({ number: 7, url: "https://github.com/acme/widget/pull/7" });
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ head: "baked/x", base: "main", draft: false });
    answer = new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    await expect(provider.findByHead("acme/widget", "b")).rejects.toMatchObject({ failure: "auth" });
    answer = new Response("oops", { status: 502 });
    await expect(provider.findByHead("acme/widget", "b")).rejects.toMatchObject({ failure: "unknown" });
    const missing = githubPullRequests({ token: undefined, tokenEnv: "MY_TOKEN", apiUrl: "https://api.github.com", fetch: fetcher });
    expect(missing.unavailable()).toContain("MY_TOKEN");
    expect(repositoryOnHost("ssh://git@ghe.example.test:2222/team/app.git", "ghe.example.test")).toBe("team/app");
  });

  test("remote failures are classified from Git's messages", () => {
    expect(classifyRemoteFailure(" ! [rejected] x -> x (fetch first)")).toBe("non_fast_forward");
    expect(classifyRemoteFailure("remote: nope\n ! [remote rejected] x -> x (pre-receive hook declined)")).toBe("hook_rejected");
    expect(classifyRemoteFailure("fatal: Authentication failed for 'https://example.test/'")).toBe("auth");
    expect(classifyRemoteFailure("fatal: '/tmp/x' does not appear to be a git repository")).toBe("remote_unreachable");
  });

  test("migration 003 upgrades a version 2 database and keeps its rows", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-delivery-migration-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    Bun.spawnSync(["mkdir", "-p", join(root, ".baked")]);
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    db.exec(migration001);
    db.exec(migration002);
    db.run("INSERT INTO schema_migrations VALUES (1,?,1),(2,?,1)", [hashBytes(migration001), hashBytes(migration002)]);
    db.run("INSERT INTO features VALUES ('f','specs/f',1)");
    db.run("INSERT INTO runs (id,feature_id,status,definition_json,profiles_json,policy_json,input_manifest_json,input_hash,created_at,updated_at) VALUES ('r','f','completed','{}','[]','{}','{}',?,1,1)", ["a".repeat(64)]);
    db.run("INSERT INTO requests (run_id,id,kind,status,digest,body_json) VALUES ('r','q','checkpoint','pending',?,'{}')", ["b".repeat(64)]);
    db.close();
    const reader = new WorkflowStore(root, true);
    expect(reader.requests("r")).toHaveLength(1);
    reader.close();
    const store = new WorkflowStore(root);
    expect(store.requests("r")[0]?.kind).toBe("checkpoint");
    store.transaction(() => store.request("r", "delivery", "c".repeat(64), {}));
    expect(store.requests("r").map((r) => r.kind)).toEqual(["checkpoint", "delivery"]);
    store.close();
    expect(existsSync(join(root, ".baked", "workflows.sqlite"))).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { executeDelivery, prepareDelivery, type PreparedDelivery } from "../src/core/workflows/delivery.js";
import { classifyRemoteFailure, internalPath, looksSecret } from "../src/core/workflows/delivery-git.js";
import {
  type CommitCheck,
  githubPullRequests,
  type PullRequest,
  PullRequestError,
  type PullRequestDraft,
  type PullRequestProvider,
  type PullRequestReviews,
  repositoryOnHost,
} from "../src/core/workflows/delivery-provider.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import {
  fixChecksRequest,
  followPullRequest,
  pullRequestChecks,
  pullRequestReviews,
  repairReviewsRequest,
} from "../src/core/workflows/follow.js";
import { migration001 } from "../src/core/workflows/migrations/001.js";
import { migration002 } from "../src/core/workflows/migrations/002.js";
import { newId, WorkflowStore } from "../src/core/workflows/store.js";
import { parseWorkflowArgs, workflowHelp } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

type Fixture = ReturnType<typeof workflowFixture>;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

class FakePullRequests implements PullRequestProvider {
  readonly name = "fake";
  pulls: (PullRequest & PullRequestDraft)[] = [];
  /** What each read of the checks answers, in order; the last one repeats. */
  checkReads: CommitCheck[][] = [];
  checkedCommits: string[] = [];
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
  async checks(_repository: string, commit: string): Promise<CommitCheck[]> {
    this.checkedCommits.push(commit);
    return (this.checkReads.length > 1 ? this.checkReads.shift() : this.checkReads[0]) ?? [];
  }
  review: PullRequestReviews = { threads: [], reviews: [] };
  answers: { threadId: string; body: string | null; resolve: boolean }[] = [];
  /** Fails the next answer after it took effect, as a lost response would. */
  loseNextAnswer = false;
  async reviews(): Promise<PullRequestReviews> {
    return structuredClone(this.review);
  }
  async answerThread(threadId: string, body: string | null, resolve: boolean): Promise<void> {
    this.answers.push({ threadId, body, resolve });
    const thread = this.review.threads.find((t) => t.id === threadId);
    if (!thread) throw new PullRequestError("rejected", "GitHub answered: Could not resolve to a node");
    if (body !== null) thread.comments.push({ author: "baked", body, url: `${thread.comments[0]?.url}-reply` });
    if (resolve) thread.resolved = true;
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new PullRequestError("unknown", "socket hang up");
    }
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
  options: { repository?: boolean; userChanges?: boolean; specsTracked?: boolean } = {},
): Promise<Scenario> {
  const fx = workflowFixture();
  const remote = mkdtempSync(join(tmpdir(), "baked-delivery-remote-"));
  cleanups.push(async () => {
    await fx.dispose();
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
    if (options.specsTracked) {
      mkdirSync(join(root, "specs"));
      writeFileSync(join(root, "specs", "README.md"), "# Specs\n");
    }
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

// Tests that execute a delivery twice spawn dozens of git processes, which can pass
// the default 30s on Windows runners.
const TWO_EXECUTES_TIMEOUT = 90_000;

describe("Git delivery", () => {
  test("leaves the run's specs out when the repository keeps none, unless asked", async () => {
    const s = await completedRun();
    const plan = (await prepare(s)).plan;
    expect(plan.files.map((f) => f.path)).toEqual(["value.txt"]);
    const specs = plan.excluded.filter((e) => e.reason === "specs").map((e) => e.path);
    expect(specs.sort()).toEqual(
      ["plan.md", "spec.json", "spec.md", "tasks.json", "tasks.md"].map((f) => `specs/fixture/${f}`),
    );
    expect(plan.userChanges).toEqual([]);
    const forced = (await prepare(s, { specs: true })).plan;
    expect(forced.files.map((f) => f.path)).toContain("specs/fixture/spec.json");
  });

  test("delivers the run's specs when the base commit tracks specs/", async () => {
    const s = await completedRun({ specsTracked: true });
    const plan = (await prepare(s)).plan;
    expect(plan.files.map((f) => f.path)).toContain("specs/fixture/spec.json");
    expect(plan.excluded.some((e) => e.reason === "specs")).toBe(false);
    const without = (await prepare(s, { specs: false })).plan;
    expect(without.files.map((f) => f.path)).toEqual(["value.txt"]);
  });

  test("delivers only the run's files to a branch, a push and a pull request with evidence", async () => {
    const s = await completedRun({ userChanges: true });
    const headBefore = git(s.root, "rev-parse", "HEAD");
    const prepared = await prepare(s, { draft: true, specs: true });
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
    // The body is the run report with the delivery's files appended.
    expect(plan.pullRequest?.body).toContain("| `check` | passed | current |");
    expect(plan.pullRequest?.body).toContain("| AC-001 | pass |");
    expect(plan.pullRequest?.body).toContain("## Usage");
    expect(plan.pullRequest?.body).toContain("## Delivery\n\n- add `specs/fixture/plan.md`");
    expect(plan.pullRequest?.body).toContain("- add `value.txt`");
    expect(plan.pullRequest?.body.trimEnd().endsWith(`base \`${headBefore}\`.`)).toBe(true);
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
  }, TWO_EXECUTES_TIMEOUT);

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
  }, TWO_EXECUTES_TIMEOUT);

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
  }, TWO_EXECUTES_TIMEOUT);

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
  }, TWO_EXECUTES_TIMEOUT);

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

/** Writes `value` into value.txt instead of "ready", so a second run of the fixture changes it. */
class ValueExecutor extends FixtureExecutor {
  value = "ready";
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: Parameters<FixtureExecutor["execute"]>[0]) {
    const result = await super.execute(request);
    // The second run modifies the file the first one created.
    if (request.profile.output === "plan" && existsSync(join(this.dir, "value.txt")))
      for (const task of (result.output as { taskGraph: { tasks: { writes: { action: string }[] }[] } }).taskGraph.tasks)
        for (const write of task.writes) write.action = "modify";
    if (request.profile.output === "implementation") writeFileSync(join(this.dir, "value.txt"), this.value);
    return result;
  }
}

const followPolicy = {
  ...fixturePolicy,
  checks: fixturePolicy.checks.map((c) => ({ ...c, args: ["-e", "if (!(await Bun.file('value.txt').text()).startsWith('ready')) process.exit(1)"] })),
};
/** Run A delivered with a pull request, then run B, which changes value.txt again on top of it. */
async function followUpScenario() {
  const fx = workflowFixture({ policy: followPolicy, executor: (root) => new ValueExecutor(root) });
  const remote = mkdtempSync(join(tmpdir(), "baked-delivery-remote-"));
  cleanups.push(async () => {
    await fx.dispose();
    rmSync(remote, { recursive: true, force: true });
  });
  const root = fx.root;
  git(remote, "init", "--bare", "-q", "-b", "main");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Project\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");
  const complete = async () => {
    const run = await fx.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: followPolicy });
    const planned = await fx.service.drive(run.runId, new AbortController().signal);
    if (planned.status !== "waiting") throw new Error(`Fixture run stopped ${planned.status} ${JSON.stringify(planned)}`.slice(0, 600));
    await fx.approve(run.runId);
    const done = await fx.service.drive(run.runId, new AbortController().signal);
    if (done.status !== "completed") throw new Error(`Fixture run ended ${done.status}`);
    return run.runId;
  };
  const provider = new FakePullRequests();
  const first: Scenario = { fx, root, remote, runId: await complete(), provider };
  const prepared = await prepare(first);
  await approve(first, prepared);
  const delivered = await execute(first);
  fx.executor.value = "ready, fixed";
  const second: Scenario = { ...first, runId: await complete() };
  return { first, second, delivered, branch: prepared.plan.branch };
}


describe("Follow-up delivery", () => {
  test("commits a later run on top of the delivered branch and keeps its pull request", async () => {
    const { first, second, delivered, branch } = await followUpScenario();
    // Without --follow-up the second run's change cannot be separated from the first run's.
    expect((await refusal(prepare(second))).details.reason).toBe("base_mismatch");
    const prepared = await prepare(second, { followUp: first.runId });
    const plan = prepared.plan;
    expect(plan.operations).toEqual(["commit", "push"]);
    expect(plan.branch).toBe(branch);
    expect(plan.base).toEqual({ commit: delivered.commit as string, branch: "main" });
    expect(plan.pullRequest).toBeNull();
    expect(plan.followUp).toMatchObject({ runId: first.runId, pullRequest: { number: 1 } });
    expect(plan.files).toEqual([expect.objectContaining({ path: "value.txt", action: "modify", hash: hashBytes("ready, fixed") })]);
    expect(prepared.diff).toContain("-ready");
    expect(prepared.diff).toContain("+ready, fixed");
    const body = JSON.parse(second.fx.service.store.requests(second.runId).find((r) => r.id === prepared.requestId)?.body_json ?? "{}");
    expect(body.followUp).toEqual({ runId: first.runId, pullRequest: { number: 1, url: "https://example.test/acme/widget/pull/1" } });
    await approve(second, prepared);
    const result = await execute(second);
    expect(result.branch).toBe(branch);
    expect(result.pullRequest?.url).toBe("https://example.test/acme/widget/pull/1");
    expect(remoteHead(second, branch)).toBe(result.commit);
    expect(git(second.root, "rev-parse", `refs/heads/${branch}`)).toBe(result.commit as string);
    expect(git(second.root, "rev-parse", `${result.commit}^`)).toBe(delivered.commit as string);
    expect(git(second.root, "show", `${result.commit}:value.txt`)).toBe("ready, fixed");
    expect(git(second.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(first.provider.creates).toBe(1);
    // A repeated execute finds what it did and does nothing again.
    expect(await execute(second)).toEqual(result);
  }, TWO_EXECUTES_TIMEOUT);

  test("refuses an undelivered run, a moved or checked-out branch, and flags for a new branch", async () => {
    const { first, second, branch } = await followUpScenario();
    expect((await refusal(prepare(second, { followUp: second.runId }))).details.reason).toBe("invalid_follow_up");
    expect(() => parseWorkflowArgs(["deliver", second.runId, "--follow-up", first.runId, "--branch", "x"])).toThrow("--follow-up adds a commit");
    expect(() => parseWorkflowArgs(["deliver", second.runId, "--execute", "--expected-revision", "1", "--follow-up", first.runId])).toThrow("belongs to the plan");
    expect(workflowHelp).toContain("--follow-up DELIVERED_RUN_ID");
    const undelivered = await refusal(prepare(first, { followUp: second.runId }));
    expect(undelivered.details.reason).toBe("not_delivered");
    const checkout = mkdtempSync(join(tmpdir(), "baked-delivery-checkout-"));
    rmSync(checkout, { recursive: true, force: true });
    git(second.root, "worktree", "add", "-q", checkout, branch);
    expect((await refusal(prepare(second, { followUp: first.runId }))).details.reason).toBe("branch_checked_out");
    git(second.root, "worktree", "remove", "--force", checkout);
    const prepared = await prepare(second, { followUp: first.runId });
    await approve(second, prepared);
    // The branch moves on the remote after the plan was approved: the push is never forced.
    const other = mkdtempSync(join(tmpdir(), "baked-delivery-other-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    git(other, "clone", "-q", "-b", branch, second.remote, ".");
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.test");
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "Theirs");
    git(other, "push", "-q", "origin", branch);
    const theirs = remoteHead(second, branch);
    expect((await refusal(execute(second))).details.reason).toBe("non_fast_forward");
    expect(remoteHead(second, branch)).toBe(theirs);
    git(second.root, "fetch", "-q", "origin", branch);
    expect((await refusal(prepare(second, { followUp: first.runId }))).details.reason).toBe("branch_moved");
  }, TWO_EXECUTES_TIMEOUT);
});

describe("Following a delivered pull request", () => {
  const fail = { name: "test (windows)", state: "failed" as const, detail: "1 failed: EBUSY", url: "https://ci/9" };
  const pass = { name: "lint", state: "passed" as const, detail: "", url: null };
  const pending = { name: "test (windows)", state: "pending" as const, detail: "", url: null };

  test("waits without a model until a check fails, then proposes a fix-ci run delivered as a follow-up", async () => {
    const { first, delivered } = await followUpScenario();
    first.provider.checkReads = [[], [pass, pending], [pass, fail]];
    const slept: number[] = [];
    const calls = first.fx.executor.calls.length;
    const read = await followPullRequest(first.fx.service.store, first.fx.config, first.runId, {
      provider: first.provider,
      intervalSeconds: 5,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(read).toMatchObject({ outcome: "failed", state: "failed", commit: delivered.commit, pullRequest: { number: 1 } });
    expect(slept).toEqual([5000, 5000]);
    expect(first.provider.checkedCommits).toEqual([delivered.commit, delivered.commit, delivered.commit]);
    expect(first.fx.executor.calls.length).toBe(calls);
    const fix = fixChecksRequest(first.fx.service.store, read);
    expect(fix).toMatchObject({ workflowId: "fix-ci", featureId: "fixture-ci", followUp: first.runId });
    expect(fix.prompt).toContain("https://example.test/acme/widget/pull/1");
    expect(fix.prompt).toContain("- test (windows): 1 failed: EBUSY (https://ci/9)");
    expect(fix.prompt).not.toContain("lint");
  }, TWO_EXECUTES_TIMEOUT);

  test("passes, times out, refuses an undelivered run, and the CLI reads once with the fix", async () => {
    const { first, second } = await followUpScenario();
    const store = first.fx.service.store;
    first.provider.checkReads = [[pass]];
    expect((await followPullRequest(store, first.fx.config, first.runId, { provider: first.provider, sleep: async () => {} })).outcome).toBe("passed");
    first.provider.checkReads = [[pending]];
    let clock = 0;
    const timedOut = await followPullRequest(store, first.fx.config, first.runId, {
      provider: first.provider,
      intervalSeconds: 60,
      timeoutMinutes: 2,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(timedOut).toMatchObject({ outcome: "timeout", state: "pending" });
    const fault = await refusal(pullRequestChecks(store, first.fx.config, second.runId, first.provider));
    expect(fault.details.reason).toBe("not_delivered");
    first.provider.checkReads = [[fail]];
    const cli = (argv: string[]) => executeWorkflowCommand(first.fx.service, parseWorkflowArgs(argv), new AbortController().signal, undefined, { pullRequests: first.provider });
    const once = (await cli(["follow", first.runId, "--once"])) as { state: string; fix: { featureId: string; followUp: string } };
    expect(once.state).toBe("failed");
    expect(once.fix).toMatchObject({ featureId: "fixture-ci", followUp: first.runId });
    expect(() => parseWorkflowArgs(["follow", first.runId, "--interval", "2"])).toThrow("--interval accepts 5 to 3600");
    expect(() => parseWorkflowArgs(["follow", first.runId, "--once", "--timeout", "5"])).toThrow("--once");
    expect(workflowHelp).toContain("follow RUN_ID [--interval 60]");
  }, TWO_EXECUTES_TIMEOUT);

  const thread = (id: string, body: string, resolved = false) => ({
    id,
    resolved,
    outdated: false,
    path: "value.txt",
    line: 1,
    comments: [{ author: "reviewer", body, url: `https://example.test/acme/widget/pull/1#${id}` }],
  });

  test("reads unresolved review threads and proposes a quick-fix run that answers them", async () => {
    const { first, second } = await followUpScenario();
    const store = first.fx.service.store;
    first.provider.review = { threads: [], reviews: [{ author: "lead", state: "APPROVED", body: "", url: "u" }] };
    expect((await pullRequestReviews(store, first.fx.config, first.runId, first.provider)).state).toBe("clear");
    first.provider.review = {
      threads: [thread("T1", "Say  \n fixed"), thread("T2", "done already", true)],
      reviews: [{ author: "lead", state: "CHANGES_REQUESTED", body: "Please also update docs", url: "u" }],
    };
    const reviews = await pullRequestReviews(store, first.fx.config, first.runId, first.provider);
    expect(reviews).toMatchObject({ state: "changes", pullRequest: { number: 1 } });
    expect(reviews.threads.map((t) => t.id)).toEqual(["T1"]);
    const repair = repairReviewsRequest(store, reviews);
    expect(repair).toMatchObject({ workflowId: "quick-fix", featureId: "fixture-review", followUp: first.runId, threads: ["T1"] });
    expect(repair.prompt).toContain('- value.txt:1: reviewer: "Say fixed"');
    expect(repair.prompt).toContain('- Review by lead: "Please also update docs"');
    expect(repair.prompt).not.toContain("done already");
    expect((await refusal(pullRequestReviews(store, first.fx.config, second.runId, first.provider))).details.reason).toBe("not_delivered");
    // The CLI reads reviews only when asked, and only once no check failed.
    first.provider.checkReads = [[{ name: "lint", state: "passed", detail: "", url: null }]];
    const cli = (argv: string[]) => executeWorkflowCommand(first.fx.service, parseWorkflowArgs(argv), new AbortController().signal, undefined, { pullRequests: first.provider });
    expect(await cli(["follow", first.runId, "--once"])).not.toHaveProperty("reviews");
    const read = (await cli(["follow", first.runId, "--once", "--reviews"])) as { reviews: { state: string }; repair: { threads: string[] } };
    expect(read.reviews.state).toBe("changes");
    expect(read.repair.threads).toEqual(["T1"]);
    first.provider.checkReads = [[fail]];
    const failing = (await cli(["follow", first.runId, "--once", "--reviews"])) as Record<string, unknown>;
    expect(failing.fix).toBeDefined();
    expect(failing.reviews).toBeUndefined();
    expect(workflowHelp).toContain("[--reviews]");
  }, TWO_EXECUTES_TIMEOUT);

  test("a follow-up delivery answers and resolves the approved review threads once", async () => {
    const { first, second } = await followUpScenario();
    const provider = first.provider;
    provider.review = { threads: [thread("T1", "Say fixed"), thread("T2", "Rename it")], reviews: [] };
    expect((await refusal(prepare(second, { answer: { threads: ["T1"] } }))).details.reason).toBe("answer_without_follow_up");
    expect((await refusal(prepare(second, { followUp: first.runId, answer: { threads: ["T9"] } }))).details.reason).toBe("thread_not_open");
    expect(() => parseWorkflowArgs(["deliver", second.runId, "--answer-threads", "T1"])).toThrow("add --follow-up");
    expect(() => parseWorkflowArgs(["deliver", second.runId, "--follow-up", first.runId, "--resolve"])).toThrow("--resolve resolves");
    const prepared = await prepare(second, { followUp: first.runId, answer: { threads: ["T1", "T1"], resolve: true } });
    expect(prepared.plan.operations).toEqual(["commit", "push", "review_replies"]);
    expect(prepared.plan.reviewReplies).toMatchObject({
      pullRequest: 1,
      resolve: true,
      threads: [{ id: "T1", path: "value.txt", url: "https://example.test/acme/widget/pull/1#T1" }],
    });
    const body = JSON.parse(second.fx.service.store.requests(second.runId).find((r) => r.id === prepared.requestId)?.body_json ?? "{}");
    expect(body.reviewReplies.threads).toHaveLength(1);
    await approve(second, prepared);
    // The reply is posted but its response is lost: the retry sees the plan's marker and does not post again.
    provider.loseNextAnswer = true;
    const result = await execute(second);
    expect(result.operations.at(-1)).toMatchObject({ operation: "review_replies", status: "reconciled" });
    const replies = provider.review.threads[0]?.comments.slice(1) ?? [];
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toContain(`Addressed in ${result.commit}.`);
    expect(replies[0]?.body).toContain(`<!-- baked-delivery:${prepared.planId} -->`);
    expect(provider.review.threads.map((t) => t.resolved)).toEqual([true, false]);
    expect(await execute(second)).toEqual(result);
    expect(provider.answers).toHaveLength(1);
  }, TWO_EXECUTES_TIMEOUT);
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

  test("GitHub provider reads check runs and commit statuses of a commit", async () => {
    const answers = [
      { check_runs: [
        { name: "test", status: "completed", conclusion: "failure", html_url: "https://ci/1", output: { title: "2 failed", summary: "expected 1" } },
        { name: "lint", status: "completed", conclusion: "skipped" },
        { name: "build", status: "in_progress", conclusion: null },
      ] },
      { statuses: [{ context: "deploy", state: "success", description: "ok", target_url: null }] },
    ];
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as typeof fetch;
    const provider = githubPullRequests({ token: "t0k", tokenEnv: "GITHUB_TOKEN", apiUrl: "https://api.github.com", fetch: fetcher });
    const checks = await provider.checks?.("acme/widget", "abc123");
    expect(urls).toEqual([
      "https://api.github.com/repos/acme/widget/commits/abc123/check-runs?per_page=100",
      "https://api.github.com/repos/acme/widget/commits/abc123/status",
    ]);
    expect(checks).toEqual([
      { name: "test", state: "failed", detail: "2 failed: expected 1", url: "https://ci/1" },
      { name: "lint", state: "passed", detail: "", url: null },
      { name: "build", state: "pending", detail: "", url: null },
      { name: "deploy", state: "passed", detail: "ok", url: null },
    ]);
  });

  test("GitHub provider reads review threads over GraphQL and answers them", async () => {
    const calls: { url: string; body: { query: string; variables: Record<string, unknown> } }[] = [];
    const answers: unknown[] = [
      { data: { repository: { pullRequest: {
        reviewThreads: { nodes: [{ id: "PRRT_1", isResolved: false, isOutdated: true, path: "a.ts", line: 3, comments: { nodes: [{ author: { login: "amy" }, body: "Rename", url: "https://c/1" }] } }] },
        latestReviews: { nodes: [{ author: null, state: "CHANGES_REQUESTED", body: "More", url: "https://r/1" }] },
      } } } },
      { data: {} },
      { data: {} },
      { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] },
    ];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as typeof fetch;
    const provider = githubPullRequests({ token: "t0k", tokenEnv: "GITHUB_TOKEN", apiUrl: "https://api.github.com", fetch: fetcher });
    expect(await provider.reviews?.("acme/widget", 7)).toEqual({
      threads: [{ id: "PRRT_1", resolved: false, outdated: true, path: "a.ts", line: 3, comments: [{ author: "amy", body: "Rename", url: "https://c/1" }] }],
      reviews: [{ author: "ghost", state: "CHANGES_REQUESTED", body: "More", url: "https://r/1" }],
    });
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(calls[0]?.body.variables).toEqual({ owner: "acme", name: "widget", number: 7 });
    await provider.answerThread?.("PRRT_1", "Addressed", true);
    expect(calls[1]?.body.query).toContain("addPullRequestReviewThreadReply");
    expect(calls[1]?.body.variables).toEqual({ thread: "PRRT_1", body: "Addressed" });
    expect(calls[2]?.body.query).toContain("resolveReviewThread");
    await expect(provider.answerThread?.("PRRT_1", null, true)).rejects.toMatchObject({ failure: "auth" });
    expect(calls[3]?.body.query).toContain("resolveReviewThread");
    const enterprise = githubPullRequests({ token: "t", tokenEnv: "GITHUB_TOKEN", apiUrl: "https://ghe.example.test/api/v3", fetch: fetcher });
    answers.push({ data: {} });
    await enterprise.answerThread?.("PRRT_1", null, true);
    expect(calls[4]?.url).toBe("https://ghe.example.test/api/graphql");
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

describe("Delivery of a run started from an issue", () => {
  test("the pull request body opens with the line that closes the issue", async () => {
    const s = await completedRun();
    const store = s.fx.service.store;
    const issue = { repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/issues/7", title: "Ready value" };
    store.saveState(s.runId, { ...store.state(s.runId), issue });
    expect((await prepare(s)).plan.pullRequest?.body.startsWith("Closes #7\n\n")).toBe(true);
    store.saveState(s.runId, { ...store.state(s.runId), issue: { ...issue, repository: "acme/tracker" } });
    expect((await prepare(s)).plan.pullRequest?.body.startsWith("Closes acme/tracker#7\n\n")).toBe(true);
  });
});

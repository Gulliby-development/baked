import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { executeDelivery, prepareDelivery } from "../src/core/workflows/delivery.js";
import { initiativeSpecPrefix, runSpecPath, treeShipsSpecs } from "../src/core/workflows/delivery-git.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import {
  assertWorkspaceMutationAllowed,
  releaseDeadOwnerLeases,
  WorkspaceLeases,
} from "../src/core/workflows/leases.js";
import { PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId, WorkflowStore } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { upgradeWorkflowV1 } from "../src/core/workflows/v2/upgrade.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { worktreeView } from "../src/core/workflows/worktree.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy } from "./helpers/workflow-fixture.js";
import { initWorkspaceGit } from "../src/core/git/init.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with one commit and a local identity; `.baked/` is ignored as BAKED sets it up. */
function repository(root: string): string {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Project\n");
  writeFileSync(join(root, "user.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  return git(root, "rev-parse", "HEAD");
}

/**
 * Completes the fixture flow in the root the scheduler hands out. The implementation edits
 * value.txt through the workflow tool policy, so the edit is a journaled file effect, and records
 * what the user could do in the working copy at that moment.
 */
class RootExecutor implements AgentExecutor {
  service: NativeWorkflowService | undefined;
  roots: string[] = [];
  leases: string[] = [];
  userCouldEdit: boolean | null = null;
  /** Reports the task blocked after its edit, leaving an edit the run can undo. */
  block = false;
  constructor(private workspace: string) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    this.roots.push(root);
    const service = this.service;
    if (request.profile.output !== "implementation" || !service)
      return new FixtureExecutor(root).execute(request);
    this.leases = service.store.leases().map((lease) => lease.resource);
    this.userCouldEdit = userCanEdit(this.workspace);
    const policy = PolicySchema.parse(JSON.parse(service.store.run(request.runId).policy_json));
    const guard = new WorkflowToolPolicy(
      service.store,
      service.leases,
      request.runId,
      request.attemptId,
      request.profile,
      policy,
      request.task,
      root,
    );
    await guard.execute("edit_file", { path: "value.txt" }, async () =>
      writeFileSync(join(root, "value.txt"), "ready"),
    );
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: this.block ? "blocked" : "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

/** Takes and releases the project mutation lease the way an ordinary edit outside the run does. */
function userCanEdit(workspace: string): boolean {
  const store = new WorkflowStore(workspace);
  const leases = new WorkspaceLeases(store);
  try {
    assertWorkspaceMutationAllowed(workspace);
    leases.acquire("mutation", null);
    return true;
  } catch (error) {
    if (error instanceof WorkflowFault && error.code === "WORKSPACE_BUSY") return false;
    throw error;
  } finally {
    leases.release();
    store.close();
  }
}

function setup(options: { git?: boolean; policy?: RunPolicy; executor?: (root: string) => RootExecutor } = {}) {
  const root = mkdtempSync(join(tmpdir(), "baked-worktree-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const head = options.git === false ? "" : repository(root);
  const policy = options.policy ?? fixturePolicy;
  const executor = options.executor ? options.executor(root) : new RootExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const start = (mode?: "inline" | "worktree", workflowId = "sdd") =>
    service.start({
      commandId: newId(), featureId: "fixture", workflowId, prompt: "Create ready value", ownerLabel: "test", policy,
      ...(mode ? { executionMode: mode } : {}),
    });
  const drive = (runId: string) => service.drive(runId, new AbortController().signal);
  const pendingApproval = (runId: string) =>
    service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  const approve = (runId: string, extra: { userChanges?: "exclude" } = {}) => {
    const request = pendingApproval(runId);
    if (!request) throw new Error("No pending approval");
    return service.decide(
      runId,
      { commandId: newId(), expectedRevision: service.store.run(runId).revision },
      { kind: "approve", requestId: request.id, digest: request.digest, ...extra },
    );
  };
  const complete = async (runId: string, extra: { userChanges?: "exclude" } = {}) => {
    const waiting = await drive(runId);
    if (waiting.status !== "waiting") throw new Error(`Expected an approval, run is ${waiting.status}`);
    await approve(runId, extra);
    return drive(runId);
  };
  return { root, head, executor, service, config, policy, start, drive, approve, complete, pendingApproval };
}

async function refusal(action: Promise<unknown>): Promise<WorkflowFault> {
  try {
    await action;
  } catch (error) {
    if (error instanceof WorkflowFault) return error;
    throw error;
  }
  throw new Error("Expected a refusal");
}

const status = (root: string) => git(root, "status", "--porcelain=v1", "--untracked-files=all");

describe("workflow worktree execution", () => {
  test("edits, checks and acceptance happen in the worktree; the working copy never changes", async () => {
    const fx = setup();
    const run = await fx.start("worktree");
    const waiting = await fx.drive(run.runId);
    expect(waiting.status).toBe("waiting");
    const worktree = fx.service.store.state(run.runId).worktree;
    expect(worktree).toMatchObject({
      path: `.baked/worktrees/${run.runId}/main`,
      branch: `baked/wf/${run.runId}`,
      baseHead: fx.head,
      commit: null,
    });
    const tree = join(fx.root, worktree?.path ?? "");
    // The spec publication went to the worktree too.
    expect(existsSync(join(tree, "specs/fixture/spec.json"))).toBe(true);
    expect(existsSync(join(fx.root, "specs"))).toBe(false);
    const body = JSON.parse(fx.pendingApproval(run.runId)?.body_json ?? "{}");
    expect(body.executionMode).toBe("worktree");
    expect(body.worktree).toMatchObject({ branch: `baked/wf/${run.runId}`, baseHead: fx.head, userChangesInScope: [] });

    await fx.approve(run.runId);
    const done = await fx.drive(run.runId);
    expect(done.status).toBe("completed");

    // Every agent call worked in the worktree; the user could edit the project meanwhile.
    expect(new Set(fx.executor.roots)).toEqual(new Set([tree]));
    expect(fx.executor.leases.sort()).toEqual([`execution:${run.runId}`, `worktree:${worktree?.path}`]);
    expect(fx.executor.userCouldEdit).toBe(true);
    expect(existsSync(join(fx.root, "value.txt"))).toBe(false);
    expect(status(fx.root)).toBe("");
    expect(git(fx.root, "rev-parse", "HEAD")).toBe(fx.head);
    expect(readFileSync(join(tree, "value.txt"), "utf8")).toBe("ready");

    // The edit is journaled against the worktree.
    const edit = fx.service.store.effects(run.runId).find((e) => e.kind === "file_patch");
    expect(JSON.parse(edit?.intent_json ?? "{}")).toMatchObject({ path: "value.txt", root: worktree?.path });
    expect(edit?.status).toBe("applied");

    // The check ran in the worktree: it reads value.txt, which exists only there.
    expect(fx.service.store.checks(run.runId).some((c) => c.status === "passed")).toBe(true);

    // The accepted changes are one commit on the run branch, parented on the baseline HEAD.
    const state = fx.service.store.state(run.runId);
    const commit = state.worktree?.commit ?? "";
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(fx.root, "rev-parse", `baked/wf/${run.runId}`)).toBe(commit);
    expect(git(fx.root, "rev-parse", `${commit}^`)).toBe(fx.head);
    expect(git(fx.root, "show", `${commit}:value.txt`)).toBe("ready");
    // The project tracks no specs/, so the published spec stays a run artifact, as in the
    // delivery plan (#1998).
    expect(git(fx.root, "ls-tree", "--name-only", commit, "--", "specs")).toBe("");
    expect(git(fx.root, "log", "-1", "--format=%B", commit)).toContain(`Baked-Run: ${run.runId}`);
    expect(status(tree).split("\n").every((line) => line.startsWith("?? specs/fixture/"))).toBe(true);
    const completion = fx.service.store.artifacts(run.runId).find((a) => a.logical_path === "completion.json");
    expect(JSON.parse(fx.service.store.readArtifact(run.runId, completion?.id ?? "")).worktree.commit).toBe(commit);
    // The leases are released after the drive.
    expect(fx.service.store.leases()).toEqual([]);
  });

  test("the execution mode is part of the approval digest; inline runs keep their policy hash", async () => {
    const fx = setup();
    const inline = await fx.start();
    const worktree = await fx.start("worktree");
    const policyOf = (runId: string) => JSON.parse(fx.service.store.run(runId).policy_json);
    expect("executionMode" in policyOf(inline.runId)).toBe(false);
    expect(hashJson(policyOf(inline.runId))).toBe(hashJson(PolicySchema.parse(fx.policy)));
    expect(policyOf(worktree.runId).executionMode).toBe("worktree");
    const inlineManifest = fx.service.store.state(inline.runId).manifest;
    const worktreeManifest = fx.service.store.state(worktree.runId).manifest;
    expect(worktreeManifest.policyHash).toBe(hashJson(policyOf(worktree.runId)));
    expect(worktreeManifest.policyHash).not.toBe(inlineManifest.policyHash);
  });

  test("a v2 definition can request worktree execution", async () => {
    const fx = setup();
    mkdirSync(join(fx.root, "baked", "workflows"), { recursive: true });
    const definition = { ...upgradeWorkflowV1(sddWorkflow, fx.policy), id: "sdd-isolated", execution: "worktree" };
    writeFileSync(join(fx.root, "baked", "workflows", "sdd-isolated.json"), JSON.stringify(definition));
    const run = await fx.start(undefined, "sdd-isolated");
    expect(JSON.parse(fx.service.store.run(run.runId).policy_json).executionMode).toBe("worktree");
    // The CLI flag overrides the definition.
    const inline = await fx.start("inline", "sdd-isolated");
    expect("executionMode" in JSON.parse(fx.service.store.run(inline.runId).policy_json)).toBe(false);
  });

  test("an inline run is unchanged: no worktree, no root in effects, project lease held", async () => {
    const fx = setup();
    const run = await fx.start();
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.service.store.state(run.runId).worktree).toBeNull();
    expect(existsSync(join(fx.root, ".baked", "worktrees"))).toBe(false);
    expect(readFileSync(join(fx.root, "value.txt"), "utf8")).toBe("ready");
    expect(new Set(fx.executor.roots)).toEqual(new Set([fx.root]));
    expect(fx.executor.leases.sort()).toEqual(["execution", "mutation"]);
    expect(fx.executor.userCouldEdit).toBe(false);
    for (const effect of fx.service.store.effects(run.runId))
      expect("root" in JSON.parse(effect.intent_json)).toBe(false);
    expect(git(fx.root, "branch", "--list", "baked/wf/*")).toBe("");
  });

  test("worktree execution needs Git and is refused at start without it", async () => {
    const fx = setup({ git: false });
    const fault = await refusal(fx.start("worktree"));
    expect(fault.code).toBe("INVALID_DEFINITION");
    expect(fault.details.reason).toBe("git_required");
    expect(fault.details.gitInit).toBe(true);
    expect(existsSync(join(fx.root, ".baked", "worktrees"))).toBe(false);
  });

  test("after Git is initialized the same worktree run starts (#1345)", async () => {
    const fx = setup({ git: false });
    await refusal(fx.start("worktree"));
    const init = await initWorkspaceGit(fx.root);
    expect(init.initialized).toBe(true);
    const run = await fx.start("worktree");
    const done = await fx.complete(run.runId);
    expect(done.status).toBe("completed");
    expect(fx.service.store.state(run.runId).worktree?.baseHead).toBe(init.commit);
  });

  test("approved files with uncommitted user changes need an explicit choice", async () => {
    const fx = setup();
    writeFileSync(join(fx.root, "value.txt"), "user draft\n");
    const run = await fx.start("worktree");
    expect((await fx.drive(run.runId)).status).toBe("waiting");
    const body = JSON.parse(fx.pendingApproval(run.runId)?.body_json ?? "{}");
    expect(body.worktree.userChangesInScope).toEqual(["value.txt"]);
    const fault = await refusal(fx.approve(run.runId));
    expect(fault.code).toBe("STALE_DECISION");
    expect(fault.details.userChangesInScope).toEqual(["value.txt"]);
    await fx.approve(run.runId, { userChanges: "exclude" });
    expect(fx.service.store.state(run.runId).worktree?.excludedUserChanges).toEqual(["value.txt"]);
    expect((await fx.drive(run.runId)).status).toBe("completed");
    // The user's draft stays as it was; the branch carries the run's version.
    expect(readFileSync(join(fx.root, "value.txt"), "utf8")).toBe("user draft\n");
    expect(git(fx.root, "show", `baked/wf/${run.runId}:value.txt`)).toBe("ready");
  });

  test("a crash between an effect and its journal entry is recovered in the effect's own root", async () => {
    const fx = setup();
    const run = await fx.start("worktree");
    await fx.drive(run.runId);
    const store = fx.service.store;
    const worktree = store.state(run.runId).worktree;
    if (!worktree) throw new Error("No worktree");
    const tree = join(fx.root, worktree.path);
    const { attemptId } = store.transaction(() => store.beginExternalAttempt(run.runId, "crash"));
    const prepare = (path: string, content: string, root?: string) =>
      store.transaction(() =>
        store.prepareEffect(run.runId, attemptId, "artifact_write", { path, ...(root ? { root } : {}) }, null, hashBytes(content)),
      );
    // Written in the worktree, then the process died before the journal said so.
    const applied = prepare("crash/a.txt", "A", worktree.path);
    mkdirSync(join(tree, "crash"), { recursive: true });
    writeFileSync(join(tree, "crash/a.txt"), "A");
    // The same content in the project root does not count for an effect bound to the worktree.
    const elsewhere = prepare("crash/b.txt", "B", worktree.path);
    mkdirSync(join(fx.root, "crash"), { recursive: true });
    writeFileSync(join(fx.root, "crash/b.txt"), "B");
    // A record without root means the project root, even while the run has a worktree.
    const legacy = prepare("crash/c.txt", "C");
    writeFileSync(join(tree, "crash/c.txt"), "C");
    // An effect whose root is gone cannot be observed and goes to recovery.
    const gone = prepare("crash/d.txt", "D", ".baked/worktrees/missing/main");
    expect(fx.service.scheduler.journal.reconcile(run.runId)).toEqual([gone]);
    const statusOf = (id: string) => store.effects(run.runId).find((e) => e.id === id)?.status;
    expect(statusOf(applied)).toBe("reconciled");
    expect(statusOf(elsewhere)).toBe("failed");
    expect(statusOf(legacy)).toBe("failed");
    expect(statusOf(gone)).toBe("unknown");
  });

  test("undo restores the run's unfinished edits in its worktree", async () => {
    const fx = setup();
    fx.executor.block = true;
    writeFileSync(join(fx.root, "value.txt"), "user draft\n");
    const run = await fx.start("worktree");
    expect((await fx.complete(run.runId, { userChanges: "exclude" })).status).toBe("blocked");
    const tree = join(fx.root, fx.service.store.state(run.runId).worktree?.path ?? "missing");
    expect(readFileSync(join(tree, "value.txt"), "utf8")).toBe("ready");
    await fx.service.undo(run.runId, { commandId: newId(), expectedRevision: fx.service.store.run(run.runId).revision });
    expect(existsSync(join(tree, "value.txt"))).toBe(false);
    expect(readFileSync(join(fx.root, "value.txt"), "utf8")).toBe("user draft\n");
    const restore = fx.service.store.effects(run.runId).filter((e) => JSON.parse(e.intent_json).tool === "rollback");
    expect(restore.map((e) => JSON.parse(e.intent_json).root)).toEqual([`.baked/worktrees/${run.runId}/main`]);
  });

  test("a dead owner's worktree lease is released by the v1 rules", async () => {
    const fx = setup();
    const run = await fx.start("worktree");
    const store = fx.service.store;
    const resource = `worktree:.baked/worktrees/${run.runId}/main` as const;
    const dead = JSON.stringify({ pid: 2147483647 });
    store.transaction(() => {
      store.putLease({ resource: "execution", owner_id: "dead-owner", owner_epoch: 1, run_id: run.runId, expires_at: 0, process_identity_json: dead });
      store.putLease({ resource, owner_id: "dead-owner", owner_epoch: 3, run_id: run.runId, expires_at: 0, process_identity_json: dead });
    });
    // The project working copy stays free while a worktree run holds its leases.
    expect(userCanEdit(fx.root)).toBe(true);
    // A new owner takes the dead owner's worktree lease over with the next fencing epoch.
    const leases = new WorkspaceLeases(store);
    leases.acquire(resource, run.runId);
    expect(store.lease(resource)).toMatchObject({ owner_id: leases.owner, owner_epoch: 4 });
    leases.release();
    expect(store.lease(resource)).toBeNull();
    // A live owner is never taken over.
    store.transaction(() =>
      store.putLease({ resource, owner_id: "live-owner", owner_epoch: 1, run_id: run.runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: process.pid }) }),
    );
    expect(() => new WorkspaceLeases(store).acquire(resource, run.runId)).toThrow(/owned by/);
    store.transaction(() => store.releaseLease(resource, "live-owner", 1));
    // Stopping a run whose owner died releases every lease of the run, the worktree's included.
    store.transaction(() => store.putLease({ resource, owner_id: "dead-owner", owner_epoch: 5, run_id: run.runId, expires_at: 0, process_identity_json: dead }));
    expect(store.transaction(() => releaseDeadOwnerLeases(store, run.runId)).sort()).toEqual(["execution", resource].sort());
    expect(store.leases()).toEqual([]);
  });

  test("a worktree run is delivered from its branch, then its worktree is removed", async () => {
    const fx = setup();
    const remote = mkdtempSync(join(tmpdir(), "baked-worktree-remote-"));
    cleanups.push(() => rmSync(remote, { recursive: true, force: true }));
    git(remote, "init", "--bare", "-q", "-b", "main");
    git(fx.root, "remote", "add", "origin", remote);
    git(fx.root, "push", "-q", "origin", "main");
    const run = await fx.start("worktree");
    expect((await fx.complete(run.runId)).status).toBe("completed");
    // The user keeps working in the working copy; delivery leaves that alone.
    writeFileSync(join(fx.root, "user.txt"), "user edit\n");
    const store = fx.service.store;
    const worktree = store.state(run.runId).worktree;
    const prepared = await prepareDelivery(store, fx.config, run.runId, { pullRequest: false, now: 1700000000 });
    expect(prepared.plan.worktree).toEqual({ path: worktree?.path ?? "", branch: `baked/wf/${run.runId}`, commit: worktree?.commit ?? "" });
    expect(prepared.plan.files.map((f) => f.path)).toContain("value.txt");
    expect(prepared.plan.userChanges).toEqual(["user.txt"]);
    expect(prepared.plan.base.commit).toBe(fx.head);
    expect(prepared.diff).toContain("+ready");
    await fx.service.decide(
      run.runId,
      { commandId: newId(), expectedRevision: store.run(run.runId).revision },
      { kind: "approve", requestId: prepared.requestId, digest: prepared.digest },
    );
    const result = await executeDelivery(store, fx.config, run.runId, { expectedRevision: store.run(run.runId).revision, provider: null });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(remote, "show", `${prepared.plan.branch}:value.txt`)).toBe("ready");
    expect(git(fx.root, "rev-parse", `${result.commit}^`)).toBe(fx.head);
    // The working copy, its HEAD and the user's edit are untouched.
    expect(existsSync(join(fx.root, "value.txt"))).toBe(false);
    expect(readFileSync(join(fx.root, "user.txt"), "utf8")).toBe("user edit\n");
    expect(git(fx.root, "rev-parse", "HEAD")).toBe(fx.head);
    // Delivered: the worktree is removed, the run branch keeps the accepted commit.
    expect(existsSync(join(fx.root, worktree?.path ?? "missing"))).toBe(false);
    expect(git(fx.root, "rev-parse", `baked/wf/${run.runId}`)).toBe(worktree?.commit ?? "");
    expect(git(fx.root, "worktree", "list")).not.toContain(run.runId);
    // Planning again cannot read a removed worktree.
    const fault = await refusal(prepareDelivery(store, fx.config, run.runId, { pullRequest: false }));
    expect(fault.details.reason).toBe("worktree_missing");
  });

  test("a worktree run is delivered locally into the checked-out branch with no remote (#1347)", async () => {
    // A folder BAKED initialized has no remote and often no identity.
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    const globalDir = mkdtempSync(join(tmpdir(), "baked-local-delivery-config-"));
    cleanups.push(() => {
      for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      rmSync(globalDir, { recursive: true, force: true });
    });
    process.env.GIT_CONFIG_GLOBAL = join(globalDir, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const fx = setup();
    git(fx.root, "config", "--unset", "user.name");
    git(fx.root, "config", "--unset", "user.email");
    const run = await fx.start("worktree");
    expect((await fx.complete(run.runId)).status).toBe("completed");
    writeFileSync(join(fx.root, "user.txt"), "user edit\n");
    const store = fx.service.store;
    const worktree = store.state(run.runId).worktree;
    const prepared = await prepareDelivery(store, fx.config, run.runId, { local: true, now: 1700000000 });
    expect(prepared.plan.operations).toEqual(["commit", "advance"]);
    expect(prepared.plan.remote).toBeNull();
    expect(prepared.plan.pullRequest).toBeNull();
    expect(prepared.plan.base).toEqual({ commit: fx.head, branch: "main" });
    expect(prepared.plan.author.name).toBe("BAKED");
    await fx.service.decide(
      run.runId,
      { commandId: newId(), expectedRevision: store.run(run.runId).revision },
      { kind: "approve", requestId: prepared.requestId, digest: prepared.digest },
    );
    const result = await executeDelivery(store, fx.config, run.runId, { expectedRevision: store.run(run.runId).revision, provider: null });
    expect(result.remote).toBeNull();
    expect(result.operations.map((o) => o.operation)).toEqual(["commit", "advance"]);
    // main moved to the delivery commit, built on the old HEAD; the file is in the working copy and index.
    expect(git(fx.root, "rev-parse", "HEAD")).toBe(result.commit ?? "");
    expect(git(fx.root, "rev-parse", "HEAD^")).toBe(fx.head);
    expect(git(fx.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readFileSync(join(fx.root, "value.txt"), "utf8")).toBe("ready");
    expect(git(fx.root, "log", "-1", "--format=%an <%ae>")).toBe("BAKED <noreply@baked.invalid>");
    // The person's unrelated edit stays an uncommitted change; nothing else is dirty.
    expect(status(fx.root)).toBe("M user.txt");
    expect(readFileSync(join(fx.root, "user.txt"), "utf8")).toBe("user edit\n");
    expect(existsSync(join(fx.root, worktree?.path ?? "missing"))).toBe(false);
    expect(git(fx.root, "rev-parse", `baked/wf/${run.runId}`)).toBe(worktree?.commit ?? "");
  });

  test("a local delivery is refused when a delivered file has uncommitted changes or the branch moved", async () => {
    const fx = setup();
    const run = await fx.start("worktree");
    expect((await fx.complete(run.runId)).status).toBe("completed");
    const store = fx.service.store;
    writeFileSync(join(fx.root, "value.txt"), "mine");
    const before = await refusal(prepareDelivery(store, fx.config, run.runId, { local: true }));
    expect(before.details).toMatchObject({ reason: "dirty_files", files: ["value.txt"] });
    rmSync(join(fx.root, "value.txt"));
    const remoteOnly = await refusal(prepareDelivery(store, fx.config, run.runId, { local: true, remote: "origin" }));
    expect(remoteOnly.details.reason).toBe("local_with_remote");

    const approveAndExecute = async () => {
      const prepared = await prepareDelivery(store, fx.config, run.runId, { local: true });
      await fx.service.decide(
        run.runId,
        { commandId: newId(), expectedRevision: store.run(run.runId).revision },
        { kind: "approve", requestId: prepared.requestId, digest: prepared.digest },
      );
      return () => executeDelivery(store, fx.config, run.runId, { expectedRevision: store.run(run.runId).revision, provider: null });
    };
    const dirty = await approveAndExecute();
    writeFileSync(join(fx.root, "value.txt"), "mine");
    expect((await refusal(dirty())).details).toMatchObject({ reason: "dirty_files", files: ["value.txt"] });
    expect(readFileSync(join(fx.root, "value.txt"), "utf8")).toBe("mine");
    expect(git(fx.root, "rev-parse", "HEAD")).toBe(fx.head);
    rmSync(join(fx.root, "value.txt"));

    const moved = await approveAndExecute();
    writeFileSync(join(fx.root, "other.txt"), "other\n");
    git(fx.root, "add", "other.txt");
    git(fx.root, "commit", "-q", "-m", "Other work");
    const other = git(fx.root, "rev-parse", "HEAD");
    expect((await refusal(moved())).details.reason).toBe("head_moved");
    expect(git(fx.root, "rev-parse", "HEAD")).toBe(other);
    expect(existsSync(join(fx.root, "value.txt"))).toBe(false);
  });

  test("a worktree is discarded only for a terminal run, on the user's command", async () => {
    const fx = setup();
    const run = await fx.start("worktree");
    await fx.drive(run.runId);
    const store = fx.service.store;
    const worktree = store.state(run.runId).worktree;
    const tree = join(fx.root, worktree?.path ?? "missing");
    const identity = () => ({ commandId: newId(), expectedRevision: store.run(run.runId).revision });
    expect(worktreeView(fx.root, store.state(run.runId))).toEqual({
      path: worktree?.path ?? "",
      branch: `baked/wf/${run.runId}`,
      present: true,
    });
    const busy = await refusal(fx.service.discardWorktree(run.runId, identity()));
    expect(busy.code).toBe("STALE_DECISION");
    expect(existsSync(tree)).toBe(true);
    await fx.service.cancel(run.runId, identity());
    await fx.service.discardWorktree(run.runId, identity());
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(fx.root, ".baked", "worktrees", run.runId))).toBe(false);
    expect(git(fx.root, "branch", "--list", `baked/wf/${run.runId}`)).toBe("");
    expect(store.artifacts(run.runId).some((a) => a.logical_path === "worktree/discarded.json")).toBe(true);
    // The record stays for history; the run screens stop offering the discard.
    expect(worktreeView(fx.root, store.state(run.runId))?.present).toBe(false);
    const again = await refusal(fx.service.discardWorktree(run.runId, identity()));
    expect(again.code).toBe("NOT_FOUND");
    // An inline run has no worktree to discard.
    const inline = await fx.start();
    await fx.service.cancel(inline.runId, { commandId: newId(), expectedRevision: store.run(inline.runId).revision });
    const none = await refusal(fx.service.discardWorktree(inline.runId, { commandId: newId(), expectedRevision: store.run(inline.runId).revision }));
    expect(none.code).toBe("NOT_FOUND");
    expect(worktreeView(fx.root, store.state(inline.runId))).toBeNull();
  });

  test("worktrees lists run worktrees with size and cleans only ended and unknown runs", async () => {
    const fx = setup();
    const run = await fx.start("worktree");
    await fx.drive(run.runId);
    const store = fx.service.store;
    const worktree = store.state(run.runId).worktree;
    const tree = join(fx.root, worktree?.path ?? "missing");
    const orphan = join(fx.root, ".baked", "worktrees", "gone-run", "T001");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "big.txt"), "x".repeat(4096));
    const listed = await fx.service.worktrees();
    const own = listed.worktrees.find((w) => w.runId === run.runId);
    expect(own?.removable).toBe(false);
    expect(own?.kept).toMatch(/^run is /);
    expect(own?.worktrees.map((w) => w.name)).toContain("main");
    expect(own?.bytes).toBeGreaterThan(0);
    const gone = listed.worktrees.find((w) => w.runId === "gone-run");
    expect(gone).toMatchObject({ status: "orphan", removable: true, featureId: null });
    expect(gone?.bytes).toBeGreaterThanOrEqual(4096);
    // A dry run removes nothing; a cleanup keeps the waiting run and removes the orphan.
    expect((await fx.service.cleanWorktrees(true)).runIds).toEqual(["gone-run"]);
    expect(existsSync(orphan)).toBe(true);
    expect((await fx.service.cleanWorktrees(false)).runIds).toEqual(["gone-run"]);
    expect(existsSync(join(fx.root, ".baked", "worktrees", "gone-run"))).toBe(false);
    expect(existsSync(tree)).toBe(true);
    // Once the run ended, its worktree goes and its branch stays.
    await fx.service.cancel(run.runId, { commandId: newId(), expectedRevision: store.run(run.runId).revision });
    const cleaned = await fx.service.cleanWorktrees(false);
    expect(cleaned.runIds).toEqual([run.runId]);
    expect(cleaned.warnings).toEqual([]);
    expect(existsSync(join(fx.root, ".baked", "worktrees", run.runId))).toBe(false);
    expect(git(fx.root, "branch", "--list", `baked/wf/${run.runId}`)).toContain(`baked/wf/${run.runId}`);
    expect(store.artifacts(run.runId).some((a) => a.logical_path === "worktree/cleaned.json")).toBe(true);
    expect((await fx.service.worktrees()).worktrees).toEqual([]);
    expect(parseWorkflowArgs(["worktrees", "--clean", "--dry-run"]).flags).toMatchObject({ clean: true, "dry-run": true });
    expect(() => parseWorkflowArgs(["worktrees", "extra"])).toThrow();
  });
  test("the CLI requests worktree execution, the exclusion choice and discard", () => {
    expect(parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--worktree"]).flags.worktree).toBe(true);
    expect(
      parseWorkflowArgs(["approve", "r", "--request", "q", "--digest", "d", "--expected-revision", "1", "--exclude-user-changes"]).flags["exclude-user-changes"],
    ).toBe(true);
    expect(parseWorkflowArgs(["discard-worktree", "r", "--expected-revision", "2"]).command).toBe("discard-worktree");
    expect(() => parseWorkflowArgs(["status", "r", "--worktree"])).toThrow(/not valid/);
  });
});

/** Holds each implementation until `width` of them are in flight, so overlap is proven, not timed. */
class OverlapExecutor implements AgentExecutor {
  inFlight = 0;
  maxInFlight = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private workspace: string,
    private width: number,
  ) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    if (request.profile.output === "implementation") {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      if (this.inFlight >= this.width) for (const release of this.waiting.splice(0)) release();
      else
        await new Promise<void>((resolve) => {
          this.waiting.push(resolve);
          // Without a partner the run still finishes; the assertion on maxInFlight then fails.
          setTimeout(resolve, 5000);
        });
      this.inFlight--;
    }
    return new FixtureExecutor(root).execute(request);
  }
}

/** Adds a JavaScript module and its test to the fixture flow, so the mutation gate has code to mutate. */
class SignExecutor extends RootExecutor {
  override async execute(request: ExecutionRequest) {
    const root = request.root ?? "";
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.tasks[0]?.writes.push({ path: "src/sign.js", action: "create" }, { path: "tests/sign.test.js", action: "create" });
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "src/sign.js"), "export const sign = (n) => (n < 0 ? -1 : 1);\n");
      writeFileSync(
        join(root, "tests/sign.test.js"),
        'import { expect, test } from "bun:test";\nimport { sign } from "../src/sign.js";\ntest("sign", () => {\n  expect(sign(-5)).toBe(-1);\n  expect(sign(0)).toBe(1);\n});\n',
      );
    }
    return result;
  }
}

/** Whether setuptools can be asked for a flat-layout package discovery here. */
const setuptools = Bun.spawnSync(["python3", "-c", "import setuptools"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
/** The packages setuptools' automatic discovery finds in a tree, or its refusal. */
const discovered = (root: string) => {
  const probe = 'from setuptools.dist import Distribution; d = Distribution({"name": "spdxok"}); d.set_defaults(); print(d.packages)';
  const result = Bun.spawnSync(["python3", "-c", probe], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : result.stderr.toString();
};

describe("scenario: the run branch of an update on a flat-layout Python package (#1998)", () => {
  // R64 spdxok-update: the run branch carried specs/spdxok-ids-min/ next to the change, and
  // setuptools' flat-layout discovery found two top-level packages, so `pip install .` failed.
  // The publisher deleted the folder by hand in 4 of 4 sdd deliveries of the round.
  const flatLayout = (root: string) => {
    mkdirSync(join(root, "spdxok"), { recursive: true });
    writeFileSync(join(root, "spdxok/__init__.py"), "");
    writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "spdxok"\nversion = "0.1.0"\n');
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Flat-layout package");
  };
  const checkout = (root: string, commit: string) => {
    const tree = mkdtempSync(join(tmpdir(), "baked-branch-tree-"));
    cleanups.push(() => rmSync(tree, { recursive: true, force: true }));
    git(root, "--work-tree", tree, "checkout", commit, "--", ".");
    return tree;
  };

  test("the accepted commit leaves the spec out, so the package still installs", async () => {
    const fx = setup();
    flatLayout(fx.root);
    const run = await fx.start("worktree");
    expect((await fx.complete(run.runId)).status).toBe("completed");
    const commit = fx.service.store.state(run.runId).worktree?.commit ?? "";
    expect(git(fx.root, "show", `${commit}:value.txt`)).toBe("ready");
    expect(git(fx.root, "ls-tree", "--name-only", commit, "--", "specs")).toBe("");
    // The spec is still a run artifact, and the delivery plan excludes it for the same reason.
    expect(fx.service.store.artifacts(run.runId).some((a) => a.logical_path === "spec.json")).toBe(true);
    const prepared = await prepareDelivery(fx.service.store, fx.config, run.runId, { local: true });
    expect(prepared.plan.excluded.filter((e) => e.reason === "specs").map((e) => e.path)).toContain("specs/fixture/spec.json");
    if (setuptools) expect(discovered(checkout(fx.root, commit))).toBe("['spdxok']");
  }, 60000);

  test("an initiative's spec folders are not the project's own (#2017)", () => {
    const prefix = initiativeSpecPrefix("uritpl_cli", { featureId: "cli" });
    expect(prefix).toBe("specs/uritpl_");
    expect(initiativeSpecPrefix("fixture", null)).toBeNull();
    expect(initiativeSpecPrefix("fixture", { featureId: "cli" })).toBeNull();
    // A base that holds only the initiative's spec folders ships none; one with a folder of its own does.
    expect(treeShipsSpecs(["uritpl/__init__.py", "specs/uritpl_core/spec.json"], prefix)).toBe(false);
    expect(treeShipsSpecs(["specs/uritpl_core/spec.json", "specs/earlier/spec.json"], prefix)).toBe(true);
    expect(treeShipsSpecs(["specs/uritpl_core/spec.json"])).toBe(true);
    // An initiative feature's commit leaves out its own spec and its upstream features' specs.
    expect(runSpecPath("specs/uritpl_core/spec.json", "uritpl_cli", prefix)).toBe(true);
    expect(runSpecPath("specs/uritpl_cli/plan.md", "uritpl_cli", prefix)).toBe(true);
    expect(runSpecPath("specs/earlier/spec.json", "uritpl_cli", prefix)).toBe(false);
    expect(runSpecPath("specs/uritpl_core/spec.json", "uritpl_cli")).toBe(false);
  });

  test("a project that already tracks specs/ keeps getting the run's spec on its branch", async () => {
    const fx = setup();
    flatLayout(fx.root);
    mkdirSync(join(fx.root, "specs/earlier"), { recursive: true });
    writeFileSync(join(fx.root, "specs/earlier/spec.json"), "{}\n");
    git(fx.root, "add", ".");
    git(fx.root, "commit", "-q", "-m", "Earlier spec");
    const run = await fx.start("worktree");
    expect((await fx.complete(run.runId)).status).toBe("completed");
    const commit = fx.service.store.state(run.runId).worktree?.commit ?? "";
    expect(git(fx.root, "show", `${commit}:specs/fixture/spec.json`)).toContain('"featureId":"fixture"');
  }, 60000);
});

describe("mutation tools in a worktree run", () => {
  // Bench round 13 (#835): every JS/TS worktree run blocked with "Path escapes workspace", because
  // the worktree's node_modules links to the working copy's and Stryker resolved outside the worktree.
  test("Stryker installed in the working copy runs through the worktree's linked node_modules", async () => {
    const first = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
    const fx = setup({
      policy: { ...fixturePolicy, mutation: "required", checks: [...fixturePolicy.checks, { ...first, id: "unit", args: ["test", "tests/"] }] },
      executor: (root) => new SignExecutor(root),
    });
    writeFileSync(join(fx.root, ".git/info/exclude"), "node_modules/\n");
    // A stand-in for Stryker that kills every mutant on the lines it is asked to mutate.
    const bin = join(fx.root, "node_modules/@stryker-mutator/core/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "stryker.js"),
      [
        'const { mkdirSync, writeFileSync } = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const files = args[args.indexOf("--mutate") + 1].split(",");',
        "const location = { start: { line: 1, column: 23 }, end: { line: 1, column: 28 } };",
        'const mutants = [{ id: "0", mutatorName: "EqualityOperator", replacement: "n <= 0", status: "Killed", location }];',
        'mkdirSync("reports/mutation", { recursive: true });',
        'writeFileSync("reports/mutation/mutation.json", JSON.stringify({ schemaVersion: "1.0", files: Object.fromEntries(files.map((f) => [f, { mutants }])) }));',
        "",
      ].join("\n"),
    );
    const run = await fx.start("worktree");
    const done = await fx.complete(run.runId);
    expect(fx.service.store.run(run.runId).stop_detail ?? "").not.toContain("Path escapes workspace");
    expect(done.status).toBe("completed");
    expect(runReport(fx.service.store, run.runId)).toContain("Mutation gate (`required`, stryker): score 100% (1 of 1 mutants killed)");
  });
});

describe("parallel worktree runs", () => {
  function parallelSetup(maxParallelRuns?: number) {
    const root = mkdtempSync(join(tmpdir(), "baked-parallel-runs-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    repository(root);
    const executor = new OverlapExecutor(root, maxParallelRuns ?? 2);
    const workflows = { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: fixturePolicy, ...(maxParallelRuns ? { maxParallelRuns } : {}) };
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows }, executor);
    cleanups.push(() => service.close());
    const drive = (runId: string) => service.drive(runId, new AbortController().signal);
    /** A worktree run approved and ready to implement. */
    const approved = async () => {
      const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: fixturePolicy, executionMode: "worktree" });
      expect((await drive(run.runId)).status).toBe("waiting");
      const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
      if (!request) throw new Error("No pending approval");
      await service.decide(run.runId, { commandId: newId(), expectedRevision: service.store.run(run.runId).revision }, { kind: "approve", requestId: request.id, digest: request.digest });
      return run.runId;
    };
    return { root, executor, service, drive, approved };
  }

  test("two worktree runs in one workspace execute at the same time, each on its own branch", async () => {
    const fx = parallelSetup();
    const first = await fx.approved();
    const second = await fx.approved();
    const [a, b] = await Promise.all([fx.drive(first), fx.drive(second)]);
    expect([a.status, b.status]).toEqual(["completed", "completed"]);
    expect(fx.executor.maxInFlight).toBe(2);
    for (const runId of [first, second]) {
      const tree = join(fx.root, ".baked", "worktrees", runId, "main");
      expect(readFileSync(join(tree, "value.txt"), "utf8")).toBe("ready");
      expect(git(fx.root, "rev-parse", "--verify", `baked/wf/${runId}`)).not.toBe("");
    }
    expect(existsSync(join(fx.root, "value.txt"))).toBe(false);
    expect(fx.service.store.leases()).toEqual([]);
  });

  test("workflows.maxParallelRuns caps how many runs execute at once", async () => {
    const fx = parallelSetup(1);
    const first = await fx.approved();
    const second = await fx.approved();
    const running = fx.drive(first);
    // The first drive holds its execution lease from the start; the second is over the cap.
    const refused = await refusal(fx.drive(second));
    expect(refused.code).toBe("WORKSPACE_BUSY");
    expect(refused.message).toContain("workflows.maxParallelRuns is 1");
    expect((await running).status).toBe("completed");
    expect((await fx.drive(second)).status).toBe("completed");
  });
});

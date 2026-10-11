import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { executeDelivery, prepareDelivery } from "../src/core/workflows/delivery.js";
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
import { worktreeView } from "../src/core/workflows/worktree.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy } from "./helpers/workflow-fixture.js";

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

function setup(options: { git?: boolean; policy?: RunPolicy } = {}) {
  const root = mkdtempSync(join(tmpdir(), "baked-worktree-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const head = options.git === false ? "" : repository(root);
  const policy = options.policy ?? fixturePolicy;
  const executor = new RootExecutor(root);
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
    expect(fx.executor.leases.sort()).toEqual(["execution", `worktree:${worktree?.path}`]);
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
    expect(git(fx.root, "show", `${commit}:specs/fixture/spec.json`)).toContain('"featureId":"fixture"');
    expect(git(fx.root, "log", "-1", "--format=%B", commit)).toContain(`Baked-Run: ${run.runId}`);
    expect(status(tree)).toBe("");
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
    expect(existsSync(join(fx.root, ".baked", "worktrees"))).toBe(false);
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

  test("the CLI requests worktree execution, the exclusion choice and discard", () => {
    expect(parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--worktree"]).flags.worktree).toBe(true);
    expect(
      parseWorkflowArgs(["approve", "r", "--request", "q", "--digest", "d", "--expected-revision", "1", "--exclude-user-changes"]).flags["exclude-user-changes"],
    ).toBe(true);
    expect(parseWorkflowArgs(["discard-worktree", "r", "--expected-revision", "2"]).command).toBe("discard-worktree");
    expect(() => parseWorkflowArgs(["status", "r", "--worktree"])).toThrow(/not valid/);
  });
});

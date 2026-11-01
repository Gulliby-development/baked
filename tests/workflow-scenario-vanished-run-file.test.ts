import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { errorRecovery } from "../src/core/workflows/remedies.js";
import { capturePreImage } from "../src/core/workflows/rollback.js";
import { PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy } from "./helpers/workflow-fixture.js";
import { expectRecovery } from "./helpers/workflow-remedies.js";

// Scenario of the cloud smoke of 2026-11-01 (#2609): in a `--worktree` quick run, T002 created
// README.md, the file then disappeared with nothing journaled, every later edit of it was refused
// and the run blocked `input_changed`. A plain resume said to keep the file with
// `--accept-workspace`, and `--accept-workspace` said there was nothing to accept, because the
// missing file matched the baseline (absent there too). The run could not end.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function repository(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "user.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
}

const README = "# colstat\n\nUsage: python -m colstat FILE\n";

/**
 * The task creates README.md through the tool policy (a journaled edit), then the file vanishes
 * with no effect recorded and its next edits are refused until the breaker stops the attempt, as
 * the native executor's breaker does. The attempt after a resume creates it again and finishes.
 */
class VanishingExecutor implements AgentExecutor {
  service: NativeWorkflowService | undefined;
  attempts = 0;
  /**
   * Set: the task modifies this existing file instead, and the file is put back to the content it
   * had before the run, which equals the baseline as a missing created file does.
   */
  revert: { path: string; original: string } | null = null;
  constructor(private workspace: string) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const service = this.service;
    if (request.profile.output !== "implementation" || !service) {
      const out = await new FixtureExecutor(root).execute(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "README.md", action: "create" });
        if (this.revert) plan.taskGraph.tasks[0]?.writes.push({ path: this.revert.path, action: "modify" });
      }
      return out;
    }
    this.attempts++;
    const policy = PolicySchema.parse(JSON.parse(service.store.run(request.runId).policy_json));
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task, root);
    const readme = join(root, "README.md");
    const revert = this.revert;
    if (this.attempts === 1 && revert) {
      const file = join(root, revert.path);
      await guard.execute("edit_file", { path: revert.path }, async () => writeFileSync(file, "changed by the run\n"));
      writeFileSync(file, revert.original);
      let refusals = 0;
      for (let i = 0; i < 3; i++)
        await guard.execute("edit_file", { path: revert.path }, async () => writeFileSync(file, "changed again\n")).catch(() => refusals++);
      const worktree = service.store.state(request.runId).worktree?.path ?? "";
      if (refusals === 3)
        throw new WorkflowFault("INPUT_CHANGED", `Edits to ${revert.path} were refused 3 times: File changed outside this attempt`, { path: revert.path, refusals, root: worktree, hash: hashBytes(revert.original) });
    }
    if (this.attempts === 1 && !revert) {
      await guard.execute("edit_file", { path: "README.md" }, async () => writeFileSync(readme, README));
      // Removed outside the journal, as in run 4431d35f between 189.9 s and 193.8 s.
      unlinkSync(readme);
      let refusals = 0;
      for (let i = 0; i < 3; i++)
        await guard.execute("edit_file", { path: "README.md" }, async () => writeFileSync(readme, README)).catch(() => refusals++);
      const worktree = service.store.state(request.runId).worktree?.path ?? "";
      if (refusals === 3)
        throw new WorkflowFault("INPUT_CHANGED", "Edits to README.md were refused 3 times: File changed outside this attempt", { path: "README.md", refusals, root: worktree, hash: null });
    }
    await guard.execute("edit_file", { path: "README.md" }, async () => writeFileSync(readme, README));
    await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value and README", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "baked-vanished-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  repository(root);
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume" };
  const executor = new VanishingExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const signal = new AbortController().signal;
  const command = (runId: string) => ({ commandId: newId(), expectedRevision: service.store.run(runId).revision });
  /** Drives the run, approving each pending approval, until it stops on something else. */
  const drive = async (runId: string) => {
    let current = await service.drive(runId, signal);
    for (let i = 0; i < 5 && current.status === "waiting"; i++) {
      const request = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
      if (!request) break;
      await service.decide(runId, command(runId), { kind: "approve", requestId: request.id, digest: request.digest });
      current = await service.drive(runId, signal);
    }
    return current;
  };
  return { root, executor, service, policy, drive, command };
}

async function blockedRun(revert: VanishingExecutor["revert"] = null) {
  const fx = setup();
  fx.executor.revert = revert;
  const run = await fx.service.start({ commandId: newId(), featureId: "fixture", workflowId: "quick", prompt: "Create ready value", ownerLabel: "test", policy: fx.policy, executionMode: "worktree" });
  expect(await fx.drive(run.runId)).toMatchObject({ status: "blocked", reason: "input_changed" });
  expect(fx.executor.attempts).toBe(1);
  const worktree = join(fx.root, fx.service.store.state(run.runId).worktree?.path ?? "");
  if (!revert) expect(existsSync(join(worktree, "README.md"))).toBe(false);
  return { ...fx, runId: run.runId, worktree };
}

describe("scenario: a file the run created vanishes from the worktree (#2609)", () => {
  test("resume and --accept-workspace agree: the missing file is the change to accept", async () => {
    const fx = await blockedRun();
    const { service, runId } = fx;
    // The status lists (TUI, desktop) and the accept read the same outside changes.
    expect(await service.outsideChanges(runId)).toEqual([{ path: "README.md", before: null, after: null }]);
    const refused = await service.resume(runId, fx.command(runId)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkflowFault);
    expect((refused as WorkflowFault).code).toBe("STALE_DECISION");
    expectRecovery((refused as WorkflowFault).message, errorRecovery(refused), "accept-workspace");
    // It says what the run wrote, so a person restoring by hand knows what to restore.
    expect((refused as WorkflowFault).message).toContain("The run last wrote README.md with hash");
    expect((refused as WorkflowFault).message).toContain("README.md is missing now");
    expect((refused as WorkflowFault).message).toContain("The run did not keep that content.");
    expect(fx.executor.attempts).toBe(1);
    // The remedy it names works: the missing file is accepted and the task creates it again.
    await service.resume(runId, fx.command(runId), { acceptWorkspace: true });
    const accepted = service.store.artifacts(runId).find((a) => a.logical_path.startsWith("operator/accepted-workspace-"));
    expect(JSON.parse(service.store.readArtifact(runId, accepted?.id ?? "")).changes).toEqual([{ path: "README.md", before: null, after: null }]);
    expect(await fx.drive(runId)).toMatchObject({ status: "completed" });
    expect(fx.executor.attempts).toBe(2);
    expect(readFileSync(join(fx.worktree, "README.md"), "utf8")).toBe(README);
  });

  test("putting back what the run wrote resolves the refusal for a plain resume", async () => {
    const fx = await blockedRun();
    const { service, runId } = fx;
    writeFileSync(join(fx.worktree, "README.md"), README);
    expect(await service.outsideChanges(runId)).toEqual([]);
    await service.resume(runId, fx.command(runId));
    expect(await fx.drive(runId)).toMatchObject({ status: "completed" });
  });

  test("a file the run changed and someone put back to its baseline is accepted the same way", async () => {
    const fx = await blockedRun({ path: "user.txt", original: "original\n" });
    const { service, runId } = fx;
    const baseline = hashBytes("original\n");
    expect(await service.outsideChanges(runId)).toEqual([{ path: "user.txt", before: baseline, after: baseline }]);
    const refused = await service.resume(runId, fx.command(runId)).catch((error: unknown) => error);
    expect((refused as WorkflowFault).code).toBe("STALE_DECISION");
    expect((refused as WorkflowFault).message).toContain(`user.txt now has hash ${baseline.slice(0, 12)}`);
    await service.resume(runId, fx.command(runId), { acceptWorkspace: true });
    expect(await fx.drive(runId)).toMatchObject({ status: "completed" });
    expect(readFileSync(join(fx.worktree, "user.txt"), "utf8")).toBe("original\n");
  });

  test("when the run kept the content it wrote, the refusal names the artifact that prints it", async () => {
    const fx = await blockedRun();
    const { service, runId } = fx;
    // A later edit of the file would keep the run's version as its pre-image.
    const copy = join(fx.root, "kept-readme.txt");
    writeFileSync(copy, README);
    service.store.transaction(() => capturePreImage(service.store, runId, copy));
    const refused = await service.resume(runId, fx.command(runId)).catch((error: unknown) => error);
    const id = /--file ([\w-]+)/.exec((refused as WorkflowFault).message)?.[1] ?? "";
    expect(service.store.readArtifact(runId, id)).toBe(README);
  });
});

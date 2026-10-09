import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { planConsistencyProblems } from "../src/core/workflows/plan-consistency.js";
import { ROLLBACK_ARTIFACT_KIND, type RollbackReport } from "../src/core/workflows/rollback.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const signal = () => new AbortController().signal;
type Fixture = ReturnType<typeof workflowFixture>;

interface Script {
  /** Called after the implementer's edits; returns the outcome or throws to fail the attempt. */
  afterEdits?: (call: number) => "implemented" | "blocked";
  failReview?: (call: number) => boolean;
}

/**
 * T001 modifies usage.txt and creates value.txt through the workflow tool policy, so every edit is
 * journaled with its pre-image exactly as the native agent's edit tool does.
 */
function journaledFixture(script: Script = {}) {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  writeFileSync(join(root, "usage.txt"), "original usage\n");
  const original = executor.execute.bind(executor);
  let implementations = 0;
  let reviews = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "review" && script.failReview?.(reviews++))
      throw new WorkflowFault("OUTPUT_INVALID", "Reviewer unavailable");
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "usage.txt", action: "modify" });
      }
      return out;
    }
    (executor.prompts.implementation ??= []).push(request.prompt);
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    await guard.execute("edit_file", { path: "usage.txt" }, async () => writeFileSync(join(root, "usage.txt"), "usage by the run\n"));
    await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
    const outcome = script.afterEdits?.(implementations++) ?? "implemented";
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome, summary: "Wrote value", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  return fixture;
}

function rollbacks(fixture: Fixture, runId: string): RollbackReport[] {
  return fixture.service.store
    .artifacts(runId)
    .filter((a) => a.kind === ROLLBACK_ARTIFACT_KIND)
    .map((a) => JSON.parse(fixture.service.store.readArtifact(runId, a.id)) as RollbackReport);
}

async function revise(fixture: Fixture, runId: string) {
  const { service } = fixture;
  const candidate = await new WorkflowArtifacts(service).stageRevision(runId, { commandId: newId(), expectedInputHash: (await service.get(runId)).inputHash });
  await service.revise(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, candidate.candidateHash);
}

async function undo(fixture: Fixture, runId: string, paths?: string[]) {
  const { service } = fixture;
  return service.undo(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, paths);
}

async function finish(fixture: Fixture, runId: string) {
  const { service } = fixture;
  for (let i = 0; i < 4 && (await service.get(runId)).status !== "completed"; i++) {
    await fixture.resume(runId);
    await service.drive(runId, signal());
  }
  return service.get(runId);
}

/** Starts a run, approves it and lets T001 implement before a review failure blocks it. */
async function implementedThenBlocked(fixture: Fixture) {
  const { service, root } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "blocked" });
  expect(service.store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("implemented");
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  return run;
}

test("after a revision, a file the run created does not fail plan consistency and the task completes", async () => {
  const fixture = journaledFixture({ failReview: (call) => call === 0 });
  const { service, root } = fixture;
  const run = await implementedThenBlocked(fixture);

  await revise(fixture, run.runId);
  await fixture.resume(run.runId);
  // Before the fix, analysis stopped with "T001 creates value.txt, which already exists; use modify".
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "waiting", reason: "approval" });
  // Executed edits are kept, as the revision design requires.
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  await fixture.approve(run.runId);
  // The repeated task finds its earlier edits in place and may leave them unchanged.
  expect((await finish(fixture, run.runId)).status).toBe("completed");
  const prompt = fixture.executor.prompts.implementation?.at(-1) ?? "";
  expect(prompt).toContain("earlierEdits");
  expect(rollbacks(fixture, run.runId)).toEqual([]);
});

test("undo restores the run's invalidated edits from their pre-images and keeps the run's versions", async () => {
  const fixture = journaledFixture({ failReview: (call) => call === 0 });
  const { service, root } = fixture;
  const run = await implementedThenBlocked(fixture);
  // Committed task edits are part of the baseline: nothing to undo yet.
  await undo(fixture, run.runId);
  expect(rollbacks(fixture, run.runId)).toEqual([]);

  await revise(fixture, run.runId);
  await undo(fixture, run.runId);
  expect(existsSync(join(root, "value.txt"))).toBe(false);
  expect(readFileSync(join(root, "usage.txt"), "utf8")).toBe("original usage\n");
  const [report] = rollbacks(fixture, run.runId);
  expect(report?.kept).toEqual([]);
  expect(report?.restored.map((r) => [r.path, r.to])).toEqual([
    ["usage.txt", hashBytes("original usage\n")],
    ["value.txt", null],
  ]);
  const keptValue = report?.restored.find((r) => r.path === "value.txt")?.keptAs ?? "";
  expect(service.store.readArtifact(run.runId, keptValue)).toBe("ready");
  const restores = service.store.effects(run.runId).filter((e) => JSON.parse(e.intent_json).tool === "rollback");
  expect(restores.map((e) => [JSON.parse(e.intent_json).path, e.status, e.after_hash])).toEqual([
    ["usage.txt", "applied", hashBytes("original usage\n")],
    ["value.txt", "applied", null],
  ]);

  await fixture.resume(run.runId);
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "waiting", reason: "approval" });
  await fixture.approve(run.runId);
  expect((await finish(fixture, run.runId)).status).toBe("completed");
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  // Undone edits are settled; the new attempt's edits are committed and never undone.
  await undo(fixture, run.runId);
  expect(rollbacks(fixture, run.runId)).toHaveLength(1);
});

test("undo never overwrites a change made after the run's last edit", async () => {
  const fixture = journaledFixture({ failReview: (call) => call === 0 });
  const { root } = fixture;
  const run = await implementedThenBlocked(fixture);
  await revise(fixture, run.runId);
  writeFileSync(join(root, "usage.txt"), "edited by the user\n");

  await undo(fixture, run.runId);
  expect(readFileSync(join(root, "usage.txt"), "utf8")).toBe("edited by the user\n");
  expect(existsSync(join(root, "value.txt"))).toBe(false);
  const [report] = rollbacks(fixture, run.runId);
  expect(report?.restored.map((r) => r.path)).toEqual(["value.txt"]);
  expect(report?.kept).toEqual([{ path: "usage.txt", reason: "changed outside the run after its last edit; left as is" }]);
  // The kept file is settled and not reported again.
  await undo(fixture, run.runId);
  expect(rollbacks(fixture, run.runId)).toHaveLength(1);
});

test("undo can be limited to one path", async () => {
  const fixture = journaledFixture({ afterEdits: () => "blocked" });
  const { service, root } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  // A failed attempt keeps its edits until someone asks to undo them.
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  await undo(fixture, run.runId, ["value.txt"]);
  expect(existsSync(join(root, "value.txt"))).toBe(false);
  expect(readFileSync(join(root, "usage.txt"), "utf8")).toBe("usage by the run\n");
});

test("an interrupted attempt's own edits do not block the resumed run as outside changes", async () => {
  const controller = new AbortController();
  const fixture = journaledFixture({
    afterEdits: (call) => {
      if (call === 0) {
        controller.abort(new Error("Ctrl+C"));
        throw new Error("aborted");
      }
      return "implemented";
    },
  });
  const { service, root } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  expect(await service.drive(run.runId, controller.signal)).toMatchObject({ status: "paused" });
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  // Before the fix, resume blocked with "Sources changed outside the active task".
  expect((await finish(fixture, run.runId)).status).toBe("completed");
});

test("an outside change still blocks the run", async () => {
  const controller = new AbortController();
  const fixture = journaledFixture({
    afterEdits: (call) => {
      if (call === 0) {
        controller.abort(new Error("Ctrl+C"));
        throw new Error("aborted");
      }
      return "implemented";
    },
  });
  const { service, root } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, controller.signal);
  writeFileSync(join(root, "value.txt"), "someone else");
  await fixture.resume(run.runId);
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "input_changed" });
});

test("a fork treats a file its parent created as the run's own, not as a create conflict", async () => {
  const fixture = journaledFixture();
  const { service, root } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  expect((await finish(fixture, run.runId)).status).toBe("completed");
  const fork = await service.fork(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision });
  await fixture.resume(fork.runId);
  expect(await service.drive(fork.runId, signal())).toMatchObject({ status: "waiting", reason: "approval" });
  // A file someone else changed afterwards is a real conflict.
  writeFileSync(join(root, "value.txt"), "someone else");
  const graph = service.store.state(fork.runId).graph;
  if (!graph) throw new Error("graph missing");
  expect(planConsistencyProblems(root, fixtureSpec, "", graph)).toContain("T001 creates value.txt, which already exists; use modify");
});

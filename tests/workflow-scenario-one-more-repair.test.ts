import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { canRepairRun } from "../src/core/workflows/repairable.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { builtinPresets, instantiatePreset } from "../src/core/workflows/v2/definitions.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Mode = "task" | "round" | "review" | "cap" | "loop" | "visits" | "fresh";
class ScriptedExecutor extends FixtureExecutor {
  implementations = 0;
  allowRepair = false;
  constructor(private directory: string, private mode: Mode) { super(directory); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "refutation") {
      const data = JSON.parse(request.prompt.split("\n").at(-1)!);
      return { output: { schemaVersion: 1, findingId: data.extra.finding.id, decision: "confirmed", evidenceIds: data.extra.evidence?.map((e: { id: string }) => e.id) ?? [], explanation: "The value is wrong" }, inputTokens: 20, outputTokens: 30 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan" && this.mode === "task") {
      const plan = result.output as { taskGraph: { tasks: { checkIds: string[] }[] } };
      plan.taskGraph.tasks[0]!.checkIds = ["check"];
    }
    if (request.profile.output === "implementation") {
      this.implementations++;
      const broken = this.mode === "visits" ? this.implementations === 1 : !this.allowRepair;
      writeFileSync(join(this.directory, "value.txt"), broken ? `broken-${this.implementations}` : "ready");
    }
    if (request.profile.output === "review" && this.mode === "review" && readFileSync(join(this.directory, "value.txt"), "utf8") !== "ready") {
      const data = JSON.parse(request.prompt.split("\n").at(-1)!) as { snapshotHash: string; extra: { evidence: { id: string }[] } };
      result.output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [], findings: [{
        id: "F001", kind: "correctness", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null,
        evidenceIds: data.extra.evidence.map((e) => e.id), claim: `Value is wrong after attempt ${this.implementations}`, impact: "The required value is absent", suggestedFix: "Write ready",
        repro: { executable: "bun", args: ["-e", "console.log(await Bun.file('value.txt').text())"], expected: "ready", actual: `broken-${this.implementations}` },
      }] };
    }
    return result;
  }
}

async function blocked(mode: Mode) {
  const policy: RunPolicy = { ...fixturePolicy, maxTaskRepairs: 1, maxRepairRounds: mode === "fresh" ? 5 : mode === "review" ? 2 : 1, maxCorrectiveTasks: mode === "cap" ? 1 : 20,
    checks: fixturePolicy.checks.map((c) => ({ ...c, scope: mode === "task" ? "task" : "feature", args: mode === "review" ? ["-e", "process.exit(0)"] : mode === "fresh" ? ["-e", "if (await Bun.file('value.txt').text() !== 'ready') { console.log('value.txt: expected ready'); process.exit(1) }"] : ["-e", "const t = await Bun.file('value.txt').text(); if (t !== 'ready') { console.log('value.txt: expected ready, received ' + t); process.exit(1) }"] })),
  };
  if (mode === "loop" || mode === "cap") policy.maxRepairRounds = 5;
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, mode) });
  cleanups.push(fixture.dispose);
  let workflowId = "sdd";
  if (mode === "review" || mode === "loop" || mode === "visits") {
    const definition = instantiatePreset(structuredClone(builtinPresets.get("standard")!), policy);
    definition.id = "repair-fixture";
    if (mode === "loop") for (const transition of definition.transitions) if (transition.loop) transition.loop.maxIterations = 1;
    if (mode === "visits") definition.limits.maxStageVisits = definition.stages.length;
    mkdirSync(join(fixture.root, "baked", "workflows"), { recursive: true });
    writeFileSync(join(fixture.root, "baked", "workflows", "repair-fixture.json"), JSON.stringify(definition));
    workflowId = definition.id;
  }
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt: "Create ready value", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const stopped = await service.drive(run.runId, new AbortController().signal);
  return { ...fixture, runId: run.runId, stopped };
}

describe("scenario: a person grants one more repair (#1577)", () => {
  test.each([
    ["task", "maxTaskRepairs"], ["round", "maxRepairRounds"], ["review", "maxRepairRounds"],
    ["cap", "maxCorrectiveTasks"], ["loop", "maxIterations"], ["visits", "maxStageVisits"], ["fresh", "freshRestart"],
  ] as const)("%s limit can be raised and the run completes", async (mode, limit) => {
    const { service, runId, stopped, executor } = await blocked(mode);
    expect(stopped.status).toBe("blocked");
    expect(stopped.reason).toBe("no_progress");
    expect(stopped.repairBlock?.limit).toBe(limit);
    expect(canRepairRun(stopped)).toBe(true);
    const before = service.store.state(runId);
    const digest = stopped.approvalDigest;
    const implementations = executor.implementations;
    executor.allowRepair = true;
    const command = { commandId: newId(), expectedRevision: stopped.revision };
    const rounds = mode === "visits" ? 2 : 1;
    const granted = await service.repair(runId, command, rounds);
    expect(granted.status).toBe("paused");
    expect(granted.repairBlock).toBeUndefined();
    expect(granted.approvalDigest).toBe(digest);
    // Replaying a command grants nothing twice, even after the run has moved on.
    expect(await service.repair(runId, command, rounds)).toEqual(granted);
    await expect(service.repair(runId, { commandId: newId(), expectedRevision: stopped.revision })).rejects.toThrow("revision");
    const grants = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("repair-grants/"));
    expect(grants).toHaveLength(1);
    expect(JSON.parse(service.store.readArtifact(runId, grants[0]!.id))).toMatchObject({ approvedBy: "user", rounds, block: { limit } });
    expect(service.store.state(runId).extraConvergenceRounds).toBe(before.extraConvergenceRounds);
    const done = await service.drive(runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(service.workspace, "value.txt"), "utf8")).toBe("ready");
    expect(executor.implementations).toBe(mode === "visits" ? implementations : implementations + 1);
    if (mode === "task") expect(service.store.state(runId).extraTaskRepairs).toEqual({ T001: 1 });
    if (mode === "review") expect(service.store.state(runId).extraReviewRounds).toBe(1);
  }, 60000);

  test("a failed grant after a clean-context repeat stops again after exactly one repair", async () => {
    const { service, runId, stopped, executor } = await blocked("fresh");
    const count = executor.implementations;
    await service.repair(runId, { commandId: newId(), expectedRevision: stopped.revision });
    const again = await service.drive(runId, new AbortController().signal);
    expect(again).toMatchObject({ status: "blocked", reason: "no_progress", repairBlock: { limit: "freshRestart" } });
    expect(executor.implementations).toBe(count + 1);
  }, 60000);

  test("serve repair validates the grant, rejects stale revisions and drives in the background", async () => {
    const { service, runId, stopped, executor } = await blocked("round");
    const server = await startApiServer({ service, pollMs: 20, log: () => {} });
    cleanups.push(() => server.stop());
    const send = (body: unknown) => fetch(`${server.url}/v1/workflow/runs/${runId}/repair`, {
      method: "POST", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await send({ commandId: newId(), expectedRevision: stopped.revision, rounds: 0 })).status).toBe(400);
    expect((await send({ commandId: newId(), expectedRevision: stopped.revision - 1 })).status).toBe(409);
    executor.allowRepair = true;
    expect((await send({ commandId: newId(), expectedRevision: stopped.revision })).status).toBe(200);
    const deadline = Date.now() + 15000;
    while ((await service.get(runId)).status !== "completed" && Date.now() < deadline) await Bun.sleep(25);
    expect((await service.get(runId)).status).toBe("completed");
  }, 60000);

  test("CLI repair drives after the decision", async () => {
    const { service, runId, stopped, executor } = await blocked("round");
    executor.allowRepair = true;
    const done = await executeWorkflowCommand(service, parseWorkflowArgs(["repair", runId, "--expected-revision", String(stopped.revision)]), new AbortController().signal);
    expect(done).toMatchObject({ status: "completed" });
  }, 60000);
});

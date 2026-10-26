import { afterEach, describe, expect, test } from "bun:test";
import { canonical } from "../src/core/specs/hash.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { refreshedGrowth, stageReserveDecision } from "../src/core/workflows/initiatives/growth.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { costGrowthLimit, InitiativeService, type InitiativeView } from "../src/core/workflows/initiatives/service.js";
import { HOST_POOL_GROWTHS } from "../src/core/workflows/initiatives/token-pool.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import type { RecoveryAdvice } from "../src/core/workflows/remedies.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import { stageReserve, stageSuggestedUsd } from "../src/core/workflows/stage-reserve.js";
import { newId } from "../src/core/workflows/store.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2241, R71 xmlvet get-command (quick workflow, $30 cap with the owner's 25 percent tolerance:
// $37.50). T002 overran its price; seven call-growth steps chased the spend to a $1.54 bound, each
// paired with an initiative refresh whose spare was 0: $1.13 was left under the cap and
// cli-release, waiting, had a $3.13 low. At the first review call (a $0.02 call) the run stopped
// "The next model call would pass the run's cost ceiling" with $1.29 spent and both tasks done,
// while the initiative had spent $28.87. An operator extended it to $2.60 25 minutes later and
// the review finished at $1.41, on the critical path: cli-release waited for it.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: R71 get-command's review is paid before cli-release's low (#2241)", () => {
  // The initiative at 06:41:08: get-command open, cli-release waiting with its priced low.
  const r71 = {
    budget: { cost: { capUsd: 30, tolerance: 0.25, ceilingUsd: 37.5, spentUsd: 28.87, reservedUsd: 0.25, remainingUsd: 1.13 } },
    features: [
      { id: "get-command", share: { tokens: 1, calls: 1, activeMs: 1 }, shareUsd: 0.58, needUsd: { low: 0.42, high: 0.77 } },
      { id: "cli-release", share: { tokens: 1, calls: 1, activeMs: 1 }, shareUsd: 3, needUsd: { low: 3.13, high: 5.9 } },
    ],
  } as unknown as InitiativeView;
  const inputs = {
    runId: "c1e5f1b7", featureId: "get-command", stages: ["review", "converge"], stageReserveUsd: 0.3,
    runSpentUsd: 1.29, runReservedUsd: 0, requestedUsd: 0.02, boundUsd: 1.54, runHeldUsd: 1.54,
    spareUsd: costGrowthLimit(r71, "get-command"),
    initiative: { committedUsd: 28.87 + 0.25, capUsd: 30, ceilingUsd: 37.5 },
  };

  test("today's room is 0, so the refresh never raises the bound", () => {
    // $1.13 under the cap less cli-release's $3.13 low.
    expect(costGrowthLimit(r71, "get-command")).toBe(0);
    const policy: RunPolicy = { ...fixturePolicy, maxCostUsd: 1.54, costTolerance: 0.1, sizing: { maxRunTokens: 2_000_000, maxRunCostUsd: 1.54 } };
    const after = refreshedGrowth(policy, { ...fixturePolicy, sizing: { maxRunTokens: 40_000_000 } }, { usd: 1.54, tokens: 2_000_000, calls: 200, activeMs: 3_600_000 }, { calls: 0, activeMs: 0 }, { usd: 0, tokens: null, calls: 0, activeMs: 0 });
    expect(after?.sizing?.maxRunCostUsd ?? 1.54).toBe(1.54);
  });

  test("the remaining review and convergence come before the waiting low, inside the ceiling", () => {
    const decision = stageReserveDecision(inputs);
    expect(decision).toMatchObject({ reason: "stage-reserve", wouldExtend: true, suggestedUsd: 1.59, toUsd: 1.59, byUsd: 0.05 });
    // $28.87 spent plus the open runs held, with get-command held at $1.59 instead of $1.54.
    expect(decision.why).toContain("$29.17 of its $37.50 ceiling");
    expect(Object.keys(HOST_POOL_GROWTHS)).toContain(decision.reason);
  });

  test("a reserve that would pass the ceiling keeps the stop and still names the amount", () => {
    const full = stageReserveDecision({ ...inputs, initiative: { ...inputs.initiative, committedUsd: 37.5 } });
    expect(full).toMatchObject({ wouldExtend: false, toUsd: null, suggestedUsd: 1.59 });
    expect(full.why).toContain("above its $37.50 ceiling");
    // A bound that already pays for the stages needs no growth.
    expect(stageReserveDecision({ ...inputs, boundUsd: 2.6 }).wouldExtend).toBe(false);
    // A call larger than the stage reserve is paid in full.
    expect(stageReserveDecision({ ...inputs, requestedUsd: 0.5 }).suggestedUsd).toBe(1.79);
  });
});

const MODEL = "anthropic/claude-sonnet-4-6";
const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `src/${id}.ts`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });
const usage = (tokens: number): AttemptUsageRecord => ({
  schemaVersion: 1, profileId: "implementer", taskId: null, maxSteps: 10, maxTokens: 20_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: tokens,
  steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
});

const plan: InitiativePlan = {
  schemaVersion: 1, title: "xmlvet", goals: ["Ship xmlvet"], completionCriteria: ["xmlvet is released"],
  features: ["get-command", "cli-release", "docs"].map((id) => ({
    id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`, dependsOn: [], mandatory: true,
  })),
};

/**
 * get-command at its last task's end: both tasks implemented, $1.29 spent at the model's price, its
 * cap and bound chased to $1.30, and the initiative's cap lowered so that $1.13 is left under it,
 * below the waiting features' lows: the room `costGrowthLimit` gives the run is 0, as in R71.
 */
async function lastTaskEnd(mode: "shadow" | "on" | undefined, tolerance: number) {
  const fixture = workflowFixture();
  fixture.config.defaultModel = MODEL;
  if (mode) (fixture.config.workflows as Record<string, unknown>).stageReserve = mode;
  cleanups.push(fixture.dispose);
  const initiatives = new InitiativeService(fixture.service);
  const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 10_000_000, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: 50_000_000, maxRunCostUsd: 100 } };
  const view = await initiatives.start({ commandId: newId(), initiativeId: "xmlvet", prompt: "Ship xmlvet", plan, policy, model: MODEL, ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 }, costBudget: { maxCostUsd: 30, costTolerance: tolerance } });
  const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
  await initiatives.approve("xmlvet", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
  const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean> };
  expect(await service.startFeature("xmlvet", "get-command")).toBe(true);
  const runId = initiatives.view("xmlvet").features.find((f) => f.id === "get-command")!.runId!;
  const store = fixture.service.store;
  store.transaction(() => store.syncTasks(runId, { schemaVersion: 1, featureId: "get-command", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task("T001"), task("T002")] }));
  const implement = store.beginStep(runId, "implement");
  const spend = (tokens: number) => {
    const attempt = store.reserve(runId, implement, MODEL, 1000, { ...policy, maxCostUsd: null });
    store.transaction(() => {
      store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(tokens)));
      store.finishAttempt(runId, attempt, "completed", tokens);
    });
  };
  spend(100_000);
  const perToken = store.costUsage(runId).spentUsd / 100_000;
  spend(Math.round(1.29 / perToken) - 100_000);
  for (const id of ["T001", "T002"]) store.transaction(() => store.taskStatus(runId, id, "implemented"));
  const started = JSON.parse(store.run(runId).policy_json) as RunPolicy;
  const chased: RunPolicy = { ...started, maxCostUsd: 1.3, costTolerance: "off", sizing: { ...started.sizing, maxRunCostUsd: 1.3 } };
  store.setPolicy(runId, chased);
  // Leave $1.13 under the cap after what the initiative holds.
  const held = initiatives.view("xmlvet").budget.cost;
  const db = store.connection;
  const row = db.query("SELECT settings_json FROM initiatives WHERE id='xmlvet'").get() as { settings_json: string };
  const settings = JSON.parse(row.settings_json);
  settings.costBudget.maxCostUsd = Math.round((held.spentUsd + held.reservedUsd + 1.13) * 100) / 100;
  db.run("UPDATE initiatives SET settings_json=? WHERE id='xmlvet'", [JSON.stringify(settings)]);
  const before = initiatives.view("xmlvet");
  const lows = before.features.filter((f) => f.id !== "get-command").reduce((sum, f) => sum + (f.needUsd?.low ?? f.shareUsd ?? 0), 0);
  expect(lows).toBeGreaterThan(1.13);
  expect(costGrowthLimit(before, "get-command")).toBe(0);
  const review = store.beginStep(runId, "review");
  // The first review call: $0.02 at the model's price.
  const call = () => store.reserve(runId, review, MODEL, Math.round(0.02 / perToken), JSON.parse(store.run(runId).policy_json) as RunPolicy);
  return { fixture, initiatives, store, runId, call, chased, perToken };
}

const extendEvents = (initiatives: InitiativeService) =>
  initiatives.events("xmlvet").filter((e) => e.type === "decision.would_extend").map((e) => e.payload as { reason: string; mode: string; runId: string; toUsd: number; suggestedUsd: number; summary: string; inputs: Record<string, unknown> });

function stopOf(call: () => string): WorkflowFault {
  try {
    call();
  } catch (error) {
    if (error instanceof WorkflowFault) return error;
    throw error;
  }
  throw new Error("The call did not stop");
}

describe("scenario: a started run past its tasks reserves its review and convergence (#2241)", () => {
  test("shadow, the default, records the growth with its inputs and the run still stops, naming the amount", async () => {
    const { initiatives, store, runId, call, chased } = await lastTaskEnd(undefined, 0.25);
    const reserve = stageReserve(store, runId, chased)!;
    expect(reserve.stages).toContain("review");
    expect(reserve.usd).toBeGreaterThan(0);
    const stop = stopOf(call);
    expect(stop.code).toBe("BUDGET_EXHAUSTED");
    expect(stop.message).toBe("The next model call would pass the run's cost cap");
    const [extend] = extendEvents(initiatives);
    expect(extend).toMatchObject({ reason: "stage-reserve", mode: "shadow", runId, inputs: { featureId: "get-command", boundUsd: 1.3, spareUsd: 0, initiative: { ceilingUsd: expect.any(Number) } } });
    expect(Object.keys(HOST_POOL_GROWTHS)).toContain(extend!.reason);
    expect(extend!.toUsd).toBe(stageSuggestedUsd(reserve, 0));
    // The stored bound is unchanged in shadow.
    expect((JSON.parse(store.run(runId).policy_json) as RunPolicy).sizing?.maxRunCostUsd).toBe(1.3);
    // The block's extend remedy names spent plus the stage reserve (#2042's one-command answer).
    const recovery = stop.details.recovery as RecoveryAdvice;
    expect(recovery.remedies).toEqual([{ action: "extend", runId, suggestedUsd: extend!.suggestedUsd }]);
    expect(recovery.message).toContain(`baked workflow extend ${runId} --cost-usd ${extend!.suggestedUsd}`);
    // Once per bound: the next stop records nothing new.
    stopOf(call);
    expect(extendEvents(initiatives)).toHaveLength(1);
  }, 120_000);

  test("on grows the bound to the stages' need and the review call continues", async () => {
    const { initiatives, store, runId, call } = await lastTaskEnd("on", 0.25);
    expect(() => call()).not.toThrow();
    const stored = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    expect(stored.sizing!.maxRunCostUsd!).toBeGreaterThan(1.3);
    expect(stored.maxCostUsd!).toBeGreaterThan(1.3);
    const revision = store.artifacts(runId).filter((a) => a.logical_path.startsWith("policy-revisions/initiative-")).map((a) => JSON.parse(store.readArtifact(runId, a.id))).at(-1);
    expect(revision).toMatchObject({ kind: "stage-reserve", approvedBy: "sizing", previous: { sizing: { maxRunCostUsd: 1.3 } }, inputs: { featureId: "get-command", spareUsd: 0 } });
    expect(extendEvents(initiatives)).toEqual([]);
  }, 120_000);

  test("a reserve past the initiative's ceiling keeps the stop, records nothing, and the block names the amount", async () => {
    const { initiatives, store, runId, call, chased } = await lastTaskEnd("on", 0);
    // No tolerance, and the cap lowered to a cent above what the initiative holds: the stages do
    // not fit under the ceiling.
    const db = store.connection;
    const row = db.query("SELECT settings_json FROM initiatives WHERE id='xmlvet'").get() as { settings_json: string };
    const settings = JSON.parse(row.settings_json);
    const cost = initiatives.view("xmlvet").budget.cost;
    settings.costBudget.maxCostUsd = Math.round((cost.spentUsd + cost.reservedUsd + 0.01) * 100) / 100;
    db.run("UPDATE initiatives SET settings_json=? WHERE id='xmlvet'", [JSON.stringify(settings)]);
    const stop = stopOf(call);
    expect(extendEvents(initiatives)).toEqual([]);
    expect((JSON.parse(store.run(runId).policy_json) as RunPolicy).sizing?.maxRunCostUsd).toBe(1.3);
    const reserve = stageReserve(store, runId, chased)!;
    expect((stop.details.recovery as RecoveryAdvice).remedies[0]).toMatchObject({ action: "extend", runId, suggestedUsd: stageSuggestedUsd(reserve, 0) });
  }, 120_000);

  test("a workflow service no initiative service was made for grows the bound at the stop (headless)", async () => {
    const { fixture, runId, chased, perToken } = await lastTaskEnd("on", 0.25);
    const headless = new NativeWorkflowService(fixture.root, fixture.config, fixture.executor);
    cleanups.push(async () => { await headless.shutdown(); headless.close(); });
    const review = headless.store.steps(runId).find((s) => s.stage_id === "review")!.id;
    expect(() => headless.store.reserve(runId, review, MODEL, Math.round(0.02 / perToken), structuredClone(chased))).not.toThrow();
    expect((JSON.parse(headless.store.run(runId).policy_json) as RunPolicy).sizing!.maxRunCostUsd!).toBeGreaterThan(1.3);
  }, 120_000);

  test("off records nothing and the stop stands", async () => {
    const { initiatives, call } = await lastTaskEnd(undefined, 0.25);
    const fixtureConfig = (initiatives as unknown as { workflows: { config: { workflows: Record<string, unknown> } } }).workflows.config.workflows;
    fixtureConfig.stageReserve = "off";
    stopOf(call);
    expect(extendEvents(initiatives)).toEqual([]);
  }, 120_000);
});

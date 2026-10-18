import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { budgetLimitText, canExtend } from "../src/components/workflow/format.js";
import { costRate, growBudgetOnProgress, remainingCostRate } from "../src/core/workflows/budget.js";
import { featurePolicy, type InitiativeSettings } from "../src/core/workflows/initiatives/service.js";
import { assertForecastFits, costForecast, forecastProgress } from "../src/core/workflows/cost-forecast.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { verificationTokens } from "../src/core/workflows/sizing.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 28, cfgtrace b4427c85 (#1246). Sizing priced the plan's test tasks at
// about 250k tokens each; the first ones used 550k to 1.47M. The run spent $5.62 at 5.99M tokens
// with 7 of 23 tasks done, went on through four extensions and stopped at $11.92 of its $12 cap
// with 2 tasks unfinished and the review never started: from about $5.60 it could not finish.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;
const SPENT_TOKENS = 5_990_000;
// The run's spend priced at the test model; the cap keeps cfgtrace's ratio of $12 to $5.62.
const CAP = Math.round(SPENT_TOKENS * INPUT * (12 / 5.62) * 100) / 100;
const PRICE = { low: 200_000, high: 300_000 };

function usage(input: number, cacheRead = 0): AttemptUsageRecord {
  return {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 20_000_000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: input,
    steps: [{ step: 1, inputTokens: input, outputTokens: 0, cacheReadTokens: cacheRead, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
  };
}

const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `tests/${id}.test.ts`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });

function spend(store: WorkflowStore, runId: string, stage: string, policy: RunPolicy, tokens: number, cacheRead = 0) {
  const stepId = store.beginStep(runId, stage);
  const attempt = store.reserve(runId, stepId, MODEL, 1000, policy);
  store.transaction(() => {
    store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(tokens, cacheRead)));
    store.finishAttempt(runId, attempt, "completed", tokens);
  });
}

/** cfgtrace at $5.62: planning spent, 7 of 23 test tasks done, each over its price. */
async function midRun(options: { perTask: number[]; costForecast?: "ask" | "off"; taskCacheShare?: number; policy?: Partial<RunPolicy> }) {
  const policy: RunPolicy = { ...fixturePolicy, maxAgentCalls: 1000, maxTotalTokens: 16_000_000, maxCostUsd: CAP, ...(options.costForecast ? { costForecast: options.costForecast } : {}), ...options.policy };
  // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
  const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
  cleanups.push(made.dispose);
  const { store } = made.service;
  const run = await made.start();
  const { runId } = run;
  store.transaction(() => store.transition(runId, "running"));
  store.setPolicy(runId, policy);
  const tasks = Array.from({ length: 23 }, (_, i) => task(`T${String(i + 1).padStart(3, "0")}`));
  store.transaction(() =>
    store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks }),
  );
  store.artifact(
    runId,
    "sizing",
    "sizing/plan-0.json",
    canonical({ schemaVersion: 3, model: MODEL, tasks: tasks.map((t) => ({ taskId: t.id, kind: "test", files: 1, estimate: PRICE, attemptTokens: 300_000, attemptSteps: null, oversized: false })) }),
  );
  const done = options.perTask.reduce((sum, n) => sum + n, 0);
  spend(store, runId, "plan", policy, SPENT_TOKENS - done);
  options.perTask.forEach((tokens, i) => {
    const id = tasks[i]?.id ?? "";
    spend(store, runId, `task-${id}`, policy, tokens, Math.round(tokens * (options.taskCacheShare ?? 0)));
    store.transaction(() => store.taskStatus(runId, id, "implemented"));
  });
  /** Finishes one more planned task that used this many tokens. */
  const stage = (id: string, tokens: number) => {
    spend(store, runId, `task-${id}`, policy, tokens);
    store.transaction(() => store.taskStatus(runId, id, "implemented"));
  };
  return { store, runId, policy, service: made.service, stage };
}

const OVER = [550_000, 820_000, 1_470_000, 640_000, 910_000, 700_000, 600_000];

describe("scenario: cfgtrace b4427c85, a forecast past the dollar cap stops the run while the money is unspent (#1246)", () => {
  test("the run stops on its budget with the forecast, about half the cap still unspent", async () => {
    const { store, runId, policy } = await midRun({ perTask: OVER });
    let fault: unknown;
    try {
      assertForecastFits(store, runId, policy);
    } catch (error) {
      fault = error;
    }
    expect(fault).toBeInstanceOf(WorkflowFault);
    const details = (fault as WorkflowFault).details as Record<string, number | string>;
    expect((fault as WorkflowFault).code).toBe("BUDGET_EXHAUSTED");
    expect(details).toMatchObject({ reason: "cost-forecast", capUsd: CAP, measuredTasks: 7, openTasks: 16 });
    expect(Number(details.projectedUsd)).toBeGreaterThan(CAP * 1.4);
    expect(Number(details.spentUsd)).toBeLessThan(CAP / 2);
    expect((fault as WorkflowFault).message).toContain("Extend the run with a cap of at least");
    expect(store.artifacts(runId).filter((a) => a.kind === "cost-forecast")).toHaveLength(1);
  });

  test("a cap is asked about once: resumed at the same cap the run goes on", async () => {
    const { store, runId, policy } = await midRun({ perTask: OVER });
    expect(() => assertForecastFits(store, runId, policy)).toThrow();
    expect(() => assertForecastFits(store, runId, policy)).not.toThrow();
    // A higher cap that the forecast still passes is asked about again.
    const raised = { ...policy, maxCostUsd: CAP * 1.5 };
    store.setPolicy(runId, raised);
    expect(() => assertForecastFits(store, runId, raised)).toThrow();
    const enough = { ...policy, maxCostUsd: CAP * 4 };
    store.setPolicy(runId, enough);
    expect(() => assertForecastFits(store, runId, enough)).not.toThrow();
  });

  // Edge of #1363 (#1433): the host grows a feature's cap with its tokens. The person answered the
  // stop at the old cap, so a cap the host grew since then is not asked about again.
  test("a cap the host grew after the stop is not asked about again", async () => {
    const { store, runId, policy } = await midRun({ perTask: OVER });
    // A bound the forecast cannot reach, so the forecast stops instead of growing the cap (#1503).
    const live: RunPolicy = { ...policy, sizing: { maxRunTokens: 17_000_000, maxRunCostUsd: CAP * 1.05 } };
    store.setPolicy(runId, live);
    expect(() => assertForecastFits(store, runId, live)).toThrow();
    expect(growBudgetOnProgress(store, runId, live, 16_500_000)).toBe(true);
    expect(live.maxCostUsd).toBeGreaterThan(CAP);
    expect(costForecast(store, runId, live)?.projectedUsd).toBeGreaterThan(live.maxCostUsd ?? 0);
    expect(() => assertForecastFits(store, runId, live)).not.toThrow();
    expect(store.artifacts(runId).filter((a) => a.kind === "cost-forecast")).toHaveLength(1);
    // A cap a person raises is still asked about.
    const raised = { ...live, maxCostUsd: (live.maxCostUsd ?? 0) * 1.2 };
    store.setPolicy(runId, raised);
    expect(() => assertForecastFits(store, runId, raised)).toThrow();
  });

  test("tasks on their price leave a forecast inside the cap", async () => {
    const { store, runId, policy } = await midRun({ perTask: Array(7).fill(250_000) });
    expect(() => assertForecastFits(store, runId, policy)).not.toThrow();
    expect(costForecast(store, runId, policy)?.projectedUsd).toBeLessThan(CAP);
  });

  test("`costForecast: off` spends to the cap as before", async () => {
    const { store, runId, policy } = await midRun({ perTask: OVER, costForecast: "off" });
    expect(() => assertForecastFits(store, runId, policy)).not.toThrow();
  });

  test("too few finished tasks give no forecast", async () => {
    const { store, runId, policy } = await midRun({ perTask: OVER.slice(0, 2) });
    expect(costForecast(store, runId, policy)).toBeNull();
  });

  test("the run screen names the forecast, and extending raises the cap to go on", async () => {
    const { store, runId, policy, service } = await midRun({ perTask: OVER });
    let message = "";
    try {
      assertForecastFits(store, runId, policy);
    } catch (error) {
      message = (error as Error).message;
    }
    // What the scheduler records when the fault stops the run.
    store.transaction(() => {
      store.artifact(runId, "diagnostic", `errors/${newId()}.txt`, message);
      store.transition(runId, "blocked", "budget_exhausted");
    });
    const view = readWorkflowView(service, runId).budget;
    expect(view.cost?.forecastUsd).toBeGreaterThan(CAP);
    expect(budgetLimitText(view)).toContain("forecast to cost about");
    expect(canExtend(view)).toBe(true);
    const extended = await service.extendBudget(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision });
    expect(extended.maxCostUsd).toBe(CAP * 2);
  });

  // Bench round 30 (#1246 follow-up): no run recorded any forecast, because only a stop wrote one.
  test("a forecast that does not stop the run is kept once per finished task count and reported", async () => {
    const { store, runId, policy, stage } = await midRun({ perTask: Array(7).fill(250_000) });
    assertForecastFits(store, runId, policy);
    assertForecastFits(store, runId, policy);
    expect(forecastProgress(store, runId)).toHaveLength(1);
    expect(forecastProgress(store, runId)[0]).toMatchObject({ measuredTasks: 7, openTasks: 16, capUsd: CAP });
    stage("T008", 250_000);
    assertForecastFits(store, runId, policy);
    expect(forecastProgress(store, runId).map((f) => f.measuredTasks)).toEqual([7, 8]);
    expect(runReport(store, runId)).toMatch(/Cost forecast: about \$[\d.]+ at 7 finished tasks .*, then about \$[\d.]+ at 8 finished tasks .*it did not stop the run\./);
  });

  test("`costForecast: off` records no forecast", async () => {
    const { store, runId, policy } = await midRun({ perTask: OVER, costForecast: "off" });
    assertForecastFits(store, runId, policy);
    expect(forecastProgress(store, runId)).toHaveLength(0);
    expect(runReport(store, runId)).not.toContain("Cost forecast");
  });
});

// Bench round 42, fecsmith front (#1503): under `--budget-usd 30` with a base policy cap of $8,
// the feature's dollar share (about $9.8) and the dollars it could grow into (about $19) were both
// clipped to $8. After five tasks over their price the forecast ($11.88) passed the $9.20 ceiling
// and the run stopped for a person with $21 of the initiative unspent; it finished at $9.03.
describe("scenario: an initiative feature's dollar cap under a dollar budget (#1503, R42)", () => {
  const BASE = Math.round(CAP * 0.8 * 100) / 100;
  // Dollar amounts in whole cents, as the initiative computes them.
  const SHARE = Math.floor(CAP);
  const ROOM = Math.floor(CAP * 4);
  const SHORT = Math.floor(CAP * 1.1);
  const settings = {
    basePolicy: { ...fixturePolicy, maxCostUsd: BASE, sizing: { maxRunTokens: 50_000_000 } },
    costBudget: { maxCostUsd: CAP * 4, costTolerance: "auto" },
    featureAutoApproval: null,
  } as unknown as InitiativeSettings;
  const front = { id: "front", title: "front", boundary: { scope: "front", paths: ["src/front.ts"] }, contract: "front", dependsOn: [], mandatory: true };
  const share = { tokens: 16_000_000, calls: 1000, activeMs: 3_600_000 };
  const policyOf = (growUsd: number, humanOnly = false) => featurePolicy(settings, share, front, humanOnly, 17_000_000, SHARE, growUsd);

  test("the feature's cap is its share and may grow into the initiative's spare dollars, past the base cap", () => {
    for (const humanOnly of [false, true]) {
      const policy = policyOf(ROOM, humanOnly);
      expect(policy.maxCostUsd).toBe(SHARE);
      expect(policy.sizing?.maxRunCostUsd).toBe(ROOM);
    }
    // A share below the base cap stays the cap; a run without a dollar budget keeps the base cap.
    expect(featurePolicy(settings, share, front, false, 17_000_000, 3, CAP * 4).maxCostUsd).toBe(3);
    expect(featurePolicy({ ...settings, costBudget: null } as unknown as InitiativeSettings, share, front, false, 17_000_000, null, null).maxCostUsd).toBe(BASE);
  });

  test("a forecast over the cap that the spare dollars cover grows the cap instead of stopping", async () => {
    const feature = policyOf(ROOM);
    const { store, runId, policy } = await midRun({
      perTask: OVER,
      policy: { maxCostUsd: feature.maxCostUsd, costTolerance: feature.costTolerance, ...(feature.sizing ? { sizing: feature.sizing } : {}) },
    });
    const before = costForecast(store, runId, policy);
    expect(before?.projectedUsd).toBeGreaterThan(before?.ceilingUsd ?? Infinity);
    expect(() => assertForecastFits(store, runId, policy)).not.toThrow();
    expect(policy.maxCostUsd).toBeGreaterThan(SHARE);
    const after = costForecast(store, runId, policy);
    expect(after?.projectedUsd).toBeLessThanOrEqual(after?.ceilingUsd ?? 0);
    const revision = store.artifacts(runId).find((a) => a.kind === "policy-revision");
    expect(JSON.parse(store.readArtifact(runId, revision?.id ?? ""))).toMatchObject({
      kind: "forecast-growth",
      approvedBy: "sizing",
      previous: { maxCostUsd: SHARE },
      next: { maxCostUsd: policy.maxCostUsd },
    });
    expect(store.artifacts(runId).filter((a) => a.kind === "cost-forecast")).toHaveLength(0);
  });

  test("a forecast the spare dollars cannot cover still stops, naming what the initiative can spare", async () => {
    const feature = policyOf(SHORT);
    const { store, runId, policy } = await midRun({
      perTask: OVER,
      policy: { maxCostUsd: feature.maxCostUsd, costTolerance: feature.costTolerance, ...(feature.sizing ? { sizing: feature.sizing } : {}) },
    });
    expect(() => assertForecastFits(store, runId, policy)).toThrow(`The initiative can spare up to $${SHORT.toFixed(2)} for this run`);
    expect(policy.maxCostUsd).toBe(SHARE);
  });
});

// fecsmith front, bench round 42 (#1505): planning paid $1.91 per million tokens, the task attempts
// $0.79 (mostly cache reads). The forecast priced the 9.19M tokens left at the blended $0.965 and
// read $11.88; the run finished at $9.03.
describe("scenario: fecsmith front, the forecast prices the tokens left at the task price (#1505)", () => {
  test("open tasks are priced at what the finished tasks paid, not the blended price with planning", async () => {
    const { store, runId, policy } = await midRun({ perTask: OVER, taskCacheShare: 0.8 });
    const forecast = costForecast(store, runId, policy);
    if (!forecast) throw new Error("no forecast");
    const blended = costRate(forecast.spentUsd, store.run(runId).token_usage, null);
    const taskRate = remainingCostRate(store, runId);
    // The task attempts paid less per token than the run as a whole, planning included.
    expect(taskRate).toBeLessThan(blended);
    const taskTokens = forecast.remainingTokens - verificationTokens();
    expect(forecast.projectedUsd).toBeCloseTo(forecast.spentUsd + taskTokens * taskRate + verificationTokens() * blended, 6);
    // The old rule priced every token left at the blended price.
    expect(forecast.projectedUsd).toBeLessThan(forecast.spentUsd + forecast.remainingTokens * blended);
  });

  test("before a task attempt is priced, the blended price stands in", async () => {
    const { store, runId } = await midRun({ perTask: [] });
    const { spentUsd } = store.costUsage(runId);
    expect(remainingCostRate(store, runId)).toBeCloseTo(costRate(spentUsd, store.run(runId).token_usage, null), 12);
  });

  test("a dearer later task raises the task price, so the forecast follows it", async () => {
    const { store, runId, policy, stage } = await midRun({ perTask: OVER, taskCacheShare: 0.8 });
    const before = remainingCostRate(store, runId);
    // A corrective on the same model without cache: every token at the input price.
    stage("T008", 900_000);
    expect(remainingCostRate(store, runId)).toBeGreaterThan(before);
    expect(costForecast(store, runId, policy)).not.toBeNull();
  });
});


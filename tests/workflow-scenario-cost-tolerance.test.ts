import { afterEach, describe, expect, test } from "bun:test";
import { budgetLimitText } from "../src/components/workflow/format.js";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertForecastFits, costForecast } from "../src/core/workflows/cost-forecast.js";
import {
  autoCostTolerance,
  costCeilingUsd,
  costToleranceOf,
  inCostWrapUp,
} from "../src/core/workflows/cost-tolerance.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { PolicySchema, type RunPolicy, type Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 28, cfgtrace b4427c85 (#1263): 26 planned tasks, priced 2-3x too low.
// The run spent to $11.92 of its $12 cap, the next attempt did not fit, and it stopped with two
// tasks and the final review left; the whole run needed about $14. With `costTolerance: "auto"`
// the cap is a soft target and the run may finish up to the ceiling (25% for 26 tasks).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;
const SPENT_TOKENS = 14_170_000;
// cfgtrace's $11.92 of $12: the spend is 99.3% of the cap.
const CAP = Math.round(((SPENT_TOKENS * INPUT) / (11.92 / 12)) * 100) / 100;
const PRICE = { low: 200_000, high: 300_000 };
const NEXT_ATTEMPT = 600_000;

function usage(input: number): AttemptUsageRecord {
  return {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 20_000_000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: input,
    steps: [{ step: 1, inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
  };
}

const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `tests/${id}.test.ts`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });

function spend(store: WorkflowStore, runId: string, stage: string, policy: RunPolicy, tokens: number) {
  const stepId = store.beginStep(runId, stage);
  const attempt = store.reserve(runId, stepId, MODEL, 1000, policy);
  store.transaction(() => {
    store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(tokens)));
    store.finishAttempt(runId, attempt, "completed", tokens);
  });
}

/** A run of `planned` sized tasks with the first `perTask.length` done and `spent` tokens in all. */
async function run(options: { planned: number; perTask: number[]; spent: number; cap: number; costTolerance?: RunPolicy["costTolerance"] }) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    maxAgentCalls: 1000,
    maxTotalTokens: 40_000_000,
    maxCostUsd: options.cap,
    ...(options.costTolerance === undefined ? {} : { costTolerance: options.costTolerance }),
  };
  // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
  const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
  cleanups.push(made.dispose);
  const { store } = made.service;
  const { runId } = await made.start();
  store.transaction(() => store.transition(runId, "running"));
  store.setPolicy(runId, policy);
  const tasks = Array.from({ length: options.planned }, (_, i) => task(`T${String(i + 1).padStart(3, "0")}`));
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
  spend(store, runId, "plan", policy, options.spent - done);
  options.perTask.forEach((tokens, i) => {
    const id = tasks[i]?.id ?? "";
    spend(store, runId, `task-${id}`, policy, tokens);
    store.transaction(() => store.taskStatus(runId, id, "implemented"));
  });
  return { store, runId, policy, service: made.service };
}

/** cfgtrace at $11.92 of $12: 24 of 26 tasks done. */
const atTheCap = (costTolerance?: RunPolicy["costTolerance"]) =>
  run({ planned: 26, perTask: Array(24).fill(400_000), spent: SPENT_TOKENS, cap: CAP, costTolerance });

function faultOf(fn: () => unknown): WorkflowFault | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof WorkflowFault) return error;
    throw error;
  }
  return null;
}

describe("scenario: cfgtrace b4427c85, a run priced too low finishes inside its cost tolerance (#1263)", () => {
  test("without a tolerance the next attempt does not fit the cap and the run stops", async () => {
    const { store, runId, policy } = await atTheCap();
    const fault = faultOf(() => store.reserve(runId, store.beginStep(runId, "task-T025"), MODEL, NEXT_ATTEMPT, policy));
    expect(fault?.code).toBe("BUDGET_EXHAUSTED");
    expect(fault?.message).toBe("The next model call would pass the run's cost cap");
    expect(costCeilingUsd(store, runId, policy)).toBe(CAP);
  });

  test("with `costTolerance: auto` the attempt fits under the ceiling and the run winds up", async () => {
    const { store, runId, policy, service } = await atTheCap("auto");
    expect(costToleranceOf(store, runId, policy)).toBe(0.25);
    expect(costCeilingUsd(store, runId, policy)).toBeCloseTo(CAP * 1.25, 1);
    const attempt = store.reserve(runId, store.beginStep(runId, "task-T025"), MODEL, NEXT_ATTEMPT, policy);
    expect(attempt).toBeTruthy();
    // Spent and reserved are now past the soft cap: only serious findings start repairs.
    expect(inCostWrapUp(store, runId, policy)).toBe(true);
    const view = readWorkflowView(service, runId).budget;
    expect(view.cost?.ceilingUsd).toBeCloseTo(CAP * 1.25, 1);
    expect(view.cost?.wrapUp).toBe(true);
    expect(store.snapshot(runId).costCeilingUsd).toBeCloseTo(CAP * 1.25, 1);
  });

  test("the ceiling is still a hard stop", async () => {
    const { store, runId, policy } = await atTheCap(0.05);
    const tokens = Math.ceil((CAP * 1.06) / INPUT) - SPENT_TOKENS;
    const fault = faultOf(() => store.reserve(runId, store.beginStep(runId, "task-T025"), MODEL, tokens, policy));
    expect(fault?.code).toBe("BUDGET_EXHAUSTED");
    expect(fault?.message).toContain("cost ceiling");
    expect(fault?.details).toMatchObject({ reason: "cost", maxCostUsd: CAP });
  });

  test("a forecast past the cap but inside the ceiling does not stop the run for a decision", async () => {
    const perTask = [330_000, 300_000, 360_000, 280_000, 350_000, 310_000, 320_000];
    const spent = 5_990_000;
    // Measure the forecast once, then put the cap 10% below it.
    const probe = await run({ planned: 23, perTask, spent, cap: 1000 });
    const projected = costForecast(probe.store, probe.runId, probe.policy)?.projectedUsd ?? 0;
    expect(projected).toBeGreaterThan(0);
    const cap = Math.round((projected / 1.1) * 100) / 100;

    const strict = await run({ planned: 23, perTask, spent, cap });
    expect(faultOf(() => assertForecastFits(strict.store, strict.runId, strict.policy))?.details).toMatchObject({ reason: "cost-forecast" });

    // 23 planned tasks: a 20% band, the forecast fits it.
    const tolerant = await run({ planned: 23, perTask, spent, cap, costTolerance: "auto" });
    expect(faultOf(() => assertForecastFits(tolerant.store, tolerant.runId, tolerant.policy))).toBeNull();
    expect(costForecast(tolerant.store, tolerant.runId, tolerant.policy)?.ceilingUsd).toBeCloseTo(cap * 1.2, 1);
  });

  test("a forecast past the ceiling stops with the ceiling named", async () => {
    const perTask = [550_000, 820_000, 1_470_000, 640_000, 910_000, 700_000, 600_000];
    const capped = await run({ planned: 23, perTask, spent: 5_990_000, cap: Math.round(5_990_000 * INPUT * (12 / 5.62) * 100) / 100, costTolerance: "auto" });
    const message = faultOf(() => assertForecastFits(capped.store, capped.runId, capped.policy))?.message ?? "";
    expect(message).toContain("ceiling (the $");
    // What the scheduler records when the fault stops the run.
    capped.store.transaction(() => {
      capped.store.artifact(capped.runId, "diagnostic", `errors/${newId()}.txt`, message);
      capped.store.transition(capped.runId, "blocked", "budget_exhausted");
    });
    const view = readWorkflowView(capped.service, capped.runId).budget;
    expect(budgetLimitText(view)).toContain("ceiling (the $");
  });
});

describe("cost tolerance policy", () => {
  test("auto widens with the plan: 10% to 30%", () => {
    expect([1, 8, 9, 16, 17, 24, 25, 32, 33, 80].map(autoCostTolerance)).toEqual([0.1, 0.1, 0.15, 0.15, 0.2, 0.2, 0.25, 0.25, 0.3, 0.3]);
  });

  test("the setting is optional and bounded", () => {
    const base = PolicySchema.parse(fixturePolicy);
    expect(base.costTolerance).toBeUndefined();
    expect(PolicySchema.parse({ ...fixturePolicy, costTolerance: "auto" }).costTolerance).toBe("auto");
    expect(PolicySchema.parse({ ...fixturePolicy, costTolerance: 0.3 }).costTolerance).toBe(0.3);
    expect(() => PolicySchema.parse({ ...fixturePolicy, costTolerance: 0.8 })).toThrow();
  });

  test("off by default, and nothing without a cap", async () => {
    const { store, runId, policy } = await atTheCap();
    expect(costToleranceOf(store, runId, policy)).toBe(0);
    expect(inCostWrapUp(store, runId, policy)).toBe(false);
    const uncapped = { ...policy, maxCostUsd: null, costTolerance: "auto" as const };
    expect(costCeilingUsd(store, runId, uncapped)).toBeNull();
    expect(store.snapshot(runId).costCeilingUsd).toBeUndefined();
  });
});

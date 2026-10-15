import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { budgetLimitText, canExtend } from "../src/components/workflow/format.js";
import { assertForecastFits, costForecast, forecastProgress } from "../src/core/workflows/cost-forecast.js";
import { runReport } from "../src/core/workflows/run-report.js";
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

/** cfgtrace at $5.62: planning spent, 7 of 23 test tasks done, each over its price. */
async function midRun(options: { perTask: number[]; costForecast?: "ask" | "off" }) {
  const policy: RunPolicy = { ...fixturePolicy, maxAgentCalls: 1000, maxTotalTokens: 16_000_000, maxCostUsd: CAP, ...(options.costForecast ? { costForecast: options.costForecast } : {}) };
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
    spend(store, runId, `task-${id}`, policy, tokens);
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

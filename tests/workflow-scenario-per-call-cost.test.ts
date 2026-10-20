import { afterEach, describe, expect, test } from "bun:test";
import { budgetLimitText } from "../src/components/workflow/format.js";
import { canExtendRun } from "../src/core/workflows/extendable.js";
import { findPricing } from "../src/core/llm/pricing.js";
import { growCostCapToForecast, remainingCostRate } from "../src/core/workflows/budget.js";
import { costCeilingUsd } from "../src/core/workflows/cost-tolerance.js";
import { DEFAULT_MIX } from "../src/core/workflows/stage-price.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { CALL_COST_MODELS, NEXT_CALL, perCallCostScenario } from "./helpers/per-call-cost-scenario.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("scenario: cached calls fit after expensive planning (#1630, R49)", () => {
  for (const model of CALL_COST_MODELS) {
    test(`${model}: the scripted implementer completes without a budget intervention`, async () => {
      const { fixture, store, runId, policy, rate } = await perCallCostScenario(model, true);
      cleanups.push(fixture.dispose);
      const cap = policy.maxCostUsd;
      const blended = store.costUsage(runId).spentUsd / store.run(runId).token_usage;
      expect(store.costUsage(runId).spentUsd + NEXT_CALL * blended).toBeGreaterThan(costCeilingUsd(store, runId, policy)!);
      expect(remainingCostRate(store, runId)).toBeCloseTo(rate, 12);
      await fixture.approve(runId);
      const outcome = await fixture.service.drive(runId, new AbortController().signal);
      expect(outcome.status).toBe("completed");
      expect(fixture.executor.expanded).toBe(true);
      expect(JSON.parse(store.run(runId).policy_json).maxCostUsd).toBe(cap);
    }, 60000);

    test(`${model}: parallel reservations, expansion and recovery use the task price`, async () => {
      const { fixture, store, runId, policy, rate } = await perCallCostScenario(model);
      cleanups.push(fixture.dispose);
      const step = store.beginStep(runId, "task-T001");
      const first = store.reserve(runId, step, model, NEXT_CALL / 2, policy);
      const child = store.beginStep(runId, "candidate", step);
      const second = store.reserve(runId, child, model, NEXT_CALL / 2, policy);
      expect(store.costUsage(runId).reservedUsd).toBeCloseTo(NEXT_CALL * rate, 10);
      expect(store.costUsage(runId, first).reservedUsd).toBeCloseTo(NEXT_CALL / 2 * rate, 10);
      store.expandReservation(runId, first, NEXT_CALL, policy);
      expect(store.costUsage(runId).reservedUsd).toBeCloseTo(1.5 * NEXT_CALL * rate, 10);
      expect(() => store.expandReservation(runId, second, NEXT_CALL, policy)).toThrow("cost ceiling");
      expect(() => store.reserve(runId, store.beginStep(runId, "task-T002"), model, NEXT_CALL, policy)).toThrow("cost ceiling");
      store.transaction(() => store.transition(runId, "blocked", "invalid_output"));
      const view = readWorkflowView(fixture.service, runId);
      expect(view.snapshot.reservedCostUsd).toBeCloseTo(1.5 * NEXT_CALL * rate, 10);
      expect(view.budget.cost?.reservedUsd).toBeCloseTo(view.snapshot.reservedCostUsd!, 10);
      expect(canExtendRun(view.snapshot)).toBe(true);
      expect(budgetLimitText(view.budget)).toContain("$");
      const committed = store.costUsage(runId).spentUsd + 1.5 * NEXT_CALL * rate;
      store.setPolicy(runId, { ...policy, maxCostUsd: committed / 0.94 });
      expect(canExtendRun(store.snapshot(runId))).toBe(false);
    });

    test(`${model}: planning and review keep their own prices, including after rerouting`, async () => {
      const { fixture, store, runId, policy, rate, spend } = await perCallCostScenario(model);
      cleanups.push(fixture.dispose);
      const review = store.reserve(runId, store.beginStep(runId, "review"), model, 1000, policy);
      // A stage without samples is priced on its own model at its default mix, not at the run's
      // blended price, which the cached task calls pulled down (#1740).
      const price = findPricing(model)!.pricing;
      const reviewMix = DEFAULT_MIX.input * price.input + DEFAULT_MIX.cacheRead * price.cacheRead + DEFAULT_MIX.output * price.output;
      expect(store.costUsage(runId).reservedUsd).toBeCloseTo(1000 * reviewMix / 1e6, 10);
      store.transaction(() => store.finishAttempt(runId, review, "completed", 0));
      store.setPolicy(runId, { ...policy, maxCostUsd: null });
      spend("review", 100_000);
      const pricedReview = store.reserve(runId, store.beginStep(runId, "review"), model, 1000, { ...policy, maxCostUsd: null });
      expect(store.costUsage(runId).reservedUsd).toBeCloseTo(1000 * findPricing(model)!.pricing.input / 1e6, 10);
      store.transaction(() => store.finishAttempt(runId, pricedReview, "completed", 0));
      const task = store.reserve(runId, store.beginStep(runId, "task-corrective"), model, 1000, { ...policy, maxCostUsd: null });
      expect(store.costUsage(runId).reservedUsd).toBeCloseTo(1000 * rate, 10);
      store.transaction(() => store.finishAttempt(runId, task, "completed", 0));
      const other = CALL_COST_MODELS.find((m) => m !== model)!;
      store.reserve(runId, store.beginStep(runId, "task-rerouted"), other, 1000, { ...policy, maxCostUsd: null });
      // Same cache mix, at the new model's prices.
      const otherPrice = findPricing(other)!.pricing;
      expect(store.costUsage(runId).reservedUsd).toBeCloseTo(1000 * (66_000 * otherPrice.input + 925_000 * otherPrice.cacheRead) / 991_000 / 1e6, 10);
    });
  }

  test.each(["forecast-growth", "call-growth"] as const)("%s adds headroom and respects the bound", async (kind) => {
    const { fixture, store, runId, policy } = await perCallCostScenario(CALL_COST_MODELS[0]);
    cleanups.push(fixture.dispose);
    Object.assign(policy, { maxCostUsd: 2.75, costTolerance: 0.1, sizing: { maxRunCostUsd: 19 } });
    store.setPolicy(runId, policy);
    expect(growCostCapToForecast(store, runId, policy, 3.034, 0.1, kind)).toBe(true);
    expect(policy.maxCostUsd).toBe(3.34);
    expect(JSON.parse(store.run(runId).policy_json).maxCostUsd).toBe(3.34);
    const revision = store.artifacts(runId).find((a) => a.kind === "policy-revision")!;
    expect(JSON.parse(store.readArtifact(runId, revision.id))).toMatchObject({ kind, approvedBy: "sizing", previous: { maxCostUsd: 2.75 }, next: { maxCostUsd: 3.34 } });
    Object.assign(policy, { maxCostUsd: 2.75, sizing: { maxRunCostUsd: 3 } });
    store.setPolicy(runId, policy);
    expect(growCostCapToForecast(store, runId, policy, 3.034, 0.1, kind)).toBe(true);
    expect(policy.maxCostUsd).toBe(3);
    expect(growCostCapToForecast(store, runId, policy, 3.31, 0.1, kind)).toBe(false);
    expect(policy.maxCostUsd).toBe(3);
    const fixed = { ...policy, maxCostUsd: 2.75, sizing: undefined };
    store.setPolicy(runId, fixed);
    expect(growCostCapToForecast(store, runId, fixed, 3.034, 0.1, kind)).toBe(false);
  });
});

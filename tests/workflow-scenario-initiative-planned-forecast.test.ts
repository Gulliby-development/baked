import { afterAll, beforeAll, expect, test } from "bun:test";
import { costLine } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { startApiServer } from "../src/core/api/server.js";
import { costText } from "../src/core/workflows/initiatives/forms.js";
import { initiativePriceSamples } from "../src/core/workflows/initiatives/forecast.js";
import { estimateHistory, historyStorePaths } from "../src/core/workflows/estimate.js";
import { forecastSamples, forecastStageCost } from "../src/core/workflows/forecast-price.js";
import { findPricing } from "../src/core/llm/pricing.js";
import type { InitiativeView } from "../src/core/workflows/initiatives/service.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { backtests, historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

const histories: Awaited<ReturnType<typeof historyFixture>>[] = [];
beforeAll(async () => {
  for (const cohort of backtests) histories.push(await historyFixture(cohort.actualUsd / cohort.count));
}, 60000);
afterAll(async () => { for (const fixture of histories.reverse()) await fixture.dispose(); });

test("#1643 historical stage prices also come from completed runs in the current project", () => {
  const store = histories[0]!.service.store;
  const history = store.history();
  const samples = initiativePriceSamples(store, [], history, []);
  expect(samples).toEqual(forecastSamples(store, history.map((r) => r.runId)));
  const cheap = "anthropic/claude-haiku-4-5";
  const price = findPricing(cheap)!.pricing;
  expect(forecastStageCost(samples, [{ id: "implement", models: [cheap], tokens: 1e6 }]))
    .toBeCloseTo(0.05 * price.input + 0.9 * price.cacheRead + 0.05 * price.output, 4);
  expect(forecastStageCost(samples, [{ id: "implement", models: ["unknown/model"], tokens: 1e6 }])).toBeNull();
});

for (const cohort of [...backtests, { id: "selwhy", count: 12, actualUsd: null }]) {
  test(`#1643 planned forecast: ${cohort.id} at 1/${cohort.count} accepted`, async () => {
    // Use selwhy's observed setup spend for the scripted skeleton in every backtest. The other
    // cohorts supply completed totals and counts, not unavailable per-feature usage traces.
    const firstUsd = 0.72;
    const { fixture, initiatives, view, identity } = await plannedForecastScenario(cohort.count, firstUsd, histories.map((f) => f.root));
    try {
      expect(view.features.filter((f) => f.state === "accepted")).toHaveLength(1);
      expect(view.budget.cost.spentUsd).toBeCloseTo(firstUsd, 2);
      expect(view.budget.cost.ceilingUsd).toBe(37.5);
      expect(view.budget.cost.forecastUsd).toBeLessThanOrEqual(view.budget.cost.ceilingUsd!);
      if (cohort.actualUsd !== null) {
        expect(view.budget.cost.forecastUsd!).toBeGreaterThan(cohort.actualUsd * 0.75);
        expect(view.budget.cost.forecastUsd!).toBeLessThan(cohort.actualUsd * 1.25);
      }
      const estimate = initiatives.estimate("values", 0);
      expect(estimate.progress.ratio).toBeNull();
      const remaining = estimate.features.slice(1);
      const centralUsd = remaining.reduce((sum, f) => sum + (f.costUsd!.low + f.costUsd!.high) / 2, 0);
      expect(view.budget.cost.forecastUsd).toBeCloseTo(firstUsd + centralUsd, 2);
      expect(view.budget.cost.forecastUsd!).toBeLessThan(firstUsd + remaining.reduce((sum, f) => sum + f.costUsd!.high, 0));
      expect(view.next).toMatchObject({ kind: "start", featureId: "f2" });
      expect(costLine(view)).toBe(costText(view.budget.cost));
      expect(await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "values"]), new AbortController().signal)).toEqual(view);
      if (cohort.id === "selwhy") {
        expect(view.budget.cost.forecastUsd).toBeLessThan(30);
        expect(view.budget.cost.remainingUsd).toBe(29.28);
        const store = fixture.service.store;
        const policy = { sizing: { historyStores: histories.map((f) => f.root) } };
        const history = estimateHistory(store, fixture.root, policy, 0);
        const paths = historyStorePaths(fixture.root, policy);
        const runId = view.features[0]!.runId!;
        const samples = initiativePriceSamples(store, [runId], history, [...paths, ...paths]);
        // Duplicate shared stores count once, and current research overrides historical research.
        expect(new Set(samples.map((a) => a.attemptId)).size).toBe(samples.length);
        expect(samples.filter((a) => a.stage === "research" && (a.usedTokens ?? 0) > 0)).toHaveLength(1);
        expect(samples.some((a) => a.stage === "implement" && (a.usedTokens ?? 0) > 0)).toBe(true);
        expect(() => initiativePriceSamples(store, [runId], history, ["missing/.baked/workflows.sqlite"])).not.toThrow();
        const server = await startApiServer({ service: fixture.service, log: () => {} });
        try {
          const response = await fetch(`${server.url}/v1/initiatives/values`, { headers: { Authorization: `Bearer ${server.token}` } });
          expect(response.status).toBe(200);
          expect((await response.json() as InitiativeView).budget.cost).toEqual(view.budget.cost);
        } finally { await server.stop(); }
      }
      await initiatives.pause("values", identity());
      expect((await initiatives.resume("values", identity())).next).toMatchObject({ kind: "start", featureId: "f2" });
    } finally { await fixture.dispose(); }
  }, 60000);
}

import { afterEach, describe, expect, test } from "bun:test";
import { costLine } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { costText } from "../src/core/workflows/initiatives/forms.js";
import { type InitiativeView, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// #2186: the dollar notice prices the features still to run at the measured ratio itself, as the
// token notice does (#2062); `forecastUsd` and the forecast stop keep the estimate's blend, which
// weighs the measured ratio a third at three features.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: the dollar notice advises at the measured ratio, the forecast stop keeps the blend (#2186)", () => {
  test("three features above their estimates warn while the blended forecast fits the ceiling", async () => {
    // Three finished history runs at $1 each; every feature here costs $2. The glob boundaries
    // leave no path rate to floor the waiting features, so the ratio alone scales them.
    const histories = await Promise.all([1, 2, 3].map(() => historyFixture(1, { taskShare: 0.4 })));
    for (const history of histories) cleanups.push(() => history.dispose());
    const result = await plannedForecastScenario(6, 2, histories.map((h) => h.root), {
      skeleton: false, capUsd: 12.5, costTolerance: "off", globPaths: true,
    });
    cleanups.push(() => result.fixture.dispose());
    const { initiatives, fixture } = result;
    const driveOne = async (): Promise<InitiativeView> => {
      const controller = new AbortController();
      const unwatch = fixture.service.store.observe((e) => {
        if (e.type === "run.state_changed" && e.payload.to === "completed") controller.abort();
      });
      try { return await initiatives.drive("values", controller.signal); } finally { unwatch(); }
    };
    let view = result.view;
    while (view.features.filter((f) => f.state === "accepted").length < 3) {
      // No notice before three measured features: the blend and the measured ratio wait for them.
      expect(view.budget.cost.forecastNotice).toBeNull();
      expect(view.budget.cost.advice ?? null).toBeNull();
      view = await driveOne();
    }
    expect(view.features.filter((f) => f.state === "accepted").map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    const cost = view.budget.cost;
    // The blend says $11.34, under the $12.50 ceiling; the measured 1.56x says $13.03.
    expect(cost).toMatchObject({ spentUsd: 6, ceilingUsd: 12.5, forecastUsd: 11.34, measuredFeatures: 3, forecastBinding: false });
    expect(cost.forecastNotice).toBe("At the measured 1.6x of the estimates the cost forecast is $13.03 ($11.34 at the blended 1.2x that the forecast stop uses; $6.00 spent), above the $12.50 ceiling. The advice changes no decision: features keep starting while the blended forecast and their spent and reserved dollars fit the budget. A cap of $14.00 covers it (baked workflow initiative extend values --budget-usd 14).");
    expect(cost.advice).toEqual({ forecastUsd: 13.03, ratio: 1.56, blendedRatio: 1.19 });
    // The estimate exposes both ratios; only the notice reads the raw one.
    const progress = initiatives.estimate("values")?.progress;
    expect(progress?.ratio).toBeCloseTo(1.19, 2);
    expect(progress?.rawRatio).toBeCloseTo(1.56, 2);
    // The terminal and desktop cost lines name both forecasts, with no advisory mark: the blend fits.
    expect(costText(cost)).toBe("$6.00 of $12.50 · $6.50 left · forecast $11.34, $13.03 at the measured 1.6x");
    expect(costLine(view)).toBe(costText(cost));
    // The advice changes no decision: the next feature starts.
    expect(shareShortfall(view, view.features[3]!)).toBeNull();
    expect(view.next).toMatchObject({ kind: "start", featureId: "f4" });

    // Even binding and enforced, the forecast stop reads the blend, which fits.
    const binding = { ...view, budget: { ...view.budget, cost: { ...cost, forecastBinding: true } } };
    expect(shareShortfall(binding, view.features[3]!)).toBeNull();

    view = await driveOne();
    expect(view.features.find((f) => f.id === "f4")?.state).toBe("accepted");
    const notes = initiatives.events("values").filter((e) => e.type === "cost.forecast_advisory");
    expect(notes.map((e) => e.payload)).toEqual([
      expect.objectContaining({ featureId: "f4", forecastUsd: 11.34, advice: cost.advice, ceilingUsd: 12.5, measuredFeatures: 3, message: cost.forecastNotice }),
    ]);
    // The headless CLI shows the same view.
    const shown = (await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "values"]), new AbortController().signal)) as InitiativeView;
    expect(shown.budget.cost).toEqual(initiatives.view("values").budget.cost);
  }, 120000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { dollarShortfall, type ShareGateRecord, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import type { StopMode } from "../src/core/workflows/stop-reasons.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// R59 wheeltags (#1890): features were priced at the history's stage weights, from long
// cache-heavy task loops, while the initiative's short task loops and uncached planning calls
// spent its tokens in another mix and paid $1.95 per million. Here the history spends 80% of a
// feature's dollars on cached tasks and the initiative 10%, the rest on uncached planning.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scenario(mode?: StopMode) {
  const history = await historyFixture(1, { taskShare: 0.8 });
  cleanups.push(() => history.dispose());
  // $4.70: after f1's $2, the $2.69 left covers the next three features at the history's price
  // and not at the price f1 paid. Without a tolerance band the ceiling is the cap, so the shortage
  // holds at one measured feature too (#2099).
  const result = await plannedForecastScenario(4, 2, [history.root], {
    mix: { taskShare: 0.1, planCache: 0 }, skeleton: false, capUsd: 4.7, costTolerance: "off",
    ...(mode ? { stopModes: { "initiative-dollar-share": mode } } : {}),
  });
  cleanups.push(() => result.fixture.dispose());
  return result;
}

const gates = (events: { type: string; payload: unknown }[]) =>
  events.filter((e) => e.type === "feature.share_gate").map((e) => e.payload as ShareGateRecord);
const wouldStops = (events: { type: string; payload: unknown }[]) =>
  events.filter((e) => e.type === "decision.would_stop" && (e.payload as { reason?: string }).reason === "initiative-dollar-share");

describe("scenario: an initiative prices waiting features at what its accepted features paid (#1890, R59 wheeltags)", () => {
  test("the waiting features' dollars come from the stage mix f1 measured", async () => {
    const { view } = await scenario();
    const f1 = view.features[0]!;
    expect(f1).toMatchObject({ state: "accepted", spentUsd: 2 });
    const paid = f1.spentUsd / f1.usage.tokens;
    // The history's stage mix says about $2.24 per million tokens; f1 paid $2.98.
    for (const feature of view.features.slice(1)) {
      const rate = feature.needUsd!.low / feature.need!.low;
      expect(Math.abs(rate / paid - 1)).toBeLessThan(0.01);
    }
    // Two waiting features reserve their low ends; what is left is below f2's.
    expect(dollarShortfall(view, view.features[1]!)).toStartWith("The shared dollar budget is short: f2 has $0.65 to grow into");
  }, 120000);

  test("in shadow, the default, f2 starts and the would-stop is recorded once", async () => {
    const { initiatives, view } = await scenario();
    expect(view.budget.cost.shareMode).toBe("shadow");
    expect(shareShortfall(view, view.features[1]!)).toBeNull();
    const controller = new AbortController();
    const driven = await initiatives.drive("values", controller.signal);
    expect(driven.features.find((f) => f.id === "f2")?.runId).not.toBeNull();
    const stops = wouldStops(initiatives.events("values"));
    expect(stops).toHaveLength(1);
    expect(stops[0]?.payload).toMatchObject({ reason: "initiative-dollar-share", mode: "shadow", featureId: "f2", key: "share-f2" });
    expect((stops[0]?.payload as { summary: string }).summary).toEndWith("f2 would not start.");
  }, 120000);

  test("enforced, the drive parks f2 for an extend, the gate event replays it, and the extend clears it", async () => {
    const { initiatives, view, identity } = await scenario("enforce");
    const advice = shareShortfall(view, view.features[1]!);
    expect(advice?.message).toContain("The shared dollar budget is short: f2 has $0.65 to grow into");
    expect(advice?.message).toContain("needs at least $0.37 more. Raise it with baked workflow initiative extend values --budget-usd 5.07.");
    // The remedy carries the cap that starts f2, so one command or click answers it (#2042).
    expect(advice?.remedies).toEqual([{ action: "extend", initiativeId: "values", suggestedUsd: 5.07 }]);

    const driven = await initiatives.drive("values", new AbortController().signal);
    expect(driven.features.find((f) => f.id === "f2")?.runId).toBeNull();
    const parked = gates(initiatives.events("values")).find((g) => g.featureId === "f2" && g.verdict === "park");
    expect(parked?.feature.needUsd?.low).toBeCloseTo(view.features[1]!.needUsd!.low, 6);
    expect(shareShortfall(parked!.view, parked!.feature)?.message).toBe(advice?.message);

    const extended = await initiatives.extendBudget("values", identity(), { maxCostUsd: 4.7 + 0.37 });
    expect(shareShortfall(extended, extended.features[1]!)).toBeNull();
  }, 120000);

  test("a gate recorded before #1890 has no priced need or share mode and replays without a dollar decision", async () => {
    const { view } = await scenario("enforce");
    const { shareMode: _mode, ...cost } = view.budget.cost;
    const recorded = {
      ...view,
      budget: { ...view.budget, cost },
      features: view.features.map(({ needUsd: _n, shareUsd: _s, ...f }) => f),
    };
    const { needUsd: _needUsd, ...old } = view.features[1]!;
    expect(shareShortfall(recorded, old)).toBeNull();
    expect(shareShortfall({ ...view, budget: { ...view.budget, cost } }, view.features[1]!)).toBeNull();
  }, 120000);
});

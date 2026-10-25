import { afterEach, describe, expect, test } from "bun:test";
import { dollarShortfall, shareSpareUsd } from "../src/core/workflows/initiatives/service.js";
import { costGrowthLimit } from "../src/core/workflows/initiatives/growth.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// R67 ampwhy (#2099): at one measured feature the waiting features' dollar lows were priced at the
// rate the first feature paid, above what the initiative paid in the end, and reserved $20.91 of
// an initiative that cost $16.24. Reader and scanning recorded `initiative-dollar-share`
// would-stops for dollars that were never short. Until the dollar rate is measured on three
// features the rule counts the remaining dollars up to the tolerance ceiling, not the cap.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The split and f1 pay $2 on uncached planning (a high dollar rate); f2 to f4 pay $0.60 each. */
async function scenario(capUsd: number) {
  const history = await historyFixture(1, { taskShare: 0.8 });
  cleanups.push(() => history.dispose());
  const result = await plannedForecastScenario(4, { fixture: 2, f1: 2, f2: 0.6, f3: 0.6, f4: 0.6 }, [history.root], {
    mix: { taskShare: 0.1, planCache: 0 }, skeleton: false, capUsd,
  });
  cleanups.push(() => result.fixture.dispose());
  return result;
}

const wouldStops = (events: { type: string; payload: unknown }[]) =>
  events
    .filter((e) => e.type === "decision.would_stop" && (e.payload as { reason?: string }).reason === "initiative-dollar-share")
    .map((e) => e.payload as { featureId: string; summary: string; inputs: Record<string, unknown> });

describe("scenario: the dollar share waits for a measured dollar rate (#2099, R67 ampwhy)", () => {
  test("a first feature at a high dollar rate does not make features 2 and 3 would-stop", async () => {
    // $4.70 and its $5.88 ceiling: against the cap f2's spare is $0.65, below its $1.02 low.
    const { initiatives, view } = await scenario(4.7);
    const f2 = view.features[1]!;
    expect(view.budget.cost).toMatchObject({ measuredFeatures: 1, capUsd: 4.7, ceilingUsd: 5.88 });
    expect(costGrowthLimit(view, "f2")!).toBeLessThan(f2.needUsd!.low);
    expect(shareSpareUsd(view, "f2")!).toBeGreaterThan(f2.needUsd!.low);
    expect(dollarShortfall(view, f2)).toBeNull();
    const driven = await initiatives.drive("values", new AbortController().signal);
    for (const id of ["f2", "f3"]) expect(driven.features.find((f) => f.id === id)?.runId).not.toBeNull();
    expect(wouldStops(initiatives.events("values"))).toEqual([]);
  }, 120000);

  test("a shortage past the ceiling still records a would-stop", async () => {
    // $4.00 and its $5.00 ceiling: after $2 spent, the $3.00 to the ceiling less f3's and f4's
    // $1.02 lows does not cover f2's.
    const { initiatives, view } = await scenario(4);
    const f2 = view.features[1]!;
    expect(view.budget.cost.measuredFeatures).toBe(1);
    expect(shareSpareUsd(view, "f2")!).toBeLessThan(f2.needUsd!.low);
    expect(dollarShortfall(view, f2)).toStartWith("The shared dollar budget is short: f2 has $");
    expect(dollarShortfall(view, f2)).toContain("to grow into within the ceiling after reserving");
    await initiatives.drive("values", new AbortController().signal);
    const stops = wouldStops(initiatives.events("values"));
    expect(stops[0]).toMatchObject({ featureId: "f2", inputs: { remainingTo: "ceiling", measuredFeatures: 1 } });
  }, 120000);
});

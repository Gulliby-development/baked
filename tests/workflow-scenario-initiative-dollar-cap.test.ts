import { afterEach, describe, expect, test } from "bun:test";
import {
  dollarCapPark,
  dollarShortfall,
  expectedSplitUsd,
  type ShareGateView,
} from "../src/core/workflows/initiatives/service.js";
import { StopModesSchema } from "../src/core/workflows/stop-reasons.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// #2218, R70 evalpin (7 features, $30 cap, 0.2 tolerance, 3 measured): report-cli started with
// $4.82 under the cap against a $5.17 low while suite-runner (cap $5.07, $3.90 spent) still needed
// its review. report-cli spent $4.38 on planning and suite-runner stopped about $0.50 short. The
// `initiative-dollar-cap` rule records, in shadow, that the initiative would pause (`dollar_cap`)
// with one extend remedy instead of starting a feature no dollars left can pay for.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The share gate's inputs at report-cli's start, with suite-runner held at a plan charge. */
function r70(lowUsd: number, chargeUsd: number | null): { view: ShareGateView; feature: ShareGateView["features"][number] } {
  const feature = { id: "report-cli", state: "ready", share: { tokens: 1, calls: 1, activeMs: 1 }, need: null, shareUsd: 2.4, needUsd: { low: lowUsd, high: 10.14 } };
  const view = {
    initiativeId: "evalpin",
    budget: {
      remaining: { tokens: 1, calls: 1, activeMs: 1 },
      cost: { capUsd: 30, tolerance: 0.2, ceilingUsd: 36, spentUsd: 25.17, reservedUsd: 0, remainingUsd: 4.82, forecastUsd: 38.19, measuredFeatures: 3, forecastBinding: false, forecastMode: "enforce", forecastNotice: null, shareMode: "shadow" },
      ...(chargeUsd === null ? {} : {
        planCharge: {
          mode: "shadow", ratio: null, runs: [], limitCommittedTokens: 0, planCommittedTokens: 0, releasedTokens: 0,
          // suite-runner's cap holds $5.07; its plan charge prices it at spent plus its review.
          usd: { taskRate: 1, limitCommittedUsd: 30 - 4.82, planCommittedUsd: 30 - 4.82 - 5.07 + chargeUsd, releasedUsd: 5.07 - chargeUsd },
        },
      }),
    },
    features: [feature],
  } as unknown as ShareGateView;
  return { view, feature };
}

const capStops = (events: { type: string; payload: unknown }[]) =>
  events
    .filter((e) => e.type === "decision.would_stop" && (e.payload as { reason?: string }).reason === "initiative-dollar-cap")
    .map((e) => e.payload as { featureId: string; mode: string; key: string; parkReason: string; summary: string; remedy: { action: string; suggestedUsd: number }; inputs: Record<string, unknown> });

describe("scenario: a dollar-capped initiative would pause before a start its cap cannot pay for (#2218, R70 evalpin)", () => {
  test("R70's report-cli: the dollars left after suite-runner's plan need are below its low", () => {
    const { view, feature } = r70(5.17, 5.4);
    const park = dollarCapPark(view, feature);
    expect(park).toMatchObject({ parkReason: "dollar_cap", leftUsd: 4.49, lowUsd: 5.17, openNeedUsd: 0.33, remainingTo: "cap" });
    // The remedy pays for the expected remaining work, not only for report-cli's low.
    expect(park!.suggestedUsd).toBe(38.19);
    expect(park!.summary).toContain("--budget-usd 38.19");
    expect(park!.summary).toContain("after the open runs' plan needs ($0.33 above their caps)");
  });

  test("an open run's plan need above its cap turns a start that the cap alone would pay for", () => {
    // A $4.50 low fits the $4.82 to the cap, but not after suite-runner's $1.50 still to run.
    expect(dollarCapPark(r70(4.5, null).view, r70(4.5, null).feature)).toBeNull();
    const { view, feature } = r70(4.5, 3.9 + 1.5 + 1.17);
    expect(dollarCapPark(view, feature)).toMatchObject({ leftUsd: 3.32, openNeedUsd: 1.5 });
    // A plan charge below the cap frees dollars the other way.
    expect(dollarCapPark(r70(5.17, 3).view, r70(5.17, 3).feature)).toBeNull();
  });

  test("the rule waits for the first measured feature and counts to the ceiling while uncalibrated", () => {
    const { view, feature } = r70(5.17, null);
    const at = (measuredFeatures: number) => ({ ...view, budget: { ...view.budget, cost: { ...view.budget.cost, measuredFeatures } } });
    expect(dollarCapPark(at(0), feature)).toBeNull();
    // Two measured features: $4.82 plus the $6 tolerance band covers the $5.17 low.
    expect(dollarCapPark(at(2), feature)).toBeNull();
    expect(dollarCapPark(at(3), feature)).not.toBeNull();
  });

  test("a driven start records the would-stop once, with its extend remedy, and still starts in shadow", async () => {
    const history = await historyFixture(1, { taskShare: 0.8 });
    cleanups.push(() => history.dispose());
    const { fixture, initiatives, view } = await plannedForecastScenario(4, { fixture: 2, f1: 2, f2: 0.6, f3: 0.6, f4: 0.6 }, [history.root], {
      mix: { taskShare: 0.1, planCache: 0 }, skeleton: false, capUsd: 4,
    });
    cleanups.push(() => fixture.dispose());
    expect(view.features[0]!.state).toBe("accepted");
    expect(view.budget.cost).toMatchObject({ spentUsd: 2, measuredFeatures: 1 });
    // f1 cost more than the split priced: lower the cap to what an overrun would have left, $0.20
    // under the cap and $0.55 more to the ceiling, below f2's $1.02 low.
    const db = fixture.service.store.connection;
    const row = db.query("SELECT settings_json FROM initiatives WHERE id='values'").get() as { settings_json: string };
    const settings = JSON.parse(row.settings_json);
    settings.costBudget.maxCostUsd = 2.2;
    db.run("UPDATE initiatives SET settings_json=? WHERE id='values'", [JSON.stringify(settings)]);
    const before = initiatives.view("values");
    const f2 = before.features[1]!;
    expect(dollarCapPark(before, f2)).toMatchObject({ remainingTo: "ceiling", lowUsd: f2.needUsd!.low });
    expect(dollarShortfall(before, f2)).not.toBeNull();
    const driven = await initiatives.drive("values", new AbortController().signal);
    expect(driven.features[1]!.runId).not.toBeNull();
    const stops = capStops(initiatives.events("values"));
    expect(stops.map((s) => s.featureId)).toContain("f2");
    const stop = stops.find((s) => s.featureId === "f2")!;
    expect(stop).toMatchObject({ mode: "shadow", key: "cap-f2", parkReason: "dollar_cap", remedy: { action: "extend" }, inputs: { remainingTo: "ceiling", measuredFeatures: 1 } });
    expect(stop.remedy.suggestedUsd).toBeGreaterThan(2.2);
    expect(stop.summary).toContain(`baked workflow initiative extend values --budget-usd ${stop.remedy.suggestedUsd}`);
    expect(stop.summary).toContain("would pause (dollar_cap)");
    expect(stops.filter((s) => s.key === "cap-f2")).toHaveLength(1);
  }, 120000);

  test("a policy cannot enforce the rule before its promotion", () => {
    expect(StopModesSchema.safeParse({ "initiative-dollar-cap": "advisory" }).success).toBe(true);
    expect(StopModesSchema.safeParse({ "initiative-dollar-cap": "enforce" }).success).toBe(false);
  });
});

describe("scenario: the split approval states the expected dollars, not only the lows (#2218)", () => {
  test("R70's seven features: about $36.5 expected against $30.11 of lows, and how many the cap pays for", () => {
    // Lows and highs whose expected tokens sit 0.4 of the way up their range, as R70's four
    // accepted features did ($20.63 against lows of $14.90 and highs of $31.10).
    const lows = [3.1, 4.6, 4.2, 5.17, 4.5, 4.4, 4.14];
    const features = lows.map((low) => ({ costUsd: { low, high: low * 2 }, tokens: { low: 1_000_000, high: 2_000_000 }, expectedTokens: 1_210_000 }));
    const expected = expectedSplitUsd(features, { spentUsd: 0, remainingUsd: 30 });
    expect(expected).toMatchObject({ lowsUsd: 30.11, totalUsd: 36.44, waiting: 7, paid: 5 });
    // Unpriced features give no total rather than a partial one.
    expect(expectedSplitUsd([...features, undefined], { spentUsd: 0, remainingUsd: 30 })).toBeNull();
  });
});

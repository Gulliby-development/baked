import { describe, expect, test } from "bun:test";
import {
  capCovering,
  dollarCapPark,
  dollarShortfall,
  shareShortfall,
  type ShareGateView,
} from "../src/core/workflows/initiatives/service.js";

// #2282, R73 flatelens (9 features, 8 accepted, $31.98 cap after one raise, 0.2 tolerance, $38.38
// ceiling): $34.64 was spent, past the cap and inside the tolerance, and docs (priced $1.04-$1.97)
// waited with a $0.00 share. The remedy named a $33.96 cap, built from the clamped `remainingUsd`
// ($0): applied, it still left docs at $0 and asked for $35.93 next. A dollar `extend` remedy
// names a cap above what the runs committed, so applying it gives the feature its estimate.

type Feature = ShareGateView["features"][number];
const docs = (shareUsd: number): Feature =>
  ({ id: "docs", state: "ready", share: { tokens: 5_000_000, calls: 50, activeMs: 3_600_000 }, need: null, shareUsd, needUsd: { low: 1.04, high: 1.97 } }) as Feature;

/** The share gate's inputs with `capUsd`, `spentUsd` committed and docs the one waiting feature. */
function flatelens(capUsd: number, spentUsd = 34.64, overrides: Partial<ShareGateView["budget"]["cost"]> = {}): { view: ShareGateView; feature: Feature } {
  // Floored to the cent as the initiative view floors it.
  const remainingUsd = Math.floor(Math.round(Math.max(0, capUsd - spentUsd) * 1e6) / 1e4) / 100;
  // One waiting feature: its dollar share is all that remains under the cap.
  const feature = docs(remainingUsd);
  const view = {
    initiativeId: "flatelens",
    budget: {
      remaining: { tokens: 5_000_000, calls: 50, activeMs: 3_600_000 },
      cost: { capUsd, tolerance: 0.2, ceilingUsd: Math.round(capUsd * 1.2 * 100) / 100, spentUsd, reservedUsd: 0, remainingUsd, forecastUsd: null, measuredFeatures: 8, forecastBinding: true, forecastMode: "enforce", forecastNotice: null, shareMode: "enforce", ...overrides },
    },
    features: [feature],
  } as unknown as ShareGateView;
  return { view, feature };
}

describe("scenario: a dollar extend remedy covers what was spent past the cap (#2282, R73 flatelens)", () => {
  test("the exhausted share names spent plus the waiting high, and applying it gives docs its low", () => {
    const { view, feature } = flatelens(31.98);
    expect(view.budget.cost.ceilingUsd).toBe(38.38);
    const advice = shareShortfall(view, feature);
    expect(advice?.summary).toContain("The shared dollar budget is exhausted");
    const suggested = (advice?.remedies[0] as { suggestedUsd?: number }).suggestedUsd!;
    expect(suggested).toBeGreaterThanOrEqual(36.61);
    expect(advice?.summary).toContain(`A cap of $${suggested.toFixed(2)} covers`);
    const applied = flatelens(suggested);
    expect(applied.feature.shareUsd!).toBeGreaterThanOrEqual(1.04);
    expect(shareShortfall(applied.view, applied.feature)).toBeNull();
  });

  test("the dollar-share raise counts from what was committed past the cap", () => {
    const { view } = flatelens(31.98);
    // A share recorded before the tolerance was spent reaches the enforced dollar-share branch.
    const feature = docs(0.5);
    const advice = shareShortfall(view, feature);
    expect(advice?.summary).toContain("The shared dollar budget is short");
    const suggested = (advice?.remedies[0] as { suggestedUsd?: number }).suggestedUsd!;
    expect(suggested).toBeGreaterThanOrEqual(34.64 + 1.04);
    expect(flatelens(suggested).feature.shareUsd!).toBeGreaterThanOrEqual(1.04);
    // The text's raise is the same cap: $31.98 plus $3.70.
    expect(dollarShortfall(view, feature)).toContain("needs at least $3.70 more");
  });

  test("the dollar-cap park without a forecast names a cap that pays for docs' low", () => {
    const { view, feature } = flatelens(31.98);
    const park = dollarCapPark(view, feature);
    expect(park).toMatchObject({ leftUsd: 0, lowUsd: 1.04, remainingTo: "cap" });
    expect(park!.suggestedUsd).toBeGreaterThanOrEqual(35.68);
    const applied = flatelens(park!.suggestedUsd);
    expect(dollarCapPark(applied.view, applied.feature)).toBeNull();
  });

  test("with committed dollars below the cap the remedies keep today's numbers", () => {
    // $30.50 of a $31.98 cap committed: $1.48 left, below docs' $1.97 high and above its low.
    const { view, feature } = flatelens(31.98, 30.5);
    expect(capCovering(view.budget.cost, 1.97)).toBe(32.47);
    expect(shareShortfall({ ...view, features: [docs(0)] }, docs(0))?.remedies[0]).toMatchObject({ suggestedUsd: 32.47 });
    // A $2 low the $1.48 left does not cover: the cap grows by the $0.52 gap.
    const big = { ...feature, needUsd: { low: 2, high: 3 } };
    expect(dollarCapPark(view, big)!.suggestedUsd).toBe(32.5);
    expect(shareShortfall(view, big)?.remedies[0]).toMatchObject({ suggestedUsd: 32.5 });
    expect(dollarShortfall(view, big)).toContain("needs at least $0.52 more");
  });
});

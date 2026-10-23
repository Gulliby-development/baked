import { describe, expect, test } from "bun:test";
import type { PastRun } from "../src/core/workflows/estimate.js";
import {
  estimateInitiative,
  estimateSummary,
  type FeatureRunSample,
  type FeatureToEstimate,
  highCalibrationOf,
  MIN_HIGH_RATIO_SAMPLES,
} from "../src/core/workflows/initiatives/estimate.js";
import { estimateBudgetText } from "../src/core/workflows/initiatives/estimate-budget.js";

// Bench rounds 62 and 63 (#1982): stepvet used 1.32x the low end of its split estimate and
// eolscope 1.05x, while the high end sat at about twice the low end by construction. The warning
// "high end exceeds the shared budget" made an operator extend a budget the run used 37% of.
const SDD = [
  { id: "specify", type: "agent", models: [] },
  { id: "implement", type: "tasks", models: [] },
];
const history: PastRun[] = Array.from({ length: 6 }, (_, i) => ({
  runId: `h${i}`,
  workflowId: "sdd",
  status: "completed",
  tokens: 1_000_000,
  calls: 10,
  activeMs: 1000,
  taskCount: 6,
  stageTokens: { specify: 200_000, implement: 800_000 },
  taskTokens: 800_000,
}));
const sample = (
  runId: string,
  initiativeId: string | undefined,
  size: FeatureRunSample["size"],
  perPath: number,
  paths: number,
): FeatureRunSample => ({
  runId,
  workflowId: "sdd",
  size,
  tokens: perPath * paths,
  taskCount: 6,
  paths,
  source: "shared",
  ...(initiativeId ? { initiativeId } : {}),
});
// Three earlier initiatives whose features cost 400k-500k per path: priced from the other
// initiatives by the estimate's own rules, each lands 0.8-1.25x its low end. The one large feature
// makes the size class's range 0.7x-1.4x, twice the low end by construction.
const SAMPLES = [
  sample("a1", "A", "medium", 410_000, 3),
  sample("a2", "A", "medium", 450_000, 4),
  sample("b1", "B", "medium", 400_000, 2),
  sample("b2", "B", "medium", 480_000, 5),
  sample("c1", "C", "medium", 420_000, 3),
  sample("c2", "C", "medium", 500_000, 2),
  sample("c3", "C", "large", 420_000, 14),
];
const core: FeatureToEstimate = {
  id: "core",
  title: "core",
  workflowId: "sdd",
  size: "large",
  stages: SDD,
  paths: 10,
};
const BUDGET = 6_500_000;

describe("scenario: the split's high end from measured actual-to-low ratios (#1982, R62/R63)", () => {
  test("ratios near 1.0-1.3 put the high end well below twice the low end", () => {
    const estimate = estimateInitiative({
      features: [core],
      history,
      samples: SAMPLES,
      maxTotalTokens: BUDGET,
    });
    const f = estimate.features[0];
    const calibration = estimate.highCalibration;
    expect(calibration).not.toBeNull();
    expect(calibration?.samples).toBe(SAMPLES.length);
    expect(calibration?.initiatives).toBe(3);
    expect(calibration?.low).toBeGreaterThanOrEqual(0.75);
    expect(calibration?.high).toBeLessThanOrEqual(1.3);
    expect(calibration?.total.high).toBeLessThanOrEqual(1.1);
    expect(f?.highBasis).toBe("ratios");
    const low = f?.tokens.low ?? 0;
    const high = f?.tokens.high ?? 0;
    expect(high).toBeLessThanOrEqual(Math.round(1.3 * low));
    // The low end stays 0.7x the large sample; the high end is it times the 90th percentile ratio.
    expect(low).toBe(Math.round(0.7 * 420_000 * 14));
    expect(high).toBe(Math.round(low * (calibration?.high ?? 0)));
    // The total is bounded by whole initiatives' spread, tighter than the feature's own bound.
    expect(estimate.tokens.high).toBe(Math.round(low * (calibration?.total.high ?? 0)));
    expect(estimate.tokens.high).toBeLessThanOrEqual(high);
    // The expected value sits inside the range, at the median ratio.
    expect(f?.expectedTokens).toBeGreaterThanOrEqual(low);
    expect(f?.expectedTokens).toBeLessThanOrEqual(high);
    expect(estimate.expectedTokens).toBe(f?.expectedTokens ?? -1);
    // The budget sits above the calibrated high end: no warning, and the label shows the expected value.
    expect(estimate.tokens.high).toBeLessThan(BUDGET);
    expect(estimate.label).not.toContain("high end exceeds");
    expect(estimate.label).toContain("expected");
    expect(estimateSummary(estimate)).toContain("expected");
    expect(estimate.notes.join("\n")).toContain("90th percentile of actual-to-low ratios");
  });

  test("with fewer measured ratios the high end keeps today's rule and the warning says it is uncalibrated", () => {
    // Samples of older callers name no initiative, so no ratio is measured.
    const anonymous = SAMPLES.map(({ initiativeId: _, ...s }) => s);
    const estimate = estimateInitiative({
      features: [core],
      history,
      samples: anonymous,
      maxTotalTokens: BUDGET,
    });
    const f = estimate.features[0];
    expect(estimate.highCalibration).toBeNull();
    expect(f?.highBasis).toBeUndefined();
    // The single large sample prices the size class at 0.7x-1.4x: about twice the low end.
    expect(f?.tokens.high).toBe(Math.round(1.4 * 420_000 * 14));
    expect((f?.tokens.high ?? 0) / (f?.tokens.low ?? 1)).toBeGreaterThan(1.9);
    expect(estimate.label).toContain("high end exceeds the shared budget");
    expect(estimate.label).toContain("uncalibrated");
    expect(estimate.label).toContain(`expected ${(estimate.expectedTokens ?? 0).toLocaleString("en-US")} tokens`);
    // Fewer than the minimum ratios from enough initiatives: no calibration either.
    expect(highCalibrationOf(SAMPLES.slice(0, MIN_HIGH_RATIO_SAMPLES - 1))).toBeNull();
    expect(highCalibrationOf(SAMPLES.map((s) => ({ ...s, initiativeId: "one" })))).toBeNull();
  });

  test("the budget text names the expected value and the measured spread", () => {
    const text = estimateBudgetText(
      { low: 4_000_000, high: 8_000_000 },
      { maxTotalTokens: 6_000_000, fits: "maybe" },
      10_000_000,
      { expectedTokens: 4_400_000, spread: "finished features used 1.00-1.20x their low end" },
    );
    expect(text).toContain("expected 4,400,000 tokens fits the shared budget");
    expect(text).toContain("high end exceeds the shared budget (finished features used 1.00-1.20x their low end)");
    // Callers without the detail keep the old wording.
    expect(
      estimateBudgetText({ low: 4_000_000, high: 8_000_000 }, { maxTotalTokens: 6_000_000, fits: "maybe" }, 10_000_000),
    ).toBe("low end fits the shared budget; high end exceeds the shared budget, consider extending to 10,000,000 tokens with margin");
  });
});

describe("scenario: a feature cheaper than every sample under the ratio rule (#1982, forecast-floor rule)", () => {
  test("a cheaper initiative keeps the low end at the lowest rate and widens the ratios, never the low end", () => {
    // Initiative D cost 200k per path, half the others: the floor drops to it, and the others now
    // land about twice above that floor, so the measured spread is wide and the high end stays put.
    const samples = [...SAMPLES, sample("d1", "D", "medium", 200_000, 3), sample("d2", "D", "medium", 210_000, 2)];
    const estimate = estimateInitiative({ features: [core], history, samples, maxTotalTokens: BUDGET });
    const f = estimate.features[0];
    expect(estimate.perPath?.low).toBe(200_000);
    expect(estimate.highCalibration?.low).toBeLessThan(0.6);
    expect(estimate.highCalibration?.high).toBeGreaterThan(2);
    // The ratio rule never raises the low end: it is what the same samples give without ratios.
    const plain = estimateInitiative({ features: [core], history, samples: samples.map(({ initiativeId: _, ...s }) => s), maxTotalTokens: BUDGET });
    expect(f?.tokens.low).toBe(plain.features[0]?.tokens.low ?? -1);
    expect(f?.tokens.high).toBeLessThanOrEqual(plain.features[0]?.tokens.high ?? -1);
    expect(f?.tokens.high).toBeGreaterThanOrEqual(f?.tokens.low ?? Infinity);
    expect(f?.expectedTokens).toBeGreaterThanOrEqual(f?.tokens.low ?? Infinity);
    expect(f?.expectedTokens).toBeLessThanOrEqual(f?.tokens.high ?? -1);
  });

  test("an accepted feature cheaper than every sample counts as a ratio below 1 and lowers the rest", () => {
    const first: FeatureToEstimate = { ...core, id: "first", size: "medium", paths: 4 };
    const estimate = estimateInitiative({
      features: [first, core],
      history,
      samples: SAMPLES,
      maxTotalTokens: BUDGET * 2,
      progress: { features: { first: { spent: 4 * 240_000, accepted: true } }, overhead: 0 },
    });
    expect(estimate.highCalibration?.low).toBeLessThan(0.6);
    expect(estimate.highCalibration?.initiatives).toBe(4);
    const rest = estimate.features.find((f) => f.featureId === "core");
    // The low end is the lowest measured rate, now the accepted feature's 240k per path.
    expect(estimate.perPath?.low).toBe(240_000);
    // 0.7x the size class's one large sample: the ratio rule leaves the low end where it was.
    expect(rest?.tokens.low).toBe(Math.round(0.7 * 420_000 * 14));
    expect(rest?.tokens.high).toBeGreaterThanOrEqual(rest?.tokens.low ?? Infinity);
  });
});

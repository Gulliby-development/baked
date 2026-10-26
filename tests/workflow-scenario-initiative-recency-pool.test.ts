import { describe, expect, test } from "bun:test";
import { type PastRun, rangeOf } from "../src/core/workflows/estimate.js";
import {
  estimateInitiative,
  type FeatureRunSample,
  type FeatureToEstimate,
  recencyWeights,
  weightedRangeOf,
} from "../src/core/workflows/initiatives/estimate.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";

// Bench rounds 63 to 68 (#2150): 24 of 60 finished features used less than the low end of their
// range, 20 of them priced by a size pool that weighed round 45's features as much as the last
// round's. `sizing.recencyHalfLife` halves a feature's weight for every that many initiatives
// started after its own.
const SDD = [
  { id: "specify", type: "agent", models: [] },
  { id: "implement", type: "tasks", models: [] },
];
const history: PastRun[] = Array.from({ length: 6 }, (_, i) => ({
  runId: `h${i}`,
  workflowId: "sdd",
  status: "completed",
  tokens: 1_500_000,
  calls: 10,
  activeMs: 1000,
  taskCount: 6,
  stageTokens: { specify: 300_000, implement: 1_200_000 },
  taskTokens: 1_200_000,
}));
const DAY = 86_400_000;
/** Feature `n` of initiative `i`, started on day `i`. */
const sample = (i: number, n: number, tokens: number): FeatureRunSample => ({
  runId: `i${i}f${n}`,
  initiativeId: `i${i}`,
  startedAt: i * DAY + n,
  workflowId: "sdd",
  size: "medium",
  tokens,
  taskCount: 6,
});
// Six older initiatives at about 3M a feature, then two at about 1.25M.
const SAMPLES = [
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => [sample(i, 0, 3_000_000), sample(i, 1, 3_200_000)]),
  ...[6, 7].flatMap((i) => [sample(i, 0, 1_200_000), sample(i, 1, 1_300_000)]),
];
const feature: FeatureToEstimate = { id: "next", title: "next", workflowId: "sdd", size: "medium", stages: SDD };
const range = (samples: FeatureRunSample[], recencyHalfLife?: number) =>
  estimateInitiative({
    features: [feature],
    history,
    samples,
    maxTotalTokens: 30_000_000,
    ...(recencyHalfLife ? { recencyHalfLife } : {}),
  }).features[0]?.tokens;

describe("scenario: the size pool weighs recent initiatives' features more (#2150)", () => {
  test("off by default, every feature counts the same; at a half-life of 2 the recent cheap ones set the low end", () => {
    expect(range(SAMPLES)?.low).toBe(rangeOf(SAMPLES.map((s) => s.tokens))?.low);
    expect(range(SAMPLES)?.low).toBeGreaterThan(2_000_000);
    const recent = range(SAMPLES, 2);
    expect(recent?.low).toBeLessThan(1_500_000);
    expect(recent?.high).toBeLessThan(range(SAMPLES)?.high ?? 0);
  });

  test("a dearer recent initiative raises the low end again", () => {
    // The high end is the low end times the measured actual-to-low ratios here (`highCalibration`).
    const dearer = [...SAMPLES, sample(8, 0, 4_000_000), sample(8, 1, 4_200_000)];
    expect(range(dearer, 2)?.low).toBeGreaterThan(range(SAMPLES, 2)?.low ?? 0);
  });

  test("weights halve per half-life of later initiatives; a sample without a start counts as newest", () => {
    const { startedAt: _t, ...undated } = sample(9, 0, 1);
    const weights = recencyWeights([...SAMPLES, undated], 2);
    expect(weights.get(SAMPLES[0] as FeatureRunSample)).toBeCloseTo(0.5 ** (7 / 2), 9);
    expect(weights.get(SAMPLES[14] as FeatureRunSample)).toBe(1);
    expect(weights.get(undated)).toBe(1);
  });

  test("equal weights give rangeOf's quartiles; fewer than four values take rangeOf", () => {
    const values = [1, 4, 9, 16, 25, 36, 49];
    expect(weightedRangeOf(values.map((v) => [v, 3]))).toEqual(rangeOf(values));
    expect(weightedRangeOf([[10, 1], [30, 5], [20, 1]])).toEqual(rangeOf([10, 30, 20]));
  });

  test("the policy takes a positive half-life and nothing else", () => {
    expect(PolicySchema.shape.sizing.safeParse({ recencyHalfLife: 2 }).success).toBe(true);
    expect(PolicySchema.shape.sizing.safeParse({ recencyHalfLife: 0 }).success).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  estimateInitiative,
  type FeatureRunSample,
  type FeatureToEstimate,
} from "../src/core/workflows/initiatives/estimate.js";

// Bench round 100 retrylane (#2941): the medium pool had no path fit, so the few-path share priced
// the one-path `breaker` at the square root of its share of the pool's median paths. It scaled
// both ends of the pool's middle half, and the high end came out at 675k, under the 735k the feature
// used. Few paths say how cheap a feature can be, not how dear: the share lowers the low end and
// the pool's high end stays. The pool here is made up: medium features of four to eight paths whose
// tokens do not follow their paths, so the pool gives no fit, with a cheap one-path feature among them.

const sample = (runId: string, paths: number, tokens: number): FeatureRunSample => ({
  runId,
  workflowId: "sdd",
  size: "medium",
  paths,
  tokens,
  taskCount: paths,
  source: "shared",
});
const POOL = [
  sample("m1", 4, 1_400_000),
  sample("m2", 8, 900_000),
  sample("m3", 5, 1_300_000),
  sample("m4", 7, 1_000_000),
  sample("m5", 6, 1_200_000),
  sample("m6", 4, 800_000),
];
const feature = (paths: number): FeatureToEstimate => ({
  id: "breaker",
  title: "breaker",
  workflowId: "sdd",
  size: "medium",
  stages: [
    { id: "specify", type: "agent", models: [] },
    { id: "implement", type: "tasks", models: [] },
  ],
  paths,
});
const priced = (paths: number, fewPathPrice: boolean) => {
  const found = estimateInitiative({
    features: [feature(paths)],
    history: [],
    samples: POOL,
    maxTotalTokens: 30_000_000,
    ...(fewPathPrice ? { fewPathPrice } : {}),
  }).features[0];
  if (!found) throw new Error("no estimate");
  return found;
};

describe("the few-path share lowers the low end and keeps the pool's high end (#2941)", () => {
  test("a one-path feature in a pool with no fit: lower low end, the same high end", () => {
    const off = priced(1, false);
    const on = priced(1, true);
    expect(on.pathFit).toBeUndefined();
    expect(on.fewPathShare?.reason).toBe("fewer-paths");
    expect(on.tokens.low).toBeLessThan(off.tokens.low);
    expect(on.tokens.high).toBe(off.tokens.high);
    // The share of the median's 5.5 paths is 0.43: scaled with it, the high end was 0.54M.
    expect(on.tokens.high).toBeGreaterThan(1_000_000);
    // Its point stays the middle of its share of the pool, which calibrates later features: moving
    // it up with the high end freed R66 nodepluck's pool enough that select's true park passed.
    expect(on.expectedTokens).toBeLessThan((on.tokens.low + on.tokens.high) / 2);
    expect(on.expectedTokens).toBeCloseTo((on.tokens.low + 543_662) / 2, -1);
  });

  test("a feature with the pool's usual paths takes the pool's range either way", () => {
    expect(priced(6, true).tokens).toEqual(priced(6, false).tokens);
  });
});

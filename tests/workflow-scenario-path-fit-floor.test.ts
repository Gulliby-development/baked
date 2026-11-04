import { describe, expect, test } from "bun:test";
import {
  estimateInitiative,
  type FeatureRunSample,
  type FeatureToEstimate,
} from "../src/core/workflows/initiatives/estimate.js";

// Bench round 91 stopcut (#2895): the medium pool's path fit placed the one-path `reports` and
// `check` features, and the fit's low end for one path fell below the pool's cheapest sample, a
// three-path feature at 774k. The cheapest whole sample set both low ends, and they used 0.69M and
// 0.57M. The floor is now that sample times the square root of the feature's share of its paths.
// The pool here is made up: medium features of three to eight paths at about 0.77M plus 0.38M for
// each path past three.

const sample = (runId: string, paths: number, tokens: number): FeatureRunSample => ({
  runId,
  workflowId: "sdd",
  size: "medium",
  paths,
  tokens,
  taskCount: paths,
  source: "shared",
});
const CHEAPEST = 774_000;
const POOL = [
  sample("m3", 3, CHEAPEST),
  sample("m4", 4, 1_214_000),
  sample("m5", 5, 1_474_000),
  sample("m6", 6, 1_974_000),
  sample("m7", 7, 2_234_000),
  sample("m8", 8, 2_734_000),
];
const feature = (id: string, paths: number): FeatureToEstimate => ({
  id,
  title: id,
  workflowId: "sdd",
  size: "medium",
  stages: [
    { id: "specify", type: "agent", models: [] },
    { id: "implement", type: "tasks", models: [] },
  ],
  paths,
});
const priced = (paths: number) => {
  const estimate = estimateInitiative({
    features: [feature("f", paths)],
    history: [],
    samples: POOL,
    maxTotalTokens: 30_000_000,
  });
  const found = estimate.features[0];
  if (!found?.pathFit) throw new Error("the pool gave no path fit");
  return found;
};

describe("the path fit floors a feature with fewer paths than the pool's cheapest sample below it (#2895)", () => {
  test("a one-path feature's low end is the cheapest sample times the root of a third, under what it used", () => {
    const one = priced(1);
    expect(one.tokens.low).toBe(Math.round(CHEAPEST * Math.sqrt(1 / 3)));
    // R91 stopcut's `check` used 573,733 tokens against a 774k low end.
    expect(one.tokens.low).toBeLessThan(573_733);
    expect(one.tokens.low).toBeLessThan(CHEAPEST);
  });

  test("a feature with as many paths as the cheapest sample keeps it as the floor", () => {
    // The fit at three paths sits about at the cheapest sample; its spread below it is floored there.
    const three = priced(3);
    expect(three.tokens.low).toBeGreaterThanOrEqual(CHEAPEST);
    expect(priced(2).tokens.low).toBeGreaterThan(priced(1).tokens.low);
  });
});

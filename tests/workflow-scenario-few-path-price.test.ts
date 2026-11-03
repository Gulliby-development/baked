import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boundaryKindOf } from "../src/core/workflows/initiatives/documented-surface.js";
import {
  estimateInitiative,
  type FeatureRunSample,
  type FeatureToEstimate,
} from "../src/core/workflows/initiatives/estimate.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";

// Bench round 89 loopwatch (#2640): the split's preview gave `license` (one LICENSE file) the
// small class's low end, 0.63M (0.60M on the pool below), and it used 160,295 tokens. The small pool has no
// path fit (its features name one or two paths and their tokens do not follow them), so the pool's
// middle half priced a one-file feature like any other small feature, and nothing about its single
// path could move its low end: the path floor only raises one. The pool here is the one the replay
// of loopwatch's split reads from the corpus (94 finished features of 16 initiatives, every
// history store of the round that has a trace), with runs and initiatives renamed.
//
// With `sizing.fewPathPrice`, a feature of legal files alone is priced at the path rate, and a
// feature with fewer paths than its pool's median, in a pool with no path fit, at the square root
// of that share of the pool's range. A documentation feature keeps its price: its documented
// surface prices it (#2569), and loopwatch's one-file `docs` used 976,577.

const POOL = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "size-pools", "r89-loopwatch.json"), "utf8"),
) as FeatureRunSample[];
const USED = { application: 1_866_181, docs: 976_577, license: 160_295 };
const SDD = [
  { id: "specify", type: "agent", models: [] },
  { id: "implement", type: "tasks", models: [] },
];
const QUICK = [{ id: "implement", type: "tasks", models: [] }];
const feature = (
  id: string,
  size: FeatureToEstimate["size"],
  paths: string[],
  extra: Partial<FeatureToEstimate> = {},
): FeatureToEstimate => ({
  id,
  title: id,
  workflowId: size === "small" ? "quick" : "sdd",
  size,
  stages: size === "small" ? QUICK : SDD,
  paths: paths.length,
  ...boundaryKindOf({ boundary: { scope: id, paths } }),
  ...extra,
});
// The split as the preview counted it: `application`'s six host-written row files are no paths
// and 86 of its 96 cases the host's (#2640).
const SPLIT = [
  feature("application", "large", ["src/constants.js", "src/parse.js", "src/detect.js", "src/main.js", "bin/loopwatch.js", "tests/helpers/run.js"], { testCases: 10 }),
  feature("docs", "small", ["README.md"]),
  feature("license", "small", ["LICENSE"]),
];
const estimate = (fewPathPrice: boolean, features = SPLIT) =>
  estimateInitiative({
    features,
    history: [],
    samples: POOL,
    maxTotalTokens: 30_000_000,
    language: "javascript",
    testCaseRate: { perCase: { low: 15_000, high: 75_000 }, samples: 0, basis: "defaults" },
    ...(fewPathPrice ? { fewPathPrice } : {}),
  });
const of = (fewPathPrice: boolean, id: string, features = SPLIT) => {
  const found = estimate(fewPathPrice, features).features.find((f) => f.featureId === id);
  if (!found) throw new Error(`no feature ${id}`);
  return found;
};

describe("scenario: R89 loopwatch, a one-file licence feature priced at its path, not its size class (#2640)", () => {
  test("off: the licence has the small class's low end, more than three times what it used", () => {
    const license = of(false, "license");
    expect(license.boundaryKind).toBe("legal");
    expect(license.tokens.low).toBe(of(false, "docs").tokens.low);
    expect(license.tokens.low).toBeGreaterThan(3 * USED.license);
  });

  test("on: the licence's range holds what it used; docs and the large feature keep their price", () => {
    const license = of(true, "license");
    expect(license.tokens.low).toBeLessThanOrEqual(USED.license);
    expect(license.tokens.high).toBeGreaterThanOrEqual(USED.license);
    expect(license.expectedTokens).toBeLessThan(of(false, "license").expectedTokens / 2);
    // The documentation feature is not priced by its one file: its range still holds what it used.
    const docs = of(true, "docs");
    expect(docs.boundaryKind).toBe("documentation");
    expect(docs.tokens.low).toBe(of(false, "docs").tokens.low);
    expect(docs.tokens.high).toBeGreaterThanOrEqual(USED.docs);
    // The large pool has a path fit, which places `application` as before.
    expect(of(true, "application").tokens.low).toBe(of(false, "application").tokens.low);
    expect(estimate(true).expectedTokens).toBeLessThan(estimate(false).expectedTokens);
  });

  test("on: a code feature below its pool's median paths takes the root of that share; at the median it keeps the pool", () => {
    // The medium sdd pool names three paths at its median and has no path fit.
    const one = [feature("one", "medium", ["src/one.js"])];
    const three = [feature("three", "medium", ["src/a.js", "src/b.js", "src/c.js"])];
    const off = of(false, "one", one).tokens.low;
    expect(of(true, "one", one).tokens.low).toBeLessThan(off);
    expect(of(true, "one", one).tokens.low).toBeGreaterThanOrEqual(Math.floor(off * Math.sqrt(1 / 3)));
    expect(of(true, "three", three).tokens.low).toBe(of(false, "three", three).tokens.low);
  });

  test("the policy knob is opt-in", () => {
    const sizing = PolicySchema.shape.sizing.unwrap();
    expect(sizing.parse({ fewPathPrice: true }).fewPathPrice).toBe(true);
    expect(sizing.parse({}).fewPathPrice).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import type { PastRun } from "../src/core/workflows/estimate.js";
import {
  estimateInitiative,
  type FeatureRunSample,
  type FeatureToEstimate,
  testVolumeText,
} from "../src/core/workflows/initiatives/estimate.js";
import { InitiativePlanSchema } from "../src/core/workflows/initiatives/plan.js";
import { DEFAULT_PER_CASE, type SizingSample, testCaseRate } from "../src/core/workflows/sizing.js";

// Bench round 66, nodepluck (#2055): the brief demanded "at least 150 cases", "at most 14 tests per
// file" and "40 cases for the read commands". Its test-writing tasks were 17.26M tokens, 51.9
// percent of the initiative, while the split priced every feature by its size class. A feature
// the request demands test cases of is now forecast at no less than those cases times what a case
// cost in finished test tasks.
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
const sample = (runId: string, size: FeatureRunSample["size"], tokens: number): FeatureRunSample => ({
  runId,
  workflowId: "sdd",
  size,
  tokens,
  taskCount: 6,
});
const SAMPLES = [
  sample("m1", "medium", 1_120_000),
  sample("m2", "medium", 1_500_000),
  sample("m3", "medium", 2_290_000),
  sample("l1", "large", 1_920_000),
  sample("l2", "large", 3_920_000),
];
const feature = (id: string, size: FeatureToEstimate["size"], testCases?: number): FeatureToEstimate => ({
  id,
  title: id,
  workflowId: "sdd",
  size,
  stages: SDD,
  ...(testCases ? { testCases } : {}),
});
const testTask = (runId: string, tokens: number, cases: number, source: SizingSample["source"] = "project", taskId = "T1"): SizingSample => ({
  runId,
  taskId,
  kind: "test",
  action: "create",
  source,
  files: 1,
  tokens,
  model: null,
  cases,
});

describe("scenario: the estimate prices the test volume the request demands (#2055, R66 nodepluck)", () => {
  test("a case costs from the cheapest finished run's rate up to their median, this project's first", () => {
    // Runs at 40k, 30k and 20k a case in this project; another project's dearer 90k does not count.
    // r2's two test tasks are one rate: 450k over 15 cases.
    const rate = testCaseRate([
      testTask("r1", 400_000, 10),
      testTask("r2", 300_000, 5),
      testTask("r2", 150_000, 10, "project", "T2"),
      testTask("r3", 160_000, 8),
      testTask("s1", 900_000, 10, "shared"),
    ]);
    expect(rate).toEqual({ perCase: { low: 20_000, high: 30_000 }, samples: 3, basis: "project" });
    // A cheaper run lowers the low end: no measured run stays under a floor.
    expect(testCaseRate([testTask("r1", 400_000, 10), testTask("r2", 50_000, 10)]).perCase.low).toBe(5_000);
    // A task cheap for its cases inside a dearer run does not: the run's rate is 25k.
    expect(testCaseRate([testTask("r1", 400_000, 10), testTask("r2", 480_000, 10), testTask("r2", 20_000, 10, "project", "T2")]).perCase.low).toBe(25_000);
    // With one project run every store's count; with none, the cold-start allowance.
    expect(testCaseRate([testTask("r1", 400_000, 10), testTask("s1", 900_000, 10, "shared")]).basis).toBe("history");
    expect(testCaseRate([])).toEqual({ perCase: DEFAULT_PER_CASE, samples: 0, basis: "defaults" });
  });

  test("the feature need follows the cases the decomposition carries; features without any keep their class", () => {
    const rate = { perCase: { low: 25_000, high: 40_000 }, samples: 6, basis: "project" as const };
    const features = [feature("base", "medium"), feature("readcmd", "medium", 40), feature("tests", "large", 150)];
    const without = estimateInitiative({ features, history, samples: SAMPLES, maxTotalTokens: 30_000_000 });
    const priced = estimateInitiative({ features, history, samples: SAMPLES, maxTotalTokens: 30_000_000, testCaseRate: rate });
    const of = (e: typeof priced, id: string) => e.features.find((f) => f.featureId === id)!;
    // 150 cases at 25k-40k: 3.75M-6.00M, above the large class's 1.92M-3.92M.
    expect(of(without, "tests").tokens.low).toBeLessThan(3_750_000);
    expect(of(priced, "tests")).toMatchObject({ tokens: { low: 3_750_000, high: 6_000_000 }, floor: "tests", testCases: 150 });
    expect(of(priced, "tests").expectedTokens).toBeGreaterThanOrEqual(3_750_000);
    // 40 cases price 1.00M-1.60M, under the medium class: the class stays.
    expect(of(priced, "readcmd").tokens).toEqual(of(without, "readcmd").tokens);
    expect(of(priced, "base")).toEqual(of(without, "base"));
    expect(priced.tokens.low).toBeGreaterThan(without.tokens.low);
    expect(priced.testVolume).toMatchObject({ cases: 190, features: 2, perCase: rate.perCase });
    expect(priced.notes).toContain(
      "The request demands 190 test cases of 2 features (readcmd 40, tests 150); each feature is forecast at no less than 25k\u201340k tokens per case, as measured on 6 finished test tasks of this project.",
    );
    expect(without.testVolume).toBeNull();
  });

  test("an accepted feature is measured, and its cases leave the volume", () => {
    const rate = { perCase: { low: 25_000, high: 40_000 }, samples: 6, basis: "project" as const };
    const priced = estimateInitiative({
      features: [feature("readcmd", "medium", 40), feature("tests", "large", 150)],
      history,
      samples: SAMPLES,
      maxTotalTokens: 30_000_000,
      testCaseRate: rate,
      progress: { features: { tests: { spent: 5_100_000, accepted: true } }, overhead: 0 },
    });
    expect(priced.features.find((f) => f.featureId === "tests")).toMatchObject({ basis: "measured", tokens: { low: 5_100_000, high: 5_100_000 } });
    expect(priced.testVolume).toMatchObject({ cases: 40, features: 1 });
  });

  test("the split carries test cases only as whole positive numbers", () => {
    const plan = (testCases: unknown) => ({
      schemaVersion: 1,
      title: "t",
      goals: ["g"],
      completionCriteria: ["c"],
      features: [{ id: "tests", title: "Tests", boundary: { scope: "s", paths: ["tests/a.test.ts"] }, contract: "c", dependsOn: [], mandatory: true, testCases }],
    });
    expect(InitiativePlanSchema.safeParse(plan(150)).success).toBe(true);
    expect(InitiativePlanSchema.safeParse(plan(0)).success).toBe(false);
    expect(InitiativePlanSchema.safeParse(plan(1.5)).success).toBe(false);
    expect(testVolumeText({ cases: 3, features: 1, perCase: DEFAULT_PER_CASE, samples: 0, basis: "defaults" }, [{ featureId: "a", testCases: 3 }])).toContain("the default allowance");
  });
});

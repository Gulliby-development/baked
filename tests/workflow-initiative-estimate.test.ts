import { describe, expect, test } from "bun:test";
import type { PastRun } from "../src/core/workflows/estimate.js";
import {
  estimateInitiative,
  estimateSummary,
  type FeatureRunSample,
  type FeatureToEstimate,
  levelOf,
} from "../src/core/workflows/initiatives/estimate.js";

const SDD = [
  { id: "specify", type: "agent", models: [] },
  { id: "plan", type: "agent", models: [] },
  { id: "implement", type: "tasks", models: [] },
  { id: "review", type: "review", models: [] },
];
const QUICK = [{ id: "implement", type: "tasks", models: [] }];
const feature = (
  id: string,
  size: FeatureToEstimate["size"],
  workflowId = "sdd",
): FeatureToEstimate => ({
  id,
  title: id,
  workflowId,
  size,
  stages: workflowId === "sdd" ? SDD : QUICK,
});
const run = (runId: string, workflowId: string, tokens: number, taskCount: number): PastRun => ({
  runId,
  workflowId,
  status: "completed",
  tokens,
  calls: 10,
  activeMs: 1000,
  taskCount,
  stageTokens: { specify: 20_000, plan: 30_000, implement: tokens - 70_000, review: 20_000 },
  taskTokens: tokens - 70_000,
});

describe("initiative estimate", () => {
  test("levels follow the planned task count of the bench ladder", () => {
    expect([6, 8, 10, 12.5, 15, 18.5, 22, 26, 30].map(levelOf)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  test("without history, sizes scale the tasks of a typical run and the margin sets the plan", () => {
    const estimate = estimateInitiative({
      features: [feature("a", "small"), feature("b", "medium"), feature("c", "large")],
      history: [],
      samples: [],
      maxTotalTokens: 100_000_000,
    });
    const [small, medium, large] = estimate.features;
    expect(estimate.basis).toBe("defaults");
    expect(small?.tokens.high).toBeLessThan(medium?.tokens.high ?? 0);
    expect(medium?.tokens.high).toBeLessThan(large?.tokens.high ?? 0);
    // Default task counts 2-6, times 0.5, 1 and 2.
    expect(estimate.features.map((f) => f.tasks)).toEqual([
      { low: 1, high: 3 },
      { low: 2, high: 6 },
      { low: 4, high: 12 },
    ]);
    expect(estimate.tasks).toEqual({ low: 7, high: 21 });
    expect(estimate.level).toBe(3);
    expect(estimate.withMargin).toBe(Math.round(estimate.tokens.high * 1.25));
    expect(estimate.budget.fits).toBe("yes");
    expect(estimate.notes.length).toBe(2);
    expect(estimateSummary(estimate)).toStartWith("Level 3 · ~7-21 tasks");
  });

  test("history of the feature's workflow replaces the defaults", () => {
    const history = [run("r1", "quick", 400_000, 2), run("r2", "quick", 500_000, 3)];
    const estimate = estimateInitiative({
      features: [feature("a", "medium", "quick"), feature("b", "medium", "quick"), feature("c", "medium", "quick")],
      history,
      samples: [],
      maxTotalTokens: 500_000,
    });
    expect(estimate.features[0]?.basis).toBe("workflow-history");
    expect(estimate.features[0]?.tasks).toEqual({ low: 2, high: 3 });
    expect(estimate.budget.fits).toBe("no");
  });

  test("finished feature runs of the same size measure a feature, same workflow first", () => {
    const samples: FeatureRunSample[] = [
      { runId: "s1", workflowId: "sdd", size: "large", tokens: 3_000_000, taskCount: 12 },
      { runId: "s2", workflowId: "quick", size: "large", tokens: 900_000, taskCount: 8 },
      { runId: "s3", workflowId: "quick", size: "large", tokens: 1_100_000, taskCount: 10 },
      { runId: "s4", workflowId: "sdd", size: "small", tokens: 300_000, taskCount: 2 },
    ];
    const estimate = estimateInitiative({
      features: [feature("a", "large", "quick"), feature("b", "large"), feature("c", "medium")],
      history: [],
      samples,
      maxTotalTokens: 10_000_000,
    });
    const [quickLarge, sddLarge, medium] = estimate.features;
    expect(quickLarge).toMatchObject({ basis: "initiative-history", samples: 2, tokens: { low: 900_000, high: 1_100_000 } });
    // One sdd sample is not enough on its own, so every large sample counts.
    expect(sddLarge).toMatchObject({ basis: "initiative-history", samples: 3 });
    expect(medium?.basis).toBe("defaults");
    expect(estimate.basis).toBe("defaults");
  });

  test("accepted features count at what they used and scale the forecast of the rest (#1312)", () => {
    const features = [feature("a", "medium"), feature("b", "medium"), feature("c", "medium")];
    const plain = estimateInitiative({ features, history: [], samples: [], maxTotalTokens: 30_000_000 });
    const forecast = plain.features[0]?.tokens ?? { low: 0, high: 0 };
    const twice = forecast.low + forecast.high;
    const estimate = estimateInitiative({
      features,
      history: [],
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: {
        features: { a: { spent: twice, accepted: true }, b: { spent: 10, accepted: false } },
        overhead: 500_000,
      },
    });
    const [a, b, c] = estimate.features;
    expect(a?.basis).toBe("measured");
    expect(a?.tokens).toEqual({ low: twice, high: twice });
    // Feature a used twice its forecast's middle, so b and c are forecast at twice theirs.
    expect(estimate.progress).toEqual({ spent: 500_000 + twice + 10, accepted: 1, ratio: 2, bySize: { medium: 2 } });
    expect(b?.basis).toBe("calibrated");
    expect(c?.tokens).toEqual({ low: forecast.low * 2, high: forecast.high * 2 });
    expect(estimate.tokens.high).toBe(500_000 + twice + 4 * forecast.high);
    // The margin covers only what is still to run.
    expect(estimate.withMargin).toBe(Math.round(500_000 + twice + 4 * forecast.high * 1.25));
    expect(estimate.notes.join(" ")).toContain("Re-forecast after 1 of 3 features");
    expect(estimate.label).toContain("used with 1 of 3 features accepted");
  });

  test("a running feature is never forecast below what it used, and the ratio is bounded", () => {
    const features = [feature("a", "small"), feature("b", "small")];
    const estimate = estimateInitiative({
      features,
      history: [],
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: {
        features: { a: { spent: 1_000_000_000, accepted: true }, b: { spent: 900_000_000, accepted: false } },
        overhead: 0,
      },
    });
    expect(estimate.progress.ratio).toBe(5);
    expect(estimate.features[1]?.tokens.low).toBe(900_000_000);
    expect(estimate.budget.fits).toBe("no");
  });

  test("a feature with a written spec is forecast at no less than its criteria times the measured rate (#1312)", () => {
    const features = [feature("a", "small"), feature("b", "small"), feature("c", "small")];
    const sample = (runId: string, tokens: number, criteria: number): FeatureRunSample => ({
      runId,
      workflowId: "sdd",
      size: "large",
      tokens,
      taskCount: 10,
      criteria,
    });
    // 1M per criterion on two finished large features; their size keeps them out of the small pool.
    const samples = [sample("x", 4_000_000, 4), sample("y", 6_000_000, 6)];
    const progress = { features: { b: { spent: 0, accepted: false, criteria: 8 } }, overhead: 0 };
    const estimate = estimateInitiative({ features, history: [], samples, maxTotalTokens: 30_000_000, progress });
    const [a, b] = estimate.features;
    expect(estimate.perCriterion).toEqual({ low: 1_000_000, high: 1_000_000 });
    expect(b?.criteria).toBe(8);
    expect(b?.tokens).toEqual({ low: 8_000_000, high: 8_000_000 });
    expect(b?.basis).toBe("calibrated");
    // A feature without a spec yet keeps its size-based forecast.
    expect(a?.basis).toBe("defaults");
    expect(a?.tokens.high).toBeLessThan(8_000_000);
    expect(estimate.notes.join(" ")).toContain("per acceptance criterion");
  });

  test("one measured feature is not enough to price by criteria", () => {
    const features = [feature("a", "medium"), feature("b", "medium")];
    const estimate = estimateInitiative({
      features,
      history: [],
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: {
        features: { a: { spent: 5_000_000, accepted: true, criteria: 5 }, b: { spent: 0, accepted: false, criteria: 20 } },
        overhead: 0,
      },
    });
    expect(estimate.perCriterion).toBeNull();
    expect(estimate.features[0]?.criteria).toBe(5);
    expect(estimate.notes.join(" ")).not.toContain("per acceptance criterion");
  });
});

// Bench round 34 (sketchfold, #1338): a typical sdd run of 1.2M tokens, 0.5M of them in its tasks.
// The split gave both large features the same range, 2.4 times a small one's, and they cost 3.4 to
// 5.5 times a small one; the accepted large feature had used 3.2 times its forecast before the
// other started.
describe("scenario: large features against small ones in an initiative estimate (#1338)", () => {
  const typical = (runId: string, implement: number): PastRun => ({
    ...run(runId, "sdd", 0, 6),
    tokens: implement + 700_000,
    stageTokens: { specify: 250_000, plan: 250_000, implement, review: 200_000 },
    taskTokens: implement,
  });
  const history = [typical("h1", 300_000), typical("h2", 700_000)];
  const features = [
    feature("core", "medium"),
    feature("sketch", "small"),
    feature("docs", "small"),
    feature("bundles", "large"),
    feature("commands", "large"),
  ];

  test("a large feature is forecast at least three times a small one", () => {
    const estimate = estimateInitiative({ features, history, samples: [], maxTotalTokens: 30_000_000 });
    const byId = Object.fromEntries(estimate.features.map((f) => [f.featureId, f]));
    expect(byId.bundles?.basis).toBe("workflow-history");
    expect(byId.bundles?.tokens.low).toBeGreaterThanOrEqual(3 * (byId.sketch?.tokens.low ?? 0));
    expect(byId.bundles?.tokens.high).toBeGreaterThanOrEqual(3 * (byId.sketch?.tokens.high ?? 0));
  });

  test("an accepted large feature re-forecasts the other large one by its own overrun", () => {
    const plain = estimateInitiative({ features, history, samples: [], maxTotalTokens: 30_000_000 });
    const forecast = (id: string) => plain.features.find((f) => f.featureId === id)?.tokens ?? { low: 0, high: 0 };
    const mid = (id: string) => (forecast(id).low + forecast(id).high) / 2;
    const estimate = estimateInitiative({
      features,
      history,
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: {
        features: {
          core: { spent: Math.round(mid("core")), accepted: true },
          bundles: { spent: Math.round(mid("bundles") * 3.2), accepted: true },
        },
        overhead: 0,
      },
    });
    const commands = estimate.features.find((f) => f.featureId === "commands");
    expect(estimate.progress.bySize.large).toBeCloseTo(3.2, 2);
    expect(estimate.progress.bySize.medium).toBeCloseTo(1, 2);
    expect(commands?.basis).toBe("calibrated");
    expect(commands?.tokens.low).toBeGreaterThanOrEqual(Math.floor(forecast("commands").low * 3.19));
    expect(commands?.tokens.high).toBeGreaterThanOrEqual(Math.floor(forecast("commands").high * 3.19));
    // Small features have no accepted feature of their size and keep the overall ratio.
    const docs = estimate.features.find((f) => f.featureId === "docs");
    const overall = estimate.progress.ratio ?? 0;
    expect(overall).toBeLessThan(3);
    expect(docs?.tokens.high).toBe(Math.round(forecast("docs").high * overall));
    expect(estimate.notes.join(" ")).toContain("Accepted large features used 3.2 times their forecast");
  });
});

// Bench round 35 (narrowfit, #1354): four large features named 4, 5, 6 and 11 boundary paths and
// got one range; language (11 paths) used 7.9M against a high end of 2.65M, after core, solver,
// cli and the small features were accepted at 0.36M to 0.58M per path. Its plan then sized its
// tasks at about 4.8M to 8.5M tokens while the estimate still said 2.65M at most.
describe("scenario: features estimated from their boundary paths and their plan (#1354)", () => {
  const typical = (runId: string, implement: number): PastRun => ({
    ...run(runId, "sdd", 0, 6),
    tokens: implement + 700_000,
    stageTokens: { specify: 250_000, plan: 250_000, implement, review: 200_000 },
    taskTokens: implement,
  });
  const history = [typical("h1", 300_000), typical("h2", 700_000)];
  const withPaths = (id: string, size: FeatureToEstimate["size"], paths: number) => ({ ...feature(id, size), paths });
  const features = [
    withPaths("core", "large", 4),
    withPaths("solver", "large", 5),
    withPaths("cli", "large", 6),
    withPaths("language", "large", 11),
    withPaths("release", "medium", 3),
    withPaths("sum", "small", 1),
    withPaths("alldiff", "small", 1),
  ];
  const accepted = {
    core: { spent: 1_839_836, accepted: true },
    solver: { spent: 1_816_678, accepted: true },
    cli: { spent: 3_086_741, accepted: true },
    sum: { spent: 575_000, accepted: true },
    alldiff: { spent: 439_000, accepted: true },
  };

  test("a feature still to run is forecast at no less than its paths times the measured rate", () => {
    const estimate = estimateInitiative({
      features,
      history,
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: { features: accepted, overhead: 0 },
    });
    const language = estimate.features.find((f) => f.featureId === "language");
    expect(language?.paths).toBe(11);
    expect(estimate.perPath).not.toBeNull();
    const perPath = estimate.perPath ?? { low: 0, high: 0 };
    expect(perPath.low).toBeGreaterThanOrEqual(400_000);
    expect(language?.tokens.low).toBeGreaterThanOrEqual(11 * perPath.low);
    expect(language?.tokens.high).toBeGreaterThanOrEqual(11 * perPath.high);
    expect(language?.tokens.high).toBeGreaterThanOrEqual(5_000_000);
    expect(language?.basis).toBe("calibrated");
    expect(estimate.notes.join(" ")).toContain("per path of its boundary");
  });

  test("a feature whose run has a sized plan is forecast at no less than the plan's tasks", () => {
    const planned = { low: 4_800_000, high: 8_500_000 };
    const estimate = estimateInitiative({
      features,
      history,
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: {
        features: { ...accepted, language: { spent: 900_000, accepted: false, planned } },
        overhead: 0,
      },
    });
    const language = estimate.features.find((f) => f.featureId === "language");
    expect(language?.planned).toEqual(planned);
    expect(language?.tokens.low).toBeGreaterThanOrEqual(planned.low);
    expect(language?.tokens.high).toBeGreaterThanOrEqual(planned.high);
    expect(estimate.notes.join(" ")).toContain("the tokens its plan sized");
  });

  test("paths measured on earlier initiatives' feature runs price a split before any feature runs", () => {
    const sample = (runId: string, tokens: number, paths: number): FeatureRunSample => ({
      runId,
      workflowId: "sdd",
      size: "medium",
      tokens,
      taskCount: 6,
      paths,
    });
    const estimate = estimateInitiative({
      features,
      history,
      samples: [sample("a", 1_500_000, 3), sample("b", 3_500_000, 5)],
      maxTotalTokens: 30_000_000,
    });
    const byId = Object.fromEntries(estimate.features.map((f) => [f.featureId, f]));
    expect(estimate.perPath).toEqual({ low: 500_000, high: 700_000 });
    expect(byId.language?.tokens).toEqual({ low: 5_500_000, high: 7_700_000 });
    // Fewer paths than a typical large feature never lowers its size-based forecast.
    expect(byId.core?.tokens.high).toBeGreaterThanOrEqual(4 * 700_000);
  });
});


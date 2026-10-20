import { describe, expect, test } from "bun:test";
import type { PastRun } from "../src/core/workflows/estimate.js";
import {
  estimateInitiative,
  estimateSummary,
  type FeatureRunSample,
  type FeatureToEstimate,
  levelOf,
  PLACEHOLDER_SHARE,
} from "../src/core/workflows/initiatives/estimate.js";
import { boundaryPathCounts, type InitiativePlan } from "../src/core/workflows/initiatives/plan.js";

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

  test("one accepted feature counts at what it used while the rest keep their plan (#1631)", () => {
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
    expect(estimate.progress).toEqual({ spent: 500_000 + twice + 10, accepted: 1, ratio: null, bySize: {} });
    expect(b?.basis).toBe("defaults");
    expect(c?.tokens).toEqual(forecast);
    expect(estimate.tokens.high).toBe(500_000 + twice + 2 * forecast.high);
    // The margin covers only what is still to run.
    expect(estimate.withMargin).toBe(Math.round(500_000 + twice + 2 * forecast.high * 1.25));
    expect(estimate.label).toContain("used with 1 of 3 features accepted");
  });

  test.each([0, 1, 2, 3, 4, 5, 6])("%i accepted features blend measured usage only after three samples", (count) => {
    const features = Array.from({ length: 7 }, (_, i) => feature(`f${i}`, "medium"));
    const input = { features, history: [], samples: [], maxTotalTokens: 30_000_000 };
    const prior = estimateInitiative(input).features[0]!;
    const midpoint = prior.expectedTokens;
    const estimate = estimateInitiative({ ...input, progress: {
      features: Object.fromEntries(features.slice(0, count).map((f) => [f.id, { spent: midpoint * 2, accepted: true }])), overhead: 0,
    } });
    const ratio = count < 3 ? null : 1 + Math.min(1, (count - 2) / 3);
    expect(estimate.progress.ratio).toBe(ratio);
    expect(estimate.progress.bySize.medium).toBe(ratio ?? undefined);
    expect(estimate.features[6]!.expectedTokens).toBeCloseTo(midpoint * (ratio ?? 1), 0);
  });

  test("accepted skeleton features never supply calibration samples, even beside five real features", () => {
    const features = [
      ...Array.from({ length: 5 }, (_, i) => feature(`f${i}`, "medium")),
      ...Array.from({ length: 4 }, (_, i) => ({ ...feature(`host${i}`, "medium"), skeleton: 24 })),
      feature("next", "medium"),
    ];
    const input = { features, history: [], samples: [], maxTotalTokens: 30_000_000 };
    const midpoint = estimateInitiative(input).features[0]!.expectedTokens;
    const estimate = estimateInitiative({ ...input, progress: {
      features: Object.fromEntries(features.slice(0, -1).map((f) => [f.id, { spent: midpoint * ("skeleton" in f ? 50 : 2), accepted: true }])), overhead: 0,
    } });
    expect(estimate.progress.ratio).toBe(2);
    expect(estimate.progress.bySize.medium).toBe(2);
    expect(estimate.features.at(-1)!.expectedTokens).toBe(midpoint * 2);
    const onlySkeletons = estimateInitiative({ ...input, progress: {
      features: Object.fromEntries(features.filter((f) => "skeleton" in f).map((f) => [f.id, { spent: midpoint * 50, accepted: true }])), overhead: 0,
    } });
    expect(onlySkeletons.progress.ratio).toBeNull();
    expect(onlySkeletons.progress.bySize).toEqual({});
    expect(onlySkeletons.features.at(-1)!.expectedTokens).toBe(midpoint);
    const twoReal = estimateInitiative({ ...input, progress: {
      features: Object.fromEntries(features.filter((f, i) => i < 2 || "skeleton" in f).map((f) => [f.id, { spent: midpoint * 2, accepted: true }])), overhead: 0,
    } });
    expect(twoReal.progress.accepted).toBe(6);
    expect(twoReal.progress.ratio).toBeNull();
    expect(twoReal.progress.bySize).toEqual({});
  });

  test("a running feature is never forecast below what it used, and the ratio is bounded", () => {
    const features = ["a", "b", "c", "d", "e", "f"].map((id) => feature(id, "small"));
    const estimate = estimateInitiative({
      features,
      history: [],
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: {
        features: { a: { spent: 1_000_000_000, accepted: true }, b: { spent: 900_000_000, accepted: false },
          ...Object.fromEntries(["c", "d", "e", "f"].map((id) => [id, { spent: 1_000_000_000, accepted: true }])) },
        overhead: 0,
      },
    });
    expect(estimate.progress.ratio).toBe(5);
    expect(estimate.features[1]?.tokens.low).toBe(900_000_000);
    expect(estimate.budget.fits).toBe("no");
  });

  test.each(["small", "medium", "large"] as const)("%s features calibrate below 25 percent without raising the dollar point forecast (#1607)", (size) => {
    const features = ["a", "b", "d", "e", "f", "c"].map((id) => ({ ...feature(id, size), paths: 1 }));
    const estimate = estimateInitiative({
      features, history: [], samples: [], maxTotalTokens: 30_000_000,
      progress: { features: Object.fromEntries(["a", "b", "d", "e", "f"].map((id) => [id, { spent: 40_000, accepted: true }])), overhead: 0 },
    });
    expect(estimate.progress.ratio).toBeLessThan(0.25);
    expect(estimate.progress.bySize[size]).toBe(estimate.progress.ratio!);
    expect(estimate.features.map((f) => f.expectedTokens)).toEqual(Array(6).fill(40_000));
    const next = estimate.features[5]!;
    // The path floor raises the low end, so the resulting range's midpoint is no longer the
    // calibrated point forecast. Keep that uncertainty for token reserves, not dollar stops.
    expect(next.tokens.low).toBe(40_000);
    expect((next.tokens.low + next.tokens.high) / 2).toBeGreaterThan(next.expectedTokens);
    expect(estimate.withMargin).toBe(200_000 + Math.round(next.tokens.high * 1.25));
  });

  test.each(["criteria", "plan", "spent"] as const)("the dollar point forecast still respects the feature's %s floor (#1607)", (floor) => {
    const estimate = estimateInitiative({
      features: ["a", "b", "c", "d", "e", "f"].map((id) => ({ ...feature(id, "medium"), paths: 1 })),
      history: [], samples: [], maxTotalTokens: 30_000_000,
      progress: { features: {
        a: { spent: 40_000, accepted: true, criteria: 1 },
        b: { spent: 40_000, accepted: true, criteria: 1 },
        ...Object.fromEntries(["d", "e", "f"].map((id) => [id, { spent: 40_000, accepted: true, criteria: 1 }])),
        c: { spent: floor === "spent" ? 400_000 : 10_000, accepted: false,
          ...(floor === "criteria" ? { criteria: 10 } : {}),
          ...(floor === "plan" ? { planned: { low: 300_000, high: 500_000 } } : {}),
        },
      }, overhead: 0 },
    });
    expect(estimate.features[2]?.expectedTokens).toBe(400_000);
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

  test("five accepted large features re-forecast the other large one by their own overrun", () => {
    const extended = [...features.filter((f) => f.id !== "sketch"),
      ...Array.from({ length: 4 }, (_, i) => feature(`large${i}`, "large")),
      ...Array.from({ length: 4 }, (_, i) => feature(`medium${i}`, "medium")),
    ];
    const plain = estimateInitiative({ features: extended, history, samples: [], maxTotalTokens: 30_000_000 });
    const forecast = (id: string) => plain.features.find((f) => f.featureId === id)?.tokens ?? { low: 0, high: 0 };
    const mid = (id: string) => (forecast(id).low + forecast(id).high) / 2;
    const estimate = estimateInitiative({
      features: extended,
      history,
      samples: [],
      maxTotalTokens: 30_000_000,
      progress: {
        features: {
          core: { spent: Math.round(mid("core")), accepted: true },
          bundles: { spent: Math.round(mid("bundles") * 3.2), accepted: true },
          ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`large${i}`, { spent: Math.round(mid(`large${i}`) * 3.2), accepted: true }])),
          ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`medium${i}`, { spent: Math.round(mid(`medium${i}`)), accepted: true }])),
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
    expect(estimate.notes.join(" ")).toContain("Accepted large non-skeleton features blend with their planned estimates");
  });

  test("one accepted feature of a size cannot override the blended overall ratio", () => {
    const input = { features, history, samples: [], maxTotalTokens: 30_000_000 };
    const plain = estimateInitiative(input);
    const progress = Object.fromEntries(plain.features.slice(0, 4).map((f) => [f.featureId, {
      spent: f.expectedTokens * (f.size === "large" ? 4 : 1), accepted: true,
    }]));
    const estimate = estimateInitiative({ ...input, progress: { features: progress, overhead: 0 } });
    expect(estimate.progress.bySize).toEqual({});
    expect(estimate.progress.ratio).toBeGreaterThan(1);
    const next = estimate.features.find((f) => f.featureId === "commands")!;
    expect(next.expectedTokens).toBeCloseTo(plain.features.find((f) => f.featureId === "commands")!.expectedTokens * estimate.progress.ratio!, 0);
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
    expect(estimate.notes.join(" ")).toContain("the tokens its plan sizing expects the whole run to use");
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
    // From the lowest rate up to the median (#1354, R36).
    expect(estimate.perPath).toEqual({ low: 500_000, high: 600_000 });
    expect(byId.language?.tokens).toEqual({ low: 5_500_000, high: 6_600_000 });
    // Fewer paths than a typical large feature never lowers its size-based forecast.
    expect(byId.core?.tokens.high).toBeGreaterThanOrEqual(4 * 600_000);
  });
});

// Bench round 36 (seqmill, #1354 follow-up): tokens per path ran from 0.29M (formats, 7 paths) to
// 1.28M (alignment, 2 paths: one rule-dense module and its test), and a floor at the highest rate
// put the high end 1.3 to 1.9 times above what the features used. Tokens per spec criterion were
// steadier, 155k to 320k.
describe("scenario: the path floor at the median rate, and criteria once a spec exists (#1354, R36)", () => {
  const withPaths = (id: string, paths: number) => ({ ...feature(id, "medium"), paths });
  const features = [
    withPaths("core", 8),
    withPaths("formats", 7),
    withPaths("quality", 2),
    withPaths("alignment", 2),
    withPaths("transforms", 5),
    // Many paths in one boundary, as a cli that names each subcommand's module and test.
    withPaths("cli", 20),
  ];
  const progress = {
    features: {
      core: { spent: 2_770_000, accepted: true, criteria: 12 },
      formats: { spent: 2_020_000, accepted: true, criteria: 13 },
      quality: { spent: 1_820_000, accepted: true, criteria: 7 },
      alignment: { spent: 2_560_000, accepted: true, criteria: 8 },
      cli: { spent: 0, accepted: false, criteria: 10 },
    },
    overhead: 0,
  };

  test("a feature without a spec is floored at its paths times the median rate, not the highest", () => {
    const estimate = estimateInitiative({ features, history: [], samples: [], maxTotalTokens: 30_000_000, progress });
    const rates = [2_770_000 / 8, 2_020_000 / 7, 1_820_000 / 2, 2_560_000 / 2].sort((a, b) => a - b);
    const median = Math.round(((rates[1] ?? 0) + (rates[2] ?? 0)) / 2);
    expect(estimate.perPath?.high).toBe(median);
    // transforms (5 paths) used 2.0M; at the highest rate (1.28M a path) its floor said 6.4M.
    const transforms = estimate.features.find((f) => f.featureId === "transforms");
    expect(transforms?.tokens.high).toBeLessThan(5 * 1_000_000);
  });

  test("a feature whose spec is written is priced by its criteria, not its paths", () => {
    const estimate = estimateInitiative({ features, history: [], samples: [], maxTotalTokens: 30_000_000, progress });
    const cli = estimate.features.find((f) => f.featureId === "cli");
    const perCriterion = estimate.perCriterion ?? { low: 0, high: 0 };
    expect(cli?.criteria).toBe(10);
    // cli used 1.95M; its criteria floor stays near it while 20 paths would say 9M or more.
    expect(cli?.tokens.high).toBeGreaterThanOrEqual(10 * perCriterion.high);
    expect(cli?.tokens.high).toBeLessThan(20 * (estimate.perPath?.low ?? 0));
  });
});


describe("scenario: the split estimate floored by paths at another project's rate (#1376, R37)", () => {
  // ranktally: core, methods and cli (large, 10, 10 and 9 paths) all got 1.60M-2.85M and used
  // 4.34M, 5.35M and 6.19M; release (small, 3 paths) got 0.43M-0.77M and used 1.65M. Before any
  // feature ran, the only measured path rates were the finished features of earlier projects.
  const withPaths = (id: string, size: FeatureToEstimate["size"], paths: number) => ({ ...feature(id, size), paths });
  const features = [
    withPaths("core", "large", 10),
    withPaths("formats", "medium", 4),
    withPaths("methods", "large", 10),
    withPaths("cli", "large", 9),
    withPaths("release", "small", 3),
  ];
  const shared = (runId: string, size: FeatureRunSample["size"], tokens: number, paths: number): FeatureRunSample => ({
    runId,
    workflowId: "sdd",
    size,
    tokens,
    taskCount: 8,
    paths,
    source: "shared",
  });
  // Fifteen runs of the workflow, which priced a large feature at 1.6M to 2.2M as R37 did.
  const history = Array.from({ length: 15 }, (_, i) => run(`r${i}`, "sdd", 700_000 + i * 40_000, 8));
  // Earlier projects' features: 0.48M to 0.69M per path.
  const samples = [
    shared("a", "medium", 1_400_000, 4),
    shared("b", "medium", 2_400_000, 5),
    shared("c", "small", 1_380_000, 2),
    shared("d", "small", 1_100_000, 2),
  ];

  test("features of one size are told apart by their paths before any of them runs", () => {
    const plain = estimateInitiative({ features, history, samples: [], maxTotalTokens: 30_000_000 });
    const estimate = estimateInitiative({ features, history, samples, maxTotalTokens: 30_000_000 });
    const of = (e: typeof estimate, id: string) => e.features.find((f) => f.featureId === id);
    // By size class alone every large feature has the same range, whatever its boundary.
    expect(plain.tokens.high).toBeLessThan(10_840_000);
    expect(of(plain, "core")?.tokens).toEqual(of(plain, "cli")?.tokens ?? { low: -1, high: -1 });
    expect(estimate.perPathSamples).toEqual({ features: 4, shared: 4 });
    const perPath = estimate.perPath ?? { low: 0, high: 0 };
    for (const id of ["core", "methods", "cli"]) {
      const f = of(estimate, id);
      expect(f?.floor).toBe("paths");
      expect(f?.basis).toBe("calibrated");
      expect(f?.tokens.high).toBe((f?.paths ?? 0) * perPath.high);
    }
    expect(of(estimate, "cli")?.tokens.high).toBeLessThan(of(estimate, "core")?.tokens.high ?? 0);
    // ranktally used 18.98M: within this estimate's margin, and well above the size class's.
    expect(estimate.tokens.high).toBeGreaterThan(18_980_000 * 0.95);
    expect(estimate.withMargin).toBeGreaterThan(18_980_000);
    expect(estimate.notes.join("\n")).toContain("as measured on 4 finished features (4 of other projects)");
  });
});

describe("scenario: a feature's own skeleton costs nothing in the estimate (#1550, R45)", () => {
  // grundykit: base owned 6 files and its skeleton held the 22 module stubs the later features
  // fill. The host wrote the skeleton (T001, 0 tokens); base used 2.25M. At 1/3 of a path per stub
  // the floor said 281,827 x (6 + 22/3) = 3.76M low; at 0 it says 1.69M.
  const stubs = Array.from({ length: 22 }, (_, i) => `src/m${i}.rs`);
  const node = (id: string, paths: string[], skeleton?: string[]): InitiativePlan["features"][number] => ({
    id,
    title: id,
    boundary: { scope: id, paths },
    contract: id,
    dependsOn: id === "base" ? [] : ["base"],
    mandatory: true,
    ...(skeleton ? { skeleton: skeleton.map((path) => ({ path, content: "// stub\n" })) } : {}),
  });
  const own = ["src/lib.rs", "src/group.rs", "src/error.rs", "src/parse.rs", "src/table.rs", "Cargo.toml"];
  const grundykit: InitiativePlan = {
    schemaVersion: 1,
    title: "grundykit",
    goals: ["g"],
    completionCriteria: ["c"],
    features: [
      node("base", [...own, ...stubs], stubs),
      node("games", stubs.slice(0, 11)),
      node("solver", stubs.slice(11)),
    ],
  };

  test("skeleton files count apart, neither as paths nor as placeholders", () => {
    expect(Object.fromEntries(boundaryPathCounts(grundykit))).toEqual({
      base: { paths: 6, placeholders: 0, skeleton: 22 },
      games: { paths: 11, placeholders: 0, skeleton: 0 },
      solver: { paths: 11, placeholders: 0, skeleton: 0 },
    });
    // A skeleton file only its own feature lists (a registration file) is host-written too.
    const alone = { ...grundykit, features: [node("base", own, ["src/lib.rs"])] };
    expect(boundaryPathCounts(alone).get("base")).toEqual({ paths: 5, placeholders: 0, skeleton: 1 });
  });

  test("the path floor prices base's own files only, and the actual spend is inside the range", () => {
    const counts = boundaryPathCounts(grundykit);
    const features = grundykit.features.map((f) => ({ ...feature(f.id, "large"), ...counts.get(f.id) }));
    const sample = (runId: string, tokens: number): FeatureRunSample => ({
      runId,
      workflowId: "sdd",
      size: "medium",
      tokens,
      taskCount: 8,
      paths: 4,
    });
    const samples = [sample("a", 281_827 * 4), sample("b", 426_851 * 4)];
    const estimate = estimateInitiative({ features, history: [], samples, maxTotalTokens: 30_000_000 });
    const base = estimate.features.find((f) => f.featureId === "base");
    expect(base).toMatchObject({ paths: 6, skeleton: 22, floor: "paths" });
    expect(base?.placeholders).toBeUndefined();
    expect(base?.tokens.low).toBe(281_827 * 6);
    expect(base?.tokens.low).toBeLessThan(2_245_117);
    expect(base?.tokens.high).toBeGreaterThan(2_245_117);
    expect(estimate.notes.join("\n")).toContain("A file of a feature's skeleton counts nothing");
  });

  test("a finished skeleton feature's rate is per file it wrote, not diluted by its stubs", () => {
    const counts = boundaryPathCounts(grundykit).get("base");
    const samples: FeatureRunSample[] = [
      { runId: "a", workflowId: "sdd", size: "medium", tokens: 2_400_000, taskCount: 5, ...counts },
      { runId: "b", workflowId: "sdd", size: "medium", tokens: 1_600_000, taskCount: 5, paths: 4 },
    ];
    const estimate = estimateInitiative({ features: [feature("x", "medium")], history: [], samples, maxTotalTokens: 10_000_000 });
    expect(estimate.perPath).toEqual({ low: 400_000, high: 400_000 });
  });
});

describe("scenario: a placeholder two features list counts in full once (#1464, R40)", () => {
  // tonemath: core listed its 7 files and 15 module stubs that theory, analysis and front then
  // filled, 48 boundary paths for 33 files. Core sat on the path floor at 22 x 389k = 8.57M low
  // and used 5.56M; the stubs cost about 129k each, a third of a full path.
  const node = (id: string, paths: string[]): InitiativePlan["features"][number] => ({
    id,
    title: id,
    boundary: { scope: id, paths },
    contract: id,
    dependsOn: id === "core" ? [] : ["core"],
    mandatory: true,
  });
  const files = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `src/${dir}/m${i}.rs`);
  const stubs = { theory: files("theory", 5), analysis: files("analysis", 5), front: files("front", 5) };
  const tonemath: InitiativePlan = {
    schemaVersion: 1,
    title: "tonemath",
    goals: ["g"],
    completionCriteria: ["c"],
    features: [
      node("core", [...files("core", 7), ...stubs.theory, ...stubs.analysis, ...stubs.front]),
      node("theory", [...stubs.theory, "src/theory/scale.rs"]),
      node("analysis", [...stubs.analysis, "src/analysis/key.rs"]),
      node("front", [...stubs.front, ...files("front-cli", 6)]),
      node("docs", ["README.md", "docs/usage.md", "CHANGELOG.md"]),
    ],
  };

  test("each path counts in full only in the last feature that lists it", () => {
    const counts = boundaryPathCounts(tonemath);
    expect(Object.fromEntries(counts)).toEqual({
      core: { paths: 7, placeholders: 15, skeleton: 0 },
      theory: { paths: 6, placeholders: 0, skeleton: 0 },
      analysis: { paths: 6, placeholders: 0, skeleton: 0 },
      front: { paths: 11, placeholders: 0, skeleton: 0 },
      docs: { paths: 3, placeholders: 0, skeleton: 0 },
    });
    // 33 distinct files, not the 48 the boundaries list.
    expect([...counts.values()].reduce((n, c) => n + c.paths, 0)).toBe(33);
    // A glob boundary claims no path and counts none.
    const glob = { ...tonemath, features: [...tonemath.features, node("all", ["src/**"])] };
    expect(boundaryPathCounts(glob).get("all")).toEqual({ paths: 0, placeholders: 0, skeleton: 0 });
    expect(boundaryPathCounts(glob).get("core")).toEqual({ paths: 7, placeholders: 15, skeleton: 0 });
  });

  const sample = (runId: string, tokens: number, paths: number, placeholders = 0): FeatureRunSample => ({
    runId,
    workflowId: "sdd",
    size: "medium",
    tokens,
    taskCount: 8,
    paths,
    ...(placeholders ? { placeholders } : {}),
  });

  test("the floor counts a placeholder at its share in the feature that creates it", () => {
    const counts = boundaryPathCounts(tonemath);
    const features = tonemath.features.map((f) => ({ ...feature(f.id, "large"), ...counts.get(f.id) }));
    // Finished features at 389k and 506k per path.
    const samples = [sample("a", 389_476 * 4, 4), sample("b", 506_000 * 4, 4)];
    const estimate = estimateInitiative({ features, history: [], samples, maxTotalTokens: 40_000_000 });
    const core = estimate.features.find((f) => f.featureId === "core");
    expect(core).toMatchObject({ paths: 7, placeholders: 15, floor: "paths" });
    // 7 + 15 / 3 = 12 paths: 4.67M low against 5.56M used, where 22 paths said 8.57M.
    expect(core?.tokens.low).toBe(Math.round(389_476 * (7 + 15 * PLACEHOLDER_SHARE)));
    expect(core?.tokens.low).toBeLessThan(5_560_000);
    expect(estimate.notes.join("\n")).toContain("counts in full only in that feature, and at 33% as a placeholder");
  });

  test("a finished feature's placeholders do not dilute the per-path rate", () => {
    // 1.2M for 2 files and 3 stubs is 400k per path, not the 240k five full paths would say.
    const samples = [sample("a", 1_200_000, 2, 3), sample("b", 800_000, 2)];
    const estimate = estimateInitiative({ features: [feature("x", "medium")], history: [], samples, maxTotalTokens: 10_000_000 });
    expect(estimate.perPath).toEqual({ low: 400_000, high: 400_000 });
    expect(estimate.perPathSamples).toEqual({ features: 2, shared: 0 });
  });
});

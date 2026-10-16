import { describe, expect, test } from "bun:test";
import type {
  AttemptUsageRow,
  InitiativeEstimate,
  InitiativeFeature,
  InitiativeView,
  RunUsageReport,
  UsageGroup,
  UsageSummary,
} from "../src/renderer/client/insights.ts";
import { MOCK_ROUTES, type MockRequest } from "../src/renderer/client/mock-routes.ts";
import {
  budgetExtension,
  budgetFields,
  costLine,
  parseUsd,
  canEditSplit,
  canExtendBudget,
  canRemoveFeature,
  canReplanFeature,
  canSplitFeature,
  canSwitchModel,
  configurableFeatures,
  detailStatus,
  estimateBasisText,
  estimateFit,
  featureCounts,
  featureRow,
  featureSteps,
  featureWorkflow,
  featureWorkflowChoices,
  initiativeIsLive,
  initiativeLine,
  isInitiativeKey,
  mergeProblem,
  parseBudget,
  parseCount,
  splitProblem,
  startBody,
  suggestInitiativeId,
} from "../src/renderer/screens/insights/initiative-model.ts";
import {
  aggregateUsage,
  crossUsage,
  isCurrentSummary,
  serverFilter,
  stageKey,
  summarizeUsage,
  taskGenerationUsage,
} from "../src/renderer/screens/insights/usage-model.ts";

const none = { stage: null, model: null };

function attempt(
  stage: string,
  model: string | null,
  usedTokens: number | null,
  cacheReadTokens: number | null,
  extra: Partial<AttemptUsageRow> = {},
): AttemptUsageRow {
  return {
    attemptId: `${stage}-${model}`,
    stage,
    model,
    status: "succeeded",
    usedTokens,
    cacheReadTokens,
    ...extra,
  };
}

function run(runId: string, attempts: AttemptUsageRow[]): RunUsageReport {
  return {
    runId,
    totalTokens: attempts.reduce((s, a) => s + (a.usedTokens ?? 0), 0),
    attempts,
  };
}

const RUNS = [
  run("a", [
    attempt("research", "haiku", 100, 60),
    attempt("task-T001", "sonnet", 300, 200),
    attempt("task-T002", "sonnet", 100, 50),
  ]),
  run("b", [attempt("review", "gpt", 200, 100), attempt("checks", null, null, null)]),
];

describe("taskGenerationUsage", () => {
  // Bench round 24 (#936): a task's reruns after repairs were folded into one row.
  const report = run("a", [
    attempt("task-T008", "sonnet", 300, 100, { attemptId: "1", taskId: "T008", taskGeneration: 0, costUsd: 1 }),
    attempt("task-T008", "sonnet", 200, 50, { attemptId: "2", taskId: "T008", taskGeneration: 1, costUsd: 0.5 }),
    attempt("task-T008", null, 0, 0, { attemptId: "3", taskId: "T008", taskGeneration: 1, costUsd: 0 }),
    attempt("task-T010", "sonnet", 50, 0, { attemptId: "4", taskId: "T010", taskGeneration: 0, costUsd: 0.1 }),
    attempt("review", "gpt", 400, 0, { attemptId: "5", taskId: null, taskGeneration: null }),
  ]);

  test("each task generation is its own row, in task then generation order", () => {
    const slices = taskGenerationUsage([report], none);
    expect(slices.map((s) => [s.taskId, s.generation, s.tokens, s.attempts, s.costUsd])).toEqual([
      ["T008", 0, 300, 1, 1],
      ["T008", 1, 200, 2, 0.5],
      ["T010", 0, 50, 1, 0.1],
    ]);
  });

  test("the model filter applies and another stage leaves no task rows", () => {
    expect(taskGenerationUsage([report], { stage: null, model: "(host)" })).toHaveLength(1);
    expect(taskGenerationUsage([report], { stage: "review", model: null })).toEqual([]);
    expect(taskGenerationUsage([run("b", [attempt("task-T001", "x", 5, 0)])], none)).toEqual([]);
  });
});

describe("aggregateUsage", () => {
  test("totals, cache share and task stages folded into implement", () => {
    const report = aggregateUsage(RUNS, { a: 5, b: 2 }, none);
    expect(report.totalTokens).toBe(700);
    expect(report.cachedTokens).toBe(410);
    expect(report.cacheShare).toBeCloseTo(410 / 700);
    expect(report.runs).toBe(2);
    expect(report.attempts).toBe(5);
    expect(report.costUsd).toBeCloseTo(7);
    expect(report.outputTokens).toBeNull();
    expect(report.byStage.map((s) => [s.key, s.tokens])).toEqual([
      ["research", 100],
      ["implement", 400],
      ["checks", 0],
      ["review", 200],
    ]);
    expect(report.byModel.map((s) => s.key)).toEqual(["sonnet", "gpt", "haiku", "(host)"]);
    expect(report.stages).toEqual(["research", "implement", "checks", "review"]);
    expect(report.crossFiltered).toBe(true);
  });

  test("filters by stage and model together and spreads run cost by tokens", () => {
    const report = aggregateUsage(RUNS, { a: 5, b: null }, { stage: "implement", model: "sonnet" });
    expect(report.totalTokens).toBe(400);
    expect(report.runs).toBe(1);
    expect(report.costUsd).toBeCloseTo(4);
    expect(report.byModel).toHaveLength(1);
    expect(report.byStage[0]?.fresh).toBe(150);
    // Options still list everything, so a filter can be changed without clearing it first.
    expect(report.models).toContain("gpt");
  });

  test("runs without a cost estimate leave cost unknown", () => {
    const report = aggregateUsage(RUNS, {}, { stage: "review", model: null });
    expect(report.costUsd).toBeNull();
    expect(report.byModel[0]?.costUsd).toBeNull();
  });

  test("output is split out only when every attempt reports it", () => {
    const withOutput = [
      run("c", [
        attempt("plan", "m", 100, 40, { outputTokens: 10 }),
        attempt("plan", "m", 50, 0, { outputTokens: 5 }),
      ]),
    ];
    const report = aggregateUsage(withOutput, {}, none);
    expect(report.outputTokens).toBe(15);
    expect(report.byStage[0]).toMatchObject({ cached: 40, output: 15, fresh: 95 });
    const mixed = aggregateUsage([...withOutput, run("d", [attempt("plan", "m", 10, 0)])], {}, none);
    expect(mixed.outputTokens).toBeNull();
    expect(mixed.byStage[0]?.fresh).toBe(160 - 40);
  });

  test("empty input", () => {
    const report = aggregateUsage([], {}, none);
    expect(report.totalTokens).toBe(0);
    expect(report.cacheShare).toBeNull();
    expect(report.byStage).toEqual([]);
  });
});

function summary(
  groupBy: UsageSummary["groupBy"],
  groups: UsageSummary["groups"],
): UsageSummary {
  return {
    days: 7,
    since: 0,
    groupBy,
    runs: 3,
    attempts: groups.reduce((s, g) => s + g.attempts, 0),
    totalTokens: groups.reduce((s, g) => s + g.tokens, 0),
    cacheReadTokens: groups.reduce((s, g) => s + g.cacheReadTokens, 0),
    groups,
  };
}

const BY_STAGE = summary("stage", [
  { key: "task-T001", runs: 2, attempts: 2, tokens: 500, cacheReadTokens: 300 },
  { key: "plan", runs: 3, attempts: 3, tokens: 200, cacheReadTokens: 100 },
  { key: "task-T002", runs: 2, attempts: 2, tokens: 100, cacheReadTokens: 0 },
]);
const BY_MODEL = summary("model", [
  { key: "sonnet", runs: 3, attempts: 6, tokens: 700, cacheReadTokens: 380 },
  { key: "haiku", runs: 1, attempts: 1, tokens: 100, cacheReadTokens: 20 },
]);

describe("summarizeUsage", () => {
  test("unfiltered totals come from the summary", () => {
    const report = summarizeUsage(BY_STAGE, BY_MODEL, none);
    expect(report.totalTokens).toBe(800);
    expect(report.cachedTokens).toBe(400);
    expect(report.runs).toBe(3);
    expect(report.costUsd).toBeNull();
    expect(report.byStage.map((s) => [s.key, s.tokens])).toEqual([
      ["plan", 200],
      ["implement", 600],
    ]);
    expect(report.crossFiltered).toBe(true);
  });

  test("a stage filter narrows the chart and totals but not the model table", () => {
    const report = summarizeUsage(BY_STAGE, BY_MODEL, { stage: "implement", model: null });
    expect(report.totalTokens).toBe(600);
    expect(report.runs).toBe(3);
    expect(report.byStage).toHaveLength(1);
    expect(report.byModel).toHaveLength(2);
    expect(report.crossFiltered).toBe(false);
  });

  test("a model filter narrows the table and totals", () => {
    const report = summarizeUsage(BY_STAGE, BY_MODEL, { stage: null, model: "haiku" });
    expect(report.totalTokens).toBe(100);
    expect(report.runs).toBe(1);
    expect(report.byModel.map((s) => s.key)).toEqual(["haiku"]);
    expect(report.models).toEqual(["haiku", "sonnet"]);
  });

  test("stage keys", () => {
    expect(stageKey("task-T009")).toBe("implement");
    expect(stageKey("review")).toBe("review");
  });

  test("an older summary is not mistaken for a current one", () => {
    expect(isCurrentSummary(BY_STAGE)).toBe(false);
  });
});

type Figures = Omit<UsageGroup, "key" | "keys">;

function cell(stage: string, model: string, figures: Partial<Figures>): UsageGroup {
  return {
    key: `${stage} / ${model}`,
    keys: { stage, model },
    runs: 1,
    attempts: 1,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
    ...figures,
  };
}

function current(groups: UsageGroup[], runs: number): UsageSummary {
  const sum = (pick: (g: UsageGroup) => number | undefined) =>
    groups.reduce((s, g) => s + (pick(g) ?? 0), 0);
  return {
    days: 7,
    since: 0,
    groupBy: ["stage", "model"],
    filters: {},
    runs,
    attempts: sum((g) => g.attempts),
    tokens: sum((g) => g.tokens),
    totalTokens: sum((g) => g.tokens),
    inputTokens: sum((g) => g.inputTokens),
    outputTokens: sum((g) => g.outputTokens),
    cacheReadTokens: sum((g) => g.cacheReadTokens),
    costUsd: sum((g) => g.costUsd),
    unpricedTokens: sum((g) => g.unpricedTokens),
    groups,
  };
}

const CROSS = current(
  [
    cell("task-T001", "sonnet", {
      runs: 2,
      tokens: 500,
      inputTokens: 450,
      outputTokens: 50,
      cacheReadTokens: 300,
      costUsd: 2,
    }),
    cell("task-T002", "sonnet", {
      runs: 2,
      tokens: 100,
      inputTokens: 90,
      outputTokens: 10,
      cacheReadTokens: 0,
      costUsd: 1,
    }),
    cell("plan", "sonnet", {
      runs: 3,
      tokens: 200,
      inputTokens: 180,
      outputTokens: 20,
      cacheReadTokens: 100,
      costUsd: 0.5,
    }),
    cell("plan", "local", {
      runs: 1,
      tokens: 80,
      inputTokens: 70,
      outputTokens: 10,
      cacheReadTokens: 0,
      unpricedTokens: 80,
    }),
    // Recorded without per-step usage: tokens but no split, and no price.
    cell("review", "gpt", { tokens: 60, unpricedTokens: 60 }),
    cell("checks", "(host)", {}),
  ],
  3,
);

describe("crossUsage", () => {
  test("recognizes the current shape and folds task stages", () => {
    expect(isCurrentSummary(CROSS)).toBe(true);
    const report = crossUsage(CROSS, none);
    expect(report.totalTokens).toBe(940);
    expect(report.inputTokens).toBe(790);
    expect(report.outputTokens).toBe(90);
    expect(report.costUsd).toBeCloseTo(3.5);
    expect(report.unpricedTokens).toBe(140);
    expect(report.costPartial).toBe(true);
    expect(report.runs).toBe(3);
    expect(report.runsExact).toBe(true);
    expect(report.byStage.map((s) => [s.key, s.tokens])).toEqual([
      ["plan", 280],
      ["implement", 600],
      ["checks", 0],
      ["review", 60],
    ]);
    expect(report.byModel.map((s) => s.key)).toEqual(["sonnet", "local", "gpt", "(host)"]);
    expect(report.byStageModel.map((s) => s.key)).toEqual([
      "plan / sonnet",
      "plan / local",
      "implement / sonnet",
      "checks / (host)",
      "review / gpt",
    ]);
    expect(report.stages).toEqual(["plan", "implement", "checks", "review"]);
  });

  test("splits tokens into cache reads, uncached input, output and the unsplit rest", () => {
    const report = crossUsage(CROSS, none);
    const implement = report.byStage.find((s) => s.key === "implement");
    expect(implement).toMatchObject({ cached: 300, input: 540, fresh: 240, output: 60, unsplit: 0 });
    const review = report.byStage.find((s) => s.key === "review");
    expect(review).toMatchObject({ cached: 0, fresh: 0, output: 0, unsplit: 60 });
    expect(review?.costUsd).toBe(0);
    expect(review?.unpricedTokens).toBe(60);
  });

  test("filters narrow every breakdown; runs are an upper bound until the exact answer", () => {
    const report = crossUsage(CROSS, { stage: "plan", model: null });
    expect(report.totalTokens).toBe(280);
    expect(report.byModel.map((s) => s.key)).toEqual(["sonnet", "local"]);
    expect(report.byStageModel).toHaveLength(2);
    expect(report.runs).toBe(3);
    expect(report.runsExact).toBe(false);
    expect(report.costPartial).toBe(true);
    // Options keep everything so the filter can be changed.
    expect(report.models).toContain("gpt");

    const exact = current(CROSS.groups.slice(2, 4), 2);
    const withExact = crossUsage(CROSS, { stage: "plan", model: null }, exact);
    expect(withExact.runs).toBe(2);
    expect(withExact.runsExact).toBe(true);
    expect(withExact.totalTokens).toBe(280);
  });

  test("a model filter on folded task stages adds up", () => {
    const report = crossUsage(CROSS, { stage: "implement", model: "sonnet" });
    expect(report.totalTokens).toBe(600);
    expect(report.costUsd).toBeCloseTo(3);
    expect(report.costPartial).toBe(false);
    expect(report.byStageModel.map((s) => s.key)).toEqual(["implement / sonnet"]);
  });

  test("server filters", () => {
    expect(serverFilter({ stage: "plan", model: "(host)" })).toEqual({
      stage: "plan",
      model: "(host)",
    });
    expect(serverFilter({ stage: null, model: "gpt" })).toEqual({ model: "gpt" });
    expect(serverFilter({ stage: "implement", model: "gpt" })).toBeNull();
  });
});

describe("aggregateUsage with per-attempt cost", () => {
  test("uses each attempt's cost and counts unpriced tokens", () => {
    const reports = [
      run("e", [
        attempt("plan", "m", 100, 40, { inputTokens: 90, outputTokens: 10, costUsd: 0.25 }),
        attempt("review", "x", 50, 0, { inputTokens: 45, outputTokens: 5, costUsd: null }),
        attempt("checks", null, 0, 0, { inputTokens: null, outputTokens: null, costUsd: 0 }),
      ]),
    ];
    // The run estimate is ignored when attempts carry their own.
    const report = aggregateUsage(reports, { e: 99 }, none);
    expect(report.costUsd).toBeCloseTo(0.25);
    expect(report.unpricedTokens).toBe(50);
    expect(report.costPartial).toBe(true);
    expect(report.inputTokens).toBe(135);
    expect(report.outputTokens).toBe(15);
    expect(report.byStageModel.map((s) => s.key)).toEqual([
      "plan / m",
      "checks / (host)",
      "review / x",
    ]);
  });
});

function feature(state: InitiativeFeature["state"], extra: Partial<InitiativeFeature> = {}) {
  return {
    id: "f",
    title: "F",
    mandatory: true,
    dependsOn: [],
    state,
    runId: "run-f",
    runStatus: null,
    blockers: [],
    pendingRequests: [],
    usage: { tokens: 0, calls: 0, activeMs: 0 },
    ...extra,
  } satisfies InitiativeFeature;
}

describe("initiative view model", () => {
  test("a rejected split waits for edits, not for an approval", () => {
    const pending = [{ scope: "initiative", featureId: null, runId: null, requestId: "r", kind: "split_approval", digest: "d" }] as InitiativeView["pendingDecisions"];
    expect(detailStatus({ status: "awaiting_approval", pendingDecisions: pending }).label).toBe("approve split");
    expect(detailStatus({ status: "awaiting_approval", pendingDecisions: [] })).toEqual({ label: "split rejected", tone: "warn" });
    expect(detailStatus({ status: "active", pendingDecisions: [] }).label).toBe("active");
  });

  test("the screen follows an initiative while the backend splits or runs it", () => {
    expect(initiativeIsLive("decomposing")).toBe(true);
    expect(initiativeIsLive("active")).toBe(true);
    for (const status of ["awaiting_approval", "paused", "completed", "refused"] as const)
      expect(initiativeIsLive(status)).toBe(false);
  });

  test("feature rows", () => {
    expect(featureRow(feature("accepted"))).toMatchObject({ label: "done", link: "Run" });
    expect(featureRow(feature("needs_decision"))).toMatchObject({ tone: "warn", link: "Decide" });
    expect(featureRow(feature("in_progress", { runStatus: "implement" })).label).toBe(
      "in progress · implement",
    );
    expect(
      featureRow(feature("waiting", { runId: null, dependsOn: ["run-view"] })),
    ).toMatchObject({ label: "waits for run-view", link: null });
    expect(featureRow(feature("blocked", { blockers: ["budget spent"] })).label).toBe(
      "budget spent",
    );
  });

  test("counts and list lines", () => {
    const counts = featureCounts({
      features: [feature("accepted"), feature("in_progress"), feature("waiting"), feature("failed")],
    });
    expect(counts).toEqual({
      done: 1,
      inProgress: 1,
      needsDecision: 0,
      blocked: 1,
      waiting: 1,
      total: 4,
    });
    const next = { kind: "drive", featureId: null, runId: null, message: "" };
    expect(
      initiativeLine({ initiativeId: "i", title: "I", status: "awaiting_approval", features: 4, next }),
    ).toBe("approve split · 4 proposed");
    expect(
      initiativeLine({ initiativeId: "i", title: "I", status: "completed", features: 3, next }),
    ).toBe("completed");
  });

  test("model switch is offered while nothing executes and the backend reports the model", () => {
    const view = (extra: Partial<InitiativeView> = {}): InitiativeView => ({
      initiativeId: "i",
      title: "I",
      status: "active",
      reason: "",
      revision: 1,
      planRevision: 1,
      model: null,
      goals: [],
      features: [feature("needs_decision", { runStatus: "waiting" })],
      pendingDecisions: [],
      budget: {
        limits: { maxTotalTokens: 1, maxAgentCalls: 1, maxActiveMs: 1 },
        used: { tokens: 0, calls: 0, activeMs: 0 },
      },
      next: { kind: "decide", featureId: null, runId: null, message: "" },
      ...extra,
    });
    expect(canSwitchModel(view())).toBe(true);
    expect(canSwitchModel(view({ status: "paused", model: "a/b" }))).toBe(true);
    expect(canSwitchModel(view({ model: undefined }))).toBe(false);
    expect(canSwitchModel(view({ status: "completed" }))).toBe(false);
    expect(canSwitchModel(view({ features: [feature("in_progress", { runStatus: "running" })] }))).toBe(
      false,
    );
  });
});

function initiativeView(extra: Partial<InitiativeView> = {}): InitiativeView {
  return {
    initiativeId: "i",
    title: "I",
    status: "awaiting_approval",
    reason: "",
    revision: 3,
    planRevision: 1,
    approvedPlanRevision: null,
    model: null,
    goals: [],
    features: ["a", "b", "c", "d"].map((id) =>
      feature("proposed", { id, title: id.toUpperCase(), runId: null }),
    ),
    pendingDecisions: [],
    budget: {
      limits: { maxTotalTokens: 1_000_000, maxAgentCalls: 100, maxActiveMs: 90 * 60_000 },
      used: { tokens: 0, calls: 0, activeMs: 0 },
    },
    next: { kind: "await_split_approval", featureId: null, runId: null, message: "" },
    ...extra,
  };
}

describe("initiative management", () => {
  test("initiative IDs and suggestions", () => {
    expect(isInitiativeKey("desktop-app")).toBe(true);
    expect(isInitiativeKey("Desktop")).toBe(false);
    expect(isInitiativeKey("-x")).toBe(false);
    expect(isInitiativeKey("a".repeat(41))).toBe(false);
    expect(suggestInitiativeId("Add a desktop app, with installers!")).toBe("add-a-desktop-app-with");
    const long = suggestInitiativeId("internationalization localization accessibility performance");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(isInitiativeKey(long)).toBe(true);
    expect(long.endsWith("-")).toBe(false);
    expect(suggestInitiativeId("!!!")).toBe("");
  });

  test("the split is editable while awaiting approval or paused after approval", () => {
    expect(canEditSplit(initiativeView())).toBe(true);
    expect(canEditSplit(initiativeView({ status: "paused", approvedPlanRevision: 1 }))).toBe(true);
    expect(canEditSplit(initiativeView({ status: "paused" }))).toBe(false);
    expect(canEditSplit(initiativeView({ status: "paused", approvedPlanRevision: undefined }))).toBe(
      false,
    );
    expect(canEditSplit(initiativeView({ status: "active", approvedPlanRevision: 1 }))).toBe(false);
  });

  test("edits keep 3 to 12 features", () => {
    const four = initiativeView();
    const three = initiativeView({ features: four.features.slice(0, 3) });
    expect(canRemoveFeature(four)).toBe(true);
    expect(canRemoveFeature(three)).toBe(false);
    expect(canSplitFeature(three)).toBe(true);
    const twelve = initiativeView({
      features: Array.from({ length: 12 }, (_, i) => feature("proposed", { id: `f${i}` })),
    });
    expect(canSplitFeature(twelve)).toBe(false);
    const blank = { id: "", title: "" };
    expect(mergeProblem(four, ["a", "b"], blank)).toBeNull();
    expect(mergeProblem(four, ["a"], blank)).toMatch(/two or more/);
    expect(mergeProblem(four, ["a", "b", "c"], blank)).toMatch(/at least 3/);
    expect(mergeProblem(four, ["a", "b"], { id: "c", title: "" })).toMatch(/already/);
    expect(mergeProblem(four, ["a", "b"], { id: "b", title: "" })).toBeNull();
    expect(mergeProblem(four, ["a", "b"], { id: "Bad", title: "" })).toMatch(/lowercase/);
    expect(mergeProblem(initiativeView({ status: "active" }), ["a", "b"], blank)).toMatch(
      /cannot be edited/,
    );
  });

  test("split rows", () => {
    const view = initiativeView();
    const first = { id: "a-1", title: "One" };
    const ok = [first, { id: "a", title: "Two" }];
    expect(splitProblem(view, "a", ok)).toBeNull();
    expect(splitProblem(view, "a", ok.slice(0, 1))).toMatch(/two or more/);
    expect(splitProblem(view, "a", [first, { id: "b", title: "B" }])).toMatch(/already/);
    expect(splitProblem(view, "a", [first, { id: "a-1", title: "X" }])).toMatch(
      /Two parts/,
    );
    expect(splitProblem(view, "a", [first, { id: "a-2", title: " " }])).toMatch(
      /Part 2 needs a title/,
    );
    expect(splitProblem(view, "a", [first, { id: "A_2", title: "X" }])).toMatch(
      /Part 2: the ID/,
    );
  });

  test("re-plan needs an approved split, a run and nothing executing", () => {
    const run = feature("in_progress", { runId: "r", runStatus: "blocked" });
    const approved = initiativeView({ status: "active", approvedPlanRevision: 1 });
    expect(canReplanFeature(approved, run)).toBe(true);
    expect(canReplanFeature({ ...approved, status: "paused" }, run)).toBe(true);
    expect(canReplanFeature(approved, { ...run, runStatus: "running" })).toBe(false);
    expect(canReplanFeature(approved, { ...run, runId: null })).toBe(false);
    expect(canReplanFeature(initiativeView({ status: "active" }), run)).toBe(false);
    expect(canReplanFeature({ ...approved, status: "completed" }, run)).toBe(false);
  });

  test("budget fields", () => {
    expect(parseCount("6M")).toBe(6_000_000);
    expect(parseCount("600k")).toBe(600_000);
    expect(parseCount("1,500")).toBe(1500);
    expect(parseCount("0")).toBeNull();
    expect(parseCount("-3")).toBeNull();
    expect(parseCount("lots")).toBeNull();
    expect(parseBudget({ tokens: "2M", calls: "50", minutes: "60" })).toEqual({
      ok: true,
      limits: { tokens: 2_000_000, calls: 50, timeMs: 3_600_000 },
    });
    expect(parseBudget({ tokens: "2M", calls: "", minutes: "60" }).ok).toBe(false);

    const view = initiativeView();
    expect(canExtendBudget(view)).toBe(true);
    expect(canExtendBudget({ status: "refused" })).toBe(false);
    const current = budgetFields(view);
    expect(current).toEqual({ tokens: "1000000", calls: "100", minutes: "90" });
    expect(budgetExtension(view, current)).toEqual({ ok: false, error: "Raise at least one limit." });
    expect(budgetExtension(view, { ...current, tokens: "2M" })).toEqual({
      ok: true,
      limits: { tokens: 2_000_000 },
    });
    expect(budgetExtension(view, { ...current, calls: "50" }).ok).toBe(false);
    expect(budgetExtension(view, { ...current, minutes: "120" })).toEqual({
      ok: true,
      limits: { timeMs: 120 * 60_000 },
    });
    // An odd time limit shows rounded up; leaving it unchanged sends nothing for it.
    const odd = initiativeView({
      budget: { ...view.budget, limits: { ...view.budget.limits, maxActiveMs: 90_500 } },
    });
    expect(budgetExtension(odd, { ...budgetFields(odd), calls: "200" })).toEqual({
      ok: true,
      limits: { calls: 200 },
    });
    // A dollar cap goes up on its own; the token limits stay as they are.
    expect(budgetExtension(view, current, "$40")).toEqual({ ok: true, limits: { costUsd: 40 } });
    expect(budgetExtension(view, current, "lots").ok).toBe(false);
    const cost = {
      capUsd: 32,
      tolerance: 0.25,
      ceilingUsd: 40,
      spentUsd: 29.15,
      reservedUsd: 0,
      remainingUsd: 2.85,
      forecastUsd: 41.2,
    };
    const capped = initiativeView({ budget: { ...view.budget, cost } });
    expect(budgetExtension(capped, current, "30")).toEqual({
      ok: false,
      error: "Limits can only go up.",
    });
    expect(budgetExtension(capped, current, "32").ok).toBe(false);
    expect(costLine(capped)).toBe(
      "$29.15 of $32.00 (ceiling $40.00) · $2.85 left · forecast $41.20",
    );
    expect(costLine(view)).toBeNull();
    expect(parseUsd("$12.50")).toBe(12.5);
    expect(parseUsd("0")).toBeNull();
  });

  test("start body", () => {
    const fields = {
      prompt: "  Ship it  ",
      initiativeId: "ship-it",
      workflow: "sdd",
      model: "",
      budget: null,
      tiered: null,
    };
    expect(startBody(fields)).toEqual({
      ok: true,
      body: { initiativeId: "ship-it", prompt: "Ship it", workflow: "sdd" },
    });
    expect(
      startBody({
        ...fields,
        model: "anthropic/claude",
        budget: { tokens: "1M", calls: "10", minutes: "30" },
        tiered: { maxTasks: "5", maxFiles: "10" },
      }),
    ).toEqual({
      ok: true,
      body: {
        initiativeId: "ship-it",
        prompt: "Ship it",
        workflow: "sdd",
        model: "anthropic/claude",
        budget: { tokens: 1_000_000, calls: 10, timeMs: 1_800_000 },
        tieredApproval: { maxTasks: 5, maxFiles: 10 },
      },
    });
    expect(startBody({ ...fields, prompt: " " }).ok).toBe(false);
    expect(startBody({ ...fields, initiativeId: "Ship" }).ok).toBe(false);
    expect(startBody({ ...fields, budget: { tokens: "1M", calls: "", minutes: "" } }).ok).toBe(
      false,
    );
    expect(startBody({ ...fields, tiered: { maxTasks: "0", maxFiles: "10" } }).ok).toBe(false);
    expect(startBody({ ...fields, budgetUsd: "40" })).toEqual({
      ok: true,
      body: { initiativeId: "ship-it", prompt: "Ship it", workflow: "sdd", budgetUsd: 40 },
    });
    expect(startBody({ ...fields, budgetUsd: "free" }).ok).toBe(false);
    expect(startBody({ ...fields, forecastStop: true })).toEqual({
      ok: true,
      body: { initiativeId: "ship-it", prompt: "Ship it", workflow: "sdd", forecastStop: true },
    });
  });
});

async function mock(method: MockRequest["method"], path: string, body?: object) {
  const request: MockRequest = {
    key: "mock-initiatives",
    method,
    path,
    query: new URLSearchParams(),
    body,
  };
  for (const route of MOCK_ROUTES) {
    const answer = await route(request);
    if (answer) return answer;
  }
  throw new Error(`no mock route answered ${method} ${path}`);
}

describe("initiative board", () => {
  const f = (id: string, dependsOn: string[] = []) => ({ id, dependsOn });
  test("columns follow the dependency steps and keep the split order", () => {
    const steps = featureSteps([
      f("docs"),
      f("api", ["core"]),
      f("core"),
      f("ui", ["api"]),
      f("cli", ["core"]),
    ]);
    expect(steps.map((column) => column.map((x) => x.id))).toEqual([
      ["docs", "core"],
      ["api", "cli"],
      ["ui"],
    ]);
    // An unknown dependency counts as done; a cycle does not loop.
    expect(featureSteps([f("a", ["gone"]), f("b", ["c"]), f("c", ["b"])]).flat()).toHaveLength(3);
  });

  test("a feature runs its own workflow, or the initiative's on an older backend", () => {
    expect(featureWorkflow({ workflowId: "sdd" }, { workflowId: "quick" })).toBe("quick");
    expect(featureWorkflow({ workflowId: "full" }, {})).toBe("full");
    expect(featureWorkflow({}, {})).toBe("sdd");
    const old = { features: [{ ...feature("proposed"), size: undefined }] };
    expect(configurableFeatures(old as Pick<InitiativeView, "features">)).toBe(false);
    expect(
      featureWorkflowChoices([
        { id: "sdd", problems: [], writes: true },
        { id: "spike", problems: [], writes: false },
        { id: "broken", problems: ["bad gate"], writes: true },
      ]).map((d) => d.id),
    ).toEqual(["sdd"]);
  });
});

describe("mock initiative backend", () => {
  test("starts, edits, extends and rejects", async () => {
    const startedAnswer = await mock("POST", "/v1/initiatives", {
      commandId: "c1",
      initiativeId: "new-one",
      prompt: "Build the thing",
    });
    expect(startedAnswer.status).toBe(202);
    const view = startedAnswer.body as InitiativeView;
    expect(view.status).toBe("awaiting_approval");
    expect(view.features).toHaveLength(3);
    const path = "/v1/initiatives/new-one";
    const removed = await mock("POST", `${path}/remove`, { feature: "ui" });
    expect(removed.status).toBe(400);
    const split = await mock("POST", `${path}/split`, {
      feature: "ui",
      parts: [
        { id: "ui-tui", title: "TUI" },
        { id: "ui-desktop", title: "Desktop" },
      ],
    });
    const afterSplit = split.body as InitiativeView;
    expect(afterSplit.features.map((f) => f.id)).toEqual(["core", "api", "ui-tui", "ui-desktop"]);
    expect(afterSplit.planRevision).toBe(view.planRevision + 1);
    expect(afterSplit.revision).toBe(view.revision + 1);
    const merged = (
      await mock("POST", `${path}/merge`, { features: ["ui-tui", "ui-desktop"], title: "UI" })
    ).body as InitiativeView;
    expect(merged.features.map((f) => f.title)).toEqual([
      "Core model and storage",
      "Local API endpoints",
      "UI",
    ]);
    const renamed = (await mock("POST", `${path}/rename`, { feature: "core", title: "Core" }))
      .body as InitiativeView;
    expect(renamed.features[0]?.title).toBe("Core");
    const quick = (await mock("POST", `${path}/configure`, { feature: "ui-tui", workflow: "quick" }))
      .body as InitiativeView;
    expect(quick.features.find((f) => f.id === "ui-tui")?.workflowId).toBe("quick");
    // core is built on by api, so it keeps a workflow that writes a spec.
    expect(
      (await mock("POST", `${path}/configure`, { feature: "core", workflow: "quick" })).status,
    ).toBe(400);
    const large = (await mock("POST", `${path}/configure`, { feature: "ui-tui", size: "large" }))
      .body as InitiativeView;
    expect(large.features.find((f) => f.id === "ui-tui")?.size).toBe("large");
    const estimate = (await mock("GET", `${path}/estimate`)).body as InitiativeEstimate;
    expect(estimate.features.map((f) => [f.featureId, f.size])).toEqual([
      ["core", "medium"],
      ["api", "medium"],
      ["ui-tui", "large"],
    ]);
    expect(estimate.withMargin).toBe(Math.round(estimate.tokens.high * 1.25));
    expect(estimate.level).toBeGreaterThanOrEqual(1);
    expect(estimateFit(estimate).tone).toBe(estimate.budget.fits === "yes" ? "ok" : estimate.budget.fits === "maybe" ? "warn" : "err");
    expect(estimateBasisText(estimate)).toContain("Generic ranges");
    const extended = (await mock("POST", `${path}/extend`, { tokens: 9_000_000 }))
      .body as InitiativeView;
    expect(extended.budget.limits.maxTotalTokens).toBe(9_000_000);
    expect((await mock("POST", `${path}/extend`, { tokens: 1 })).status).toBe(400);
    const rejected = (
      await mock("POST", `${path}/reject`, { requestId: "x", reason: "Too coarse" })
    ).body as InitiativeView;
    expect(rejected.status).toBe("awaiting_approval");
    expect(rejected.reason).toContain("Too coarse");
    expect(rejected.pendingDecisions.some((d) => d.scope === "initiative")).toBe(false);
    const edited = (await mock("POST", `${path}/rename`, { feature: "core", title: "Core 2" }))
      .body as InitiativeView;
    expect(edited.pendingDecisions.some((d) => d.scope === "initiative")).toBe(true);
  });
});

describe("mock usage export", () => {
  test("answers format=md with Markdown for the summary and for one run", async () => {
    const ask = async (path: string, query: string) => {
      const request: MockRequest = {
        key: "mock-usage",
        method: "GET",
        path,
        query: new URLSearchParams(query),
        body: undefined,
      };
      for (const route of MOCK_ROUTES) {
        const answer = await route(request);
        if (answer) return answer.body as { markdown?: string };
      }
      throw new Error(`no mock route answered ${path}`);
    };
    expect((await ask("/v1/usage", "days=7&groupBy=stage,model&format=md")).markdown).toContain(
      "# BAKED usage",
    );
    expect((await ask("/v1/usage", "days=7&groupBy=model")).markdown).toBeUndefined();
    expect(
      (await ask("/v1/workflow/runs/run-usage-totals/usage", "format=md")).markdown,
    ).toContain("run-usage-totals");
  });
});

import { describe, expect, test } from "bun:test";
import type {
  AttemptUsageRow,
  InitiativeFeature,
  RunUsageReport,
  UsageGroup,
  UsageSummary,
} from "../src/renderer/client/insights.ts";
import {
  featureCounts,
  featureRow,
  initiativeLine,
} from "../src/renderer/screens/insights/initiative-model.ts";
import {
  aggregateUsage,
  crossUsage,
  isCurrentSummary,
  serverFilter,
  stageKey,
  summarizeUsage,
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
});

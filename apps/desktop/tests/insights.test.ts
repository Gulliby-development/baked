import { describe, expect, test } from "bun:test";
import type {
  AttemptUsageRow,
  InitiativeFeature,
  RunUsageReport,
  UsageSummary,
} from "../src/renderer/client/insights.ts";
import {
  featureCounts,
  featureRow,
  initiativeLine,
} from "../src/renderer/screens/insights/initiative-model.ts";
import {
  aggregateUsage,
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

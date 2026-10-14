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
});

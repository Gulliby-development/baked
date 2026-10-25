import { describe, expect, test } from "bun:test";
import { msPerToken, scheduledMinutes } from "../src/core/workflows/initiatives/duration.js";
import {
  estimateInitiative,
  estimateSummary,
  type FeatureRunSample,
  type FeatureToEstimate,
} from "../src/core/workflows/initiatives/estimate.js";

const QUICK = [{ id: "implement", type: "tasks", models: [] }];
const feature = (id: string, dependsOn: string[] = []): FeatureToEstimate => ({
  id,
  title: id,
  workflowId: "quick",
  size: "medium",
  stages: QUICK,
  dependsOn,
});
// 1M tokens in 10 active minutes: 0.6 ms per token.
const sample = (runId: string, activeMs?: number, workflowId = "quick"): FeatureRunSample => ({
  runId,
  workflowId,
  size: "medium",
  tokens: 1_000_000,
  taskCount: 3,
  ...(activeMs === undefined ? {} : { activeMs }),
});

describe("split wall time in minutes (#1557)", () => {
  // Bench round 55 (routeshadow): a serial head, independent features after it, and a tail; the
  // measured durations replayed through the plan's graph gave 66 min on 2 slots and 51 on 6.
  const graph = [
    { id: "base", minutes: 10, dependsOn: [] },
    { id: "model", minutes: 10, dependsOn: ["base"] },
    { id: "a", minutes: 10, dependsOn: ["model"] },
    { id: "b", minutes: 10, dependsOn: ["model"] },
    { id: "c", minutes: 10, dependsOn: ["model"] },
    { id: "docs", minutes: 5, dependsOn: ["a", "b", "c"] },
  ];

  test("the wall time schedules the features over their dependencies on the run slots", () => {
    expect(scheduledMinutes(graph, 1)).toBe(55);
    expect(scheduledMinutes(graph, 2)).toBe(45);
    expect(scheduledMinutes(graph, 3)).toBe(35);
    expect(scheduledMinutes(graph, 6)).toBe(35);
  });

  test("a ready feature with the longest remaining chain starts first", () => {
    const features = [
      { id: "p", minutes: 10, dependsOn: [] },
      { id: "q", minutes: 2, dependsOn: [] },
      { id: "r", minutes: 10, dependsOn: ["q"] },
      { id: "s", minutes: 2, dependsOn: [] },
    ];
    // q (chain 12) and p start; r takes the slot q frees, s waits for p.
    expect(scheduledMinutes(features, 2)).toBe(12);
  });

  test("a dependency cycle ends the schedule instead of looping", () => {
    expect(
      scheduledMinutes(
        [
          { id: "x", minutes: 3, dependsOn: ["y"] },
          { id: "y", minutes: 3, dependsOn: ["x"] },
        ],
        2,
      ),
    ).toBe(0);
  });

  test("the rate needs two timed runs, of the feature's workflow when it has them", () => {
    expect(msPerToken([sample("r1", 600_000)], "quick")).toBeNull();
    expect(msPerToken([sample("r1", 600_000), sample("r2")], "quick")).toBeNull();
    const pair = msPerToken([sample("r1", 600_000), sample("r2", 1_200_000)], "quick");
    expect(pair?.rate).toBeCloseTo(0.9, 9);
    expect(pair?.samples).toBe(2);
    const mixed = [
      sample("r1", 600_000),
      sample("r2", 600_000),
      sample("s1", 3_000_000, "sdd"),
      sample("s2", 3_000_000, "sdd"),
    ];
    expect(msPerToken(mixed, "quick")?.rate).toBe(0.6);
    expect(msPerToken(mixed, "sdd")?.rate).toBe(3);
  });

  test("the estimate gives summed active minutes and the wall time on the slots and the widest group", () => {
    const estimate = estimateInitiative({
      features: [
        feature("base"),
        feature("model", ["base"]),
        feature("a", ["model"]),
        feature("b", ["model"]),
        feature("c", ["model"]),
      ],
      history: [],
      samples: [sample("r1", 600_000), sample("r2", 600_000), sample("r3", 600_000)],
      maxTotalTokens: 100_000_000,
      parallelRuns: 2,
    });
    const duration = estimate.duration;
    expect(duration).not.toBeNull();
    const minutes = estimate.features.map((f) => f.minutes ?? 0);
    for (const [i, f] of estimate.features.entries())
      expect(minutes[i]).toBeCloseTo((f.expectedTokens * 0.6) / 60_000, 6);
    const each = minutes[0] ?? 0;
    expect(duration?.activeMinutes).toBeCloseTo(each * 5, 6);
    // Same-sized features: base, model, two of a-c, then the third.
    expect(duration?.wallMinutes).toBeCloseTo(each * 4, 6);
    expect(duration?.slots).toBe(2);
    expect(duration?.widest?.slots).toBe(3);
    expect(duration?.widest?.wallMinutes).toBeCloseTo(each * 3, 6);
    expect(estimate.label).toContain("of wall time with 2 at once");
    expect(estimate.label).toContain("with 3, the plan's widest group");
    expect(estimate.label).toContain("of summed active time, which the shared time budget limits");
    expect(estimateSummary(estimate)).toContain(
      `~${Math.round(each * 4)} min wall with 2 at once (~${Math.round(each * 5)} min active)`,
    );
  });

  test("an accepted feature counts no minutes and a running one only what it has left", () => {
    const estimate = estimateInitiative({
      features: [feature("a"), feature("b", ["a"])],
      history: [],
      samples: [sample("r1", 600_000), sample("r2", 600_000)],
      maxTotalTokens: 100_000_000,
      progress: {
        features: { a: { spent: 900_000, accepted: true }, b: { spent: 200_000, accepted: false } },
        overhead: 0,
      },
    });
    const [a, b] = estimate.features;
    expect(a?.minutes).toBe(0);
    expect(b?.minutes).toBeCloseTo((Math.max(0, (b?.expectedTokens ?? 0) - 200_000) * 0.6) / 60_000, 6);
    expect(estimate.duration?.widest).toBeNull();
  });

  test("without timed runs the estimate gives no minutes", () => {
    const estimate = estimateInitiative({
      features: [feature("a"), feature("b")],
      history: [],
      samples: [sample("r1"), sample("r2")],
      maxTotalTokens: 100_000_000,
      parallelRuns: 2,
    });
    expect(estimate.duration).toBeNull();
    expect(estimate.features.every((f) => f.minutes === undefined)).toBe(true);
    expect(estimate.label).not.toContain("wall time");
    expect(estimateSummary(estimate)).not.toContain("min wall");
  });
});

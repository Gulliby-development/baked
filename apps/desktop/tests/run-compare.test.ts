import { describe, expect, test } from "bun:test";
import type { ComparedRun, RunComparison } from "../src/renderer/client/runs.ts";
import { compareRows, togglePick } from "../src/renderer/screens/runs/compare-model.ts";

const side = (runId: string, tokens: number, activeMs: number, high: number): ComparedRun => ({
  runId,
  featureId: "report-totals",
  workflowId: "sdd",
  status: "completed",
  reason: "none",
  routes: [],
  tokens,
  costUsd: tokens / 1_000_000,
  activeMs,
  agentCalls: 10,
  repairRounds: 0,
  correctiveTasks: 0,
  stages: [],
  models: [],
  checks: { passed: 3, failed: 0 },
  findings: { critical: 0, high, medium: 1, low: 0 },
  openFindings: high,
  limitations: 0,
});

describe("run comparison", () => {
  test("rows show both sides, B minus A and the better side", () => {
    const a = side("run-a", 1_200_000, 600_000, 1);
    const b = side("run-b", 800_000, 900_000, 0);
    const comparison: RunComparison = {
      a,
      b,
      sameFeature: true,
      sameWorkflow: true,
      routeDifferences: [],
      stages: [],
      delta: { tokens: -400_000, costUsd: -0.4, activeMs: 300_000 },
      markdown: "",
    };
    const rows = new Map(compareRows(comparison).map((r) => [r.label, r]));
    expect(rows.get("Tokens")).toMatchObject({ a: "1.20M", b: "800k", delta: "-400k", better: "b" });
    expect(rows.get("Estimated cost")).toMatchObject({ delta: "-$0.40", better: "b" });
    expect(rows.get("Active time")).toMatchObject({ delta: "+5.0 min", better: "a" });
    expect(rows.get("Review findings")).toMatchObject({
      a: "1 high, 1 medium (1 open)",
      b: "1 medium (0 open)",
      better: "b",
    });
    expect(rows.get("Status")?.better).toBeNull();
  });

  test("at most two runs are picked; a third replaces the oldest pick", () => {
    expect(togglePick([], "a")).toEqual(["a"]);
    expect(togglePick(["a", "b"], "c")).toEqual(["b", "c"]);
    expect(togglePick(["a", "b"], "a")).toEqual(["b"]);
  });
});

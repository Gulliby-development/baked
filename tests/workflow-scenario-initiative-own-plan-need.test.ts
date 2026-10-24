import { describe, expect, test } from "bun:test";
import type { PastRun } from "../src/core/workflows/estimate.js";
import {
  calibrationLagText,
  estimateInitiative,
  type FeatureRunSample,
  type FeatureToEstimate,
  type InitiativeProgress,
  ownPlanNeed,
} from "../src/core/workflows/initiatives/estimate.js";
import { growthLimit } from "../src/core/workflows/initiatives/service.js";

// Bench round 66, nodepluck (#2043): the split priced its ten features by size class (medium
// 1.12M-2.29M, large 1.92M-3.92M). Six of them planned ahead, and their own plans expected more
// before they started (readcmd 3.49M of a 4.07M high, syntax 3.96M of 4.52M), but the pool kept
// the class values until a feature finished; the initiative used 2.54x its summed low ends.
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
// Finished features of earlier initiatives: the size classes the split prices from.
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
  sample("m3", "medium", 1_900_000),
  sample("m4", "medium", 2_290_000),
  sample("l1", "large", 1_920_000),
  sample("l2", "large", 2_900_000),
  sample("l3", "large", 3_920_000),
];
const feature = (id: string, size: FeatureToEstimate["size"]): FeatureToEstimate => ({
  id,
  title: id,
  workflowId: "sdd",
  size,
  stages: SDD,
});
const FEATURES = [
  feature("base", "medium"),
  feature("readcmd", "medium"),
  feature("syntax", "large"),
  feature("path", "medium"),
  feature("cli", "medium"),
];
const BUDGET = 30_000_000;
// The planned-ahead features' own plan sizing (`plannedRunTokens`), above their class need.
const READCMD = { low: 2_600_000, expected: 3_490_000, high: 4_070_000 };
const SYNTAX = { low: 3_100_000, expected: 3_960_000, high: 4_520_000 };
const running = (spent: number, planned?: InitiativeProgress["features"][string]["planned"]) => ({
  spent,
  accepted: false,
  ...(planned ? { planned } : {}),
});
const estimate = (features: InitiativeProgress["features"] = {}) =>
  estimateInitiative({
    features: FEATURES,
    history,
    samples: SAMPLES,
    maxTotalTokens: BUDGET,
    progress: { features, overhead: 0 },
  });
const of = (e: ReturnType<typeof estimate>, id: string) => e.features.find((f) => f.featureId === id);

describe("scenario: a planned-ahead feature's need follows its own plan (#2043, R66 nodepluck)", () => {
  test("the reserved need is the plan's expected tokens; a feature without a plan keeps its class need", () => {
    const split = estimate();
    // At the split every feature is priced by its size class.
    const medium = of(split, "readcmd")?.tokens;
    const large = of(split, "syntax")?.tokens;
    expect(of(split, "readcmd")?.basis).toBe("initiative-history");
    // The middle half of the class's finished features: below both plans.
    expect(medium).toEqual({ low: 1_405_000, high: 1_997_500 });
    expect(large).toEqual({ low: 1_920_000, high: 3_920_000 });
    expect(split.planCalibration).toEqual({ features: 0, ratio: null });

    // Both planned ahead: their plans are sized, no feature has finished yet.
    const planned = estimate({
      readcmd: running(400_000, READCMD),
      syntax: running(500_000, SYNTAX),
    });
    const readcmd = of(planned, "readcmd");
    const syntax = of(planned, "syntax");
    // Unmeasured ratio: the plan's expected value times 1, above the class need and its own low end.
    expect(readcmd?.tokens).toEqual({ low: 3_490_000, high: 4_070_000 });
    expect(syntax?.tokens).toEqual({ low: 3_960_000, high: 4_520_000 });
    expect(readcmd?.floor).toBe("plan");
    expect(syntax?.floor).toBe("plan");
    // A feature without a plan keeps the class value.
    for (const id of ["base", "path", "cli"]) expect(of(planned, id)?.tokens).toEqual(medium);
    expect(planned.notes.join("\n")).toContain("unscaled until 3 features with a plan are accepted (0 so far)");

    // The share gate reserves the need: a waiting feature can grow only into what remains after it.
    const view = {
      budget: { remaining: { tokens: 12_000_000, calls: 100, activeMs: 1e6 } },
      features: planned.features.map((f) => ({
        id: f.featureId,
        share: { tokens: 1, calls: 1, activeMs: 1 },
        need: f.tokens,
      })),
    } as unknown as Parameters<typeof growthLimit>[0];
    // 12M less readcmd 3.49M, syntax 3.96M, path 1.405M and cli 1.405M (the class values).
    expect(growthLimit(view, "base")).toBe(12_000_000 - 3_490_000 - 3_960_000 - 2 * 1_405_000);
  });

  test("the measured plan-to-actual ratio scales the plan once three features with a plan finished", () => {
    // Three accepted features each used 1.5x what their own plan expected: blended a third at three.
    const done = (spent: number, expected: number) => ({
      spent,
      accepted: true,
      planned: { low: expected * 0.8, expected, high: expected * 1.2 },
    });
    const measured = estimate({
      base: done(1_500_000, 1_000_000),
      path: done(1_800_000, 1_200_000),
      cli: done(2_100_000, 1_400_000),
      readcmd: running(400_000, READCMD),
      syntax: running(500_000, SYNTAX),
    });
    expect(measured.planCalibration.features).toBe(3);
    const ratio = 1 + (1 / 3) * (1.5 - 1);
    expect(measured.planCalibration.ratio).toBeCloseTo(ratio, 6);
    expect(of(measured, "readcmd")?.tokens.low).toBe(Math.round(3_490_000 * ratio));
    expect(of(measured, "syntax")?.tokens.low).toBe(Math.round(3_960_000 * ratio));
    expect(measured.notes.join("\n")).toContain("times 1.17, how far 3 accepted features landed from their own plans");
    expect(calibrationLagText(measured)).toBe("");
  });

  test("a plan below the class need keeps the class need; the plan's low end is never undercut", () => {
    const cheap = { low: 600_000, expected: 800_000, high: 1_000_000 };
    const below = estimate({ readcmd: running(100_000, cheap) });
    expect(of(below, "readcmd")?.tokens).toEqual(of(estimate(), "readcmd")?.tokens);
    // A ratio below 1 does not take the need under the plan's own low end.
    expect(ownPlanNeed(READCMD, 0.5)).toEqual({ low: 2_600_000, high: 4_070_000 });
    expect(ownPlanNeed(READCMD, 1.3)).toEqual({ low: 4_537_000, high: 4_537_000 });
    // A report without an expected value prices from its low end, as before.
    expect(ownPlanNeed({ low: 2_600_000, high: 4_070_000 }, null)).toEqual({ low: 2_600_000, high: 4_070_000 });
  });

  test("the split request says the calibration is unmeasured and which features their plans price", () => {
    const planned = estimate({
      readcmd: running(400_000, READCMD),
      syntax: running(500_000, SYNTAX),
    });
    expect(calibrationLagText(planned)).toBe(
      " The measured calibration is unmeasured until 3 features are accepted (0 so far); 2 features still to run are priced by their own plans.",
    );
    expect(calibrationLagText(estimate())).toBe(" The measured calibration is unmeasured until 3 features are accepted (0 so far).");
  });
});

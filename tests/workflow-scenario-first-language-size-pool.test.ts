import { describe, expect, test } from "bun:test";
import { SUPPORTED_LANGUAGES } from "../src/core/intelligence/language-records.js";
import { EXT_TO_LANGUAGE } from "../src/core/intelligence/types.js";
import type { PastRun } from "../src/core/workflows/estimate.js";
import * as estimates from "../src/core/workflows/initiatives/estimate.js";
import type {
  FeatureRunSample,
  FeatureToEstimate,
  InitiativeEstimate,
} from "../src/core/workflows/initiatives/estimate.js";
import * as plans from "../src/core/workflows/initiatives/plan.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";

// #2398: the size pool priced a language's first initiative from other languages' features. R73
// flatelens (the first Lua initiative) went above the high end of 6 of its 8 features, R74
// ladlemath (the first PHP one) 7 of 12, and the corpus's last six rounds put 31 of 90 finished
// features above their range, beyond the bound of 30.7.
const SDD = [
  { id: "specify", type: "agent", models: [] },
  { id: "implement", type: "tasks", models: [] },
];
const history: PastRun[] = Array.from({ length: 6 }, (_, i) => ({
  runId: `h${i}`,
  workflowId: "sdd",
  status: "completed",
  tokens: 1_000_000,
  calls: 10,
  activeMs: 1000,
  taskCount: 6,
  stageTokens: { specify: 200_000, implement: 800_000 },
  taskTokens: 800_000,
}));
const sample = (
  runId: string,
  initiativeId: string,
  language: string,
  startedAt: number,
  perPath: number,
  paths: number,
): FeatureRunSample => ({
  runId,
  workflowId: "sdd",
  size: "medium",
  tokens: perPath * paths,
  taskCount: 6,
  paths,
  source: "shared",
  initiativeId,
  startedAt,
  language,
});
// Five TypeScript initiatives and two Go ones at 0.40M-0.50M per path, then the first Lua and the
// first Ruby initiative at two to three times that. Lua's `cheap` feature cost less than the rest,
// so the measured first-language ratios start below 1.
const known = (id: string, language: string, startedAt: number): FeatureRunSample[] => [
  sample(`${id}a`, id, language, startedAt, 400_000, 3),
  sample(`${id}b`, id, language, startedAt, 450_000, 4),
  sample(`${id}c`, id, language, startedAt, 500_000, 2),
];
const SAMPLES = [
  ...known("T1", "typescript", 1),
  ...known("G1", "go", 2),
  ...known("T2", "typescript", 3),
  ...known("T3", "typescript", 4),
  ...known("G2", "go", 5),
  ...known("T4", "typescript", 6),
  ...known("T5", "typescript", 7),
  sample("l1", "L1", "lua", 8, 1_200_000, 3),
  sample("l2", "L1", "lua", 8, 1_350_000, 4),
  sample("cheap", "L1", "lua", 8, 300_000, 2),
  sample("r1", "R1", "ruby", 9, 1_000_000, 3),
  sample("r2", "R1", "ruby", 9, 1_100_000, 2),
];
const feature = (id: string, paths: number): FeatureToEstimate => ({
  id,
  title: id,
  workflowId: "sdd",
  size: "medium",
  stages: SDD,
  paths,
});
const FEATURES = [feature("parse", 3), feature("render", 4), feature("cli", 2)];
const estimate = (
  language: string | undefined,
  progress?: Parameters<typeof estimates.estimateInitiative>[0]["progress"],
): InitiativeEstimate =>
  estimates.estimateInitiative({
    features: FEATURES,
    history,
    samples: SAMPLES,
    maxTotalTokens: 60_000_000,
    ...(progress ? { progress } : {}),
    ...(language ? { language } : {}),
  });

describe("scenario: a language new to the size pool gets a high end that covers first-initiative overruns (#2398)", () => {
  test("the first PHP initiative is priced up to the measured first-language ratio; the low end and the expectation stay", () => {
    const known = estimate(undefined);
    const php = estimate("php");
    // The general ratios, over every initiative, keep the high end of a known language lower.
    expect(known.highCalibration?.high).toBeLessThan(php.newLanguage?.calibration.high ?? 0);
    expect(php.newLanguage?.language).toBe("php");
    expect(php.newLanguage?.features).toBe(0);
    const calibration = php.newLanguage?.calibration;
    // Measured on the features of the first initiative of each language, priced from other
    // languages' features alone: the Lua and Ruby overruns, and the cheaper Lua feature.
    expect(calibration?.low).toBeLessThan(1);
    expect(calibration?.high).toBeGreaterThan(2);
    for (const [i, f] of php.features.entries()) {
      const before = known.features[i];
      expect(f.tokens.low).toBe(before?.tokens.low ?? -1);
      expect(f.expectedTokens).toBe(before?.expectedTokens ?? -1);
      expect(f.tokens.high).toBe(Math.round(f.tokens.low * (calibration?.high ?? 0)));
      expect(f.tokens.high).toBeGreaterThan(before?.tokens.high ?? 0);
      expect(f.newLanguage).toBe(true);
      // A first-initiative overrun of 2.5 times the low end (R73 flatelens's bits, R74
      // ladlemath's head) was above the range and is within it now.
      expect(2.5 * f.tokens.low).toBeGreaterThan(before?.tokens.high ?? 0);
      expect(2.5 * f.tokens.low).toBeLessThanOrEqual(f.tokens.high);
    }
    // The whole initiative's bound widens with its features, from first initiatives' totals.
    expect(php.tokens.high).toBeGreaterThan(known.tokens.high);
    expect(php.expectedTokens).toBe(known.expectedTokens);
    expect(php.notes.join("\n")).toContain("finished php features, fewer than 3");
  });

  test("a language the pool has measured is priced as before", () => {
    const known = estimate(undefined);
    for (const language of ["typescript", "lua"]) {
      const priced = estimate(language);
      expect(priced.newLanguage).toBeUndefined();
      expect(priced.features.map((f) => f.tokens)).toEqual(known.features.map((f) => f.tokens));
      expect(priced.features.some((f) => f.newLanguage)).toBe(false);
    }
    // Ruby has two finished features, fewer than three: still new.
    expect(estimate("ruby").newLanguage?.features).toBe(2);
  });

  test("the initiative's own accepted features count toward the language's three", () => {
    const accepted = (n: number) => ({
      features: Object.fromEntries(
        FEATURES.slice(0, n).map((f) => [f.id, { spent: 3_000_000, accepted: true }]),
      ),
      overhead: 0,
    });
    expect(estimate("php", accepted(2)).newLanguage?.features).toBe(2);
    expect(estimate("php", accepted(3)).newLanguage).toBeUndefined();
  });

  test.each([...SUPPORTED_LANGUAGES])("every supported language's first initiative is new to the pool: %s", (language) => {
    const unseen = SAMPLES.filter((s) => s.language !== language);
    const priced = estimates.estimateInitiative({
      features: FEATURES,
      history,
      samples: unseen,
      maxTotalTokens: 60_000_000,
      language,
    });
    expect(priced.newLanguage?.language).toBe(language);
    expect(priced.features.every((f) => f.tokens.high >= Math.round(f.tokens.low * 2))).toBe(true);
    // The plan's boundary paths name the language.
    const ext = Object.entries(EXT_TO_LANGUAGE).find(([, l]) => l === language)?.[0];
    expect(ext).toBeDefined();
    const plan = {
      features: [
        { boundary: { paths: [`src/main${ext}`, `src/lib${ext}`, "README.md", "src/**"] } },
      ],
    } as unknown as InitiativePlan;
    expect(plans.planLanguage?.(plan)).toBe(language);
  });

  test("a plan that names no code has no language and is priced as before", () => {
    const plan = {
      features: [{ boundary: { paths: ["README.md", "docs/**"] } }],
    } as unknown as InitiativePlan;
    expect(typeof plans.planLanguage).toBe("function");
    expect(plans.planLanguage(plan)).toBeNull();
  });
});

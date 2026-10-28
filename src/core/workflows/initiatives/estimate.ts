/**
 * The estimate of a split initiative: a difficulty level and a token range, per feature and in
 * total. Every number is a forecast from the runs this project already stored (or the generic
 * ranges of `estimate.ts` when there are none), never a provider-specific constant, and it is
 * used by split approval warnings, feature budget reserves and the optional forecast stop.
 */
import {
  DEFAULT_TASK_COUNT,
  estimatePreRun,
  type PastRun,
  rangeOf,
  rangeText,
  type TokenRange,
  tokenText,
} from "../estimate.js";
import {
  type BudgetDetail,
  estimateBudgetText,
  type HighCalibration,
  highCalibrationText,
  MIN_HIGH_RATIO_SAMPLES,
} from "./estimate-budget.js";

export { type HighCalibration, highCalibrationText, MIN_HIGH_RATIO_SAMPLES };

import type { TestCaseRate } from "../sizing.js";
import { callsPerToken, finishedRunCallRate } from "./calls-pool.js";
import { planWidth } from "./critical-path.js";
import { type DurationForecast, durationText, msPerToken, scheduledMinutes } from "./duration.js";
import type { FeatureSize } from "./plan.js";

/** The margin added on top of the high end, for the token figure to plan the budget with. */
export const ESTIMATE_MARGIN = 0.25;
/**
 * Planned tasks at which an initiative reaches each level above 1: the midpoints between the
 * typical task counts of the bench difficulty ladder (about 6, 10, 15, 22 and 30 tasks).
 */
export const LEVEL_TASKS = [8, 12.5, 18.5, 26] as const;
/** How many tasks a feature of each size plans next to a typical run of its workflow. */
export const SIZE_TASK_FACTOR: Record<FeatureSize, number> = { small: 0.5, medium: 1, large: 2 };
/**
 * How the stages around the tasks (research, spec, plan, review) of a feature of each size compare
 * with a typical run's: a larger feature writes a longer spec and has more to review. Bench round 34
 * (sketchfold): with those stages at a typical run's cost at every size, a large feature was
 * forecast at 2.4 times a small one and cost 3.4 to 5.5 times as much (#1338).
 */
export const SIZE_STAGE_FACTOR: Record<FeatureSize, number> = { small: 0.6, medium: 1, large: 1.6 };
/**
 * What a placeholder path costs next to a path a feature writes in full: the stub a feature
 * creates for a later feature to fill. Bench round 40 (tonemath): 20 stub tasks used 2.58M tokens,
 * about 129k each, against 389k per path measured on finished features (#1464).
 */
export const PLACEHOLDER_SHARE = 1 / 3;

/**
 * The paths a feature counts for the per-path rate: its own in full, its placeholders less, the
 * files of its skeleton not at all (the host writes them, #1550).
 */
export const pathWeight = (f: { paths?: number; placeholders?: number }): number =>
  (f.paths ?? 0) + PLACEHOLDER_SHARE * (f.placeholders ?? 0);

/**
 * Finished features of a size, with paths, needed before a feature's paths place it within them.
 * Bench rounds 45 to 52: within a size, a feature's tokens follow its paths (medium features about
 * 0.27M plus 0.38M per path), and the size's middle priced R52 srcwhere's two-path modules like
 * six-path ones (#1767).
 */
export const MIN_PATH_FIT_SAMPLES = 4;
/**
 * How closely tokens must follow paths in those features for the fit to place one. Rounds 45 to 52
 * at the split: medium features follow their paths (0.61), large ones hardly (0.14), and a fit of
 * large features from earlier rounds priced R49 shexpand's large features 15% lower than its size's
 * middle, where they cost 1.4 to 2.5 times their forecast.
 */
export const MIN_PATH_FIT_CORRELATION = 0.5;

/** Initiatives the `MIN_HIGH_RATIO_SAMPLES` measured ratios must come from. */
export const MIN_HIGH_RATIO_INITIATIVES = 2;
/** The upper quantile of the measured actual-to-low ratios that sets the high end. */
export const HIGH_RATIO_QUANTILE = 0.9;

/** Tokens against path weight over finished features: `base + perPath * pathWeight`. */
export interface PathFit {
  base: number;
  perPath: number;
}

/** A finished feature run of an earlier initiative, with the size its plan gave the feature. */
export interface FeatureRunSample {
  runId: string;
  workflowId: string;
  size: FeatureSize;
  tokens: number;
  taskCount: number;
  /** The run's active time; absent in older callers, whose samples give no minutes (#1557). */
  activeMs?: number;
  /** The run's agent calls; absent in older callers, whose samples give no calls pace (#2345). */
  calls?: number;
  /** The acceptance criteria of the run's spec; absent before a spec exists. */
  criteria?: number;
  /** The paths of the feature's boundary in its plan that no later feature lists; absent or 0 when it named none. */
  paths?: number;
  /** Paths of its boundary a later feature of the plan lists too (`boundaryPathCounts`). */
  placeholders?: number;
  /** Files of its skeleton, which the host wrote; they are not in the per-path rate. */
  skeleton?: number;
  /**
   * The initiative the feature run belongs to, unique across stores; absent in older callers, whose
   * samples then measure no actual-to-low ratio (`HighCalibration`).
   */
  initiativeId?: string;
  /** This project's store, or one of the policy's `sizing.historyStores`; absent means project. */
  source?: "project" | "shared";
  /** When the feature's run was linked (epoch ms); absent in older callers, which count as newest. */
  startedAt?: number;
}

/** A feature to estimate: its workflow and that workflow's stages. */
export interface FeatureToEstimate {
  id: string;
  title: string;
  workflowId: string;
  size: FeatureSize;
  stages: { id: string; type: string; models: string[] }[];
  /** The paths of the feature's boundary no later feature lists; absent or 0 when the decomposer named none. */
  paths?: number;
  /** Paths of its boundary a later feature lists too: placeholders it creates for that one. */
  placeholders?: number;
  /** Files of its skeleton: the host writes them, so they add nothing to its forecast. */
  skeleton?: number;
  /** The features it waits for, which order the wall-time forecast (#1557); absent means none. */
  dependsOn?: string[];
  /** The test cases the request demands of it (`testCases` of the plan, #2055); absent when none. */
  testCases?: number;
}

export type FeatureEstimateBasis =
  | "measured"
  | "calibrated"
  | "initiative-history"
  | "workflow-history"
  | "history"
  | "defaults";

export interface FeatureEstimate {
  /** Dollar range on the workflow's routed models; absent without a shared dollar budget. */
  costUsd?: TokenRange | null;
  featureId: string;
  title: string;
  workflowId: string;
  size: FeatureSize;
  tokens: TokenRange;
  /** Point forecast before range floors widen it; dollar forecasts use this without a margin. */
  expectedTokens: number;
  tasks: TokenRange;
  basis: FeatureEstimateBasis;
  /** Past runs the range comes from; 0 for generic ranges. */
  samples: number;
  /** Tokens this initiative's runs of the feature have used so far. */
  spent: number;
  /** The acceptance criteria of the feature run's spec, once it has one. */
  criteria?: number;
  /** The paths of the feature's boundary no later feature lists, when it names any. */
  paths?: number;
  /** Placeholder paths of its boundary that a later feature fills, when it has any. */
  placeholders?: number;
  /** Files of its skeleton the host writes, when it has any; they cost no tokens. */
  skeleton?: number;
  /** The test cases the request demands of it, when it states any (#2055). */
  testCases?: number;
  /** The tokens the feature run's plan sizing expects the run to use, once it has a plan. */
  planned?: PlannedRun;
  /**
   * What raised the range above the size-scaled forecast: the spec's criteria, the boundary's
   * paths, the plan's sized tasks or the request's test cases (each times its measured rate);
   * absent when nothing did.
   */
  floor?: FeatureFloor;
  /** The fit over finished features of its size that placed it by its paths, when one did. */
  pathFit?: PathFit;
  /** "ratios" when the measured actual-to-low ratios set the high end (`HighCalibration`). */
  highBasis?: "ratios";
  /** Active minutes still to run: its expected tokens not used yet at the measured rate (#1557). */
  minutes?: number;
}

export type FeatureFloor = "criteria" | "paths" | "plan" | "tests";

/**
 * What a feature run's latest plan sizing expects the whole run to use (`plannedRunTokens`): its
 * range, and the expected value inside it when the report has one.
 */
export interface PlannedRun extends TokenRange {
  expected?: number;
}

/**
 * How far this initiative's accepted features with a plan landed from what their own plans
 * expected (`PlannedRun.expected`): `features` measured, and the blended actual-to-plan ratio,
 * null until `MIN_CALIBRATION_FEATURES` of them are accepted.
 */
export interface PlanCalibration {
  features: number;
  ratio: number | null;
}

/**
 * The tokens a feature whose run has a sized plan needs by that plan (#2043): the plan's expected
 * tokens times the measured plan-to-actual ratio of finished features (times 1 while unmeasured),
 * never below the plan's own low end, and the plan's high end above that. The estimate takes the
 * larger of this and the size class's need, so the share gate, the growth limits and the split
 * approval all reserve it. Bench round 66 (nodepluck): six planned-ahead features' own plans
 * expected 1.95M to 3.96M while the pool kept their class values (1.12M-2.29M medium) until they
 * finished, and the initiative used 2.54x its summed low ends.
 */
export function ownPlanNeed(planned: PlannedRun, ratio: number | null): TokenRange {
  const expected = Math.round((planned.expected ?? planned.low) * (ratio ?? 1));
  const low = Math.max(planned.low, expected);
  return { low, high: Math.max(planned.high, low) };
}

/** What an initiative has used so far: per feature, and on runs of no feature (the split). */
export interface InitiativeProgress {
  features: Record<
    string,
    { spent: number; accepted: boolean; criteria?: number; planned?: PlannedRun }
  >;
  overhead: number;
}

export interface InitiativeEstimate {
  schemaVersion: 1;
  /** 1 to 5, from the planned task count (see `LEVEL_TASKS`). */
  level: 1 | 2 | 3 | 4 | 5;
  tasks: TokenRange;
  tokens: TokenRange;
  /**
   * The point forecast: what is used so far plus each feature's expected tokens. Below the high end,
   * which is a bound, not a forecast (#1982).
   */
  expectedTokens: number;
  /** The high end plus `ESTIMATE_MARGIN`: what to plan the budget with. */
  withMargin: number;
  margin: number;
  budget: { maxTotalTokens: number; fits: "yes" | "maybe" | "no" };
  /** The weakest basis among the features. */
  basis: FeatureEstimateBasis;
  features: FeatureEstimate[];
  /**
   * The re-forecast once features are accepted (#1312): tokens used so far, how many features are
   * accepted, and the blended measured-to-planned ratio that scales the rest. Null until three
   * non-skeleton features are accepted. `bySize` applies the same sampling rule per size (#1338).
   * `rawRatio` is the measured-to-planned ratio itself, unblended and capped like the blend, which
   * only advice reads (#2186); null when `ratio` is.
   */
  progress: {
    spent: number;
    accepted: number;
    ratio: number | null;
    rawRatio: number | null;
    bySize: Partial<Record<FeatureSize, number>>;
  };
  /**
   * Tokens per acceptance criterion, measured on finished feature runs and this initiative's
   * accepted features; a feature whose spec is written is forecast at no less than its criteria
   * times this rate: from the lowest measured rate up to the upper end of their range (the third
   * quartile from four rates on). Null with fewer than `MIN_CRITERIA_SAMPLES` measured features.
   */
  perCriterion: TokenRange | null;
  /**
   * Tokens per boundary path, measured like `perCriterion`: the lowest measured rate up to their
   * median. A feature still to run, whose spec is not written yet, is forecast at no less than
   * its paths times this rate (#1354). Null with fewer than `MIN_CRITERIA_SAMPLES`. Finished
   * features of the stores in `sizing.historyStores` count too, so the rate applies at the split,
   * before any feature of this initiative ran (#1376).
   */
  perPath: TokenRange | null;
  /** The finished features `perPath` is measured on, and how many of them are other projects'. */
  perPathSamples: { features: number; shared: number };
  /**
   * The measured actual-to-low ratios that set the high end of path-floored features; null with
   * fewer than `MIN_HIGH_RATIO_SAMPLES`, when the high end is the median path rate.
   */
  highCalibration: HighCalibration | null;
  /** How this initiative's accepted features compared with their own plans (`ownPlanNeed`). */
  planCalibration: PlanCalibration;
  /**
   * The test cases the request demands across the features still to run and what each is priced
   * at (`testCaseRate`): a feature with `testCases` is forecast at no less than its cases times
   * `perCase` (#2055). Null when no feature carries test cases.
   */
  testVolume: ({ cases: number; features: number } & TestCaseRate) | null;
  /** Minutes still to run, summed and on the run slots; null without timed samples (#1557). */
  duration: DurationForecast | null;
  /**
   * The median agent calls per token of finished feature runs (#2345), the calls forecast's
   * fallback before the initiative has its own; null with too few.
   */
  callsPace: { rate: number; samples: number } | null;
  notes: string[];
  label: string;
}

const BASIS_ORDER: FeatureEstimateBasis[] = [
  "measured",
  "calibrated",
  "initiative-history",
  "workflow-history",
  "history",
  "defaults",
];
const sum = (ranges: TokenRange[]): TokenRange =>
  ranges.reduce((a, b) => ({ low: a.low + b.low, high: a.high + b.high }), { low: 0, high: 0 });
const scaled = (r: TokenRange, f: number): TokenRange => ({
  low: Math.round(r.low * f),
  high: Math.round(r.high * f),
});
const middle = (r: TokenRange): number => (r.low + r.high) / 2;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[half] ?? 0)
    : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
};

/** Linear-interpolated quantile `q` of `values` (not empty). */
const quantileOf = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const at = sorted[base] ?? 0;
  return at + (pos - base) * ((sorted[base + 1] ?? at) - at);
};
const ratioRound = (r: number): number => Math.round(r * 100) / 100;

/**
 * The actual-to-low ratios of finished features (`HighCalibration`), or null with fewer than
 * `MIN_HIGH_RATIO_SAMPLES` of them from `MIN_HIGH_RATIO_INITIATIVES` initiatives. A finished
 * feature is priced from the other initiatives' features alone, as the estimate prices a feature
 * still to run from earlier initiatives (their size and path fit, then the path floor at their
 * lowest per-path rate), and compared with what it used. `accepted` are this initiative's
 * accepted features with the low end the samples gave them.
 */
export function highCalibrationOf(
  samples: FeatureRunSample[],
  accepted: { low: number; spent: number }[] = [],
): HighCalibration | null {
  const rate = (s: FeatureRunSample) => s.tokens / pathWeight(s);
  const ratios: number[] = [];
  const initiatives = new Set<string>();
  // Per initiative, what its features used against the sum of their low ends: features of one
  // initiative miss in the same direction, so the total's spread is its own.
  const totals: number[] = [];
  const groups = Map.groupBy(
    samples.filter((s) => s.initiativeId && s.tokens > 0),
    (s) => s.initiativeId ?? "",
  );
  for (const [id, own] of groups) {
    const others = samples.filter((o) => o.initiativeId && o.initiativeId !== id);
    if (!others.length) continue;
    const rates = others.filter((o) => pathWeight(o) > 0).map(rate);
    const lowest = rates.length >= MIN_CRITERIA_SAMPLES ? Math.min(...rates) : 0;
    let used = 0;
    let lows = 0;
    for (const s of own) {
      // No stages and no run history: the backtest prices by finished features only.
      const priced = estimateFeature(
        {
          id: s.runId,
          title: s.runId,
          workflowId: s.workflowId,
          size: s.size,
          stages: [],
          ...(s.paths ? { paths: s.paths } : {}),
          ...(s.placeholders ? { placeholders: s.placeholders } : {}),
          ...(s.skeleton ? { skeleton: s.skeleton } : {}),
        },
        [],
        others,
      );
      const low = Math.max(priced.tokens.low, lowest * pathWeight(s));
      if (low <= 0) continue;
      ratios.push(s.tokens / low);
      initiatives.add(id);
      used += s.tokens;
      lows += low;
    }
    if (lows > 0) totals.push(used / lows);
  }
  // This initiative's accepted features, against the low end the earlier initiatives gave them.
  const own = accepted.filter((a) => a.low > 0 && a.spent > 0);
  for (const a of own) ratios.push(a.spent / a.low);
  if (own.length) {
    initiatives.add("");
    totals.push(own.reduce((t, a) => t + a.spent, 0) / own.reduce((t, a) => t + a.low, 0));
  }
  if (ratios.length < MIN_HIGH_RATIO_SAMPLES || initiatives.size < MIN_HIGH_RATIO_INITIATIVES)
    return null;
  return {
    samples: ratios.length,
    initiatives: initiatives.size,
    low: ratioRound(Math.min(...ratios)),
    median: ratioRound(median(ratios)),
    high: ratioRound(quantileOf(ratios, HIGH_RATIO_QUANTILE)),
    total: {
      low: ratioRound(Math.min(...totals)),
      median: ratioRound(median(totals)),
      high: ratioRound(quantileOf(totals, HIGH_RATIO_QUANTILE)),
    },
  };
}

/** The level of a planned task count. */
export function levelOf(tasks: number): InitiativeEstimate["level"] {
  const above = LEVEL_TASKS.filter((t) => tasks >= t).length;
  return (above + 1) as InitiativeEstimate["level"];
}

/** Planned task counts of a workflow's finished runs, then of any finished run, then defaults. */
function taskCounts(history: PastRun[], workflowId: string): TokenRange {
  const counts = (runs: PastRun[]) =>
    rangeOf(
      runs.filter((r) => r.status === "completed" && r.taskCount > 0).map((r) => r.taskCount),
    );
  return (
    counts(history.filter((r) => r.workflowId === workflowId)) ??
    counts(history) ??
    DEFAULT_TASK_COUNT
  );
}

/**
 * Least squares of tokens on path weight over `pool`, and each
 * sample's residual. Null with fewer than `MIN_PATH_FIT_SAMPLES` samples that name paths, when
 * they all name the same number, or when their tokens follow their paths less closely than
 * `MIN_PATH_FIT_CORRELATION`.
 */
function pathFitOf(
  pool: FeatureRunSample[],
  value: (s: FeatureRunSample) => number = (s) => s.tokens,
): (PathFit & { residuals: number[] }) | null {
  const named = pool.filter((s) => pathWeight(s) > 0);
  if (named.length < MIN_PATH_FIT_SAMPLES) return null;
  const xs = named.map(pathWeight);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = named.reduce((a, s) => a + value(s), 0) / named.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = named.reduce((a, s, i) => a + ((xs[i] ?? 0) - mx) * (value(s) - my), 0);
  const syy = named.reduce((a, s) => a + (value(s) - my) ** 2, 0);
  if (syy === 0 || sxy / Math.sqrt(sxx * syy) < MIN_PATH_FIT_CORRELATION) return null;
  const perPath = sxy / sxx;
  const base = my - perPath * mx;
  return {
    base,
    perPath,
    residuals: named.map((s, i) => value(s) - (base + perPath * (xs[i] ?? 0))),
  };
}

function estimateFeature(
  feature: FeatureToEstimate,
  history: PastRun[],
  samples: FeatureRunSample[],
  weights: ReadonlyMap<FeatureRunSample, number> | null = null,
): FeatureEstimate {
  const head = {
    featureId: feature.id,
    title: feature.title,
    workflowId: feature.workflowId,
    size: feature.size,
    spent: 0,
    ...(feature.paths ? { paths: feature.paths } : {}),
    ...(feature.placeholders ? { placeholders: feature.placeholders } : {}),
    ...(feature.skeleton ? { skeleton: feature.skeleton } : {}),
    ...(feature.testCases ? { testCases: feature.testCases } : {}),
  };
  const hasTasks = feature.stages.some((s) => s.type === "tasks");
  // Finished feature runs of the same size measure the whole feature, split and all; those of the
  // same workflow first once there are two.
  const sized = samples.filter((s) => s.size === feature.size);
  const sameWorkflow = sized.filter((s) => s.workflowId === feature.workflowId);
  const pool = sameWorkflow.length >= 2 ? sameWorkflow : sized;
  const run = estimatePreRun({
    history,
    workflowId: feature.workflowId,
    stages: feature.stages,
    maxTotalTokens: 0,
    price: () => null,
  });
  // Features of other workflows price a feature only while its own workflow has no runs: a quick
  // leaf skips the research, spec, analysis and reviews of an sdd feature, and the small sdd
  // features priced R54 lanewalk's three light leaves at 0.80M-1.00M where they used 0.33M-0.47M,
  // and R55's two at 1.01M-1.38M where they used 0.39M and 0.76M (#1813).
  const ownRuns =
    sameWorkflow.length < 2 &&
    sized.length > sameWorkflow.length &&
    run.basis === "workflow-history";
  const poolRange = (value: (s: FeatureRunSample) => number) =>
    weights
      ? weightedRangeOf(pool.map((s) => [value(s), weights.get(s) ?? 1]))
      : rangeOf(pool.map(value));
  const measured = ownRuns ? null : poolRange((s) => s.tokens);
  // A feature that names paths sits where its paths put it among them, with their spread around
  // the fit; never below the cheapest of them.
  const placeBy = (value: (s: FeatureRunSample) => number) => {
    const f = pathWeight(feature) > 0 ? pathFitOf(pool, value) : null;
    const cheapest = Math.min(...pool.map(value));
    const range =
      f &&
      rangeOf(
        f.residuals.map((r) => Math.max(cheapest, f.base + f.perPath * pathWeight(feature) + r)),
      );
    return range ? { fit: f, range } : null;
  };
  const byTokens = measured ? placeBy((s) => s.tokens) : null;
  const fit = byTokens?.fit;
  const placed = byTokens?.range;
  if (measured) {
    const tokens = placed ?? measured;
    return {
      ...head,
      tokens,
      expectedTokens: middle(tokens),
      // Its tasks follow its paths the same way, so a two-path module does not plan six-path counts.
      tasks: hasTasks
        ? (placeBy((s) => s.taskCount)?.range ??
          poolRange((s) => s.taskCount) ?? { low: 0, high: 0 })
        : { low: 0, high: 0 },
      basis: "initiative-history",
      samples: pool.length,
      ...(placed && fit
        ? { pathFit: { base: Math.round(fit.base), perPath: Math.round(fit.perPath) } }
        : {}),
    };
  }
  // Otherwise a typical run of the feature's workflow scaled by the feature's size: its tasks by the
  // planned task count, the stages around them less steeply.
  const factor = SIZE_TASK_FACTOR[feature.size];
  const stageFactor = SIZE_STAGE_FACTOR[feature.size];
  const tokens = sum(
    run.stages.map((s) => scaled(s.tokens, s.type === "tasks" ? factor : stageFactor)),
  );
  const counts = taskCounts(history, feature.workflowId);
  const tasks = hasTasks
    ? {
        low: Math.max(1, Math.round(counts.low * factor)),
        high: Math.max(1, Math.round(counts.high * factor)),
      }
    : { low: 0, high: 0 };
  const basis: FeatureEstimateBasis = run.basis;
  return {
    ...head,
    tokens,
    expectedTokens: middle(tokens),
    tasks,
    basis,
    samples: basis === "defaults" ? 0 : run.samples,
  };
}

/** The expected value and measured spread the budget text words its warning by (#1982). */
export const budgetDetail = (
  estimate: Pick<InitiativeEstimate, "expectedTokens" | "highCalibration">,
): BudgetDetail => ({
  expectedTokens: estimate.expectedTokens,
  spread: highCalibrationText(estimate.highCalibration),
});

/**
 * The split warning's words on a calibration still to come (#2043): until
 * `MIN_CALIBRATION_FEATURES` features are accepted nothing this initiative measured scales the
 * features still to run, and in a parallel plan they finish late (bench round 66: 4 measured when
 * half the budget was spent). Empty once the ratio is measured; leads with a space otherwise.
 */
export function calibrationLagText(
  estimate: Pick<InitiativeEstimate, "progress" | "features">,
): string {
  if (estimate.progress.ratio !== null) return "";
  const planned = estimate.features.filter((f) => f.basis !== "measured" && f.planned).length;
  return ` The measured calibration is unmeasured until ${MIN_CALIBRATION_FEATURES} features are accepted (${estimate.progress.accepted} so far)${planned ? `; ${planned} features still to run are priced by their own plans` : ""}.`;
}

/**
 * The test volume line of the estimate and the split request (#2055): the cases the request
 * demands of the features still to run, and what a case is priced at.
 */
export function testVolumeText(
  volume: NonNullable<InitiativeEstimate["testVolume"]>,
  features: Pick<FeatureEstimate, "featureId" | "testCases">[],
): string {
  const each = features.map((f) => `${f.featureId} ${f.testCases}`).join(", ");
  const from =
    volume.basis === "defaults"
      ? "the default allowance: no finished test task with cases yet"
      : `as measured on ${volume.samples} finished test tasks${volume.basis === "project" ? " of this project" : ""}`;
  return `The request demands ${volume.cases} test cases of ${volume.features} features (${each}); each feature is forecast at no less than ${rangeText(volume.perCase)} tokens per case, ${from}.`;
}

/** The estimate in one line for a screen: level, tasks, tokens, what to plan for, the budget. */
export function estimateSummary(estimate: InitiativeEstimate): string {
  const fits = estimateBudgetText(
    estimate.tokens,
    estimate.budget,
    estimate.withMargin,
    budgetDetail(estimate),
  );
  const wall = estimate.duration
    ? ` · ~${Math.round(estimate.duration.wallMinutes)} min wall with ${estimate.duration.slots} at once (~${Math.round(estimate.duration.activeMinutes)} min active)`
    : "";
  return `Level ${estimate.level} · ~${estimate.tasks.low}-${estimate.tasks.high} tasks · ${rangeText(estimate.tokens)} tokens · expected ${tokenText(estimate.expectedTokens)} · plan for ${tokenText(estimate.withMargin)}${wall} · ${fits}`;
}

const fitsOf = (high: number, low: number, limit: number): "yes" | "maybe" | "no" =>
  high <= limit ? "yes" : low <= limit ? "maybe" : "no";

/** Measured features with criteria needed before the estimate prices features by criteria. */
export const MIN_CRITERIA_SAMPLES = 2;

/** Maximum measured-to-forecast ratio that scales the features still to run. */
const MAX_RATIO = 5;
/** Accepted non-skeleton features needed before measured usage scales the remaining split. */
export const MIN_CALIBRATION_FEATURES = 3;

/**
 * Blend a third of the measured ratio at three samples, two thirds at four, and all at five. The
 * token pool's forecast blends its actual-to-low ratio the same way (`poolForecast`, #2042).
 */
export function calibrationRatio(measured: number, forecast: number, count: number): number | null {
  if (count < MIN_CALIBRATION_FEATURES || forecast <= 0 || measured <= 0) return null;
  const weight = Math.min(1, (count - MIN_CALIBRATION_FEATURES + 1) / MIN_CALIBRATION_FEATURES);
  return 1 + weight * (Math.min(MAX_RATIO, measured / forecast) - 1);
}

/**
 * The features as they stand: an accepted one at its measured tokens, the rest at their forecast
 * scaled by how far the accepted ones were from theirs, and never below what they already used.
 * Bench round 32 (notesift): the split's forecast of 10.6M to 19.0M said "fits" and the initiative
 * used 32.7M; its first features had shown the gap long before the budget ran out.
 */
function reforecast(
  prior: FeatureEstimate[],
  progress: InitiativeProgress,
  samples: FeatureRunSample[],
  perTestCase: TokenRange | null,
): {
  features: FeatureEstimate[];
  ratio: number | null;
  rawRatio: number | null;
  bySize: Partial<Record<FeatureSize, number>>;
  perCriterion: TokenRange | null;
  perPath: TokenRange | null;
  perPathSamples: { features: number; shared: number };
  highCalibration: HighCalibration | null;
  planCalibration: PlanCalibration;
} {
  const used = (f: FeatureEstimate): InitiativeProgress["features"][string] =>
    progress.features[f.featureId] ?? { spent: 0, accepted: false };
  const accepted = prior.filter((f) => used(f).accepted);
  // Host-written skeletons have a different cost from delivering a feature, regardless of size.
  const representative = accepted.filter((f) => !f.skeleton);
  const ratioOf = (features: FeatureEstimate[]): number | null => {
    const forecast = features.reduce((total, f) => total + middle(f.tokens), 0);
    const measured = features.reduce((total, f) => total + used(f).spent, 0);
    // Cheap accepted features must calibrate the remaining work below 25% of the prior too.
    // A lower bound inflated the dollar forecast despite a spend rate that fit the cap (#1607).
    return calibrationRatio(measured, forecast, features.length);
  };
  const ratio = ratioOf(representative);
  // The same ratio unblended, for advice only (#2186): decisions keep the blend.
  const rawRatio =
    ratio === null
      ? null
      : calibrationRatio(
          representative.reduce((total, f) => total + used(f).spent, 0),
          representative.reduce((total, f) => total + middle(f.tokens), 0),
          Number.MAX_SAFE_INTEGER,
        );
  // Accepted features against what their own plans expected: the ratio that scales the plan of a
  // feature still to run (`ownPlanNeed`).
  const withPlan = representative.filter((f) => (used(f).planned?.expected ?? 0) > 0);
  const planCalibration: PlanCalibration = {
    features: withPlan.length,
    ratio: calibrationRatio(
      withPlan.reduce((total, f) => total + used(f).spent, 0),
      withPlan.reduce((total, f) => total + (used(f).planned?.expected ?? 0), 0),
      withPlan.length,
    ),
  };
  // Accepted features of the same size say more about a feature than all of them together: in
  // bench round 34 the accepted large feature used 3.2 times its forecast and the medium one about
  // its forecast, and the other large feature then used 3.3 times its own (#1338).
  const bySize: Partial<Record<FeatureSize, number>> = {};
  for (const size of ["small", "medium", "large"] as const) {
    const own = ratioOf(representative.filter((f) => f.size === size));
    if (own !== null) bySize[size] = own;
  }
  // A feature's work grows with the criteria its spec sets: bench round 32's notesift features
  // with the most criteria overran a size-based forecast the most (#1312).
  const rates = [
    ...samples.filter((s) => (s.criteria ?? 0) > 0).map((s) => s.tokens / (s.criteria ?? 1)),
    ...accepted
      .map(used)
      .filter((u) => (u.criteria ?? 0) > 0 && u.spent > 0)
      .map((u) => u.spent / (u.criteria ?? 1)),
  ];
  // From the lowest rate, like the path floor below (#1806), up to the upper end of their range.
  const criteriaRange = rates.length >= MIN_CRITERIA_SAMPLES ? rangeOf(rates) : null;
  const perCriterion = criteriaRange && {
    low: Math.round(Math.min(...rates)),
    high: criteriaRange.high,
  };
  // The boundary's paths tell features of one size apart before any of them runs: in bench round
  // 35 the four large narrowfit features named 4 to 11 paths and used 1.8M to 7.9M tokens, at 0.36M
  // to 0.92M per path, while the size gave them one range (#1354). A placeholder counts at its
  // share, so a stub two features list does not dilute the rate of the feature that creates it.
  const pathSamples = samples.filter((s) => pathWeight(s) > 0);
  const pathRates = [
    ...pathSamples.map((s) => s.tokens / pathWeight(s)),
    ...accepted
      .filter((f) => pathWeight(f) > 0 && used(f).spent > 0)
      .map((f) => used(f).spent / pathWeight(f)),
  ];
  // From the lowest rate, not the first quartile: a floor no measured feature stayed under. The
  // quartile applied from four samples on, and once other projects' features counted (#1376) it
  // put the low end of 11 of 12 R54 lanewalk features (Java, 165k-308k per path) above their cost,
  // at 365k per path over 91 features (#1806). Up to the median, not the highest rate: a file dense
  // in rules costs several times a plain one (bench round 36, seqmill: 0.29M to 1.28M per path),
  // and the highest rate scaled every feature still to run up to 1.9 times what it used.
  const perPath =
    pathRates.length >= MIN_CRITERIA_SAMPLES
      ? { low: Math.round(Math.min(...pathRates)), high: Math.round(median(pathRates)) }
      : null;
  // The path floor the samples alone set, for the low end an accepted feature was given.
  const sampleRates = pathSamples.map((s) => s.tokens / pathWeight(s));
  const sampleLowest = sampleRates.length >= MIN_CRITERIA_SAMPLES ? Math.min(...sampleRates) : 0;
  const highCalibration = highCalibrationOf(
    samples,
    accepted.map((f) => ({
      low: Math.max(f.tokens.low, sampleLowest * pathWeight(f)),
      spent: used(f).spent,
    })),
  );
  const features = prior.map((f): FeatureEstimate => {
    const { spent, accepted: done, criteria, planned } = used(f);
    const known = { ...(criteria ? { criteria } : {}), ...(planned ? { planned } : {}) };
    if (done)
      return {
        ...f,
        ...known,
        tokens: { low: spent, high: spent },
        expectedTokens: spent,
        basis: "measured",
        spent,
      };
    const scale = bySize[f.size] ?? ratio;
    const base = scale === null ? f.tokens : scaled(f.tokens, scale);
    // Floors from what is known of the feature itself: its spec's criteria, its boundary's paths,
    // and the run its plan sized, its tasks and what is spent around them (language's plan priced
    // 4.55 to 8.08 dollars of tasks while its estimate still said 2.65M tokens at most). Once the spec is written its criteria
    // replace the paths: seqmill used 155k to 320k per criterion against 0.29M to 1.28M per path.
    const byCriteria = perCriterion && criteria ? scaled(perCriterion, criteria) : null;
    const byPaths = !byCriteria && perPath && pathWeight(f) ? scaled(perPath, pathWeight(f)) : null;
    // The test cases the request demands of it, at what a case costs in this project's test
    // tasks: R66 nodepluck's test tasks were 51.9 percent of the initiative (#2055).
    const byTests = perTestCase && f.testCases ? scaled(perTestCase, f.testCases) : null;
    const floors = (
      [
        ["criteria", byCriteria],
        ["paths", byPaths],
        ["plan", planned ? ownPlanNeed(planned, planCalibration.ratio) : null],
        ["tests", byTests],
      ] as const
    ).filter((entry): entry is readonly [FeatureFloor, TokenRange] => entry[1] !== null);
    const tokens = {
      low: Math.max(base.low, ...floors.map(([, r]) => r.low)),
      high: Math.max(base.high, ...floors.map(([, r]) => r.high)),
    };
    // The floor that set the high end, else the low end; the high end decides the budget.
    const floor =
      floors.find(([, r]) => r.high === tokens.high && r.high > base.high)?.[0] ??
      floors.find(([, r]) => r.low === tokens.low && r.low > base.low)?.[0];
    // Flooring the range's low end raises its midpoint even when its calibrated midpoint
    // already matches measured spend. Floor the point forecast independently (#1607).
    // The plan's own range sets its point forecast, as before #2043, which raised only the need:
    // the dollar forecast priced R66 nodepluck at $28.41 of a $28.45 actual.
    let expectedTokens = Math.max(
      middle(base),
      ...floors.map(([kind, r]) => (kind === "plan" && planned ? middle(planned) : middle(r))),
      tokens.low,
      spent,
    );
    // How far finished features landed above the low end the same rules gave them bounds the
    // high end and sets the expected value (#1982): the median path rate, or a size class of one
    // sample at 0.7x-1.4x, put the high end at about twice the low end by construction, and R62
    // stepvet used 1.32x its low end, R63 eolscope 1.05x. Only ever narrower than today's range,
    // and not where the feature's own spec, plan or a re-forecast of an overrun prices it.
    const bound =
      highCalibration && !byCriteria && !planned && !byTests && (scale === null || scale <= 1)
        ? Math.max(tokens.low, Math.round(tokens.low * highCalibration.high))
        : null;
    const ratios = bound !== null && bound < tokens.high;
    if (ratios && highCalibration) {
      tokens.high = bound;
      expectedTokens = Math.max(
        spent,
        Math.min(
          tokens.high,
          Math.max(tokens.low, Math.round(tokens.low * highCalibration.median)),
        ),
      );
    }
    return {
      ...f,
      ...known,
      tokens: { low: Math.max(tokens.low, spent), high: Math.max(tokens.high, spent) },
      expectedTokens,
      basis: scale === null && !floor ? f.basis : "calibrated",
      ...(floor ? { floor } : {}),
      ...(ratios ? { highBasis: "ratios" as const } : {}),
      spent,
    };
  });
  const perPathSamples = {
    features: pathRates.length,
    shared: pathSamples.filter((s) => s.source === "shared").length,
  };
  return {
    features,
    ratio,
    rawRatio,
    bySize,
    perCriterion,
    perPath,
    perPathSamples,
    highCalibration,
    planCalibration,
  };
}

/**
 * The estimate of `features` against the initiative's token budget. `history` is the project's
 * run history (`estimateHistory`); `samples` are finished feature runs of earlier initiatives.
 */
/**
 * Each finished feature's weight by how recent its initiative is (#2150): it halves for every
 * `halfLife` initiatives whose first feature started after its initiative's first. In the
 * bench-trace corpus the features of rounds 63 to 68 used less than those before: 24 of 60
 * landed below the range their estimate gave them (40%, against 24% in rounds 45 to 61), 20 of
 * them priced by the size pool, which weighed rounds 45 to 62 as much as the last. A sample
 * without a start time, or without an initiative, counts as the newest.
 */
export function recencyWeights(
  samples: readonly FeatureRunSample[],
  halfLife: number,
): Map<FeatureRunSample, number> {
  const first = new Map<string, number>();
  for (const s of samples)
    if (s.initiativeId && s.startedAt !== undefined)
      first.set(s.initiativeId, Math.min(first.get(s.initiativeId) ?? s.startedAt, s.startedAt));
  const starts = [...first.values()];
  return new Map(
    samples.map((s) => {
      const own = s.initiativeId ? first.get(s.initiativeId) : undefined;
      const later = own === undefined ? 0 : starts.filter((t) => t > own).length;
      return [s, 0.5 ** (later / halfLife)];
    }),
  );
}

/**
 * `rangeOf` over weighted values: the middle half from four values on, at the weighted quartiles
 * (each sorted value sits at the weight before it over the total less the last one's, so equal
 * weights give `rangeOf`'s quartiles); fewer values take `rangeOf`.
 */
export function weightedRangeOf(points: readonly (readonly [number, number])[]): TokenRange | null {
  const v = points.filter(([x, w]) => Number.isFinite(x) && x >= 0 && w > 0);
  if (v.length < 4) return rangeOf(v.map(([x]) => x));
  const sorted = [...v].sort((a, b) => a[0] - b[0]);
  const span = sorted.reduce((t, [, w]) => t + w, 0) - (sorted.at(-1)?.[1] ?? 0);
  let before = 0;
  const at = sorted.map(([x, w]) => {
    const p = { x, p: before / span };
    before += w;
    return p;
  });
  const q = (target: number) => {
    const i = at.findIndex((a) => a.p >= target);
    if (i <= 0) return at[Math.max(0, i)]?.x ?? 0;
    const lo = at[i - 1] as { x: number; p: number };
    const hi = at[i] as { x: number; p: number };
    return lo.x + ((target - lo.p) / (hi.p - lo.p)) * (hi.x - lo.x);
  };
  return { low: Math.round(q(0.25)), high: Math.round(q(0.75)) };
}

export function estimateInitiative(input: {
  features: FeatureToEstimate[];
  history: PastRun[];
  samples: FeatureRunSample[];
  maxTotalTokens: number;
  margin?: number;
  /** What this initiative has used so far; its own runs are not in `samples`. */
  progress?: InitiativeProgress;
  /** Feature runs the initiative may start at once, for the wall-time forecast; absent means 1. */
  parallelRuns?: number;
  /** `sizing.recencyHalfLife`: weighs the size pools by `recencyWeights`; absent, all count the same. */
  recencyHalfLife?: number;
  /** What a test case costs (`testCaseRate`), for features with `testCases`; absent prices none. */
  testCaseRate?: TestCaseRate;
}): InitiativeEstimate {
  const margin = input.margin ?? ESTIMATE_MARGIN;
  const progress = input.progress ?? { features: {}, overhead: 0 };
  const {
    features,
    ratio,
    rawRatio,
    bySize,
    perCriterion,
    perPath,
    perPathSamples,
    highCalibration,
    planCalibration,
  } = reforecast(
    input.features.map((f) =>
      estimateFeature(
        f,
        input.history,
        input.samples,
        input.recencyHalfLife ? recencyWeights(input.samples, input.recencyHalfLife) : null,
      ),
    ),
    progress,
    input.samples,
    input.testCaseRate?.perCase ?? null,
  );
  const overhead = { low: progress.overhead, high: progress.overhead };
  const summed = sum([overhead, ...features.map((f) => f.tokens)]);
  // The total's high end is bounded by how far whole initiatives landed above their summed low
  // ends, never by the sum of each feature's bound: one feature far above its low end is common,
  // a whole initiative less so (#1982). Only what is still to run scales.
  const toRun = features.filter((f) => f.basis !== "measured");
  const totalBound = highCalibration
    ? Math.round(
        summed.low -
          toRun.reduce((t, f) => t + f.tokens.low, 0) +
          toRun.reduce((t, f) => t + f.tokens.low, 0) * Math.max(1, highCalibration.total.high),
      )
    : null;
  const tokens =
    totalBound !== null && totalBound < summed.high
      ? { low: summed.low, high: totalBound }
      : summed;
  const tasks = sum(features.map((f) => f.tasks));
  const level = levelOf(middle(tasks));
  // Measured tokens need no margin; only what is still to run does.
  const known =
    progress.overhead +
    features.filter((f) => f.basis === "measured").reduce((t, f) => t + f.spent, 0);
  const withMargin = Math.round(known + (tokens.high - known) * (1 + margin));
  const expectedTokens = Math.min(
    tokens.high,
    Math.round(progress.overhead + features.reduce((t, f) => t + f.expectedTokens, 0)),
  );
  const accepted = features.filter((f) => f.basis === "measured").length;
  const spent = progress.overhead + features.reduce((t, f) => t + f.spent, 0);
  const basis = features.reduce<FeatureEstimateBasis>(
    (worst, f) => (BASIS_ORDER.indexOf(f.basis) > BASIS_ORDER.indexOf(worst) ? f.basis : worst),
    "measured",
  );
  const generic = features.filter((f) => f.basis === "defaults").length;
  const notes = [
    ...(generic
      ? [
          `${generic} of ${features.length} features use generic ranges: this project has no finished runs of their workflow yet.`,
        ]
      : []),
    ...(input.samples.length || accepted
      ? []
      : ["No finished initiative feature runs yet, so feature sizes scale a typical run's tasks."]),
    ...(ratio !== null
      ? [
          `Re-forecast after ${accepted} of ${features.length} features: non-skeleton samples blend with the planned estimate to scale the features still to run by ${ratio.toFixed(1)}.`,
        ]
      : []),
    ...(Object.keys(bySize).length > 1 ||
    Object.values(bySize).some((r) => ratio !== null && Math.abs(r - ratio) >= 0.05)
      ? (Object.entries(bySize) as [FeatureSize, number][]).map(
          ([size, r]) =>
            `Accepted ${size} non-skeleton features blend with their planned estimates to scale ${size} features still to run by ${r.toFixed(1)} instead.`,
        )
      : []),
    ...(perCriterion && features.some((f) => f.basis !== "measured" && f.criteria)
      ? [
          `A feature whose spec is written is forecast at no less than ${rangeText(perCriterion)} tokens per acceptance criterion, as measured on finished features.`,
        ]
      : []),
    ...[
      ...new Map(
        features
          .filter((f) => f.basis !== "measured" && f.pathFit)
          .map((f) => [f.size, f.pathFit as PathFit]),
      ),
    ].map(
      ([size, fit]) =>
        `A ${size} feature still to run is placed among finished ${size} features by its paths: about ${tokenText(Math.max(0, fit.base))} plus ${tokenText(fit.perPath)} per path.`,
    ),
    ...(perPath && features.some((f) => f.basis !== "measured" && pathWeight(f) && !f.criteria)
      ? [
          `A feature still to run is forecast at no less than ${rangeText(perPath)} tokens per path of its boundary, as measured on ${perPathSamples.features} finished features${perPathSamples.shared ? ` (${perPathSamples.shared} of other projects)` : ""}.`,
        ]
      : []),
    ...(highCalibration && features.some((f) => f.basis !== "measured" && f.highBasis)
      ? [
          `A feature still to run is forecast at most at its low end times ${highCalibration.high.toFixed(2)}, the ${Math.round(HIGH_RATIO_QUANTILE * 100)}th percentile of actual-to-low ratios (${highCalibrationText(highCalibration)}), and expected at the median ratio.`,
        ]
      : []),
    ...(perPath && features.some((f) => f.basis !== "measured" && f.placeholders && !f.criteria)
      ? [
          `A path a later feature also lists counts in full only in that feature, and at ${Math.round(PLACEHOLDER_SHARE * 100)}% as a placeholder in the earlier ones.`,
        ]
      : []),
    ...(perPath && features.some((f) => f.basis !== "measured" && f.skeleton && !f.criteria)
      ? ["A file of a feature's skeleton counts nothing: the host writes it with no agent."]
      : []),
    ...(features.some((f) => f.basis !== "measured" && f.planned)
      ? [
          `A feature whose run has a plan is forecast at no less than the tokens its plan sizing expects the whole run to use, ${planCalibration.ratio !== null ? `times ${planCalibration.ratio.toFixed(2)}, how far ${planCalibration.features} accepted features landed from their own plans` : `unscaled until ${MIN_CALIBRATION_FEATURES} features with a plan are accepted (${planCalibration.features} so far)`}.`,
        ]
      : []),
  ];
  const tested = features.filter((f) => f.basis !== "measured" && f.testCases);
  const testVolume =
    tested.length && input.testCaseRate
      ? {
          cases: tested.reduce((n, f) => n + (f.testCases ?? 0), 0),
          features: tested.length,
          ...input.testCaseRate,
        }
      : null;
  if (testVolume) notes.push(testVolumeText(testVolume, tested));
  const timed = durationOf(input.features, features, input.samples, input.parallelRuns ?? 1);
  const fits = fitsOf(withMargin, tokens.low, input.maxTotalTokens);
  const budgetText = estimateBudgetText(
    tokens,
    { maxTotalTokens: input.maxTotalTokens, fits },
    withMargin,
    { expectedTokens, spread: highCalibrationText(highCalibration) },
  );
  return {
    schemaVersion: 1,
    level,
    tasks,
    tokens,
    expectedTokens,
    withMargin,
    margin,
    budget: { maxTotalTokens: input.maxTotalTokens, fits },
    basis,
    features: timed.features,
    progress: { spent, accepted, ratio, rawRatio, bySize },
    perCriterion,
    perPath,
    perPathSamples,
    highCalibration,
    planCalibration,
    testVolume,
    duration: timed.duration,
    callsPace: callsPerToken(
      input.samples.flatMap((sample) => {
        const rate =
          sample.calls === undefined
            ? null
            : finishedRunCallRate({
                status: "completed",
                tokens: sample.tokens,
                calls: sample.calls,
              });
        return rate === null ? [] : [rate];
      }),
    ),
    notes,
    label: `Estimate: level ${level}, about ${tasks.low}-${tasks.high} tasks, ${rangeText(tokens)} tokens, expected ${tokenText(expectedTokens)} (plan for ${tokenText(withMargin)} with a ${Math.round(margin * 100)}% margin)${spent ? `, ${tokenText(spent)} used with ${accepted} of ${features.length} features accepted` : ""}; ${budgetText}${timed.duration ? `; ${durationText(timed.duration)}` : ""}`,
  };
}

/**
 * Each feature's active minutes still to run and the split's wall time (#1557): the expected
 * tokens a feature has not used yet times the active milliseconds per token of finished feature
 * runs of its workflow (of all when its workflow has too few), none for an accepted feature; the
 * wall time schedules them over the plan's dependencies on `slots` runs, and on the plan's widest
 * group when that is wider. No minutes while a feature has no measured rate.
 */
function durationOf(
  planned: readonly FeatureToEstimate[],
  features: FeatureEstimate[],
  samples: readonly FeatureRunSample[],
  slots: number,
): { features: FeatureEstimate[]; duration: DurationForecast | null } {
  const rates = features.map((f) => msPerToken(samples, f.workflowId));
  if (!features.length || rates.some((r) => r === null)) return { features, duration: null };
  const timed = features.map((f, i) => ({
    ...f,
    minutes:
      f.basis === "measured"
        ? 0
        : (Math.max(0, f.expectedTokens - f.spent) * (rates[i]?.rate ?? 0)) / 60_000,
  }));
  const graph = planned.map((f, i) => ({
    id: f.id,
    minutes: timed[i]?.minutes ?? 0,
    dependsOn: f.dependsOn ?? [],
  }));
  const width = planWidth({ features: graph });
  const all = samples.filter((s) => (s.activeMs ?? 0) > 0 && s.tokens > 0).length;
  return {
    features: timed,
    duration: {
      msPerToken: msPerToken(samples)?.rate ?? 0,
      samples: all,
      activeMinutes: timed.reduce((t, f) => t + f.minutes, 0),
      wallMinutes: scheduledMinutes(graph, slots),
      slots,
      widest: width > slots ? { slots: width, wallMinutes: scheduledMinutes(graph, width) } : null,
    },
  };
}

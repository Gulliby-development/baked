/**
 * The estimate of a split initiative: a difficulty level and a token range, per feature and in
 * total. Every number is a forecast from the runs this project already stored (or the generic
 * ranges of `estimate.ts` when there are none), never a provider-specific constant, and it is
 * computed only when someone asks for it: nothing gates on it.
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
import type { FeatureSize } from "./plan.js";

/** The margin added on top of the high end, for the token figure to plan the budget with. */
export const ESTIMATE_MARGIN = 0.25;
/**
 * Planned tasks at which an initiative reaches each level above 1: the midpoints between the
 * typical task counts of the bench difficulty ladder (about 6, 10, 15, 22 and 30 tasks).
 */
export const LEVEL_TASKS = [8, 12.5, 18.5, 26] as const;
/** How many tasks a feature of each size plans next to a typical run of its workflow. */
const SIZE_TASK_FACTOR: Record<FeatureSize, number> = { small: 0.5, medium: 1, large: 2 };
/**
 * How the stages around the tasks (research, spec, plan, review) of a feature of each size compare
 * with a typical run's: a larger feature writes a longer spec and has more to review. Bench round 34
 * (sketchfold): with those stages at a typical run's cost at every size, a large feature was
 * forecast at 2.4 times a small one and cost 3.4 to 5.5 times as much (#1338).
 */
const SIZE_STAGE_FACTOR: Record<FeatureSize, number> = { small: 0.6, medium: 1, large: 1.6 };

/** A finished feature run of an earlier initiative, with the size its plan gave the feature. */
export interface FeatureRunSample {
  runId: string;
  workflowId: string;
  size: FeatureSize;
  tokens: number;
  taskCount: number;
  /** The acceptance criteria of the run's spec; absent before a spec exists. */
  criteria?: number;
  /** The paths of the feature's boundary in its plan; absent or 0 when it named none. */
  paths?: number;
  /** This project's store, or one of the policy's `sizing.historyStores`; absent means project. */
  source?: "project" | "shared";
}

/** A feature to estimate: its workflow and that workflow's stages. */
export interface FeatureToEstimate {
  id: string;
  title: string;
  workflowId: string;
  size: FeatureSize;
  stages: { id: string; type: string; models: string[] }[];
  /** The paths of the feature's boundary; absent or 0 when the decomposer named none. */
  paths?: number;
}

export type FeatureEstimateBasis =
  | "measured"
  | "calibrated"
  | "initiative-history"
  | "workflow-history"
  | "history"
  | "defaults";

export interface FeatureEstimate {
  featureId: string;
  title: string;
  workflowId: string;
  size: FeatureSize;
  tokens: TokenRange;
  tasks: TokenRange;
  basis: FeatureEstimateBasis;
  /** Past runs the range comes from; 0 for generic ranges. */
  samples: number;
  /** Tokens this initiative's runs of the feature have used so far. */
  spent: number;
  /** The acceptance criteria of the feature run's spec, once it has one. */
  criteria?: number;
  /** The paths of the feature's boundary, when it names any. */
  paths?: number;
  /** The tokens the feature run's plan sizing expects the run to use, once it has a plan. */
  planned?: TokenRange;
  /**
   * What raised the range above the size-scaled forecast: the spec's criteria, the boundary's
   * paths or the plan's sized tasks (each times its measured rate); absent when nothing did.
   */
  floor?: FeatureFloor;
}

export type FeatureFloor = "criteria" | "paths" | "plan";

/** What an initiative has used so far: per feature, and on runs of no feature (the split). */
export interface InitiativeProgress {
  features: Record<
    string,
    { spent: number; accepted: boolean; criteria?: number; planned?: TokenRange }
  >;
  overhead: number;
}

export interface InitiativeEstimate {
  schemaVersion: 1;
  /** 1 to 5, from the planned task count (see `LEVEL_TASKS`). */
  level: 1 | 2 | 3 | 4 | 5;
  tasks: TokenRange;
  tokens: TokenRange;
  /** The high end plus `ESTIMATE_MARGIN`: what to plan the budget with. */
  withMargin: number;
  margin: number;
  budget: { maxTotalTokens: number; fits: "yes" | "maybe" | "no" };
  /** The weakest basis among the features. */
  basis: FeatureEstimateBasis;
  features: FeatureEstimate[];
  /**
   * The re-forecast once features are accepted (#1312): tokens used so far, how many features are
   * accepted, and the ratio of their measured tokens to their forecast, which scales the rest.
   * `bySize` holds the same ratio per feature size with an accepted feature; a feature of that size
   * is scaled by it instead (#1338).
   */
  progress: {
    spent: number;
    accepted: number;
    ratio: number | null;
    bySize: Partial<Record<FeatureSize, number>>;
  };
  /**
   * Tokens per acceptance criterion, measured on finished feature runs and this initiative's
   * accepted features; a feature whose spec is written is forecast at no less than its criteria
   * times this rate. Null with fewer than `MIN_CRITERIA_SAMPLES` measured features.
   */
  perCriterion: TokenRange | null;
  /**
   * Tokens per boundary path, measured like `perCriterion`: the low end of the measured rates up to
   * their median. A feature still to run, whose spec is not written yet, is forecast at no less than
   * its paths times this rate (#1354). Null with fewer than `MIN_CRITERIA_SAMPLES`. Finished
   * features of the stores in `sizing.historyStores` count too, so the rate applies at the split,
   * before any feature of this initiative ran (#1376).
   */
  perPath: TokenRange | null;
  /** The finished features `perPath` is measured on, and how many of them are other projects'. */
  perPathSamples: { features: number; shared: number };
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

function estimateFeature(
  feature: FeatureToEstimate,
  history: PastRun[],
  samples: FeatureRunSample[],
): FeatureEstimate {
  const head = {
    featureId: feature.id,
    title: feature.title,
    workflowId: feature.workflowId,
    size: feature.size,
    spent: 0,
    ...(feature.paths ? { paths: feature.paths } : {}),
  };
  const hasTasks = feature.stages.some((s) => s.type === "tasks");
  // Finished feature runs of the same size measure the whole feature, split and all; those of the
  // same workflow first once there are two.
  const sized = samples.filter((s) => s.size === feature.size);
  const sameWorkflow = sized.filter((s) => s.workflowId === feature.workflowId);
  const pool = sameWorkflow.length >= 2 ? sameWorkflow : sized;
  const measured = rangeOf(pool.map((s) => s.tokens));
  if (measured)
    return {
      ...head,
      tokens: measured,
      tasks: hasTasks
        ? (rangeOf(pool.map((s) => s.taskCount)) ?? { low: 0, high: 0 })
        : { low: 0, high: 0 },
      basis: "initiative-history",
      samples: pool.length,
    };
  // Otherwise a typical run of the feature's workflow scaled by the feature's size: its tasks by the
  // planned task count, the stages around them less steeply.
  const factor = SIZE_TASK_FACTOR[feature.size];
  const stageFactor = SIZE_STAGE_FACTOR[feature.size];
  const run = estimatePreRun({
    history,
    workflowId: feature.workflowId,
    stages: feature.stages,
    maxTotalTokens: 0,
    price: () => null,
  });
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
  return { ...head, tokens, tasks, basis, samples: basis === "defaults" ? 0 : run.samples };
}

/** The estimate in one line for a screen: level, tasks, tokens, what to plan for, the budget. */
export function estimateSummary(estimate: InitiativeEstimate): string {
  const fits =
    estimate.budget.fits === "yes"
      ? "fits the budget"
      : estimate.budget.fits === "maybe"
        ? "may not fit the budget"
        : "over the budget";
  return `Level ${estimate.level} · ~${estimate.tasks.low}-${estimate.tasks.high} tasks · ${rangeText(estimate.tokens)} tokens · plan for ${tokenText(estimate.withMargin)} · ${fits}`;
}

const fitsOf = (high: number, low: number, limit: number): "yes" | "maybe" | "no" =>
  high <= limit ? "yes" : low <= limit ? "maybe" : "no";

/** Measured features with criteria needed before the estimate prices features by criteria. */
export const MIN_CRITERIA_SAMPLES = 2;

/** Bounds of the measured-to-forecast ratio that scales the features still to run. */
const RATIO_BOUNDS = { low: 0.25, high: 5 } as const;

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
): {
  features: FeatureEstimate[];
  ratio: number | null;
  bySize: Partial<Record<FeatureSize, number>>;
  perCriterion: TokenRange | null;
  perPath: TokenRange | null;
  perPathSamples: { features: number; shared: number };
} {
  const used = (f: FeatureEstimate): InitiativeProgress["features"][string] =>
    progress.features[f.featureId] ?? { spent: 0, accepted: false };
  const accepted = prior.filter((f) => used(f).accepted);
  const ratioOf = (features: FeatureEstimate[]): number | null => {
    const forecast = features.reduce((total, f) => total + middle(f.tokens), 0);
    const measured = features.reduce((total, f) => total + used(f).spent, 0);
    return features.length && forecast > 0 && measured > 0
      ? Math.min(RATIO_BOUNDS.high, Math.max(RATIO_BOUNDS.low, measured / forecast))
      : null;
  };
  const ratio = ratioOf(accepted);
  // An accepted feature of the same size says more about a feature than all of them together: in
  // bench round 34 the accepted large feature used 3.2 times its forecast and the medium one about
  // its forecast, and the other large feature then used 3.3 times its own (#1338).
  const bySize: Partial<Record<FeatureSize, number>> = {};
  for (const size of ["small", "medium", "large"] as const) {
    const own = ratioOf(accepted.filter((f) => f.size === size));
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
  const perCriterion = rates.length >= MIN_CRITERIA_SAMPLES ? rangeOf(rates) : null;
  // The boundary's paths tell features of one size apart before any of them runs: in bench round
  // 35 the four large narrowfit features named 4 to 11 paths and used 1.8M to 7.9M tokens, at 0.36M
  // to 0.92M per path, while the size gave them one range (#1354).
  const pathSamples = samples.filter((s) => (s.paths ?? 0) > 0);
  const pathRates = [
    ...pathSamples.map((s) => s.tokens / (s.paths ?? 1)),
    ...accepted
      .filter((f) => (f.paths ?? 0) > 0 && used(f).spent > 0)
      .map((f) => used(f).spent / (f.paths ?? 1)),
  ];
  // Up to the median, not the highest rate: a file dense in rules costs several times a plain one
  // (bench round 36, seqmill: 0.29M to 1.28M per path), and the highest rate scaled every feature
  // still to run up to 1.9 times what it used.
  const pathRange = pathRates.length >= MIN_CRITERIA_SAMPLES ? rangeOf(pathRates) : null;
  const perPath = pathRange && { low: pathRange.low, high: Math.round(median(pathRates)) };
  const features = prior.map((f): FeatureEstimate => {
    const { spent, accepted: done, criteria, planned } = used(f);
    const known = { ...(criteria ? { criteria } : {}), ...(planned ? { planned } : {}) };
    if (done)
      return { ...f, ...known, tokens: { low: spent, high: spent }, basis: "measured", spent };
    const scale = bySize[f.size] ?? ratio;
    const base = scale === null ? f.tokens : scaled(f.tokens, scale);
    // Floors from what is known of the feature itself: its spec's criteria, its boundary's paths,
    // and the run its plan sized, its tasks and what is spent around them (language's plan priced
    // 4.55 to 8.08 dollars of tasks while its estimate still said 2.65M tokens at most). Once the spec is written its criteria
    // replace the paths: seqmill used 155k to 320k per criterion against 0.29M to 1.28M per path.
    const byCriteria = perCriterion && criteria ? scaled(perCriterion, criteria) : null;
    const floors = (
      [
        ["criteria", byCriteria],
        ["paths", !byCriteria && perPath && f.paths ? scaled(perPath, f.paths) : null],
        ["plan", planned ?? null],
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
    return {
      ...f,
      ...known,
      tokens: { low: Math.max(tokens.low, spent), high: Math.max(tokens.high, spent) },
      basis: scale === null && !floor ? f.basis : "calibrated",
      ...(floor ? { floor } : {}),
      spent,
    };
  });
  const perPathSamples = {
    features: pathRates.length,
    shared: pathSamples.filter((s) => s.source === "shared").length,
  };
  return { features, ratio, bySize, perCriterion, perPath, perPathSamples };
}

/**
 * The estimate of `features` against the initiative's token budget. `history` is the project's
 * run history (`estimateHistory`); `samples` are finished feature runs of earlier initiatives.
 */
export function estimateInitiative(input: {
  features: FeatureToEstimate[];
  history: PastRun[];
  samples: FeatureRunSample[];
  maxTotalTokens: number;
  margin?: number;
  /** What this initiative has used so far; its own runs are not in `samples`. */
  progress?: InitiativeProgress;
}): InitiativeEstimate {
  const margin = input.margin ?? ESTIMATE_MARGIN;
  const progress = input.progress ?? { features: {}, overhead: 0 };
  const { features, ratio, bySize, perCriterion, perPath, perPathSamples } = reforecast(
    input.features.map((f) => estimateFeature(f, input.history, input.samples)),
    progress,
    input.samples,
  );
  const overhead = { low: progress.overhead, high: progress.overhead };
  const tokens = sum([overhead, ...features.map((f) => f.tokens)]);
  const tasks = sum(features.map((f) => f.tasks));
  const level = levelOf(middle(tasks));
  // Measured tokens need no margin; only what is still to run does.
  const known =
    progress.overhead +
    features.filter((f) => f.basis === "measured").reduce((t, f) => t + f.spent, 0);
  const withMargin = Math.round(known + (tokens.high - known) * (1 + margin));
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
          `Re-forecast after ${accepted} of ${features.length} features: the accepted ones used ${ratio.toFixed(1)} times their forecast, so the features still to run are scaled by it.`,
        ]
      : []),
    ...(Object.keys(bySize).length > 1 ||
    Object.values(bySize).some((r) => ratio !== null && Math.abs(r - ratio) >= 0.05)
      ? (Object.entries(bySize) as [FeatureSize, number][]).map(
          ([size, r]) =>
            `Accepted ${size} features used ${r.toFixed(1)} times their forecast; ${size} features still to run are scaled by that instead.`,
        )
      : []),
    ...(perCriterion && features.some((f) => f.basis !== "measured" && f.criteria)
      ? [
          `A feature whose spec is written is forecast at no less than ${rangeText(perCriterion)} tokens per acceptance criterion, as measured on finished features.`,
        ]
      : []),
    ...(perPath && features.some((f) => f.basis !== "measured" && f.paths && !f.criteria)
      ? [
          `A feature still to run is forecast at no less than ${rangeText(perPath)} tokens per path of its boundary, as measured on ${perPathSamples.features} finished features${perPathSamples.shared ? ` (${perPathSamples.shared} of other projects)` : ""}.`,
        ]
      : []),
    ...(features.some((f) => f.basis !== "measured" && f.planned)
      ? [
          "A feature whose run has a plan is forecast at no less than the tokens its plan sizing expects the whole run to use.",
        ]
      : []),
  ];
  const fits = fitsOf(withMargin, tokens.low, input.maxTotalTokens);
  const budgetText =
    fits === "yes"
      ? "fits the budget"
      : fits === "maybe"
        ? "may not fit the budget"
        : "does not fit the budget";
  return {
    schemaVersion: 1,
    level,
    tasks,
    tokens,
    withMargin,
    margin,
    budget: { maxTotalTokens: input.maxTotalTokens, fits },
    basis,
    features,
    progress: { spent, accepted, ratio, bySize },
    perCriterion,
    perPath,
    perPathSamples,
    notes,
    label: `Estimate: level ${level}, about ${tasks.low}-${tasks.high} tasks, ${rangeText(tokens)} tokens (plan for ${tokenText(withMargin)} with a ${Math.round(margin * 100)}% margin)${spent ? `, ${tokenText(spent)} used with ${accepted} of ${features.length} features accepted` : ""}; ${budgetText}`,
  };
}

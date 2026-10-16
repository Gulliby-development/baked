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

/** A finished feature run of an earlier initiative, with the size its plan gave the feature. */
export interface FeatureRunSample {
  runId: string;
  workflowId: string;
  size: FeatureSize;
  tokens: number;
  taskCount: number;
}

/** A feature to estimate: its workflow and that workflow's stages. */
export interface FeatureToEstimate {
  id: string;
  title: string;
  workflowId: string;
  size: FeatureSize;
  stages: { id: string; type: string; models: string[] }[];
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
}

/** What an initiative has used so far: per feature, and on runs of no feature (the split). */
export interface InitiativeProgress {
  features: Record<string, { spent: number; accepted: boolean }>;
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
   */
  progress: { spent: number; accepted: number; ratio: number | null };
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
  // Otherwise a typical run of the feature's workflow, with its tasks scaled by the feature's size:
  // the stages around the tasks (research, spec, plan, review) cost about the same at any size.
  const factor = SIZE_TASK_FACTOR[feature.size];
  const run = estimatePreRun({
    history,
    workflowId: feature.workflowId,
    stages: feature.stages,
    maxTotalTokens: 0,
    price: () => null,
  });
  const tokens = sum(
    run.stages.map((s) => (s.type === "tasks" ? scaled(s.tokens, factor) : s.tokens)),
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
): { features: FeatureEstimate[]; ratio: number | null } {
  const used = (f: FeatureEstimate) =>
    progress.features[f.featureId] ?? { spent: 0, accepted: false };
  const accepted = prior.filter((f) => used(f).accepted);
  const forecast = accepted.reduce((total, f) => total + middle(f.tokens), 0);
  const measured = accepted.reduce((total, f) => total + used(f).spent, 0);
  const ratio =
    accepted.length && forecast > 0 && measured > 0
      ? Math.min(RATIO_BOUNDS.high, Math.max(RATIO_BOUNDS.low, measured / forecast))
      : null;
  const features = prior.map((f): FeatureEstimate => {
    const { spent, accepted: done } = used(f);
    if (done) return { ...f, tokens: { low: spent, high: spent }, basis: "measured", spent };
    const tokens = ratio === null ? f.tokens : scaled(f.tokens, ratio);
    return {
      ...f,
      tokens: { low: Math.max(tokens.low, spent), high: Math.max(tokens.high, spent) },
      basis: ratio === null ? f.basis : "calibrated",
      spent,
    };
  });
  return { features, ratio };
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
  const { features, ratio } = reforecast(
    input.features.map((f) => estimateFeature(f, input.history, input.samples)),
    progress,
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
    progress: { spent, accepted, ratio },
    notes,
    label: `Estimate: level ${level}, about ${tasks.low}-${tasks.high} tasks, ${rangeText(tokens)} tokens (plan for ${tokenText(withMargin)} with a ${Math.round(margin * 100)}% margin)${spent ? `, ${tokenText(spent)} used with ${accepted} of ${features.length} features accepted` : ""}; ${budgetText}`,
  };
}

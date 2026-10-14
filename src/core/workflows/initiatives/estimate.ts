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
  notes: string[];
  label: string;
}

const BASIS_ORDER: FeatureEstimateBasis[] = [
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
}): InitiativeEstimate {
  const margin = input.margin ?? ESTIMATE_MARGIN;
  const features = input.features.map((f) => estimateFeature(f, input.history, input.samples));
  const tokens = sum(features.map((f) => f.tokens));
  const tasks = sum(features.map((f) => f.tasks));
  const level = levelOf(middle(tasks));
  const withMargin = Math.round(tokens.high * (1 + margin));
  const basis = features.reduce<FeatureEstimateBasis>(
    (worst, f) => (BASIS_ORDER.indexOf(f.basis) > BASIS_ORDER.indexOf(worst) ? f.basis : worst),
    "initiative-history",
  );
  const generic = features.filter((f) => f.basis === "defaults").length;
  const notes = [
    ...(generic
      ? [
          `${generic} of ${features.length} features use generic ranges: this project has no finished runs of their workflow yet.`,
        ]
      : []),
    ...(input.samples.length
      ? []
      : ["No finished initiative feature runs yet, so feature sizes scale a typical run's tasks."]),
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
    notes,
    label: `Estimate: level ${level}, about ${tasks.low}-${tasks.high} tasks, ${rangeText(tokens)} tokens (plan for ${tokenText(withMargin)} with a ${Math.round(margin * 100)}% margin); ${budgetText}`,
  };
}

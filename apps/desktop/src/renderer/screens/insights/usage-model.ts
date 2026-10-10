import type { RunUsageReport, UsageGroup, UsageSummary } from "../../client/insights.js";

/**
 * Usage figures for the Usage screen, from either source the backend offers: the per-attempt
 * report of runs (`GET /v1/workflow/runs/:id/usage`), which can be filtered by stage and model
 * together, or the project summary (`GET /v1/usage`), which groups by one dimension at a time.
 */

export interface UsageFilter {
  stage: string | null;
  model: string | null;
}

export interface UsageSlice {
  key: string;
  tokens: number;
  /** Input tokens served from the provider's cache. */
  cached: number;
  /** Output tokens; null when the backend does not report them. */
  output: number | null;
  /** Fresh input, plus output while output is not reported separately. */
  fresh: number;
  attempts: number;
  runs: number;
  costUsd: number | null;
}

export interface UsageReport {
  totalTokens: number;
  cachedTokens: number;
  outputTokens: number | null;
  /** Cached share of all tokens, 0..1; null without tokens. */
  cacheShare: number | null;
  runs: number;
  attempts: number;
  costUsd: number | null;
  byStage: UsageSlice[];
  byModel: UsageSlice[];
  /** Every stage and model in the data, for the filter options. */
  stages: string[];
  models: string[];
  /**
   * False when a filter could not be applied to the other breakdown: the project summary
   * groups by one dimension at a time, so a stage filter leaves the model table unfiltered.
   */
  crossFiltered: boolean;
}

export const HOST_MODEL = "(host)";

const STAGE_ORDER = [
  "research",
  "specify",
  "clarify",
  "plan",
  "analyze",
  "approve",
  "implement",
  "checks",
  "review",
  "converge",
  "accept",
  "deliver",
  "learn",
];

/** Task steps (`task-T001`) count toward the implement stage. */
export function stageKey(stage: string): string {
  return stage.startsWith("task-") ? "implement" : stage;
}

export function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

interface Accumulator {
  key: string;
  tokens: number;
  cached: number;
  output: number;
  outputKnown: boolean;
  attempts: number;
  runs: Set<string> | number;
  cost: number;
  costKnown: boolean;
}

function accumulator(key: string, runs: Set<string> | number): Accumulator {
  return {
    key,
    tokens: 0,
    cached: 0,
    output: 0,
    outputKnown: true,
    attempts: 0,
    runs,
    cost: 0,
    costKnown: false,
  };
}

function add(
  into: Accumulator,
  part: {
    tokens: number;
    cached: number;
    output: number | null | undefined;
    attempts: number;
    cost: number | null | undefined;
    runId?: string;
    runs?: number;
  },
): void {
  into.tokens += part.tokens;
  into.cached += Math.min(part.cached, part.tokens);
  if (part.output === null || part.output === undefined) into.outputKnown = false;
  else into.output += part.output;
  into.attempts += part.attempts;
  if (part.cost !== null && part.cost !== undefined) {
    into.cost += part.cost;
    into.costKnown = true;
  }
  if (into.runs instanceof Set) {
    if (part.runId !== undefined) into.runs.add(part.runId);
  } else into.runs += part.runs ?? 0;
}

function slice(acc: Accumulator): UsageSlice {
  const output = acc.outputKnown && acc.attempts > 0 ? acc.output : null;
  return {
    key: acc.key,
    tokens: acc.tokens,
    cached: acc.cached,
    output,
    fresh: Math.max(0, acc.tokens - acc.cached - (output ?? 0)),
    attempts: acc.attempts,
    runs: acc.runs instanceof Set ? acc.runs.size : acc.runs,
    costUsd: acc.costKnown ? acc.cost : null,
  };
}

function stageRank(stage: string): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? STAGE_ORDER.length : index;
}

const byStageOrder = (a: UsageSlice, b: UsageSlice): number =>
  stageRank(a.key) - stageRank(b.key) || b.tokens - a.tokens || a.key.localeCompare(b.key);
const byTokens = (a: UsageSlice, b: UsageSlice): number =>
  b.tokens - a.tokens || a.key.localeCompare(b.key);

function report(
  total: Accumulator,
  stages: Map<string, Accumulator>,
  models: Map<string, Accumulator>,
  options: { stages: Iterable<string>; models: Iterable<string>; crossFiltered: boolean },
): UsageReport {
  const totals = slice(total);
  return {
    totalTokens: totals.tokens,
    cachedTokens: totals.cached,
    outputTokens: totals.output,
    cacheShare: totals.tokens > 0 ? totals.cached / totals.tokens : null,
    runs: totals.runs,
    attempts: totals.attempts,
    costUsd: totals.costUsd,
    byStage: [...stages.values()].map(slice).sort(byStageOrder),
    byModel: [...models.values()].map(slice).sort(byTokens),
    stages: [...new Set(options.stages)].sort(
      (a, b) => stageRank(a) - stageRank(b) || a.localeCompare(b),
    ),
    models: [...new Set(options.models)].sort(),
    crossFiltered: options.crossFiltered,
  };
}

/**
 * Aggregates the attempts of several runs, keeping only attempts that match both filters. A run's
 * estimated cost is spread over its attempts in proportion to their tokens, so costs per stage
 * and model are approximate; a run without a cost estimate adds none.
 */
export function aggregateUsage(
  reports: readonly RunUsageReport[],
  costs: Readonly<Record<string, number | null>>,
  filter: UsageFilter,
): UsageReport {
  const total = accumulator("total", new Set());
  const stages = new Map<string, Accumulator>();
  const models = new Map<string, Accumulator>();
  const allStages: string[] = [];
  const allModels: string[] = [];
  for (const run of reports) {
    const runTokens = run.attempts.reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
    const runCost = costs[run.runId] ?? null;
    for (const attempt of run.attempts) {
      const stage = stageKey(attempt.stage);
      const model = attempt.model ?? HOST_MODEL;
      allStages.push(stage);
      allModels.push(model);
      if (filter.stage !== null && filter.stage !== stage) continue;
      if (filter.model !== null && filter.model !== model) continue;
      const tokens = attempt.usedTokens ?? 0;
      const part = {
        tokens,
        cached: attempt.cacheReadTokens ?? 0,
        output: attempt.outputTokens,
        attempts: 1,
        cost: runCost === null ? null : runTokens > 0 ? (runCost * tokens) / runTokens : 0,
        runId: run.runId,
      };
      add(total, part);
      const s = stages.get(stage) ?? accumulator(stage, new Set());
      add(s, part);
      stages.set(stage, s);
      const m = models.get(model) ?? accumulator(model, new Set());
      add(m, part);
      models.set(model, m);
    }
  }
  return report(total, stages, models, {
    stages: allStages,
    models: allModels,
    crossFiltered: true,
  });
}

function groupPart(group: UsageGroup) {
  return {
    tokens: group.tokens,
    cached: group.cacheReadTokens,
    output: group.outputTokens,
    attempts: group.attempts,
    cost: group.costUsd,
    runs: group.runs,
  };
}

/**
 * Usage figures from the project summary, grouped by stage and by model in two answers. A stage
 * filter narrows the stage chart and the totals; a model filter narrows the model table, and the
 * totals when no stage is chosen. Runs of folded task stages are summed, so they are an upper bound.
 */
export function summarizeUsage(
  stageSummary: UsageSummary,
  modelSummary: UsageSummary,
  filter: UsageFilter,
): UsageReport {
  const stages = new Map<string, Accumulator>();
  for (const group of stageSummary.groups) {
    const key = stageKey(group.key);
    const entry = stages.get(key) ?? accumulator(key, 0);
    add(entry, groupPart(group));
    stages.set(key, entry);
  }
  const models = new Map<string, Accumulator>();
  for (const group of modelSummary.groups) {
    const entry = accumulator(group.key, 0);
    add(entry, groupPart(group));
    models.set(group.key, entry);
  }
  const options = { stages: [...stages.keys()], models: [...models.keys()] };
  const keep = (map: Map<string, Accumulator>, key: string | null): Map<string, Accumulator> =>
    key === null ? map : new Map([...map].filter(([k]) => k === key));
  const shownStages = keep(stages, filter.stage);
  const shownModels = keep(models, filter.model);

  let total: Accumulator;
  if (filter.stage !== null) total = shownStages.get(filter.stage) ?? accumulator("total", 0);
  else if (filter.model !== null) total = shownModels.get(filter.model) ?? accumulator("total", 0);
  else {
    total = accumulator("total", stageSummary.runs);
    for (const group of stageSummary.groups) add(total, { ...groupPart(group), runs: 0 });
  }
  const runs = typeof total.runs === "number" ? Math.min(total.runs, stageSummary.runs) : 0;
  return report({ ...total, runs }, shownStages, shownModels, {
    ...options,
    crossFiltered: filter.stage === null && filter.model === null,
  });
}

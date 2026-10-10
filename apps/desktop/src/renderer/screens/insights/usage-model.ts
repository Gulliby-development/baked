import type {
  RunUsageReport,
  UsageFigures,
  UsageGroup,
  UsageSummary,
} from "../../client/insights.js";

/**
 * Usage figures for the Usage screen, from whichever source the backend offers:
 * - the project summary grouped by stage and model together (`GET /v1/usage?groupBy=stage,model`),
 *   with input, output and cache-read tokens and an estimated cost per combination;
 * - the summary of an older backend, which groups by one dimension at a time and reports only
 *   total and cached tokens (two answers, one per dimension);
 * - the per-attempt reports of runs (`GET /v1/workflow/runs/:id/usage`) for one run, or for the
 *   most recent runs when the backend has no summary at all.
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
  /** Input tokens, cache reads included; null when the backend does not report them. */
  input: number | null;
  /** Output tokens; null when the backend does not report them. */
  output: number | null;
  /**
   * Uncached input. While input is not reported, every token that is neither cached nor reported
   * output (fresh input, plus output when output is not reported either).
   */
  fresh: number;
  /** Tokens of attempts recorded without a split into input and output. */
  unsplit: number;
  attempts: number;
  runs: number;
  costUsd: number | null;
  /** Tokens the cost leaves out because they could not be priced; null when not reported. */
  unpricedTokens: number | null;
}

/** One stage and model combination. */
export interface StageModelSlice extends UsageSlice {
  stage: string;
  model: string;
}

export interface UsageReport {
  totalTokens: number;
  cachedTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Cached share of all tokens, 0..1; null without tokens. */
  cacheShare: number | null;
  runs: number;
  /** False when `runs` adds up groups that may share runs, so it is an upper bound. */
  runsExact: boolean;
  attempts: number;
  costUsd: number | null;
  unpricedTokens: number | null;
  /** True when some tokens could not be priced, so `costUsd` covers only part of the usage. */
  costPartial: boolean;
  byStage: UsageSlice[];
  byModel: UsageSlice[];
  /** Every stage and model combination; empty when the source groups by one dimension only. */
  byStageModel: StageModelSlice[];
  /** Every stage and model in the data, for the filter options. */
  stages: string[];
  models: string[];
  /**
   * False when a filter could not be applied to the other breakdown: an older backend's summary
   * groups by one dimension at a time, so a stage filter leaves the model table unfiltered.
   */
  crossFiltered: boolean;
}

export const HOST_MODEL = "(host)";
/** The stage every task step (`task-T001`) is shown under. */
export const IMPLEMENT_STAGE = "implement";

const STAGE_ORDER = [
  "research",
  "specify",
  "clarify",
  "plan",
  "analyze",
  "approve",
  IMPLEMENT_STAGE,
  "checks",
  "review",
  "converge",
  "accept",
  "deliver",
  "learn",
];

/** Task steps (`task-T001`) count toward the implement stage. */
export function stageKey(stage: string): string {
  return stage.startsWith("task-") ? IMPLEMENT_STAGE : stage;
}

export function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

interface Accumulator {
  key: string;
  tokens: number;
  cached: number;
  input: number;
  inputKnown: boolean;
  output: number;
  outputKnown: boolean;
  attempts: number;
  runs: Set<string> | number;
  cost: number;
  costKnown: boolean;
  unpriced: number;
  unpricedKnown: boolean;
}

function accumulator(key: string, runs: Set<string> | number): Accumulator {
  return {
    key,
    tokens: 0,
    cached: 0,
    input: 0,
    inputKnown: true,
    output: 0,
    outputKnown: true,
    attempts: 0,
    runs,
    cost: 0,
    costKnown: false,
    unpriced: 0,
    unpricedKnown: false,
  };
}

/**
 * Figures to add. `undefined` means the source does not report the figure at all (an older
 * backend), which makes the sum unknown; `null` means it has none for this part, which adds 0.
 */
interface Part {
  tokens: number;
  cached: number;
  input: number | null | undefined;
  output: number | null | undefined;
  attempts: number;
  cost: number | null | undefined;
  unpriced: number | undefined;
  runId?: string;
  runs?: number;
}

function add(into: Accumulator, part: Part): void {
  into.tokens += part.tokens;
  into.cached += Math.min(part.cached, part.tokens);
  if (part.input === undefined) into.inputKnown = false;
  else into.input += part.input ?? 0;
  if (part.output === undefined) into.outputKnown = false;
  else into.output += part.output ?? 0;
  into.attempts += part.attempts;
  if (part.cost !== null && part.cost !== undefined) {
    into.cost += part.cost;
    into.costKnown = true;
  }
  if (part.unpriced !== undefined) {
    into.unpriced += part.unpriced;
    into.unpricedKnown = true;
  }
  if (into.runs instanceof Set) {
    if (part.runId !== undefined) into.runs.add(part.runId);
  } else into.runs += part.runs ?? 0;
}

function slice(acc: Accumulator): UsageSlice {
  const input = acc.inputKnown && acc.attempts > 0 ? acc.input : null;
  const output = acc.outputKnown && acc.attempts > 0 ? acc.output : null;
  const cached = Math.min(acc.cached, acc.tokens);
  const fresh =
    input === null ? Math.max(0, acc.tokens - cached - (output ?? 0)) : Math.max(0, input - cached);
  const unsplit =
    input === null ? 0 : Math.max(0, acc.tokens - Math.max(input, cached) - (output ?? 0));
  return {
    key: acc.key,
    tokens: acc.tokens,
    cached,
    input,
    output,
    fresh,
    unsplit,
    attempts: acc.attempts,
    runs: acc.runs instanceof Set ? acc.runs.size : acc.runs,
    costUsd: acc.costKnown ? acc.cost : null,
    unpricedTokens: acc.unpricedKnown ? acc.unpriced : null,
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
const byStageThenTokens = (a: StageModelSlice, b: StageModelSlice): number =>
  stageRank(a.stage) - stageRank(b.stage) ||
  a.stage.localeCompare(b.stage) ||
  b.tokens - a.tokens ||
  a.model.localeCompare(b.model);

/** Stage and model combinations, keyed `stage / model`. */
class Cells {
  private readonly cells = new Map<string, { stage: string; model: string; acc: Accumulator }>();

  add(stage: string, model: string, part: Part, runs: () => Set<string> | number): void {
    const key = `${stage} / ${model}`;
    const cell = this.cells.get(key) ?? { stage, model, acc: accumulator(key, runs()) };
    add(cell.acc, part);
    this.cells.set(key, cell);
  }

  slices(): StageModelSlice[] {
    return [...this.cells.values()]
      .map(({ stage, model, acc }) => ({ ...slice(acc), stage, model }))
      .sort(byStageThenTokens);
  }
}

function report(
  total: Accumulator,
  stages: Map<string, Accumulator>,
  models: Map<string, Accumulator>,
  cells: StageModelSlice[],
  options: {
    stages: Iterable<string>;
    models: Iterable<string>;
    crossFiltered: boolean;
    runsExact: boolean;
  },
): UsageReport {
  const totals = slice(total);
  return {
    totalTokens: totals.tokens,
    cachedTokens: totals.cached,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheShare: totals.tokens > 0 ? totals.cached / totals.tokens : null,
    runs: totals.runs,
    runsExact: options.runsExact,
    attempts: totals.attempts,
    costUsd: totals.costUsd,
    unpricedTokens: totals.unpricedTokens,
    costPartial: (totals.unpricedTokens ?? 0) > 0,
    byStage: [...stages.values()].map(slice).sort(byStageOrder),
    byModel: [...models.values()].map(slice).sort(byTokens),
    byStageModel: cells,
    stages: [...new Set(options.stages)].sort(
      (a, b) => stageRank(a) - stageRank(b) || a.localeCompare(b),
    ),
    models: [...new Set(options.models)].sort(),
    crossFiltered: options.crossFiltered,
  };
}

const noFilter = (filter: UsageFilter): boolean => filter.stage === null && filter.model === null;

/**
 * Aggregates the attempts of several runs, keeping only attempts that match both filters.
 * Attempts carry their own cost estimate on current backends; on older ones a run's estimated
 * cost is spread over its attempts in proportion to their tokens, so costs per stage and model
 * are approximate, and a run without a cost estimate adds none.
 */
export function aggregateUsage(
  reports: readonly RunUsageReport[],
  costs: Readonly<Record<string, number | null>>,
  filter: UsageFilter,
): UsageReport {
  const total = accumulator("total", new Set());
  const stages = new Map<string, Accumulator>();
  const models = new Map<string, Accumulator>();
  const cells = new Cells();
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
      const spread = runCost === null ? null : runTokens > 0 ? (runCost * tokens) / runTokens : 0;
      const part: Part = {
        tokens,
        cached: attempt.cacheReadTokens ?? 0,
        input: attempt.inputTokens,
        output: attempt.outputTokens,
        attempts: 1,
        cost: attempt.costUsd === undefined ? spread : attempt.costUsd,
        unpriced: attempt.costUsd === undefined ? undefined : attempt.costUsd === null ? tokens : 0,
        runId: run.runId,
      };
      add(total, part);
      const s = stages.get(stage) ?? accumulator(stage, new Set());
      add(s, part);
      stages.set(stage, s);
      const m = models.get(model) ?? accumulator(model, new Set());
      add(m, part);
      models.set(model, m);
      cells.add(stage, model, part, () => new Set());
    }
  }
  return report(total, stages, models, cells.slices(), {
    stages: allStages,
    models: allModels,
    crossFiltered: true,
    runsExact: true,
  });
}

function figuresPart(figures: UsageFigures, runs: number): Part {
  return {
    tokens: figures.tokens,
    cached: figures.cacheReadTokens,
    input: figures.inputTokens,
    output: figures.outputTokens,
    attempts: figures.attempts,
    cost: figures.costUsd,
    unpriced: figures.unpricedTokens,
    runs,
  };
}

const groupPart = (group: UsageGroup): Part => figuresPart(group, group.runs);

/**
 * True when a summary has the shape of current backends: two-dimension groups with `keys`, and
 * the token split and cost estimate. Older backends get the one-dimension treatment instead.
 */
export function isCurrentSummary(summary: UsageSummary): boolean {
  return (
    Array.isArray(summary.groupBy) &&
    typeof summary.costUsd === "number" &&
    typeof summary.inputTokens === "number" &&
    summary.groups.every((group) => group.keys !== undefined)
  );
}

/**
 * The `model` and `stage` query of a filter, or null when the backend cannot apply the filter in
 * one answer: the implement stage folds every task stage (`task-T001`, `task-T002`, ...).
 */
export function serverFilter(filter: UsageFilter): { model?: string; stage?: string } | null {
  if (filter.stage === IMPLEMENT_STAGE) return null;
  return {
    ...(filter.model !== null ? { model: filter.model } : {}),
    ...(filter.stage !== null ? { stage: filter.stage } : {}),
  };
}

/**
 * Usage figures from a summary grouped by stage and model (`groupBy=stage,model`). Filters apply
 * to every combination, so the stage chart, the model table and the combinations all follow
 * both. Combinations are disjoint, so tokens and cost add up exactly; runs do not, since one run
 * spans several stages and models. Totals therefore come from the backend: from `base` without
 * a filter, and from `filtered` (the same request with the filter's `model` and `stage`) with
 * one. Without `filtered` the runs total is an upper bound.
 */
export function crossUsage(
  base: UsageSummary,
  filter: UsageFilter,
  filtered: UsageSummary | null = null,
): UsageReport {
  const stages = new Map<string, Accumulator>();
  const models = new Map<string, Accumulator>();
  const cells = new Cells();
  const allStages: string[] = [];
  const allModels: string[] = [];
  const summed = accumulator("total", 0);
  for (const group of base.groups) {
    const [keyStage, keyModel] = group.key.split(" / ");
    const stage = stageKey(group.keys?.stage ?? keyStage ?? "");
    const model = group.keys?.model ?? keyModel ?? HOST_MODEL;
    allStages.push(stage);
    allModels.push(model);
    if (filter.stage !== null && filter.stage !== stage) continue;
    if (filter.model !== null && filter.model !== model) continue;
    const part = groupPart(group);
    add(summed, part);
    const s = stages.get(stage) ?? accumulator(stage, 0);
    add(s, part);
    stages.set(stage, s);
    const m = models.get(model) ?? accumulator(model, 0);
    add(m, part);
    models.set(model, m);
    cells.add(stage, model, part, () => 0);
  }
  const exact = noFilter(filter) ? base : filtered;
  let total: Accumulator;
  if (exact) {
    total = accumulator("total", 0);
    add(total, figuresPart({ ...exact, tokens: exact.totalTokens }, exact.runs));
  } else total = { ...summed, runs: Math.min(summed.runs as number, base.runs) };
  const result = report(total, stages, models, cells.slices(), {
    stages: allStages,
    models: allModels,
    crossFiltered: true,
    runsExact: exact !== null,
  });
  // Folded task stages add up the runs of each task stage; no slice has more runs than the range.
  const cap = <T extends UsageSlice>(slices: T[]): T[] =>
    slices.map((s) => ({ ...s, runs: Math.min(s.runs, base.runs) }));
  return {
    ...result,
    byStage: cap(result.byStage),
    byModel: cap(result.byModel),
    byStageModel: cap(result.byStageModel),
  };
}

/**
 * Usage figures from an older backend's summary, grouped by stage and by model in two answers. A
 * stage filter narrows the stage chart and the totals; a model filter narrows the model table,
 * and the totals when no stage is chosen. Runs of folded task stages are summed, so they are an
 * upper bound.
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
  return report({ ...total, runs }, shownStages, shownModels, [], {
    ...options,
    crossFiltered: noFilter(filter),
    runsExact: filter.stage !== IMPLEMENT_STAGE,
  });
}

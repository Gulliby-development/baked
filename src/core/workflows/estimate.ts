import { join, resolve } from "node:path";
import type { RunPolicy } from "./schemas.js";
import { readStoreHistory, type WorkflowStore } from "./store.js";

/**
 * Spend estimates. Every number here is a forecast from the runs already stored in this project,
 * or from generic ranges when there are none yet. They are shown as ranges, labeled as estimates,
 * and compared with the real usage once a run completes.
 */
export interface TokenRange {
  low: number;
  high: number;
}
/** Tokens and calls one past run spent in each stage, with its task count. */
export interface PastRun {
  runId: string;
  /** The ID of the definition the run started from, when the store knows it. */
  workflowId?: string | null;
  status: string;
  tokens: number;
  calls: number;
  activeMs: number;
  taskCount: number;
  /** Tokens by stage ID; child steps (tasks, review dimensions, skeptics) count toward their stage. */
  stageTokens: Record<string, number>;
  /** Tokens spent in task steps only, to price one task. */
  taskTokens: number;
  /** Set to `shared` for a run read from a store the policy names in `sizing.historyStores`. */
  source?: "project" | "shared";
}

/** Used when the project has no history for a stage. Deliberately wide: they are not measurements. */
export const DEFAULT_STAGE_RANGES: Record<string, TokenRange> = {
  research: { low: 20_000, high: 150_000 },
  specify: { low: 15_000, high: 60_000 },
  plan: { low: 20_000, high: 80_000 },
  analyze: { low: 10_000, high: 40_000 },
  review: { low: 20_000, high: 80_000 },
  converge: { low: 15_000, high: 60_000 },
};
/**
 * One task without history: a code file and a test file created, at sizing's default per-file
 * rates (`DEFAULT_PER_FILE`), so the start estimate prices a task as the plan's sizing would.
 * R09: the earlier 15k-80k put 7 of 10 fresh-workspace runs 1.4-2.6x above the high end.
 */
export const DEFAULT_TASK_RANGE: TokenRange = { low: 90_000, high: 450_000 };
export const DEFAULT_TASK_COUNT: TokenRange = { low: 2, high: 6 };

const sorted = (values: number[]): number[] => [...values].sort((a, b) => a - b);
function quantile(values: number[], q: number): number {
  const s = sorted(values);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const next = s[base + 1] ?? s[base] ?? 0;
  return (s[base] ?? 0) + (pos - base) * (next - (s[base] ?? 0));
}
/**
 * The range a set of past values suggests: the middle half with four or more samples, the full
 * spread with two or three, and 30% below to 40% above a single sample. Null without samples.
 */
export function rangeOf(values: number[]): TokenRange | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0);
  if (v.length === 0) return null;
  if (v.length === 1)
    return { low: Math.round((v[0] ?? 0) * 0.7), high: Math.round((v[0] ?? 0) * 1.4) };
  if (v.length < 4) return { low: Math.min(...v), high: Math.max(...v) };
  return { low: Math.round(quantile(v, 0.25)), high: Math.round(quantile(v, 0.75)) };
}
const scale = (r: TokenRange, n: TokenRange): TokenRange => ({
  low: r.low * n.low,
  high: r.high * n.high,
});
const add = (a: TokenRange, b: TokenRange): TokenRange => ({
  low: a.low + b.low,
  high: a.high + b.high,
});
const mid = (r: TokenRange): number => (r.low + r.high) / 2;
const ZERO: TokenRange = { low: 0, high: 0 };

export interface Prices {
  /** Range per stage ID, from history where there is any, else the generic one. */
  stages: Record<string, TokenRange>;
  /** Range for one task, and for the number of tasks a run plans. */
  task: TokenRange;
  taskCount: TokenRange;
  basis: "history" | "defaults";
  samples: number;
}
export function pricesFrom(history: PastRun[]): Prices {
  const finished = history.filter((r) => r.status === "completed");
  const stages: Record<string, TokenRange> = {};
  let measured = false;
  for (const id of new Set([
    ...Object.keys(DEFAULT_STAGE_RANGES),
    ...history.flatMap((r) => Object.keys(r.stageTokens)),
  ])) {
    if (id === "implement") continue;
    const seen = history
      .map((r) => r.stageTokens[id])
      .filter((x): x is number => x !== undefined && x > 0);
    const range = rangeOf(seen);
    if (range) measured = true;
    const fallback = DEFAULT_STAGE_RANGES[id];
    if (range ?? fallback) stages[id] = range ?? (fallback as TokenRange);
  }
  const perTask = rangeOf(
    history
      .filter((r) => r.taskCount > 0 && r.taskTokens > 0)
      .map((r) => r.taskTokens / r.taskCount),
  );
  const counts = rangeOf(finished.map((r) => r.taskCount).filter((n) => n > 0));
  if (perTask) measured = true;
  return {
    stages,
    task: perTask ?? DEFAULT_TASK_RANGE,
    // A count is a whole number of tasks, so the one-sample widening is replaced by a plain spread.
    taskCount: counts
      ? { low: Math.max(1, Math.floor(counts.low)), high: Math.max(1, Math.ceil(counts.high)) }
      : DEFAULT_TASK_COUNT,
    basis: measured ? "history" : "defaults",
    samples: Math.max(finished.length, measured ? 1 : 0),
  };
}

export interface StartEstimate {
  tokens: TokenRange;
  basis: Prices["basis"];
  samples: number;
  /** One line for the screen; always says it is an estimate. */
  label: string;
}
const k = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
export const rangeText = (r: TokenRange): string => `${k(r.low)}–${k(r.high)}`;
function basisText(p: Prices): string {
  return p.basis === "history"
    ? `from ${p.samples} earlier run${p.samples === 1 ? "" : "s"} in this project`
    : "generic range: this project has no finished runs yet";
}

/** The range shown before a run starts: planning stages, a typical number of tasks, then review. */
export function estimateStart(history: PastRun[]): StartEstimate {
  const p = pricesFrom(history);
  const fixed = ["research", "specify", "plan", "analyze", "review", "converge"].reduce(
    (sum, id) => add(sum, p.stages[id] ?? ZERO),
    ZERO,
  );
  const tokens = add(fixed, scale(p.task, p.taskCount));
  return {
    tokens,
    basis: p.basis,
    samples: p.samples,
    label: `Estimate: ${rangeText(tokens)} tokens (${basisText(p)})`,
  };
}

export interface StageProgress {
  id: string;
  /** "done" stages are already inside the tokens spent; "running" ones are partly spent. */
  status: "done" | "running" | "pending";
}
export interface Projection {
  /** Tokens expected for the whole run: spent plus the remaining range. */
  total: TokenRange;
  remaining: TokenRange;
  basis: Prices["basis"];
  samples: number;
  /** Tokens per active minute so far, and the minutes the remaining budget lasts at that rate. */
  tokensPerMinute: number | null;
  minutesLeft: number | null;
  /** Stage where the budget runs out at the typical cost, and at the high end; null when it lasts. */
  exhaustsAt: { typical: string | null; high: string | null };
  label: string;
}

/**
 * Re-estimates a running run: what is left in the stages not yet done (tasks priced one by one
 * once the plan fixed their number), what the burn rate says, and where the budget ends.
 */
export function project(input: {
  history: PastRun[];
  stages: StageProgress[];
  spentTokens: number;
  activeMs: number;
  maxTokens: number;
  /** Tasks in the plan (null before it exists) and how many are done. */
  tasks: { total: number; done: number } | null;
  /** Tokens spent inside the stage that is running, so it is not counted twice. */
  runningStageSpent?: number;
}): Projection {
  const p = pricesFrom(input.history);
  const costs: { id: string; range: TokenRange }[] = [];
  for (const stage of input.stages) {
    if (stage.status === "done") continue;
    let range: TokenRange;
    if (stage.id === "implement")
      range = input.tasks
        ? scale(p.task, {
            low: Math.max(0, input.tasks.total - input.tasks.done),
            high: Math.max(0, input.tasks.total - input.tasks.done),
          })
        : scale(p.task, p.taskCount);
    else range = p.stages[stage.id] ?? ZERO;
    if (
      stage.status === "running" &&
      stage.id === input.stages.find((s) => s.status === "running")?.id
    ) {
      const spent = input.runningStageSpent ?? 0;
      range = {
        low: Math.max(0, range.low - spent),
        high: Math.max(range.low * 0.25, range.high - spent),
      };
    }
    costs.push({ id: stage.id, range });
  }
  const remaining = costs.reduce((sum, c) => add(sum, c.range), ZERO);
  const total = add({ low: input.spentTokens, high: input.spentTokens }, remaining);
  const minutes = input.activeMs / 60000;
  const tokensPerMinute =
    minutes >= 0.5 && input.spentTokens > 0 ? Math.round(input.spentTokens / minutes) : null;
  const left = input.maxTokens - input.spentTokens;
  const walk = (cost: (r: TokenRange) => number): string | null => {
    let used = 0;
    for (const c of costs) {
      used += cost(c.range);
      if (used > left) return c.id;
    }
    return null;
  };
  const minutesLeft = tokensPerMinute ? Math.max(0, Math.round(left / tokensPerMinute)) : null;
  return {
    total,
    remaining,
    basis: p.basis,
    samples: p.samples,
    tokensPerMinute,
    minutesLeft,
    exhaustsAt: { typical: walk(mid), high: walk((r) => r.high) },
    label: `Estimate: about ${rangeText(total)} tokens in total, ${rangeText(remaining)} still to spend (${basisText(p)})`,
  };
}

/** Saved at run creation so the finished run can be compared with what was expected. */
export interface SavedEstimate {
  schemaVersion: 1;
  at: number;
  tokens: TokenRange;
  basis: Prices["basis"] | "workflow-history";
  samples: number;
  maxTokens: number;
  /** Added with the pre-run estimate; older saved estimates lack them. */
  workflowId?: string;
  costUsd?: TokenRange | null;
}
export function compareWithActual(
  saved: SavedEstimate,
  actualTokens: number,
): {
  verdict: "below" | "within" | "above";
  text: string;
} {
  const verdict =
    actualTokens < saved.tokens.low
      ? "below"
      : actualTokens > saved.tokens.high
        ? "above"
        : "within";
  return {
    verdict,
    text: `Estimated ${rangeText(saved.tokens)} at the start; actual ${k(actualTokens)} (${verdict === "within" ? "inside the range" : `${verdict} the range`})`,
  };
}

const cache = new WeakMap<WorkflowStore, { at: number; rows: PastRun[] }>();
/**
 * What past runs spent, per stage and per task. The panel asks on every refresh, so the answer is
 * kept for a few seconds. Pass maxAgeMs 0 to read the database now.
 */
export function readHistory(store: WorkflowStore, maxAgeMs = 5000): PastRun[] {
  const known = cache.get(store);
  if (known && Date.now() - known.at < maxAgeMs) return known.rows;
  const rows = store.history();
  cache.set(store, { at: Date.now(), rows });
  return rows;
}

/**
 * The workflow databases a policy's `sizing.historyStores` names, other than the project's own: a
 * `.sqlite` path, or a project directory whose `.baked/workflows.sqlite` is meant. Relative paths
 * are relative to the workspace.
 */
export function historyStorePaths(
  workspace: string,
  policy: Pick<RunPolicy, "sizing"> | null | undefined,
): string[] {
  const own = resolve(workspace, ".baked", "workflows.sqlite");
  return [
    ...new Set(
      (policy?.sizing?.historyStores ?? [])
        .map((path) => resolve(workspace, path))
        .map((path) => (path.endsWith(".sqlite") ? path : join(path, ".baked", "workflows.sqlite")))
        .filter((path) => path !== own),
    ),
  ];
}

/**
 * History for a start estimate: this project's runs, then the runs of the stores the policy names
 * in `sizing.historyStores`, each run once (a run found in both counts as this project's).
 */
export function estimateHistory(
  store: WorkflowStore | null,
  workspace: string,
  policy: Pick<RunPolicy, "sizing"> | null | undefined,
  maxAgeMs = 5000,
): PastRun[] {
  const own = store ? readHistory(store, maxAgeMs) : [];
  const seen = new Set(own.map((run) => run.runId));
  const shared = historyStorePaths(workspace, policy)
    .flatMap(readStoreHistory)
    .filter((run) => !seen.has(run.runId) && seen.add(run.runId));
  return [...own, ...shared];
}

/** A stage of the definition about to run, with the models its agents will use. */
export interface PlannedStage {
  id: string;
  /** The v2 stage type: agent, tasks, check, approval, review, reflection or learn. */
  type: string;
  /**
   * Models; tokens are split evenly between the entries, so a model listed twice (best-of-N
   * candidates on `candidateModels`) gets two shares. Empty for stages without agents.
   */
  models: string[];
  /** Best-of-N candidates per task of a tasks stage (#642); absent means 1. */
  candidates?: number;
}
export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  cacheRead: number;
  output: number;
  match: "table" | "approximate";
}
/** Shares of a stage's tokens priced as uncached input, cache reads and output. */
export interface TokenMix {
  input: number;
  cacheRead: number;
  output: number;
}
/**
 * Attempts record input plus output, with cache reads inside input, and no cache writes. Agent
 * loops re-send long contexts and write little, so most tokens are input and many are cached.
 */
export const DEFAULT_MIX: TokenMix = { input: 0.6, cacheRead: 0.3, output: 0.1 };
/** Used for an agent stage that neither history nor the stage defaults know. */
export const GENERIC_AGENT_RANGE: TokenRange = { low: 15_000, high: 60_000 };

export type EstimateBasis = "workflow-history" | "history" | "defaults";
export interface PreRunEstimate {
  schemaVersion: 1;
  workflowId: string;
  tokens: TokenRange;
  /** Null when no model with tokens has a known price. */
  costUsd: TokenRange | null;
  /** False when some tokens run on a model without a known price; the cost leaves them out. */
  costComplete: boolean;
  basis: EstimateBasis;
  samples: number;
  mix: TokenMix;
  notes: string[];
  stages: {
    stageId: string;
    type: string;
    models: string[];
    tokens: TokenRange;
    costUsd: TokenRange | null;
    basis: EstimateBasis;
  }[];
  models: {
    model: string;
    stages: string[];
    tokens: TokenRange;
    costUsd: TokenRange | null;
    price: "table" | "approximate" | "unknown";
  }[];
  budget: { maxTotalTokens: number; fits: "yes" | "maybe" | "no" };
  /**
   * The dollar cap (`maxCostUsd`) against the estimated cost, when the run has a cap and the
   * estimate prices it; `fits` compares the cost range with the cap as `budget.fits` does tokens.
   */
  cost?: { maxCostUsd: number; fits: "yes" | "maybe" | "no" };
  label: string;
}

const AGENT_TYPES = new Set(["agent", "reflection", "review"]);
const usd = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
export const usdRangeText = (r: TokenRange): string => `${usd(r.low)}–${usd(r.high)}`;

/**
 * Tokens and approximate cost of a run before it starts, stage by stage. Ranges come from earlier
 * runs of the same workflow where they reached the stage, then from runs of any workflow, then
 * from defaults. Dollar figures price a fixed token mix and stay advisory.
 */
export function estimatePreRun(input: {
  history: PastRun[];
  workflowId: string;
  stages: PlannedStage[];
  maxTotalTokens: number;
  /** The run's dollar cap; null or omitted when it has none. */
  maxCostUsd?: number | null;
  price: (model: string) => ModelPrice | null;
  mix?: TokenMix;
}): PreRunEstimate {
  const mix = input.mix ?? DEFAULT_MIX;
  const same = input.history.filter((r) => r.workflowId === input.workflowId);
  const pools: [EstimateBasis, PastRun[]][] = [
    ["workflow-history", same],
    ["history", input.history],
  ];
  const measure = (
    pick: (runs: PastRun[]) => number[],
  ): { range: TokenRange; basis: EstimateBasis } | null => {
    for (const [basis, runs] of pools) {
      const range = rangeOf(pick(runs));
      if (range) return { range, basis };
    }
    return null;
  };
  const stageRange = (stage: PlannedStage): { range: TokenRange; basis: EstimateBasis } => {
    if (stage.type === "tasks") {
      const perTask = measure((runs) =>
        runs
          .filter((r) => r.taskCount > 0 && r.taskTokens > 0)
          .map((r) => r.taskTokens / r.taskCount),
      );
      const counts = measure((runs) =>
        runs.filter((r) => r.status === "completed" && r.taskCount > 0).map((r) => r.taskCount),
      );
      const count = counts
        ? {
            low: Math.max(1, Math.floor(counts.range.low)),
            high: Math.max(1, Math.ceil(counts.range.high)),
          }
        : DEFAULT_TASK_COUNT;
      // Runs of the same workflow already paid for their candidates; other prices are for one.
      const candidates = perTask?.basis === "workflow-history" ? 1 : (stage.candidates ?? 1);
      const range = scale(
        scale(perTask?.range ?? DEFAULT_TASK_RANGE, { low: candidates, high: candidates }),
        count,
      );
      return {
        range: { low: Math.round(range.low), high: Math.round(range.high) },
        basis: perTask?.basis ?? "defaults",
      };
    }
    const seen = measure((runs) =>
      runs.map((r) => r.stageTokens[stage.id]).filter((x): x is number => x !== undefined && x > 0),
    );
    if (seen) return seen;
    const fallback = AGENT_TYPES.has(stage.type)
      ? (DEFAULT_STAGE_RANGES[stage.id] ?? GENERIC_AGENT_RANGE)
      : ZERO;
    return { range: fallback, basis: "defaults" };
  };

  const prices = new Map<string, ModelPrice | null>();
  const priceOf = (model: string): ModelPrice | null => {
    if (!prices.has(model)) prices.set(model, input.price(model));
    return prices.get(model) ?? null;
  };
  const perMillion = (p: ModelPrice): number =>
    mix.input * p.input + mix.cacheRead * p.cacheRead + mix.output * p.output;
  const byModel = new Map<string, PreRunEstimate["models"][number]>();
  let costComplete = true;
  let anyCost = false;
  const stages = input.stages.map((stage) => {
    const { range, basis } = stageRange(stage);
    const share = stage.models.length ? 1 / stage.models.length : 0;
    let cost: TokenRange | null = null;
    if (range.high > 0 && !stage.models.length) costComplete = false;
    for (const model of stage.models) {
      const tokens = { low: range.low * share, high: range.high * share };
      const price = priceOf(model);
      const modelCost = price
        ? {
            low: (tokens.low / 1e6) * perMillion(price),
            high: (tokens.high / 1e6) * perMillion(price),
          }
        : null;
      if (modelCost) {
        cost = add(cost ?? ZERO, modelCost);
        if (tokens.high > 0) anyCost = true;
      } else if (tokens.high > 0) costComplete = false;
      const entry = byModel.get(model) ?? {
        model,
        stages: [],
        tokens: ZERO,
        costUsd: price ? ZERO : null,
        price: price?.match ?? "unknown",
      };
      if (!entry.stages.includes(stage.id)) entry.stages.push(stage.id);
      entry.tokens = add(entry.tokens, tokens);
      if (entry.costUsd && modelCost) entry.costUsd = add(entry.costUsd, modelCost);
      byModel.set(model, entry);
    }
    return {
      stageId: stage.id,
      type: stage.type,
      models: stage.models,
      tokens: range,
      costUsd: cost,
      basis,
    };
  });
  const tokens = stages.reduce((sum, s) => add(sum, s.tokens), ZERO);
  const costUsd = anyCost ? stages.reduce((sum, s) => add(sum, s.costUsd ?? ZERO), ZERO) : null;
  const basis: EstimateBasis = stages.some((s) => s.basis === "workflow-history")
    ? "workflow-history"
    : stages.some((s) => s.basis === "history")
      ? "history"
      : "defaults";
  const sampled =
    basis === "workflow-history"
      ? same
      : basis === "history"
        ? input.history.filter((r) => Object.keys(r.stageTokens).length > 0)
        : [];
  const samples = sampled.length;
  const shared = sampled.filter((r) => r.source === "shared").length;
  const models = [...byModel.values()].map((m) => ({
    ...m,
    tokens: { low: Math.round(m.tokens.low), high: Math.round(m.tokens.high) },
  }));
  const notes: string[] = [];
  if (costUsd) {
    notes.push(
      `Cost prices ${Math.round(mix.input * 100)}% uncached input, ${Math.round(mix.cacheRead * 100)}% cache reads and ${Math.round(mix.output * 100)}% output; cache writes are not counted.`,
    );
    const approx = models.filter((m) => m.price === "approximate").map((m) => m.model);
    if (approx.length) notes.push(`Approximate prices: ${approx.join(", ")}.`);
  }
  const contested = input.stages.find((s) => s.type === "tasks" && (s.candidates ?? 1) > 1);
  if (contested)
    notes.push(
      `Each planned task runs as ${String(contested.candidates)} candidates (best-of-N); the tasks stage is priced for all of them.`,
    );
  const unknown = models.filter((m) => m.price === "unknown").map((m) => m.model);
  if (unknown.length)
    notes.push(`No price known for ${unknown.join(", ")}; the cost leaves them out.`);
  const fitsIn = (range: TokenRange, limit: number): "yes" | "maybe" | "no" =>
    range.high <= limit ? "yes" : range.low > limit ? "no" : "maybe";
  const fits = fitsIn(tokens, input.maxTotalTokens);
  const cap = input.maxCostUsd ?? null;
  const fromOthers = shared ? `, ${shared} of them from other projects` : "";
  const basisLabel =
    basis === "workflow-history"
      ? `from ${samples} earlier run${samples === 1 ? "" : "s"} of ${input.workflowId}${fromOthers}`
      : basis === "history"
        ? `from ${samples} earlier run${samples === 1 ? "" : "s"} of other workflows${fromOthers}`
        : "generic range: no earlier runs";
  return {
    schemaVersion: 1,
    workflowId: input.workflowId,
    tokens,
    costUsd,
    costComplete: costComplete && costUsd !== null,
    basis,
    samples,
    mix,
    notes,
    stages,
    models,
    budget: { maxTotalTokens: input.maxTotalTokens, fits },
    ...(cap !== null && costUsd ? { cost: { maxCostUsd: cap, fits: fitsIn(costUsd, cap) } } : {}),
    label: `Estimate: ${rangeText(tokens)} tokens${costUsd ? `, about ${usdRangeText(costUsd)}${costComplete ? "" : " (partial)"}` : ""} (${basisLabel})`,
  };
}

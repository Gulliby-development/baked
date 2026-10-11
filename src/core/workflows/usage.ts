import { findPricing } from "../llm/pricing.js";
import type { AttemptUsageRecord } from "./step-budget.js";
import type { WorkflowStore } from "./store.js";

export interface AttemptUsageRow {
  attemptId: string;
  stage: string;
  /** The model the attempt ran on; host attempts (checks, publication) have none. */
  model: string | null;
  status: string;
  usedTokens: number | null;
  steps: number | null;
  peakInputTokens: number | null;
  /** Input tokens of every step, cache reads included; null without per-step usage. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** Input tokens written to the prompt cache; 0 in attempts recorded before writes were. */
  cacheWriteTokens: number | null;
  /**
   * Estimated USD cost from the price table: uncached input, cache reads, cache writes and
   * output. 0 for host attempts; null without per-step usage or a known price.
   */
  costUsd: number | null;
  compactedBytes: number | null;
  stopReason: AttemptUsageRecord["stopReason"] | null;
  finalizedBy: AttemptUsageRecord["finalizedBy"];
}

export interface RunUsageReport {
  runId: string;
  totalTokens: number;
  totals: {
    tokens: number | null;
    steps: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    compactedBytes: number | null;
  };
  stages: Array<{ stage: string; attempts: number; tokens: number; steps: number | null }>;
  /** Usage per model, most tokens first; host attempts are grouped as `(host)`. */
  models: Array<{ model: string; attempts: number; tokens: number; steps: number | null }>;
  attempts: AttemptUsageRow[];
}

/**
 * Per-attempt token and step usage of a run. Attempts recorded before per-step usage existed
 * report only their total tokens, so older runs remain comparable at the stage level.
 */
export function runUsage(
  store: WorkflowStore,
  runId: string,
  stageFilter?: string,
  top?: number,
  modelFilter?: string,
): RunUsageReport {
  const stages = new Map(store.steps(runId).map((step) => [step.id, step.stage_id]));
  const attempts = store
    .attempts(runId)
    .filter(
      (attempt) =>
        (stageFilter === undefined ||
          (stages.get(attempt.step_id) ?? attempt.step_id) === stageFilter) &&
        (modelFilter === undefined ||
          (modelFilter === "(host)"
            ? attempt.model_id === null
            : attempt.model_id === modelFilter)),
    )
    .map((attempt): AttemptUsageRow => {
      const row = store.latestArtifact(runId, `attempts/${attempt.id}/usage.json`);
      const usage = row
        ? (JSON.parse(store.readArtifact(runId, row.id)) as AttemptUsageRecord)
        : undefined;
      const sum = (pick: (step: AttemptUsageRecord["steps"][number]) => number | null) =>
        usage ? usage.steps.reduce((total, step) => total + (pick(step) ?? 0), 0) : null;
      return {
        attemptId: attempt.id,
        stage: stages.get(attempt.step_id) ?? attempt.step_id,
        model: attempt.model_id,
        status: attempt.status,
        usedTokens: attempt.used_tokens,
        steps: usage?.steps.length ?? null,
        peakInputTokens: usage
          ? Math.max(0, ...usage.steps.map((step) => step.inputTokens ?? 0))
          : null,
        inputTokens: sum((step) => step.inputTokens),
        outputTokens: sum((step) => step.outputTokens),
        cacheReadTokens: sum((step) => step.cacheReadTokens),
        cacheWriteTokens: sum((step) => step.cacheWriteTokens ?? null),
        costUsd: attemptCost(attempt.model_id, usage),
        compactedBytes: sum((step) => step.compactedBytes),
        stopReason: usage?.stopReason ?? null,
        finalizedBy: usage?.finalizedBy ?? null,
      };
    });
  const byStage = new Map<string, RunUsageReport["stages"][number]>();
  for (const attempt of attempts) {
    const entry = byStage.get(attempt.stage) ?? {
      stage: attempt.stage,
      attempts: 0,
      tokens: 0,
      steps: null,
    };
    entry.attempts++;
    entry.tokens += attempt.usedTokens ?? 0;
    if (attempt.steps !== null) entry.steps = (entry.steps ?? 0) + attempt.steps;
    byStage.set(attempt.stage, entry);
  }
  const byModel = new Map<string, RunUsageReport["models"][number]>();
  for (const attempt of attempts) {
    const model = attempt.model ?? "(host)";
    const entry = byModel.get(model) ?? { model, attempts: 0, tokens: 0, steps: null };
    entry.attempts++;
    entry.tokens += attempt.usedTokens ?? 0;
    if (attempt.steps !== null) entry.steps = (entry.steps ?? 0) + attempt.steps;
    byModel.set(model, entry);
  }
  const sumReported = (pick: (attempt: AttemptUsageRow) => number | null): number | null => {
    let total = 0;
    let reported = false;
    for (const attempt of attempts) {
      const value = pick(attempt);
      if (value === null) continue;
      total += value;
      reported = true;
    }
    return reported ? total : null;
  };
  return {
    runId,
    totalTokens: attempts.reduce((total, attempt) => total + (attempt.usedTokens ?? 0), 0),
    totals: {
      tokens: sumReported((attempt) => attempt.usedTokens),
      steps: sumReported((attempt) => attempt.steps),
      cacheReadTokens: sumReported((attempt) => attempt.cacheReadTokens),
      cacheWriteTokens: sumReported((attempt) => attempt.cacheWriteTokens),
      compactedBytes: sumReported((attempt) => attempt.compactedBytes),
    },
    stages: [...byStage.values()],
    models: [...byModel.values()].sort(
      (a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model),
    ),
    attempts:
      top === undefined
        ? attempts
        : [...attempts].sort((a, b) => (b.usedTokens ?? 0) - (a.usedTokens ?? 0)).slice(0, top),
  };
}

export const USAGE_DIMENSIONS = ["model", "stage", "day"] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

interface UsageTotals {
  attempts: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated cost of the priced attempts. */
  costUsd: number;
  /** Tokens of attempts without per-step usage or a known price, which `costUsd` leaves out. */
  unpricedTokens: number;
}

export interface UsageSummary extends UsageTotals {
  days: number;
  since: number;
  /** One or two dimensions; with two, each group is one combination. */
  groupBy: UsageDimension[];
  filters: { model?: string; stage?: string };
  runs: number;
  /** The same as `tokens`. */
  totalTokens: number;
  /** Most tokens first, or in date order when grouped by day first. Host attempts are `(host)`. */
  groups: Array<
    UsageTotals & {
      /** The group's values joined with ` / `, in `groupBy` order. */
      key: string;
      keys: Partial<Record<UsageDimension, string>>;
      runs: number;
    }
  >;
}

const emptyTotals = (): UsageTotals => ({
  attempts: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedTokens: 0,
});

function addAttempt(totals: UsageTotals, attempt: AttemptUsageRow): void {
  totals.attempts++;
  totals.tokens += attempt.usedTokens ?? 0;
  totals.inputTokens += attempt.inputTokens ?? 0;
  totals.outputTokens += attempt.outputTokens ?? 0;
  totals.cacheReadTokens += attempt.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += attempt.cacheWriteTokens ?? 0;
  if (attempt.costUsd === null) totals.unpricedTokens += attempt.usedTokens ?? 0;
  else totals.costUsd += attempt.costUsd;
}

/**
 * Usage of every attempt that started in the last `days` days, across runs, optionally filtered
 * by model (`(host)` for host attempts) and stage, grouped by one or two of model, stage and the
 * UTC day of the attempt's start.
 */
export function usageSummary(
  store: WorkflowStore,
  options: {
    days: number;
    groupBy: UsageDimension[];
    model?: string;
    stage?: string;
    now?: number;
  },
): UsageSummary {
  const since = (options.now ?? Date.now()) - options.days * 86_400_000;
  const groups = new Map<string, UsageSummary["groups"][number] & { runIds: Set<string> }>();
  const runIds = new Set<string>();
  const totals = emptyTotals();
  for (const runId of store.runIdsWithAttemptsSince(since)) {
    const started = new Map(store.attempts(runId).map((a) => [a.id, a.started_at]));
    for (const attempt of runUsage(store, runId, options.stage, undefined, options.model)
      .attempts) {
      const at = started.get(attempt.attemptId) ?? 0;
      if (at < since) continue;
      const values: Record<UsageDimension, string> = {
        model: attempt.model ?? "(host)",
        stage: attempt.stage,
        day: new Date(at).toISOString().slice(0, 10),
      };
      const keys: Partial<Record<UsageDimension, string>> = {};
      for (const dimension of options.groupBy) keys[dimension] = values[dimension];
      const key = options.groupBy.map((dimension) => values[dimension]).join(" / ");
      const entry = groups.get(key) ?? {
        ...emptyTotals(),
        key,
        keys,
        runs: 0,
        runIds: new Set<string>(),
      };
      entry.runIds.add(runId);
      addAttempt(entry, attempt);
      groups.set(key, entry);
      runIds.add(runId);
      addAttempt(totals, attempt);
    }
  }
  const list = [...groups.values()].map(({ runIds: ids, ...entry }) => ({
    ...entry,
    runs: ids.size,
  }));
  list.sort((a, b) =>
    options.groupBy[0] === "day"
      ? a.key.localeCompare(b.key)
      : b.tokens - a.tokens || a.key.localeCompare(b.key),
  );
  return {
    days: options.days,
    since,
    groupBy: options.groupBy,
    filters: {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.stage !== undefined ? { stage: options.stage } : {}),
    },
    runs: runIds.size,
    ...totals,
    totalTokens: totals.tokens,
    groups: list,
  };
}

/** The estimated cost of one attempt; see `AttemptUsageRow.costUsd`. */
function attemptCost(model: string | null, usage: AttemptUsageRecord | undefined): number | null {
  if (model === null) return 0;
  if (!usage) return null;
  const pricing = findPricing(model)?.pricing;
  if (!pricing) return null;
  let cost = 0;
  for (const step of usage.steps) {
    const input = step.inputTokens ?? 0;
    const cacheRead = Math.min(step.cacheReadTokens ?? 0, input);
    const cacheWrite = Math.min(step.cacheWriteTokens ?? 0, input - cacheRead);
    cost +=
      (input - cacheRead - cacheWrite) * pricing.input +
      cacheRead * pricing.cacheRead +
      cacheWrite * pricing.cacheWrite +
      (step.outputTokens ?? 0) * pricing.output;
  }
  return cost / 1e6;
}

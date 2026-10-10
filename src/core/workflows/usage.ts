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
  cacheReadTokens: number | null;
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
        cacheReadTokens: sum((step) => step.cacheReadTokens),
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

export interface UsageSummary {
  days: number;
  since: number;
  groupBy: "model" | "stage" | "day";
  runs: number;
  attempts: number;
  totalTokens: number;
  cacheReadTokens: number;
  /** Most tokens first; days in date order. Host attempts are grouped as `(host)`. */
  groups: Array<{
    key: string;
    runs: number;
    attempts: number;
    tokens: number;
    cacheReadTokens: number;
  }>;
}

/**
 * Usage of every attempt that started in the last `days` days, across runs, grouped by model,
 * stage, or UTC day of the attempt's start.
 */
export function usageSummary(
  store: WorkflowStore,
  options: { days: number; groupBy: UsageSummary["groupBy"]; now?: number },
): UsageSummary {
  const since = (options.now ?? Date.now()) - options.days * 86_400_000;
  const groups = new Map<string, UsageSummary["groups"][number] & { runIds: Set<string> }>();
  const runIds = store.runIdsWithAttemptsSince(since);
  let attempts = 0;
  let totalTokens = 0;
  let cacheReadTokens = 0;
  for (const runId of runIds) {
    const started = new Map(store.attempts(runId).map((a) => [a.id, a.started_at]));
    for (const attempt of runUsage(store, runId).attempts) {
      const at = started.get(attempt.attemptId) ?? 0;
      if (at < since) continue;
      const key =
        options.groupBy === "model"
          ? (attempt.model ?? "(host)")
          : options.groupBy === "stage"
            ? attempt.stage
            : new Date(at).toISOString().slice(0, 10);
      const entry = groups.get(key) ?? {
        key,
        runs: 0,
        attempts: 0,
        tokens: 0,
        cacheReadTokens: 0,
        runIds: new Set<string>(),
      };
      entry.runIds.add(runId);
      entry.attempts++;
      entry.tokens += attempt.usedTokens ?? 0;
      entry.cacheReadTokens += attempt.cacheReadTokens ?? 0;
      groups.set(key, entry);
      attempts++;
      totalTokens += attempt.usedTokens ?? 0;
      cacheReadTokens += attempt.cacheReadTokens ?? 0;
    }
  }
  const list = [...groups.values()].map(({ runIds: ids, ...entry }) => ({
    ...entry,
    runs: ids.size,
  }));
  list.sort((a, b) =>
    options.groupBy === "day"
      ? a.key.localeCompare(b.key)
      : b.tokens - a.tokens || a.key.localeCompare(b.key),
  );
  return {
    days: options.days,
    since,
    groupBy: options.groupBy,
    runs: runIds.length,
    attempts,
    totalTokens,
    cacheReadTokens,
    groups: list,
  };
}

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
): RunUsageReport {
  const stages = new Map(store.steps(runId).map((step) => [step.id, step.stage_id]));
  const attempts = store
    .attempts(runId)
    .filter(
      (attempt) =>
        stageFilter === undefined ||
        (stages.get(attempt.step_id) ?? attempt.step_id) === stageFilter,
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
    attempts,
  };
}

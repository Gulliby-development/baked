import { findPricing } from "../llm/pricing.js";
import type { AttemptUsageRecord, ToolBackendCount } from "./step-budget.js";
import type { WorkflowStore } from "./store.js";

export interface AttemptUsageRow {
  attemptId: string;
  stage: string;
  /** The task of a task step's attempt; null for attempts of other steps. */
  taskId: string | null;
  /**
   * The task's generation when the attempt started: 0 for its first implementation, one more for
   * each repair that invalidated it (#936). Null for attempts of other steps.
   */
  taskGeneration: number | null;
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
  /** The reasoning effort sent to the provider; null when none was or before it was recorded. */
  effort: string | null;
  compactedBytes: number | null;
  stopReason: AttemptUsageRecord["stopReason"] | null;
  finalizedBy: AttemptUsageRecord["finalizedBy"];
  /** Tool calls by the code intelligence backend and language server that answered them. */
  toolBackends: ToolBackendCount[];
  /** Model tool calls by tool, from per-step usage; empty in attempts recorded before tool names. */
  tools: ToolStepTokens[];
  /** Model responses whose usage the provider never reported, so the tokens are low (#820). */
  unreportedResponses: number;
  /** The provider reported no usage, so the tokens are estimated from the sizes (#1057). */
  usageEstimated: boolean;
}

/**
 * Calls of one tool and the tokens of the model steps that made them. A step's tokens are split
 * evenly between its calls, so the figures add up to the tokens of the steps that called a tool.
 */
export interface ToolStepTokens {
  tool: string;
  calls: number;
  tokens: number;
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
  /**
   * Usage of each task by generation, in task then generation order, so the cost of a rerun
   * after a repair reads apart from the first implementation (#936).
   */
  tasks: Array<{
    taskId: string;
    generation: number;
    attempts: number;
    tokens: number;
    /** Null when an attempt of the generation has no known cost. */
    costUsd: number | null;
  }>;
  /** Tool calls of every attempt by backend and server, most calls first. */
  toolBackends: ToolBackendCount[];
  /** Model tool calls of every attempt by tool, most tokens first. */
  tools: ToolStepTokens[];
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
  const generations = store.attemptTaskGenerations(runId);
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
        taskId: generations.get(attempt.id)?.taskId ?? null,
        taskGeneration: generations.get(attempt.id)?.generation ?? null,
        model: attempt.model_id,
        status: attempt.status,
        usedTokens: attempt.used_tokens,
        steps: usage?.steps.length ?? null,
        peakInputTokens: usage
          ? Math.max(0, ...usage.steps.map((step) => step.inputTokens ?? 0))
          : null,
        inputTokens: usage?.estimatedUsage?.inputTokens ?? sum((step) => step.inputTokens),
        outputTokens: usage?.estimatedUsage?.outputTokens ?? sum((step) => step.outputTokens),
        cacheReadTokens: sum((step) => step.cacheReadTokens),
        cacheWriteTokens: sum((step) => step.cacheWriteTokens ?? null),
        costUsd: attemptCost(attempt.model_id, usage),
        effort: usage?.effort ?? null,
        compactedBytes: sum((step) => step.compactedBytes),
        stopReason: usage?.stopReason ?? null,
        finalizedBy: usage?.finalizedBy ?? null,
        toolBackends: usage?.toolBackends ?? [],
        tools: usage ? stepToolTokens(usage.steps) : [],
        unreportedResponses: usage?.unreportedResponses ?? 0,
        usageEstimated: usage?.estimatedUsage !== undefined,
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
  const byTask = new Map<string, RunUsageReport["tasks"][number]>();
  for (const attempt of attempts) {
    if (attempt.taskId === null || attempt.taskGeneration === null) continue;
    const key = JSON.stringify([attempt.taskId, attempt.taskGeneration]);
    const entry = byTask.get(key) ?? {
      taskId: attempt.taskId,
      generation: attempt.taskGeneration,
      attempts: 0,
      tokens: 0,
      costUsd: 0,
    };
    entry.attempts++;
    entry.tokens += attempt.usedTokens ?? 0;
    entry.costUsd =
      entry.costUsd === null || attempt.costUsd === null ? null : entry.costUsd + attempt.costUsd;
    byTask.set(key, entry);
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
    tasks: [...byTask.values()].sort(
      (a, b) =>
        a.taskId.localeCompare(b.taskId, "en", { numeric: true }) || a.generation - b.generation,
    ),
    toolBackends: mergeToolBackends(attempts.flatMap((attempt) => attempt.toolBackends)),
    tools: mergeToolTokens(attempts.flatMap((attempt) => attempt.tools)),
    attempts:
      top === undefined
        ? attempts
        : [...attempts].sort((a, b) => (b.usedTokens ?? 0) - (a.usedTokens ?? 0)).slice(0, top),
  };
}

/** Calls and step tokens by tool for one attempt's steps; steps without tool names are skipped. */
export function stepToolTokens(steps: AttemptUsageRecord["steps"]): ToolStepTokens[] {
  const counts: ToolStepTokens[] = [];
  for (const step of steps) {
    if (!step.tools?.length) continue;
    const share = ((step.inputTokens ?? 0) + (step.outputTokens ?? 0)) / step.tools.length;
    for (const tool of step.tools) counts.push({ tool, calls: 1, tokens: share });
  }
  return mergeToolTokens(counts);
}

/** Adds up calls and tokens of the same tool, most tokens first; tokens are rounded once summed. */
export function mergeToolTokens(counts: readonly ToolStepTokens[]): ToolStepTokens[] {
  const merged = new Map<string, ToolStepTokens>();
  for (const count of counts) {
    const entry = merged.get(count.tool) ?? { tool: count.tool, calls: 0, tokens: 0 };
    entry.calls += count.calls;
    entry.tokens += count.tokens;
    merged.set(count.tool, entry);
  }
  return [...merged.values()]
    .map((entry) => ({ ...entry, tokens: Math.round(entry.tokens) }))
    .sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool));
}

/** One line per run: `run_repro 9 calls 310,200 tokens, read 14 calls 120,000 tokens`. */
export function toolTokensLine(counts: readonly ToolStepTokens[]): string | null {
  return counts.length
    ? counts
        .map(
          (c) =>
            `${c.tool} ${c.calls} ${c.calls === 1 ? "call" : "calls"} ${c.tokens.toLocaleString("en-US")} tokens`,
        )
        .join(", ")
    : null;
}

/** Adds up counts of the same tool, backend and server, most calls first. */
export function mergeToolBackends(counts: readonly ToolBackendCount[]): ToolBackendCount[] {
  const merged = new Map<string, ToolBackendCount>();
  for (const count of counts) {
    const key = JSON.stringify([count.tool, count.backend, count.server]);
    const entry = merged.get(key) ?? { ...count, calls: 0 };
    entry.calls += count.calls;
    merged.set(key, entry);
  }
  return [...merged.values()].sort(
    (a, b) => b.calls - a.calls || `${a.tool}${a.backend}`.localeCompare(`${b.tool}${b.backend}`),
  );
}

/** One line per run: `navigate lsp (rust-analyzer) 12, bake_find repo-map 3`. */
export function toolBackendLine(counts: readonly ToolBackendCount[]): string | null {
  return counts.length
    ? counts
        .map((c) => `${c.tool} ${c.backend}${c.server ? ` (${c.server})` : ""} ${c.calls}`)
        .join(", ")
    : null;
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
  /** Null for a workspace without a workflow database, which has no usage. */
  store: WorkflowStore | null,
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
  if (store)
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

/** What one finished attempt spent, split as the provider reported it (#936). */
export interface AttemptSpend {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the model has no known price. */
  costUsd: number | null;
  effort?: string;
}

/** The spend of an attempt from its `usage.json`; null for an attempt that recorded none. */
export function attemptSpend(
  store: WorkflowStore,
  runId: string,
  attemptId: string,
  model: string | null,
): AttemptSpend | null {
  const row = store.latestArtifact(runId, `attempts/${attemptId}/usage.json`);
  if (!row) return null;
  const usage = JSON.parse(store.readArtifact(runId, row.id)) as AttemptUsageRecord;
  const sum = (pick: (step: AttemptUsageRecord["steps"][number]) => number | null | undefined) =>
    usage.steps.reduce((total, step) => total + (pick(step) ?? 0), 0);
  return {
    inputTokens: usage.estimatedUsage?.inputTokens ?? sum((step) => step.inputTokens),
    outputTokens: usage.estimatedUsage?.outputTokens ?? sum((step) => step.outputTokens),
    cacheReadTokens: sum((step) => step.cacheReadTokens),
    cacheWriteTokens: sum((step) => step.cacheWriteTokens),
    costUsd: attemptCost(model, usage),
    ...(usage.effort ? { effort: usage.effort } : {}),
  };
}

/** The estimated cost of one attempt; see `AttemptUsageRow.costUsd`. */
export function attemptCost(
  model: string | null,
  usage: AttemptUsageRecord | undefined,
): number | null {
  if (model === null) return 0;
  if (!usage) return null;
  const pricing = findPricing(model)?.pricing;
  if (!pricing) return null;
  let cost = usage.estimatedUsage
    ? usage.estimatedUsage.inputTokens * pricing.input +
      usage.estimatedUsage.outputTokens * pricing.output
    : 0;
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

import { findPricing } from "../llm/pricing.js";
import type { TokenMix } from "./estimate.js";
import type { WorkflowStore } from "./store.js";
import { type AttemptUsageRow, runUsage } from "./usage.js";

export const DEFAULT_MIX: TokenMix = { input: 0.6, cacheRead: 0.3, output: 0.1 };

type StepTree = Map<string, { stage_id: string; parent_step_id: string | null }>;

/** The run's steps by ID, for `costStageOf` calls that share one read. */
export function stepTree(store: WorkflowStore, runId: string): StepTree {
  return new Map(store.steps(runId).map((step) => [step.id, step]));
}

/** Child calls use their owning stage; planned and corrective tasks share one price history. */
export function costStageOf(
  store: WorkflowStore,
  runId: string,
  stepId: string,
  steps: StepTree = stepTree(store, runId),
): string {
  return owningStage(steps, stepId);
}

function owningStage(steps: StepTree, stepId: string): string {
  let step = steps.get(stepId);
  while (step?.parent_step_id && steps.has(step.parent_step_id))
    step = steps.get(step.parent_step_id);
  const stage = step?.stage_id ?? "";
  return stage.startsWith("task-") ? "implement" : stage;
}

/** What pricing calls of one run share: its price samples and its steps. */
export interface RunPrices {
  samples: AttemptUsageRow[];
  steps: StepTree;
}

export function runPrices(store: WorkflowStore, runId: string): RunPrices {
  const steps = stepTree(store, runId);
  return { samples: forecastSamples(store, [runId], steps), steps };
}

/** Runs whose price samples a store keeps; the least recently read is dropped past this. */
const CACHED_RUNS = 256;
/** Each store's price samples per run, with the `priceStamp` they were read at. */
const samplesCache = new WeakMap<
  WorkflowStore,
  Map<string, { stamp: string; rows: AttemptUsageRow[] }>
>();

/**
 * Child review and task calls inherit the workflow stage that owns them. A run's samples are read
 * again only when its `priceStamp` changed, since every capped model call prices them (#1647).
 * The rows are shared: callers must not change them.
 */
export function forecastSamples(
  store: WorkflowStore,
  runIds: string[],
  known?: StepTree,
): AttemptUsageRow[] {
  let runs = samplesCache.get(store);
  if (!runs) {
    runs = new Map();
    samplesCache.set(store, runs);
  }
  const cache = runs;
  return runIds.flatMap((runId) => {
    const stamp = store.priceStamp(runId);
    const cached = cache.get(runId);
    if (cached?.stamp === stamp) {
      cache.delete(runId);
      cache.set(runId, cached);
      return cached.rows;
    }
    const steps = known && runIds.length === 1 ? known : stepTree(store, runId);
    const stages = new Map(store.attempts(runId).map((a) => [a.id, owningStage(steps, a.step_id)]));
    const rows = runUsage(store, runId).attempts.map((a) => ({
      ...a,
      stage: stages.get(a.attemptId) ?? a.stage,
    }));
    cache.delete(runId);
    if (cache.size >= CACHED_RUNS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(runId, { stamp, rows });
    return rows;
  });
}

/**
 * Price a future stage on its model. Matching paid samples preserve cache discounts and writes.
 * A new model uses the same stage's measured token mix at its own prices. Without stage samples,
 * use the default mix rather than another stage's price. No estimate margin belongs in this rate.
 */
export function forecastRate(
  samples: AttemptUsageRow[],
  stage: string,
  model: string,
): number | null {
  const priced = samples.filter(
    (a) => a.status !== "running" && a.costUsd !== null && (a.usedTokens ?? 0) > 0,
  );
  const sameStage = priced.filter((a) => a.stage === stage);
  const paid = sameStage.filter((a) => a.model === model);
  const tokens = paid.reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
  if (tokens > 0) return paid.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) / tokens;
  const pricing = findPricing(model)?.pricing;
  if (!pricing) return null;
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  for (const a of sameStage) {
    if (a.inputTokens === null || a.outputTokens === null) continue;
    input += a.inputTokens;
    output += a.outputTokens;
    const cached = Math.min(a.inputTokens, a.cacheReadTokens ?? 0);
    read += cached;
    write += Math.min(a.inputTokens - cached, a.cacheWriteTokens ?? 0);
  }
  if (input + output > 0)
    return (
      ((input - read - write) * pricing.input +
        read * pricing.cacheRead +
        write * pricing.cacheWrite +
        output * pricing.output) /
      (input + output) /
      1e6
    );
  return (
    (DEFAULT_MIX.input * pricing.input +
      DEFAULT_MIX.cacheRead * pricing.cacheRead +
      DEFAULT_MIX.output * pricing.output) /
    1e6
  );
}

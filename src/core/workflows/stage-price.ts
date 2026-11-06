import { findPricing } from "../llm/pricing.js";
import type { TokenMix } from "./estimate.js";
import type { WorkflowStore } from "./store.js";
import { type AttemptUsageRow, runUsage } from "./usage.js";

export const DEFAULT_MIX: TokenMix = { input: 0.6, cacheRead: 0.3, output: 0.1 };
/**
 * A task attempt's mix before any task ran. Implementation is an agent loop that replays its
 * cached context every step: codex task attempts read 70 to 80 percent of their tokens from the
 * cache (bench round 38), a Claude Sonnet implementer 91 percent (round 51). The default mix
 * priced the first Sonnet tasks of a run at three times what they paid (#1712).
 */
export const TASK_MIX: TokenMix = { input: 0.15, cacheRead: 0.8, output: 0.05 };

/** The mix a stage without samples is priced at. */
export const stageMix = (stage: string): TokenMix =>
  stage === "implement" ? TASK_MIX : DEFAULT_MIX;

/** A provider family's token mix: `TokenMix` plus the share written to the prompt cache. */
export interface ProviderTokenMix extends TokenMix {
  cacheWrite: number;
}

/**
 * Which provider family a model ID belongs to, by its provider prefix: Claude Code and the Claude
 * API pay for cache writes, Codex and OpenAI charge none and report none (#2963). Any other
 * prefix is its own family.
 */
export function providerFamily(model: string): string {
  const slash = model.indexOf("/");
  const prefix = slash < 0 ? "" : model.slice(0, slash).toLowerCase();
  const name = (slash < 0 ? model : model.slice(slash + 1)).toLowerCase();
  if (prefix === "claude-code" || prefix === "anthropic" || (!prefix && name.startsWith("claude")))
    return "claude";
  if (prefix === "codex" || prefix === "openai" || (!prefix && /^(gpt|o\d)/.test(name)))
    return "openai";
  return prefix || name;
}

/**
 * Claude task and other-stage mixes, measured from the 219 Claude Code attempts of R99 to R103
 * (`claude-code` prefix): every input token is a cache read or a cache write. Task attempts read
 * 78% and wrote 20.5% of their tokens, output 1.5%; single-call stages (research, specify, plan,
 * review, converge) wrote 60.5%, read 33%, output 6.5%. `TASK_MIX` at a Claude price
 * card left out the writes and priced R103's Claude tasks at about 35% under what they paid.
 */
const CLAUDE_TASK_MIX: ProviderTokenMix = {
  input: 0,
  cacheRead: 0.78,
  cacheWrite: 0.205,
  output: 0.015,
};
const CLAUDE_DEFAULT_MIX: ProviderTokenMix = {
  input: 0,
  cacheRead: 0.33,
  cacheWrite: 0.605,
  output: 0.065,
};

/**
 * The mix a stage without samples of the model's own provider family is priced at (#2963): the
 * Claude family's measured mixes with their cache-write share; every other family keeps
 * `stageMix` with no cache writes. No provider's mix stands in for another's.
 */
export function providerTaskMix(model: string, stage: string): ProviderTokenMix {
  if (providerFamily(model) === "claude")
    return stage === "implement" ? CLAUDE_TASK_MIX : CLAUDE_DEFAULT_MIX;
  return { ...stageMix(stage), cacheWrite: 0 };
}

/**
 * `providerTokenMix` (#2963): `off` prices with the blended mixes, `shadow` (the default) keeps
 * them and records the per-provider forecast beside the shown one, `on` shows the per-provider
 * forecast.
 */
export type ProviderTokenMixMode = "off" | "shadow" | "on";
export const DEFAULT_PROVIDER_TOKEN_MIX: ProviderTokenMixMode = "shadow";

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
 * use the stage's default mix (`stageMix`) rather than another stage's price: single-step planning
 * calls never read the cache, so their mix priced a task loop as uncached input (#1712). No
 * estimate margin belongs in this rate. `perProvider` (#2963) measures the mix from the model's
 * own provider family only and falls back to `providerTaskMix`, which counts cache writes.
 */
export function forecastRate(
  samples: AttemptUsageRow[],
  stage: string,
  model: string,
  perProvider = false,
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
  // Per provider (#2963), only the model's own provider family measures the mix.
  const family = perProvider ? providerFamily(model) : null;
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  for (const a of sameStage) {
    if (a.inputTokens === null || a.outputTokens === null) continue;
    if (family !== null && (a.model === null || providerFamily(a.model) !== family)) continue;
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
  const mix: ProviderTokenMix = perProvider
    ? providerTaskMix(model, stage)
    : { ...stageMix(stage), cacheWrite: 0 };
  return (
    (mix.input * pricing.input +
      mix.cacheRead * pricing.cacheRead +
      mix.cacheWrite * pricing.cacheWrite +
      mix.output * pricing.output) /
    1e6
  );
}

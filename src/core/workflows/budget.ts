import type { RoutingRecord } from "../llm/model-routing.js";
import { findPricing } from "../llm/pricing.js";
import { canonical, hashJson } from "../specs/hash.js";
import { costCeilingUsd, costToleranceOf } from "./cost-tolerance.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { type AgentProfile, extendToOf, PolicySchema, type RunPolicy } from "./schemas.js";
import { forecastRate, forecastSamples, type RunPrices, runPrices } from "./stage-price.js";
import { stopFault } from "./stop-reasons.js";
import type { RunRow, WorkflowStore } from "./store.js";
import type { AttemptUsageRow } from "./usage.js";
export function reserveTokens(prompt: string, profile: AgentProfile, policy: RunPolicy): number {
  // Each tool-loop step can replay the growing context and generate another completion.
  // Native execution also enforces the total run limit between calls.
  return (
    Math.ceil(Buffer.byteLength(prompt) / 3) +
    Math.min(profile.maxOutputTokens, policy.maxTotalTokens)
  );
}

/** Token limit used with soft checkpoints: there is no hard cap, the checkpoints are the guard. */
export const UNCAPPED_TOKENS = 1_000_000_000;
export const BUDGET_PRESETS = ["quick", "standard", "extended", "checkpoints"] as const;
export type BudgetPresetId = (typeof BUDGET_PRESETS)[number];

/**
 * The policy a budget preset gives a run, from the configured one. quick and extended scale the
 * three limits; checkpoints removes the token cap, pauses every N tokens for a decision (the
 * configured interval, or half the standard cap) and doubles the call and time limits.
 */
export function scaledPolicy(base: RunPolicy, preset: BudgetPresetId): RunPolicy {
  if (preset === "standard") return base;
  const factor = preset === "quick" ? 0.5 : 2;
  const scaled = {
    ...base,
    maxAgentCalls: Math.min(1000, Math.max(1, Math.round(base.maxAgentCalls * factor))),
    maxActiveMs: Math.max(1000, Math.round(base.maxActiveMs * factor)),
  };
  return PolicySchema.parse(
    preset === "checkpoints"
      ? {
          ...scaled,
          maxTotalTokens: UNCAPPED_TOKENS,
          checkpointTokens:
            base.checkpointTokens ?? Math.max(10000, Math.round(base.maxTotalTokens / 2)),
        }
      : {
          ...scaled,
          maxTotalTokens: Math.max(1000, Math.round(base.maxTotalTokens * factor)),
          checkpointTokens: null,
        },
  );
}

/**
 * The policy a run starts with: the given policy (a `--policy` file or the config's
 * `workflows.policy`), else the built-in default, scaled by the budget preset. Every surface starts
 * runs through this, so each preset is available whether or not the config sets a policy.
 */
export function presetPolicy(base: unknown, preset: BudgetPresetId = "standard"): RunPolicy {
  return scaledPolicy(PolicySchema.parse(base ?? defaultWorkflowPolicy), preset);
}

/** The three limits a budget extension may raise. Scope, tools and checks are never part of it. */
export interface BudgetLimits {
  maxTotalTokens: number;
  maxAgentCalls: number;
  maxActiveMs: number;
}
/** How an extension error names each limit. */
export const LIMIT_NAMES: Record<keyof BudgetLimits, string> = {
  maxTotalTokens: "tokens",
  maxAgentCalls: "calls",
  maxActiveMs: "active ms",
};
export const limitsOf = (policy: RunPolicy): BudgetLimits => ({
  maxTotalTokens: policy.maxTotalTokens,
  maxAgentCalls: policy.maxAgentCalls,
  maxActiveMs: policy.maxActiveMs,
});

/** Upper bounds a single extension may reach; the schema caps calls at 1000 itself. */
export const MAX_EXTENDED_CALLS = 1000;
export const MAX_EXTENDED_MS = 24 * 3600 * 1000;
export const MAX_EXTENDED_TOKENS = 50_000_000;

export interface BudgetUsage {
  tokens: number;
  heldTokens: number;
  inFlightTokens: number;
  calls: number;
  activeMs: number;
}

/** What a run has used, with the tokens still reserved by attempts whose usage is unknown. */
export function budgetUsage(store: WorkflowStore, row: RunRow): BudgetUsage {
  const open = store.attempts(row.id).filter((a) => !a.usage_complete);
  const sum = (list: typeof open): number => list.reduce((n, a) => n + a.reserved_tokens, 0);
  return {
    tokens: row.token_usage,
    heldTokens: sum(open.filter((a) => a.status !== "running")),
    inFlightTokens: sum(open.filter((a) => a.status === "running")),
    calls: row.agent_calls,
    activeMs: row.active_ms,
  };
}

/**
 * The extension offered after a budget stop: every limit that is used up, or at least 80% used,
 * doubles; the tokens double when nothing else explains the stop. Limits at their ceiling stay.
 * Returns null when no limit can be raised any further.
 */
export function proposeExtension(current: BudgetLimits, usage: BudgetUsage): BudgetLimits | null {
  const taken = usage.tokens + usage.heldTokens + usage.inFlightTokens;
  const callsOut = usage.calls >= current.maxAgentCalls;
  const timeOut = usage.activeMs >= current.maxActiveMs;
  const raiseCalls = callsOut || usage.calls >= 0.8 * current.maxAgentCalls;
  const raiseTime = timeOut || usage.activeMs >= 0.8 * current.maxActiveMs;
  const raiseTokens = taken >= 0.8 * current.maxTotalTokens || (!callsOut && !timeOut);
  const next: BudgetLimits = {
    maxTotalTokens: raiseTokens
      ? Math.min(current.maxTotalTokens * 2, MAX_EXTENDED_TOKENS)
      : current.maxTotalTokens,
    maxAgentCalls: raiseCalls
      ? Math.min(current.maxAgentCalls * 2, MAX_EXTENDED_CALLS)
      : current.maxAgentCalls,
    maxActiveMs: raiseTime
      ? Math.min(current.maxActiveMs * 2, MAX_EXTENDED_MS)
      : current.maxActiveMs,
  };
  return next.maxTotalTokens > current.maxTotalTokens ||
    next.maxAgentCalls > current.maxAgentCalls ||
    next.maxActiveMs > current.maxActiveMs
    ? next
    : null;
}

/** Every model a routing record can call: the run model, each route and its fallback models. */
export function routedModels(routing: RoutingRecord): string[] {
  const entries = [...Object.values(routing.profiles), ...Object.values(routing.stages)];
  return [
    ...new Set([routing.runModel, ...entries.flatMap((e) => [e.model, ...(e.fallback ?? [])])]),
  ];
}

/**
 * The dollar cap a run starts with: the one it asked for (`--max-cost-usd`), the policy's own,
 * then the `runBudget.maxCostUsd` setting; null when none is set.
 */
export function startCostCap(
  requested: number | undefined,
  policy: Pick<RunPolicy, "maxCostUsd">,
  config: { runBudget?: { maxCostUsd?: number } },
): number | null {
  return requested ?? policy.maxCostUsd ?? config.runBudget?.maxCostUsd ?? null;
}

/**
 * A dollar cap (`maxCostUsd`) holds only when every model the run can call has a price in the
 * shared price table; a model without one would spend outside the cap, so the run is refused.
 */
export function assertCostCapPriced(policy: RunPolicy, routing: RoutingRecord): void {
  if (policy.maxCostUsd === null) return;
  const unpriced = routedModels(routing).filter((model) => findPricing(model) === null);
  if (unpriced.length)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `maxCostUsd needs a price for every model the run can call; no price is known for ${unpriced.join(", ")}. Route them to priced models or use the token limits with maxCostUsd=null`,
      { unpricedModels: unpriced },
    );
}

/**
 * USD per token the run has paid so far, used before a stage has measured prices.
 * Before anything is priced, the attempt model's input price stands in.
 */
export function costRate(
  spentUsd: number | null,
  spentTokens: number,
  model: string | null,
): number {
  if (spentUsd !== null && spentTokens > 0) return spentUsd / spentTokens;
  const pricing = model ? findPricing(model)?.pricing : undefined;
  return pricing ? pricing.input / 1e6 : 0;
}

/**
 * USD per token of the tokens a run still has to spend (#1505): the price its finished task
 * attempts paid, since tasks are most of what is left. Planning stages run on other models with
 * little cache and cost about twice as much per token, so the run's blended price forecast
 * fecsmith front at $11.88 while it finished at $9.03 (bench round 42). Before a task attempt is
 * priced, the blended price (`costRate`) stands in.
 */
export function remainingCostRate(
  store: WorkflowStore,
  runId: string,
  prices: RunPrices = runPrices(store, runId),
): number {
  return callCostRate(
    store,
    runId,
    "implement",
    null,
    prices.samples,
    sizedTaskModel(store, runId),
  );
}

/**
 * The model the latest plan sizing priced the tasks for, or null before one. Before a task attempt
 * is priced, the remaining tokens are priced on it at the task stage's mix (#1740).
 */
function sizedTaskModel(store: WorkflowStore, runId: string): string | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-"))
    .at(-1);
  if (!latest) return null;
  const model = (JSON.parse(store.readArtifact(runId, latest.id)) as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

/**
 * Price a call from finished attempts of its owning stage, preserving its cache mix on the
 * requested model. Without stage samples, a priced model's call is priced at the stage's own mix
 * (`forecastRate`, `stageMix`): the blended run price carried planning's uncached one-step calls
 * into the first task call, which caches most of its input (#1740, as #1712 for the plan price).
 * An unpriced model falls back to the blended run price, then nothing. With no model, return the
 * stage's paid average for token affordability; `unsampledModel` prices a stage without samples
 * there. Callers that price several calls of one run pass its `forecastSamples` once (#1647).
 */
export function callCostRate(
  store: WorkflowStore,
  runId: string,
  stage: string,
  model: string | null = null,
  runSamples: AttemptUsageRow[] = forecastSamples(store, [runId]),
  unsampledModel: string | null = null,
): number {
  const samples = runSamples.filter(
    (a) => a.status !== "running" && a.costUsd !== null && (a.usedTokens ?? 0) > 0,
  );
  const matching = samples.filter((a) => a.stage === stage);
  const tokens = matching.reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
  if (tokens > 0) {
    if (model !== null) return forecastRate(samples, stage, model) ?? 0;
    return matching.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) / tokens;
  }
  const priced = model ?? unsampledModel;
  const own = priced === null ? null : forecastRate(samples, stage, priced);
  if (own !== null) return own;
  const run = store.run(runId);
  const spentUsd =
    run.estimated_cost_microusd !== null
      ? run.estimated_cost_microusd / 1e6
      : samples.length
        ? samples.reduce((sum, a) => sum + (a.costUsd ?? 0), 0)
        : null;
  return costRate(spentUsd, run.token_usage, model);
}

/**
 * The cost cap a budget extension proposes: doubled when the spent and reserved cost reaches 80%
 * of it, or when no token, call or time limit is 80% used, so the cap is what stopped the run.
 * Unchanged otherwise; null when the run has no cost cap.
 */
export function proposeCostCap(
  maxCostUsd: number | null,
  committedUsd: number,
  current: BudgetLimits,
  usage: BudgetUsage,
): number | null {
  if (maxCostUsd === null) return null;
  const taken = usage.tokens + usage.heldTokens + usage.inFlightTokens;
  const otherLimit =
    taken >= 0.8 * current.maxTotalTokens ||
    usage.calls >= 0.8 * current.maxAgentCalls ||
    usage.activeMs >= 0.8 * current.maxActiveMs;
  return committedUsd >= 0.8 * maxCostUsd || !otherLimit ? maxCostUsd * 2 : maxCostUsd;
}

/** Share of the current token budget one automatic growth adds, at least. */
const GROWTH_STEP = 0.5;

/**
 * The cost cap after the host grows the token budget to `maxTotalTokens`. A cap that may grow
 * (`sizing.maxRunCostUsd`, set by an initiative from its unspent dollars) grows in proportion to
 * the tokens, up to that bound; any other cap stays. Every host growth of the token budget goes
 * through here, so the sizing raise and auto-growth agree (#1411). `neededUsd` also lets a call
 * grow the dollar cap without growing tokens, within the same approved bound (#1625).
 * Bench round 35 (narrowfit sum):
 * auto-growth raised 1,527,292 tokens to 2,290,938 while the cap stayed $1.46, and the run stopped
 * on the cap with 62% of them used (#1353).
 */
export function grownCostCap(
  policy: RunPolicy,
  maxTotalTokens: number,
  neededUsd = policy.maxCostUsd ?? 0,
): number | null {
  const growCostTo = policy.sizing?.maxRunCostUsd;
  if (policy.maxCostUsd === null || growCostTo === undefined) return policy.maxCostUsd;
  const proportional =
    maxTotalTokens > policy.maxTotalTokens
      ? Math.ceil(((policy.maxCostUsd * maxTotalTokens) / policy.maxTotalTokens) * 100) / 100
      : policy.maxCostUsd;
  return Math.max(policy.maxCostUsd, Math.min(growCostTo, Math.max(neededUsd, proportional)));
}

/**
 * Raises the caller's copy of the run policy to the limits stored for the run. The executor and
 * parallel attempts grow the stored limits on their own copies, so a revision written from an
 * older copy undid their growth: R50 selwhy markup's sizing refresh put a $3.01 cap back to
 * $2.32 two minutes after a forecast growth (#1434, #1704).
 */
export function adoptStoredLimits(store: WorkflowStore, runId: string, policy: RunPolicy): void {
  // Read as stored: every reservation adopts it, and only its limits are read.
  const stored = JSON.parse(store.run(runId).policy_json) as RunPolicy;
  if (stored.maxTotalTokens > policy.maxTotalTokens) policy.maxTotalTokens = stored.maxTotalTokens;
  if (stored.maxActiveMs > policy.maxActiveMs) policy.maxActiveMs = stored.maxActiveMs;
  if (stored.maxCostUsd !== null && stored.maxCostUsd > (policy.maxCostUsd ?? Infinity))
    policy.maxCostUsd = stored.maxCostUsd;
  if (stored.maxAgentCalls > policy.maxAgentCalls) policy.maxAgentCalls = stored.maxAgentCalls;
  // An initiative raises the bounds of an open feature run as its other features free their
  // budget (#1931); the drive's copy grows to them too.
  const bounds = ["maxRunTokens", "extendToTokens", "maxRunCostUsd"] as const;
  if (
    stored.sizing &&
    bounds.some((key) => (stored.sizing?.[key] ?? 0) > (policy.sizing?.[key] ?? Infinity))
  ) {
    const sizing = { ...policy.sizing };
    for (const key of bounds) {
      const value = stored.sizing[key];
      const own = sizing[key];
      if (typeof value === "number" && typeof own === "number" && value > own) sizing[key] = value;
    }
    policy.sizing = sizing;
  }
}

/**
 * Records a budget growth the host made on its own as a policy revision (`approvedBy: "sizing"`,
 * never an operator decision), stores the policy and updates the object the caller drives with.
 */
function recordGrowth(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  target: number,
  kind:
    | "auto-growth"
    | "planning-floor"
    | "planning-growth"
    | "auto-extend"
    | "forecast-growth"
    | "call-growth",
  detail: Record<string, unknown>,
  costTo?: number,
): void {
  adoptStoredLimits(store, runId, policy);
  const maxTotalTokens = Math.max(target, policy.maxTotalTokens);
  const before = hashJson(policy);
  const maxCostUsd = costTo ?? grownCostCap(policy, maxTotalTokens);
  const after = PolicySchema.parse({ ...policy, maxTotalTokens, maxCostUsd });
  const cost =
    maxCostUsd !== policy.maxCostUsd
      ? { previousCostUsd: policy.maxCostUsd, nextCostUsd: maxCostUsd }
      : {};
  const count = store
    .artifacts(runId)
    .filter(
      (a) => a.kind === "policy-revision" && a.logical_path.startsWith("policy-revisions/auto-"),
    ).length;
  store.transaction(() => {
    store.artifact(
      runId,
      "policy-revision",
      `policy-revisions/auto-${String(count + 1)}.json`,
      canonical({
        kind,
        approvedBy: "sizing",
        previousPolicyHash: before,
        policyHash: hashJson(after),
        previous: {
          maxTotalTokens: policy.maxTotalTokens,
          ...(cost.previousCostUsd != null ? { maxCostUsd: cost.previousCostUsd } : {}),
        },
        next: {
          maxTotalTokens: after.maxTotalTokens,
          ...(cost.nextCostUsd != null ? { maxCostUsd: cost.nextCostUsd } : {}),
        },
        ceiling: policy.sizing?.maxRunTokens ?? null,
        ...detail,
      }),
    );
    store.setPolicy(runId, after);
  });
  policy.maxTotalTokens = after.maxTotalTokens;
  policy.maxCostUsd = after.maxCostUsd;
}

/**
 * Grows a run's cost cap to a forecast of `projectedUsd` plus tolerance headroom, when the
 * policy lets the cap grow (`sizing.maxRunCostUsd`, what an initiative can spare for the feature)
 * that far. Recorded like every host growth (`approvedBy: "sizing"`, `kind: "forecast-growth"`).
 * Returns whether the forecast now fits. An initiative feature whose finished tasks ran over their
 * price stopped for a person with most of the initiative's dollars unspent (#1503).
 */
export function growCostCapToForecast(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  projectedUsd: number,
  tolerance: number,
  kind: "forecast-growth" | "call-growth" = "forecast-growth",
): boolean {
  // A parallel attempt may already have grown the policy. Keep that revision when growing again.
  adoptStoredLimits(store, runId, policy);
  const bound = policy.sizing?.maxRunCostUsd;
  if (policy.maxCostUsd === null || bound === undefined) return false;
  if (projectedUsd <= policy.maxCostUsd * (1 + tolerance)) return true;
  if (projectedUsd > bound * (1 + tolerance)) return false;
  const needed = Math.min(bound, Math.ceil(projectedUsd * (1 + tolerance) * 100) / 100);
  recordGrowth(
    store,
    runId,
    policy,
    policy.maxTotalTokens,
    kind,
    { projectedUsd, maxRunCostUsd: bound },
    grownCostCap(policy, policy.maxTotalTokens, needed) ?? needed,
  );
  return true;
}

/**
 * Called when a model call would pass the token budget. A run whose policy declares a ceiling
 * (`sizing.maxRunTokens`) grows its budget toward it, instead of stopping for an operator, while
 * it is making progress: at least one task is implemented or verified. The new budget covers the
 * call and is at least half again the old one, never above the ceiling nor, for an initiative's
 * feature run, above what its pool leaves after the other runs (`WorkflowStore.tokenHold`, #2468);
 * the growth is recorded as a policy revision. Returns whether `policy.maxTotalTokens` now covers
 * `projected`.
 */
export function growBudgetOnProgress(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  projected: number,
): boolean {
  const ceiling = policy.sizing?.maxRunTokens ?? null;
  if (ceiling === null) return false;
  // Another worker of this run may have grown the stored budget already.
  adoptStoredLimits(store, runId, policy);
  if (projected <= policy.maxTotalTokens) return true;
  const hold = store.tokenHold?.(runId) ?? null;
  if (policy.maxTotalTokens >= ceiling)
    return extendUnderAssume(store, runId, policy, projected, hold);
  const finished = store
    .tasks(runId)
    .filter((t) => t.status === "implemented" || t.status === "verified").length;
  if (finished === 0) return growWhilePlanning(store, runId, policy, projected, ceiling, hold);
  const next = Math.min(
    ceiling,
    hold ?? Number.POSITIVE_INFINITY,
    Math.max(projected, Math.ceil(policy.maxTotalTokens * (1 + GROWTH_STEP))),
  );
  if (next <= policy.maxTotalTokens) return false;
  recordGrowth(store, runId, policy, next, "auto-growth", {
    projectedTokens: projected,
    finishedTasks: finished,
    ...heldBy(hold),
  });
  if (projected <= policy.maxTotalTokens) return true;
  // A call that reaches the ceiling from below and still falls short extends past it now, under
  // the same rules: md-site eaeb51d6 grew to 6,000,000 for an attempt that needed 6,039,774 and
  // stopped `budget_exhausted` with the 9,000,000 hard limit unused (#1187).
  return (
    policy.maxTotalTokens >= ceiling && extendUnderAssume(store, runId, policy, projected, hold)
  );
}

/**
 * The pool hold a host growth of an initiative's feature run stayed under (`WorkflowStore.tokenHold`,
 * #2468), as the revision records it; nothing for a run of no initiative.
 */
function heldBy(hold: number | null): { poolHoldTokens?: number } {
  return hold === null ? {} : { poolHoldTokens: hold };
}

/**
 * Before the first task finishes, `growBudgetOnProgress` has no progress to see: the run sits at
 * its planning floor (the start estimate's high end) while specify, plan and analyze rounds
 * repeat. pgnvet 3f03497b used 1.26M of its 1.48M floor in seven analysis rounds and
 * blocked `budget_exhausted` at plan with its 20M ceiling unused (#1296). A model attempt that
 * completed since the last such growth counts as progress here: the budget grows by the same step,
 * up to the ceiling, recorded as `kind: "planning-growth"`. A planning phase whose attempts keep
 * failing does not grow it. The same holds once a revise or a rejected tests-first task has
 * invalidated every finished task: the run re-plans with no task finished, and without this the
 * budget did not grow again until one re-finished (#1431).
 */
function growWhilePlanning(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  projected: number,
  ceiling: number,
  hold: number | null,
): boolean {
  const completedAttempts = store
    .attempts(runId)
    .filter((a) => a.model_id !== null && a.status === "completed").length;
  const last = store
    .artifacts(runId)
    .filter(
      (a) => a.kind === "policy-revision" && a.logical_path.startsWith("policy-revisions/auto-"),
    )
    .map(
      (a) =>
        JSON.parse(store.readArtifact(runId, a.id)) as {
          kind?: string;
          completedAttempts?: number;
        },
    )
    .filter((r) => r.kind === "planning-growth")
    .at(-1);
  if (completedAttempts <= (last?.completedAttempts ?? 0)) return false;
  const next = Math.min(
    ceiling,
    hold ?? Number.POSITIVE_INFINITY,
    Math.max(projected, Math.ceil(policy.maxTotalTokens * (1 + GROWTH_STEP))),
  );
  if (next <= policy.maxTotalTokens) return false;
  recordGrowth(store, runId, policy, next, "planning-growth", {
    projectedTokens: projected,
    completedAttempts,
    ...heldBy(hold),
  });
  return projected <= policy.maxTotalTokens;
}

/** Share of the sizing ceiling one extension past it adds, at least: about one review round. */
const EXTEND_STEP = 0.25;

/**
 * Progress so far: what an extension past the ceiling must see grow. `taskCompletions` counts
 * task finishes from events, because current states can go back: corrective T014 of cfgtrace
 * eff0ebe7 finished and invalidated T005 and T011 in the same transaction, so the count of
 * finished tasks stayed at 13, and the run blocked with $3.20 of its $12 cap left (#1224).
 * `continuedAttempts` counts attempts that ended at their cap with edits kept for the task's
 * next attempt: md-site 095b7b11 (bench round 38) spent the second extension on two attempts of
 * its last corrective, which finished nothing yet, and blocked with $5 of its $13.2 cap left
 * (#1383). Each task gets a bounded number of continued attempts, so this cannot extend forever.
 */
function progressOf(store: WorkflowStore, runId: string) {
  return {
    finishedTasks: store
      .tasks(runId)
      .filter((t) => t.status === "implemented" || t.status === "verified").length,
    taskCompletions: store.taskCompletions(runId),
    continuedAttempts: store.continuedAttempts(runId),
    resolvedFindings: store.findings(runId).filter((f) => f.status === "resolved").length,
  };
}

/**
 * With a dollar cap (`maxCostUsd`), the tokens the run can still pay for: what it has used and
 * reserved, plus the cap's unspent dollars at the price its task attempts paid per token
 * (`remainingCostRate`, #1505). Null without a
 * cap or before anything is priced. Raw tokens price a codex run at about $0.9 per million (cache
 * reads) and a claude-code run at about $3.9, so a token limit cannot stand in for the cap:
 * cfgtrace 14b1da41 stopped at its 12M token hard limit with $1.45 of its $12 cap left and its
 * last corrective task unstarted (#1206).
 */
function affordableTokens(store: WorkflowStore, runId: string, policy: RunPolicy): number | null {
  // The cap's tolerance band (`costTolerance`) is part of what the run may pay for (#1263).
  const cap = costCeilingUsd(store, runId, policy);
  if (cap === null) return null;
  const row = store.run(runId);
  const prices = runPrices(store, runId);
  const { spentUsd, reservedUsd } = store.costUsage(runId, undefined, prices);
  const rate = remainingCostRate(store, runId, prices);
  if (rate <= 0) return null;
  const reserved = store
    .attempts(runId)
    .filter((a) => !a.usage_complete)
    .reduce((sum, a) => sum + a.reserved_tokens, 0);
  return Math.floor(row.token_usage + reserved + Math.max(0, cap - spentUsd - reservedUsd) / rate);
}

/**
 * A run at its sizing ceiling under `clarification: "assume"` grows past it, up to
 * `sizing.extendToTokens` (1.5 times the ceiling when unset, `extendToOf`), without a person,
 * while it still makes progress: since the last extension (or the start of the run) a task
 * finished (counted from events, `progressOf`), an attempt ended at its cap with edits the task's
 * next attempt continues, or a finding was resolved. With a dollar cap it may grow further, to what the cap
 * still pays for (`affordableTokens`): the cap then stops the run, as a cost stop. Each extension
 * covers the call and adds at least a quarter of the ceiling, about one review round, and is
 * recorded as `kind: "auto-extend"`. junitdigest 3e5be74b stopped twice at the ceiling and was
 * cleared both times by an operator `extend` with no other choice to make (#747). An initiative's
 * feature run grows no further than its pool leaves after the other runs (`hold`, from
 * `WorkflowStore.tokenHold`): R79 deltaglue's chunks extended to 12.0M on a $25.51 bound that paid
 * for 35.8M while the other features had used 1.86M of the 12.0M pool (#2468).
 *
 * Tokens the open attempts used since the last extension count as progress too, while the
 * extension stays under the hard ceiling, the pool hold and what the dollar cap pays for: with
 * several writers in flight none may finish before the limit runs out, and their tokens are the
 * work not yet counted. R84 md-site 2361845b extended at 6.0M to 7.5M, then failed two of its
 * three in-flight writers `BUDGET_EXHAUSTED` with $6.6 of its $12 cap and a 17.6M hard ceiling
 * left, and spent their 1.44M again (#2590). Each attempt is bounded by its own cap, and a new
 * attempt is checked against its cap before it starts, so one writer alone rarely reaches this.
 */
function extendUnderAssume(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  projected: number,
  hold: number | null,
): boolean {
  const tokenHard = extendToOf(policy);
  const ceiling = policy.sizing?.maxRunTokens ?? null;
  if (tokenHard === null || ceiling === null || policy.clarification !== "assume") return false;
  // An initiative's feature run grows no further than its pool leaves after the other runs: the
  // run's dollar bound pays for more than the pool the person set (#2468).
  const affordable = affordableTokens(store, runId, policy);
  const hard = Math.min(Math.max(tokenHard, affordable ?? 0), hold ?? Number.POSITIVE_INFINITY);
  if (policy.maxTotalTokens >= hard || projected > hard) return false;
  const progress = progressOf(store, runId);
  const last = store
    .artifacts(runId)
    .filter(
      (a) => a.kind === "policy-revision" && a.logical_path.startsWith("policy-revisions/auto-"),
    )
    .map(
      (a) =>
        JSON.parse(store.readArtifact(runId, a.id)) as {
          kind?: string;
          taskCompletions?: number;
          continuedAttempts?: number;
          resolvedFindings?: number;
          openAttemptTokens?: Record<string, number>;
        },
    )
    .filter((r) => r.kind === "auto-extend")
    .at(-1);
  const before = {
    taskCompletions: last?.taskCompletions ?? 0,
    continuedAttempts: last?.continuedAttempts ?? 0,
    resolvedFindings: last?.resolvedFindings ?? 0,
  };
  const openAttemptTokens = Object.fromEntries(
    store
      .attempts(runId)
      .filter((a) => a.status === "running")
      .map((a) => [a.id, a.used_tokens ?? 0]),
  );
  const inFlightTokens = Object.entries(openAttemptTokens).reduce(
    (sum, [id, used]) => sum + Math.max(0, used - (last?.openAttemptTokens?.[id] ?? 0)),
    0,
  );
  const finishedProgress =
    progress.taskCompletions > before.taskCompletions ||
    progress.continuedAttempts > before.continuedAttempts ||
    progress.resolvedFindings > before.resolvedFindings;
  // Work in flight is progress only inside what the dollar cap pays for: past it the cap stops
  // the run, as it does for finished work, rather than a token extension the run cannot pay for.
  const inFlightProgress = inFlightTokens > 0 && (affordable === null || projected <= affordable);
  if (!finishedProgress && !inFlightProgress) return false;
  const next = Math.min(
    hard,
    Math.max(projected, policy.maxTotalTokens + Math.ceil(ceiling * EXTEND_STEP)),
  );
  recordGrowth(store, runId, policy, next, "auto-extend", {
    projectedTokens: projected,
    hardCeiling: hard,
    ...heldBy(hold),
    ...progress,
    inFlightTokens,
    openAttemptTokens,
    ...(affordable !== null ? { affordableTokens: affordable } : {}),
  });
  return projected <= policy.maxTotalTokens;
}

/**
 * Checked before an attempt makes its first model call. An attempt whose cap the run budget no
 * longer covers grows the budget first (as `growBudgetOnProgress` does). In a run with a sizing
 * ceiling, whose attempt caps come from the priced plan, an attempt the budget still cannot cover
 * blocks the run with `budget_exhausted` before it spends anything: junitdigest 3e5be74b started a
 * task attempt and a converge attempt with less left than their caps and lost 46k and 149k to
 * attempts that failed on the run cap mid-loop (#747). Without a ceiling the attempt starts and
 * its cap shrinks to what is left, so it finalizes in time.
 */
export function assertAttemptFits(
  store: WorkflowStore,
  runId: string,
  attemptId: string,
  policy: RunPolicy,
  attemptTokens: number,
): void {
  const remaining = store.remainingTokens(runId, policy, attemptId);
  if (remaining >= attemptTokens) return;
  const committed = policy.maxTotalTokens - remaining;
  // Token extensions also consult affordability. Give an initiative's approved dollar growth
  // room a chance before that check refuses an otherwise affordable attempt (#1625).
  const prices = runPrices(store, runId);
  const rate = remainingCostRate(store, runId, prices);
  if (rate > 0) {
    const { spentUsd, reservedUsd } = store.costUsage(runId, attemptId, prices);
    growCostCapToForecast(
      store,
      runId,
      policy,
      spentUsd + reservedUsd + attemptTokens * rate,
      costToleranceOf(store, runId, policy),
      "call-growth",
    );
  }
  if (growBudgetOnProgress(store, runId, policy, committed + attemptTokens)) return;
  if (policy.sizing?.maxRunTokens == null) return;
  const left = store.remainingTokens(runId, policy, attemptId);
  if (left >= attemptTokens) return;
  // With a dollar cap the cap is the limit that stops the run when it cannot pay for the attempt.
  const affordable = affordableTokens(store, runId, policy);
  if (affordable !== null && committed + attemptTokens > affordable)
    throw stopFault("cost", "The next attempt would pass the run's cost cap", {
      ...store.costUsage(runId, attemptId),
      attemptTokens,
      maxCostUsd: policy.maxCostUsd,
      ceilingUsd: costCeilingUsd(store, runId, policy),
    });
  throw stopFault(
    "run-budget",
    `The next attempt needs more tokens than the run budget has left (${String(left)} of ${String(policy.maxTotalTokens)}; the policy's sizing ceiling is ${String(policy.sizing.maxRunTokens)})`,
    {
      remainingTokens: left,
      attemptTokens,
      maxTotalTokens: policy.maxTotalTokens,
      ceilingTokens: policy.sizing.maxRunTokens,
    },
  );
}

/**
 * Before the plan is priced the budget is the policy's default, below the doctor's own high
 * estimate (cronsay stopped at 768k after 9 plan and 5 specify attempts, before any pricing).
 * A run with a ceiling and no task yet starts at least at the start estimate's high end, up to
 * the ceiling, recorded as a policy revision.
 */
export function raiseToStartEstimate(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
): boolean {
  let estimateHigh: number | null = null;
  try {
    const saved = store.latestArtifact(runId, "estimates/start.json");
    const body = saved
      ? (JSON.parse(store.readArtifact(runId, saved.id)) as { tokens?: { high?: unknown } })
      : null;
    if (typeof body?.tokens?.high === "number") estimateHigh = body.tokens.high;
  } catch {
    // The estimate is advice; an unreadable one leaves the budget alone.
  }
  const ceiling = policy.sizing?.maxRunTokens ?? null;
  if (ceiling === null || estimateHigh === null || store.tasks(runId).length > 0) return false;
  const hold = store.tokenHold?.(runId) ?? null;
  const target = Math.min(ceiling, hold ?? Number.POSITIVE_INFINITY, Math.ceil(estimateHigh));
  if (target <= policy.maxTotalTokens) return false;
  recordGrowth(store, runId, policy, target, "planning-floor", { estimateHigh, ...heldBy(hold) });
  return true;
}

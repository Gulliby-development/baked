import type { RoutingRecord } from "../llm/model-routing.js";
import { findPricing } from "../llm/pricing.js";
import { canonical, hashJson } from "../specs/hash.js";
import { costCeilingUsd } from "./cost-tolerance.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { type AgentProfile, extendToOf, PolicySchema, type RunPolicy } from "./schemas.js";
import type { RunRow, WorkflowStore } from "./store.js";
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
 * USD per token the run has paid so far, used to price the tokens its open attempts reserve.
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
 * Records a budget growth the host made on its own as a policy revision (`approvedBy: "sizing"`,
 * never an operator decision), stores the policy and updates the object the caller drives with.
 */
function recordGrowth(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  maxTotalTokens: number,
  kind: "auto-growth" | "planning-floor" | "auto-extend",
  detail: Record<string, unknown>,
): void {
  const before = hashJson(policy);
  const after = PolicySchema.parse({ ...policy, maxTotalTokens });
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
        previous: { maxTotalTokens: policy.maxTotalTokens },
        next: { maxTotalTokens: after.maxTotalTokens },
        ceiling: policy.sizing?.maxRunTokens ?? null,
        ...detail,
      }),
    );
    store.setPolicy(runId, after);
  });
  policy.maxTotalTokens = after.maxTotalTokens;
}

/**
 * Called when a model call would pass the token budget. A run whose policy declares a ceiling
 * (`sizing.maxRunTokens`) grows its budget toward it, instead of stopping for an operator, while
 * it is making progress: at least one task is implemented or verified. The new budget covers the
 * call and is at least half again the old one, never above the ceiling; the growth is recorded as
 * a policy revision. Returns whether `policy.maxTotalTokens` now covers `projected`.
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
  const stored = PolicySchema.parse(JSON.parse(store.run(runId).policy_json));
  if (stored.maxTotalTokens > policy.maxTotalTokens) policy.maxTotalTokens = stored.maxTotalTokens;
  if (projected <= policy.maxTotalTokens) return true;
  if (policy.maxTotalTokens >= ceiling) return extendUnderAssume(store, runId, policy, projected);
  const finished = store
    .tasks(runId)
    .filter((t) => t.status === "implemented" || t.status === "verified").length;
  if (finished === 0) return false;
  const next = Math.min(
    ceiling,
    Math.max(projected, Math.ceil(policy.maxTotalTokens * (1 + GROWTH_STEP))),
  );
  if (next <= policy.maxTotalTokens) return false;
  recordGrowth(store, runId, policy, next, "auto-growth", {
    projectedTokens: projected,
    finishedTasks: finished,
  });
  if (projected <= policy.maxTotalTokens) return true;
  // A call that reaches the ceiling from below and still falls short extends past it now, under
  // the same rules: md-site eaeb51d6 grew to 6,000,000 for an attempt that needed 6,039,774 and
  // stopped `budget_exhausted` with the 9,000,000 hard limit unused (#1187).
  return policy.maxTotalTokens >= ceiling && extendUnderAssume(store, runId, policy, projected);
}

/** Share of the sizing ceiling one extension past it adds, at least: about one review round. */
const EXTEND_STEP = 0.25;

/**
 * Progress so far: what an extension past the ceiling must see grow. `taskCompletions` counts
 * task finishes from events, because current states can go back: corrective T014 of cfgtrace
 * eff0ebe7 finished and invalidated T005 and T011 in the same transaction, so the count of
 * finished tasks stayed at 13, and the run blocked with $3.20 of its $12 cap left (#1224).
 */
function progressOf(store: WorkflowStore, runId: string) {
  return {
    finishedTasks: store
      .tasks(runId)
      .filter((t) => t.status === "implemented" || t.status === "verified").length,
    taskCompletions: store.taskCompletions(runId),
    resolvedFindings: store.findings(runId).filter((f) => f.status === "resolved").length,
  };
}

/**
 * With a dollar cap (`maxCostUsd`), the tokens the run can still pay for: what it has used and
 * reserved, plus the cap's unspent dollars at the run's measured price per token. Null without a
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
  const { spentUsd, reservedUsd } = store.costUsage(runId);
  const rate = costRate(spentUsd > 0 ? spentUsd : null, row.token_usage, null);
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
 * finished (counted from events, `progressOf`) or a finding was resolved. With a dollar cap it may grow further, to what the cap
 * still pays for (`affordableTokens`): the cap then stops the run, as a cost stop. Each extension
 * covers the call and adds at least a quarter of the ceiling, about one review round, and is
 * recorded as `kind: "auto-extend"`. junitdigest 3e5be74b stopped twice at the ceiling and was
 * cleared both times by an operator `extend` with no other choice to make (#747).
 */
function extendUnderAssume(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  projected: number,
): boolean {
  const tokenHard = extendToOf(policy);
  const ceiling = policy.sizing?.maxRunTokens ?? null;
  if (tokenHard === null || ceiling === null || policy.clarification !== "assume") return false;
  const hard = Math.max(tokenHard, affordableTokens(store, runId, policy) ?? 0);
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
          resolvedFindings?: number;
        },
    )
    .filter((r) => r.kind === "auto-extend")
    .at(-1);
  const before = {
    taskCompletions: last?.taskCompletions ?? 0,
    resolvedFindings: last?.resolvedFindings ?? 0,
  };
  if (
    progress.taskCompletions <= before.taskCompletions &&
    progress.resolvedFindings <= before.resolvedFindings
  )
    return false;
  const next = Math.min(
    hard,
    Math.max(projected, policy.maxTotalTokens + Math.ceil(ceiling * EXTEND_STEP)),
  );
  recordGrowth(store, runId, policy, next, "auto-extend", {
    projectedTokens: projected,
    hardCeiling: hard,
    ...progress,
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
  if (growBudgetOnProgress(store, runId, policy, committed + attemptTokens)) return;
  if (policy.sizing?.maxRunTokens == null) return;
  const left = store.remainingTokens(runId, policy, attemptId);
  if (left >= attemptTokens) return;
  // With a dollar cap the cap is the limit that stops the run when it cannot pay for the attempt.
  const affordable = affordableTokens(store, runId, policy);
  if (affordable !== null && committed + attemptTokens > affordable)
    throw new WorkflowFault("BUDGET_EXHAUSTED", "The next attempt would pass the run's cost cap", {
      reason: "cost",
      ...store.costUsage(runId, attemptId),
      attemptTokens,
      maxCostUsd: policy.maxCostUsd,
      ceilingUsd: costCeilingUsd(store, runId, policy),
    });
  throw new WorkflowFault(
    "BUDGET_EXHAUSTED",
    "The next attempt needs more tokens than the run budget has left",
    {
      remainingTokens: left,
      attemptTokens,
      maxTotalTokens: policy.maxTotalTokens,
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
  const target = Math.min(ceiling, Math.ceil(estimateHigh));
  if (target <= policy.maxTotalTokens) return false;
  recordGrowth(store, runId, policy, target, "planning-floor", { estimateHigh });
  return true;
}

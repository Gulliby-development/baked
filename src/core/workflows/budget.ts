import { type AgentProfile, PolicySchema, type RunPolicy } from "./schemas.js";
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

/** The three limits a budget extension may raise. Scope, tools and checks are never part of it. */
export interface BudgetLimits {
  maxTotalTokens: number;
  maxAgentCalls: number;
  maxActiveMs: number;
}
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

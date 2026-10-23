import { hashJson } from "../../specs/hash.js";
import { extendToOf, PolicySchema, type RunPolicy } from "../schemas.js";
import { sizeWeight } from "./plan.js";
import type { InitiativeView, ShareGateView, UsageView } from "./service.js";

// How much of the initiative's shared budget a feature run may grow into (#1931, #1958). Part of
// the cap-growth hot module (.github/hot-modules.json): a per-run limit derived from an initiative
// share is raised only through these helpers, and each has a case in
// tests/workflow-scenario-initiative-guard-growth.test.ts.

const cents = (n: number): number => Math.floor(n * 100) / 100;

/**
 * The dollars a starting feature's cap may grow to independently of tokens: the remaining dollar
 * budget less the priced low estimates of the other waiting features. Unpriced features reserve
 * their whole shares. A feature's cap was fixed at its share while its token budget grew:
 * bench round 35's sum feature stopped on its $1.46
 * cap with 62% of its grown tokens unused and $14 of the initiative unspent (#1353). Null without a
 * dollar budget.
 */
export function costGrowthLimit(
  view: Pick<ShareGateView, "budget" | "features">,
  featureId: string,
): number | null {
  const remaining = view.budget.cost?.remainingUsd;
  if (remaining === null || remaining === undefined) return null;
  const reserve = view.features
    .filter((f) => f.share !== null && f.id !== featureId)
    .reduce((sum, f) => sum + (f.needUsd?.low ?? f.shareUsd ?? 0), 0);
  return Math.max(0, remaining - reserve);
}

/**
 * The calls and active time a starting feature gets: what remains of the shared budget less a
 * floor for every other feature still waiting, never below its own share. A floor is the base
 * policy's per-run limit scaled by size (half for small, double for large), at most that
 * feature's own share. Both limits are stuck-run guards rather than costs, and an open run holds
 * only what it uses once it ends; split by size alone, the first medium feature of a 6 hour,
 * 7 feature initiative got 38 minutes, needed 40 and blocked with 11.7M ms of the initiative
 * unused (#1327).
 */
export function guardGrowth(
  view: InitiativeView,
  featureId: string,
  base: Pick<RunPolicy, "maxAgentCalls" | "maxActiveMs">,
): { calls: number; activeMs: number } {
  const waiting = view.features.filter((f) => f.share !== null);
  const own = waiting.find((f) => f.id === featureId)?.share;
  const others = waiting.filter((f) => f.id !== featureId);
  const floor = (limit: number, pick: (share: UsageView) => number): number =>
    others.reduce(
      (sum, f) => sum + Math.min(f.share ? pick(f.share) : 0, (limit * sizeWeight(f)) / 2),
      0,
    );
  const { remaining } = view.budget;
  return {
    calls: Math.max(
      own?.calls ?? 0,
      Math.floor(remaining.calls - floor(base.maxAgentCalls, (s) => s.calls)),
    ),
    activeMs: Math.max(
      own?.activeMs ?? 0,
      Math.floor(remaining.activeMs - floor(base.maxActiveMs, (s) => s.activeMs)),
    ),
  };
}

/**
 * An open feature run's policy with its growth bounds raised to what it holds plus what the
 * initiative can spare now (`room`, from `costGrowthLimit`, `growthLimit` and `guardGrowth`), or
 * null when nothing rises (#1931). The dollar and token bounds are ceilings the run grows toward
 * on its own (`growCostCapToForecast`, `growBudgetOnProgress`); the base policy's ceilings still
 * hold, and a null token room (no waiting feature has an estimate) takes them, as a start does.
 * Calls and active time are limits rather than bounds, and the initiative commits them at once,
 * so they rise only for a run that has used 80 percent of them, by a step (`guardStep`).
 */
export function refreshedGrowth(
  policy: RunPolicy,
  base: RunPolicy,
  held: { usd: number; tokens: number; calls: number; activeMs: number },
  used: Pick<UsageView, "calls" | "activeMs">,
  room: { usd: number | null; tokens: number | null; calls: number; activeMs: number },
): RunPolicy | null {
  const sizing = policy.sizing ? { ...policy.sizing } : undefined;
  if (sizing?.maxRunCostUsd !== undefined && policy.maxCostUsd !== null && room.usd !== null)
    sizing.maxRunCostUsd = Math.max(sizing.maxRunCostUsd, cents(held.usd + room.usd));
  const limit = room.tokens === null ? Infinity : Math.floor(held.tokens + room.tokens);
  const ceiling = base.sizing?.maxRunTokens;
  if (sizing && typeof sizing.maxRunTokens === "number" && typeof ceiling === "number")
    sizing.maxRunTokens = Math.max(sizing.maxRunTokens, Math.min(ceiling, limit));
  const hard = extendToOf(base);
  if (sizing?.extendToTokens !== undefined && hard !== null)
    sizing.extendToTokens = Math.max(sizing.extendToTokens, Math.min(hard, limit));
  const maxAgentCalls = guardStep(
    used.calls,
    policy.maxAgentCalls,
    Math.min(1000, held.calls + room.calls),
  );
  const maxActiveMs = guardStep(
    used.activeMs,
    policy.maxActiveMs,
    Math.floor(held.activeMs + room.activeMs),
  );
  const after = PolicySchema.parse({
    ...policy,
    maxAgentCalls,
    maxActiveMs,
    ...(sizing ? { sizing } : {}),
  });
  return hashJson(after) === hashJson(policy) ? null : after;
}

/**
 * The calls and active time an open feature run may grow into on top of what it holds (`own`, its
 * limits): the pool less what every other run of the initiative used (`others`) and the floors of
 * the features still waiting for a run (`waiting`). Both are stuck-run guards rather than costs,
 * and an open run holds what it uses once it ends, so another open run reserves its use, not its
 * limit; it asks for room itself when it reaches its own limit. Counted at their limits, the open
 * runs of R62 stepvet left a room of 0 to 7 ms while a third of the initiative's 6 hours went
 * unused, and lines and tagexpr stopped on their shares (#1958). Raises go in steps
 * (`guardStep`), so runs that ask at once overrun the pool by a step at most.
 */
export function openGuardRoom(
  pool: Pick<UsageView, "calls" | "activeMs">,
  own: Pick<UsageView, "calls" | "activeMs">,
  others: Pick<UsageView, "calls" | "activeMs">,
  waiting: Pick<UsageView, "calls" | "activeMs">,
): { calls: number; activeMs: number } {
  const room = (pick: (usage: Pick<UsageView, "calls" | "activeMs">) => number): number =>
    Math.max(0, Math.floor(pick(pool) - pick(others) - pick(waiting) - pick(own)));
  return { calls: room((u) => u.calls), activeMs: room((u) => u.activeMs) };
}

/**
 * A run's call or active-time limit after a refresh: unchanged until it used 80 percent, then
 * raised toward `target` by at most a quarter of the limit, so one run does not take the whole
 * room at once and asks again when it needs more. A raise under 1 percent writes no revision: the
 * R62 lines run got 24 revisions of 3 ms to 7.5 s each (#1958).
 */
export function guardStep(used: number, limit: number, target: number): number {
  if (used < 0.8 * limit) return limit;
  const next = Math.min(target, Math.ceil(limit * 1.25));
  return next - limit < Math.max(1, limit * 0.01) ? limit : next;
}

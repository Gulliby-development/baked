import { MIN_DURATION_SAMPLES } from "./duration.js";

// The initiative's shared agent calls beside its token pool and active time (#2345). Advice only,
// as the time forecast is (#2336): the forecast, its notice and the amount a block suggests decide
// nothing; the limit stays as the person set it. Before this, a feature run that grew to the shared
// calls room and stopped, or a start whose share of calls was spent, offered `extend` with no
// `--calls` amount, and nothing warned before.

/** Suggested call limits are rounded up to this step, so the answer is a short number. */
export const CALLS_STEP = 50;
/** The margin a suggested limit keeps above the forecast, as the time's does. */
export const CALLS_MARGIN = 0.25;
/** A run below this many tokens says little about its calls per token. */
const MIN_CALL_RATE_TOKENS = 100_000;

const roundUp = (calls: number): number => Math.ceil(calls / CALLS_STEP) * CALLS_STEP;
const callsFor = (tokens: number, perMillion: number): number =>
  Math.ceil((tokens / 1_000_000) * perMillion);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[half] ?? 0)
    : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
};

/** Agent calls per million tokens, with where it comes from. */
export interface CallsPace {
  callsPerMillion: number;
  /** `initiative`: its own finished feature runs; `history`: other initiatives' feature runs. */
  basis: "initiative" | "history";
  runs: number;
}

/** A finished run's calls per token, or null when it ran too little to show one. */
export function finishedRunCallRate(run: {
  status: string;
  tokens: number;
  calls: number;
}): number | null {
  return run.status === "completed" && run.tokens >= MIN_CALL_RATE_TOKENS && run.calls > 0
    ? run.calls / run.tokens
    : null;
}

/** The median calls per token of `MIN_DURATION_SAMPLES` or more rates, or null with fewer. */
export function callsPerToken(rates: readonly number[]): { rate: number; samples: number } | null {
  const usable = rates.filter((rate) => Number.isFinite(rate) && rate > 0);
  if (usable.length < MIN_DURATION_SAMPLES) return null;
  return { rate: median(usable), samples: usable.length };
}

/**
 * The pace the initiative's calls are forecast at: the median of its own finished feature runs
 * once there are `MIN_DURATION_SAMPLES` of them, else the median of other initiatives' finished
 * feature runs; null without either.
 */
export function initiativeCallsPace(
  ownRates: readonly number[],
  measured: { rate: number; samples: number } | null,
): CallsPace | null {
  const own = callsPerToken(ownRates);
  const pace = own ?? measured;
  if (!pace || pace.rate <= 0) return null;
  return {
    callsPerMillion: Math.round(pace.rate * 1_000_000),
    basis: own ? "initiative" : "history",
    runs: pace.samples,
  };
}

export interface CallsPoolInputs {
  initiativeId: string;
  limitCalls: number;
  usedCalls: number;
  /** Used calls plus what open runs may still make under their limits. */
  committedCalls: number;
  usedTokens: number;
  /** The token pool's forecast of the whole initiative (the higher of its two); null without one. */
  forecastTokens: number | null;
  pace: CallsPace | null;
  /** The high token estimates of the features still waiting for a run. */
  waitingHighTokens: number;
  features: number;
}

/** The shared calls as `initiative show`, the TUI and the desktop budget view read them. */
export interface CallsPoolView {
  limitCalls: number;
  usedCalls: number;
  committedCalls: number;
  /** The pace the forecast is at; null without a measured one. */
  pace: CallsPace | null;
  /** Used calls plus the tokens the token forecast still has to run at the pace; null without both. */
  forecastCalls: number | null;
  /** What starts every waiting feature at its high estimate beside what open runs hold. */
  coverCalls: number | null;
  /** What the notice suggests extending the calls to: the forecast and its margin, rounded up. */
  suggestedCalls: number | null;
  /** Set when the forecast is above the limit. */
  notice: string | null;
}

/** The shared calls, their forecast at the measured pace and what to extend them to (#2345). */
export function callsPool(inputs: CallsPoolInputs): CallsPoolView {
  const { limitCalls, usedCalls, committedCalls, pace } = inputs;
  const at = (tokens: number): number => (pace ? callsFor(tokens, pace.callsPerMillion) : 0);
  const forecastCalls =
    pace && inputs.forecastTokens !== null
      ? usedCalls + at(Math.max(0, inputs.forecastTokens - inputs.usedTokens))
      : null;
  const suggestedCalls =
    forecastCalls !== null && forecastCalls > limitCalls
      ? roundUp(forecastCalls * (1 + CALLS_MARGIN))
      : null;
  const view: CallsPoolView = {
    limitCalls,
    usedCalls,
    committedCalls,
    pace,
    forecastCalls,
    coverCalls: pace ? roundUp(committedCalls + at(inputs.waitingHighTokens)) : null,
    suggestedCalls,
    notice: null,
  };
  if (pace && forecastCalls !== null && suggestedCalls !== null) {
    const basis =
      pace.basis === "initiative"
        ? `the median of ${pace.runs} finished runs of this initiative`
        : `the median of ${pace.runs} feature runs of other initiatives`;
    view.notice = `At ${pace.callsPerMillion} agent calls per million tokens (${basis}) the ${inputs.features} features need about ${forecastCalls} calls (${usedCalls} used); the shared limit is ${limitCalls}. Extend to ${suggestedCalls} calls (baked workflow initiative extend ${inputs.initiativeId} --calls ${suggestedCalls}).`;
  }
  return view;
}

/**
 * The calls a block on the shared calls suggests: the forecast's suggestion, else what starts
 * every waiting feature at its high estimate; null when neither raises the limit.
 */
export function callsRaise(calls: CallsPoolView | null | undefined): number | null {
  if (!calls) return null;
  const raise = Math.max(calls.suggestedCalls ?? 0, calls.coverCalls ?? 0);
  return raise > calls.limitCalls ? raise : null;
}

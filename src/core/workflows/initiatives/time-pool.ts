import { ACTIVE_TIME_MARGIN, ownPace, type PaceBasis, runPace } from "../sizing.js";

// The initiative's shared active time beside its token pool (#2336). Advice only: the forecast, its
// notice and the amounts a block suggests decide nothing; the limit stays as the person set it.
// R74 ladlemath summed 35.9M ms of active time against a 21.6M ms limit while the tokens carried a
// notice at 2.7x of the estimates and the time had none: three feature runs stopped on their
// active deadline before anyone was told, and the loop doubled the limit by hand.

/** Suggested times are rounded up to this step, so the answer is a short number. */
export const TIME_STEP_MS = 15 * 60_000;
const roundUp = (ms: number): number => Math.ceil(ms / TIME_STEP_MS) * TIME_STEP_MS;
const minutes = (ms: number): number => Math.round(ms / 60_000);
const msFor = (tokens: number, tokensPerMinute: number): number =>
  Math.round((tokens / tokensPerMinute) * 60_000);

/** Tokens per active minute, with where it comes from. */
export interface ActivePace {
  tokensPerMinute: number;
  /** `initiative`: its own finished feature runs; `history`: other initiatives' feature runs. */
  basis: Exclude<PaceBasis, "default">;
  runs: number;
}

/**
 * The pace the initiative's time is forecast at: the median of its own finished feature runs once
 * there are `MIN_DURATION_SAMPLES` of them (`ownPace`), else the active milliseconds per token the
 * estimate measured on other initiatives' feature runs; null without either.
 */
export function initiativePace(
  ownRates: readonly number[],
  measured: { msPerToken: number; samples: number } | null,
): ActivePace | null {
  const own = ownPace(ownRates);
  if (own) return { ...own, basis: "initiative" };
  if (!measured || measured.msPerToken <= 0) return null;
  return {
    tokensPerMinute: Math.round(60_000 / measured.msPerToken),
    basis: "history",
    runs: measured.samples,
  };
}

/** A finished run's pace, or null when it ran too briefly to show one (`runPace`). */
export const finishedRunPace = (run: { status: string; tokens: number; activeMs: number }) =>
  run.status === "completed" ? runPace(run.tokens, run.activeMs) : null;

export interface TimePoolInputs {
  initiativeId: string;
  limitMs: number;
  usedMs: number;
  /** Used active time plus what open runs may still use under their limits. */
  committedMs: number;
  usedTokens: number;
  /** The token pool's forecast of the whole initiative (the higher of its two); null without one. */
  forecastTokens: number | null;
  pace: ActivePace | null;
  /** The high token estimates of the features still waiting for a run. */
  waitingHighTokens: number;
  features: number;
  /** Feature runs at once, for the wall time. */
  slots: number;
}

/** The shared active time as `initiative show`, the TUI and the desktop budget view read it. */
export interface TimePoolView {
  limitMs: number;
  usedMs: number;
  committedMs: number;
  /** The pace the forecast is at; null without a measured one. */
  pace: ActivePace | null;
  /** Used time plus the tokens the token forecast still has to run at the pace; null without both. */
  forecastMs: number | null;
  /** That time spread over the run slots: the wall time still to run, in ms. */
  wallMs: number | null;
  /** What starts every waiting feature at its high estimate beside what open runs hold. */
  coverMs: number | null;
  /** What the notice suggests extending the time to: the forecast and its margin, rounded up. */
  suggestedMs: number | null;
  /** Set when the forecast is above the limit. */
  notice: string | null;
}

/** The shared time, its forecast at the measured pace and what to extend it to (#2336). */
export function timePool(inputs: TimePoolInputs): TimePoolView {
  const { limitMs, usedMs, committedMs, pace } = inputs;
  const at = (tokens: number): number => (pace ? msFor(tokens, pace.tokensPerMinute) : 0);
  const left =
    pace && inputs.forecastTokens !== null
      ? at(Math.max(0, inputs.forecastTokens - inputs.usedTokens))
      : null;
  const forecastMs = left === null ? null : usedMs + left;
  const suggestedMs =
    forecastMs !== null && forecastMs > limitMs
      ? roundUp(forecastMs * (1 + ACTIVE_TIME_MARGIN))
      : null;
  const wallMs = left === null ? null : Math.round(left / Math.max(1, inputs.slots));
  const view: TimePoolView = {
    limitMs,
    usedMs,
    committedMs,
    pace,
    forecastMs,
    wallMs,
    coverMs: pace ? roundUp(committedMs + at(inputs.waitingHighTokens)) : null,
    suggestedMs,
    notice: null,
  };
  if (pace && forecastMs !== null && suggestedMs !== null) {
    const basis =
      pace.basis === "initiative"
        ? `the median of ${pace.runs} finished runs of this initiative`
        : `the median of ${pace.runs} feature runs of other initiatives`;
    const wall = wallMs
      ? `, about ${minutes(wallMs)} min of wall time still to run with ${inputs.slots} at once`
      : "";
    view.notice = `At ${Math.round(pace.tokensPerMinute / 1000)}k tokens per active minute (${basis}) the ${inputs.features} features need about ${minutes(forecastMs)} min of summed active time (${minutes(usedMs)} min used${wall}); the shared time is ${minutes(limitMs)} min. Extend to ${minutes(suggestedMs)} min (baked workflow initiative extend ${inputs.initiativeId} --time-ms ${suggestedMs}).`;
  }
  return view;
}

/**
 * The time a block on the shared time suggests: the forecast's suggestion, else what starts every
 * waiting feature at its high estimate; null when neither raises the limit.
 */
export function timeRaise(time: TimePoolView | null | undefined): number | null {
  if (!time) return null;
  const raise = Math.max(time.suggestedMs ?? 0, time.coverMs ?? 0);
  return raise > time.limitMs ? raise : null;
}

/**
 * The active time a feature run stopped on its deadline suggests (#2336): what it used plus the
 * tokens its plan (or its limit) still has at the pace, with the sizing margin, rounded up; at
 * least a quarter above its limit, as a guard step raises it.
 */
export function runTimeRaise(run: {
  activeMs: number;
  maxActiveMs: number;
  usedTokens: number;
  needTokens: number;
  tokensPerMinute: number | null;
}): number {
  const step = Math.ceil((run.maxActiveMs * (1 + ACTIVE_TIME_MARGIN)) / 60_000) * 60_000;
  if (!run.tokensPerMinute) return step;
  const left = msFor(Math.max(0, run.needTokens - run.usedTokens), run.tokensPerMinute);
  return Math.max(
    step,
    Math.ceil(((run.activeMs + left) * (1 + ACTIVE_TIME_MARGIN)) / 60_000) * 60_000,
  );
}

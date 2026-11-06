import {
  ADAPTIVE_FIRST_BYTE_FLOOR_MS,
  type CallTiming,
  firstByteDeadline,
} from "../llm/provider-health.js";
import type { ActivePace } from "./initiatives/time-pool.js";
import {
  activeTimeLimit,
  ownPace,
  type PaceBasis,
  paceOf,
  runPace,
  type SizingReport,
} from "./sizing.js";
import type { AttemptUsageRecord } from "./step-budget.js";
import type { WorkflowStore } from "./store.js";

// The clean pace (#2414, item 2), recorded in shadow: tokens per active minute without the time a
// provider stalled before it answered (`stallMs`), from `CLEAN_PACE_RUNS` finished runs of the
// initiative, else the history's. R76 hintsieve's notice asked for 4.0x the time its initiative
// used, from a median of two finished runs, one with a stalled call. The pace that decides (time
// notice, forecast, run time sizing) is unchanged; the clean one is recorded beside it, so the
// replay and the next round compare them (`replayActiveTimes`).
//
// Only the stall part of a wait is left out (#2424): Codex and Claude Code buffer their answer, so
// their wait before the first response (`silentMs`) is most of the model's time. With the whole
// wait out, R62 stepvet's five finished runs all passed the history's 135k tokens per minute and
// R77 pairwick's clean rates were 2.1 to 2.4 times its real pace.

/**
 * The wait before a first response that is never a stall: the shortest adaptive first-response
 * deadline, which a silent call of a shape with short healthy answers gets (#1766).
 */
export const STALL_FLOOR_MS = ADAPTIVE_FIRST_BYTE_FLOOR_MS;

/**
 * The longest wait before its first response that is a call's own model time: the deadline its
 * shape's healthy answers give it (`firstByteDeadline` on its recorded `deadlineInputs`, without
 * the provider's ceiling), else the adaptive deadline it had (`limitMs`, a record before #2283),
 * never below `STALL_FLOOR_MS`. A call with neither (its provider's fixed deadline) gets the floor.
 */
export function stallBasisMs(
  call: Pick<CallTiming, "deadlineInputs" | "limitMs" | "promptChars">,
): number {
  const adaptive = call.deadlineInputs
    ? firstByteDeadline(Number.POSITIVE_INFINITY, call.deadlineInputs, call.promptChars)
    : (call.limitMs ?? 0);
  return Number.isFinite(adaptive) ? Math.max(STALL_FLOOR_MS, adaptive) : STALL_FLOOR_MS;
}

/**
 * The stall part of a call's wait before its first response (`wait`, its `silentMs` by default):
 * what passes `stallBasisMs`. A buffered provider's wait within it is model time, not a stall.
 */
export function callStallMs(
  call: Pick<CallTiming, "deadlineInputs" | "limitMs" | "promptChars" | "silentMs">,
  wait = call.silentMs ?? 0,
): number {
  return Math.max(0, wait - stallBasisMs(call));
}

/** Finished runs of its own an initiative needs before its clean pace replaces the history's. */
export const CLEAN_PACE_RUNS = 4;

/** A finished run's tokens per active minute without its stalled time, or null (`runPace`). */
export function cleanRunPace(run: {
  status: string;
  tokens: number;
  activeMs: number;
  stallMs: number;
}): number | null {
  return run.status === "completed"
    ? runPace(run.tokens, Math.max(0, run.activeMs - run.stallMs))
    : null;
}

/** A finished run's waits before its calls' first responses and their stall part (#2424). */
export interface RunSilence {
  silentMs: number;
  stallMs: number;
}

/**
 * The time a finished run's answered calls waited for their first response, and the stall part of
 * it, from its attempts' usage records (the store keeps each record's parse). A record before
 * #2414 sums its calls' `firstByteMs` as their waits. A record before #2424 has no `stallMs`: its
 * calls' stall parts are taken again from their timings (`callStallMs`), and a record without
 * calls counts no stall, since nothing tells its wait from model time.
 */
export function runSilence(store: WorkflowStore, runId: string): RunSilence {
  let silentMs = 0;
  let stallMs = 0;
  for (const row of store.latestArtifacts(runId, "attempts/%/usage.json")) {
    try {
      const usage = store.readArtifactJson<AttemptUsageRecord & { calls?: CallTiming[] }>(
        runId,
        row,
      );
      const calls = usage.calls ?? [];
      // Before #2414 no call had `silentMs`: an answered call's wait is its `firstByteMs`.
      const waitOf = (call: CallTiming): number =>
        usage.silentMs !== undefined
          ? (call.silentMs ?? 0)
          : call.status === undefined
            ? (call.firstByteMs ?? 0)
            : 0;
      silentMs += usage.silentMs ?? calls.reduce((sum, call) => sum + waitOf(call), 0);
      stallMs +=
        usage.stallMs ?? calls.reduce((sum, call) => sum + callStallMs(call, waitOf(call)), 0);
    } catch {
      // An unreadable record leaves its silence out.
    }
  }
  return { silentMs, stallMs };
}

/** The time a finished run's answered calls waited for their first response (`runSilence`). */
export function runSilentMs(store: WorkflowStore, runId: string): number {
  return runSilence(store, runId).silentMs;
}

/**
 * What the clean pace was decided from: each finished run's clean rate, their waits before a first
 * response (`silentMs`) and the stall part of those that was taken out (`stallMs`). A record
 * before #2424 has no `stallMs`: its rates left the whole wait out.
 */
export interface CleanPaceInputs {
  rates: number[];
  silentMs: number;
  stallMs?: number;
}

/** The clean rates of `runIds` that finished, with their stalled time taken out of them. */
export function cleanRates(
  store: WorkflowStore,
  runIds: readonly string[],
): Required<CleanPaceInputs> {
  const rates: number[] = [];
  let silentMs = 0;
  let stallMs = 0;
  for (const runId of runIds) {
    const run = store.run(runId);
    if (run.status !== "completed") continue;
    const silence = runSilence(store, runId);
    const rate = cleanRunPace({
      status: run.status,
      tokens: run.token_usage,
      activeMs: run.active_ms,
      stallMs: silence.stallMs,
    });
    if (rate === null) continue;
    rates.push(Math.round(rate));
    silentMs += silence.silentMs;
    stallMs += silence.stallMs;
  }
  return { rates, silentMs, stallMs };
}

/**
 * The initiative's clean pace: the median of its clean rates from `CLEAN_PACE_RUNS` finished
 * runs, else the history's (`initiativePace` decides from two runs, silence included); without a
 * history, the clean rates' median as `initiativePace` takes it.
 */
export function cleanInitiativePace(
  rates: readonly number[],
  measured: { msPerToken: number; samples: number } | null,
): ActivePace | null {
  const own = ownPace(rates);
  if (own && rates.length >= CLEAN_PACE_RUNS) return { ...own, basis: "initiative" };
  if (measured && measured.msPerToken > 0)
    return {
      tokensPerMinute: Math.round(60_000 / measured.msPerToken),
      basis: "history",
      runs: measured.samples,
    };
  return own ? { ...own, basis: "initiative" } : null;
}

/** The pace rule of run time sizing (`paceOf`) on clean rates, from `CLEAN_PACE_RUNS` of them. */
export function cleanSizingPace(
  history: { tokensPerMinute: number; basis: "history" | "default"; runs: number },
  rates: readonly number[],
): { tokensPerMinute: number; basis: PaceBasis; runs: number } {
  return rates.length >= CLEAN_PACE_RUNS ? paceOf(history, rates) : history;
}

/** A sizing report's active-time cap at the clean pace, recorded beside the deciding one. */
export interface CleanSizingShadow extends CleanPaceInputs {
  tokensPerMinute: number;
  basis: PaceBasis;
  runs: number;
  after: number;
}

/**
 * The active-time cap a sizing report would set at the clean pace, from what it recorded; null
 * for a report without an active time or a history pace (as `replayActiveTimes` skips them).
 */
export function cleanSizingShadow(
  report: Partial<SizingReport>,
  inputs: CleanPaceInputs,
): CleanSizingShadow | null {
  const time = report.activeTime;
  if (
    !time ||
    typeof report.runTokens !== "number" ||
    typeof report.budgetAfter !== "number" ||
    report.maxRunTokens === undefined
  )
    return null;
  const history =
    time.history ??
    (time.basis === "initiative"
      ? null
      : { tokensPerMinute: time.tokensPerMinute, basis: time.basis, runs: time.runs });
  if (!history) return null;
  const chosen = cleanSizingPace(history, inputs.rates);
  const { after } = activeTimeLimit({
    neededTokens: Math.min(report.runTokens + (report.repairReserve ?? 0), report.budgetAfter),
    tokensPerMinute: chosen.tokensPerMinute,
    maxActiveMs: time.before,
    maxRunTokens: report.maxRunTokens,
  });
  return {
    tokensPerMinute: chosen.tokensPerMinute,
    basis: chosen.basis,
    runs: chosen.runs,
    ...inputs,
    after,
  };
}

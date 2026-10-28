import type { CallTiming } from "../llm/provider-health.js";
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
// provider was silent before it answered (`silentMs`), from `CLEAN_PACE_RUNS` finished runs of the
// initiative, else the history's. R76 hintsieve's notice asked for 4.0x the time its initiative
// used, from a median of two finished runs, one with a stalled call. The pace that decides (time
// notice, forecast, run time sizing) is unchanged; the clean one is recorded beside it, so the
// replay and the next round compare them (`replayActiveTimes`).

/** Finished runs of its own an initiative needs before its clean pace replaces the history's. */
export const CLEAN_PACE_RUNS = 4;

/** A finished run's tokens per active minute without its silent time, or null (`runPace`). */
export function cleanRunPace(run: {
  status: string;
  tokens: number;
  activeMs: number;
  silentMs: number;
}): number | null {
  return run.status === "completed"
    ? runPace(run.tokens, Math.max(0, run.activeMs - run.silentMs))
    : null;
}

/**
 * The time a finished run's answered calls waited for their first response: its attempts' usage
 * records' `silentMs`; a record before #2414 sums its calls' `firstByteMs` (the store keeps
 * each record's parse).
 */
export function runSilentMs(store: WorkflowStore, runId: string): number {
  let silent = 0;
  for (const row of store.latestArtifacts(runId, "attempts/%/usage.json")) {
    try {
      const usage = store.readArtifactJson<AttemptUsageRecord & { calls?: CallTiming[] }>(
        runId,
        row,
      );
      silent +=
        usage.silentMs ??
        (usage.calls ?? []).reduce(
          (sum, call) => sum + (call.status === undefined ? (call.firstByteMs ?? 0) : 0),
          0,
        );
    } catch {
      // An unreadable record leaves its silence out.
    }
  }
  return silent;
}

/** What the clean pace was decided from: each finished run's clean rate and the silence taken out. */
export interface CleanPaceInputs {
  rates: number[];
  silentMs: number;
}

/** The clean rates of `runIds` that finished, with the silent time taken out of them. */
export function cleanRates(store: WorkflowStore, runIds: readonly string[]): CleanPaceInputs {
  const rates: number[] = [];
  let silentMs = 0;
  for (const runId of runIds) {
    const run = store.run(runId);
    if (run.status !== "completed") continue;
    const silent = runSilentMs(store, runId);
    const rate = cleanRunPace({
      status: run.status,
      tokens: run.token_usage,
      activeMs: run.active_ms,
      silentMs: silent,
    });
    if (rate === null) continue;
    rates.push(Math.round(rate));
    silentMs += silent;
  }
  return { rates, silentMs };
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

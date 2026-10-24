import type { FeatureRunSample } from "./estimate.js";

/**
 * The wall-time forecast of a split (#1557). The estimate gives tokens and tasks; the split
 * approval also needs minutes, and two of them: the summed active time of the feature runs, which
 * the shared `--budget-time-ms` limits, and the wall time, which is shorter when features run side
 * by side. Bench round 48 (recmill, 2 runs at once) used 282 minutes of active time in about 168
 * of wall time; round 55 (routeshadow) took 66 minutes of wall where its feature runs summed to 88.
 * Each feature's minutes are its tokens still to use times the active milliseconds per token of
 * finished feature runs; the wall time replays those minutes through the plan's dependencies on
 * the run slots, longest remaining chain first, as the scheduler starts ready features (#1535).
 */

/** Finished feature runs with active time needed before the estimate gives minutes. */
export const MIN_DURATION_SAMPLES = 2;

/** A feature to schedule: its minutes still to run and the features it waits for. */
export interface ScheduledFeature {
  id: string;
  minutes: number;
  dependsOn: readonly string[];
}

export interface DurationForecast {
  /** Median active milliseconds per token of the finished feature runs measured. */
  msPerToken: number;
  /** The finished feature runs `msPerToken` is measured on. */
  samples: number;
  /** The summed active time still to run, in minutes: what `--budget-time-ms` limits. */
  activeMinutes: number;
  /** The wall time with `slots` feature runs at once, in minutes. */
  wallMinutes: number;
  slots: number;
  /** The wall time with as many runs at once as the plan's widest group, when that is more than `slots`. */
  widest: { slots: number; wallMinutes: number } | null;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[half] ?? 0)
    : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
};

/**
 * Active milliseconds per token over finished feature runs with both measured: of the workflow's
 * runs when there are `MIN_DURATION_SAMPLES` of them, else of all; null with fewer.
 */
export function msPerToken(
  samples: readonly FeatureRunSample[],
  workflowId?: string,
): { rate: number; samples: number } | null {
  const timed = samples.filter((s) => (s.activeMs ?? 0) > 0 && s.tokens > 0);
  const own = timed.filter((s) => s.workflowId === workflowId);
  const pool = own.length >= MIN_DURATION_SAMPLES ? own : timed;
  if (pool.length < MIN_DURATION_SAMPLES) return null;
  return { rate: median(pool.map((s) => (s.activeMs ?? 0) / s.tokens)), samples: pool.length };
}

/**
 * The minutes from the first feature start to the last finish with `slots` runs at once: a ready
 * feature (its dependencies finished) starts as soon as a slot is free, the one with the longest
 * remaining chain of minutes first. A dependency outside `features` counts as finished.
 */
export function scheduledMinutes(features: readonly ScheduledFeature[], slots: number): number {
  const byId = new Map(features.map((f) => [f.id, f] as const));
  const dependents = new Map<string, string[]>();
  for (const f of features)
    for (const d of f.dependsOn)
      if (byId.has(d)) dependents.set(d, [...(dependents.get(d) ?? []), f.id]);
  const chain = new Map<string, number>();
  const remaining = (id: string, seen: Set<string>): number => {
    const known = chain.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    const next = new Set(seen).add(id);
    const after = Math.max(0, ...(dependents.get(id) ?? []).map((d) => remaining(d, next)));
    const value = (byId.get(id)?.minutes ?? 0) + after;
    chain.set(id, value);
    return value;
  };
  const done = new Set<string>();
  const started = new Set<string>();
  let running: { id: string; end: number }[] = [];
  let now = 0;
  while (done.size < features.length) {
    const ready = features
      .filter((f) => !started.has(f.id) && f.dependsOn.every((d) => !byId.has(d) || done.has(d)))
      .sort((a, b) => remaining(b.id, new Set()) - remaining(a.id, new Set()));
    for (const f of ready.slice(0, Math.max(1, slots) - running.length)) {
      started.add(f.id);
      running.push({ id: f.id, end: now + f.minutes });
    }
    // A dependency cycle leaves nothing to start: the rest cannot be scheduled.
    if (!running.length) break;
    now = Math.min(...running.map((r) => r.end));
    for (const r of running) if (r.end <= now) done.add(r.id);
    running = running.filter((r) => r.end > now);
  }
  return now;
}

/** "about 95 min" for the estimate's text. */
export const minutesText = (minutes: number): string => `about ${Math.round(minutes)} min`;

/**
 * The wall time in one phrase: the summed active time the budget limits and the wall time on the
 * run slots, with the plan's widest group when it is wider.
 */
export function durationText(duration: DurationForecast): string {
  const widest = duration.widest
    ? `, ${minutesText(duration.widest.wallMinutes)} with ${duration.widest.slots}, the plan's widest group`
    : "";
  return `${minutesText(duration.wallMinutes)} of wall time with ${duration.slots} at once${widest} (${minutesText(duration.activeMinutes)} of summed active time, which the shared time budget limits)`;
}

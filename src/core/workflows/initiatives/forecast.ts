import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { PastRun } from "../estimate.js";
import { forecastSamples } from "../forecast-price.js";
import { WorkflowStore } from "../store.js";
import type { AttemptUsageRow } from "../usage.js";

const sharedPrices = new Map<string, { stamp: string; samples: AttemptUsageRow[] }>();

/** Finished stage usage from the same shared stores that supply the initiative's token ranges. */
function sharedPriceSamples(path: string, history: PastRun[]): AttemptUsageRow[] {
  const parent = dirname(path);
  if (basename(path) !== "workflows.sqlite" || basename(parent) !== ".baked") return [];
  const runs = history.filter((r) => r.source === "shared" && r.status === "completed");
  const stamp = [
    ...[path, `${path}-wal`].map((file) => {
      try {
        return statSync(file).mtimeMs;
      } catch {
        return 0;
      }
    }),
    ...runs.map((r) => r.runId),
  ].join("/");
  const cached = sharedPrices.get(path);
  if (cached?.stamp === stamp) return cached.samples;
  let store: WorkflowStore | null = null;
  let samples: AttemptUsageRow[] = [];
  try {
    if (existsSync(path)) {
      store = new WorkflowStore(dirname(parent), true);
      const ids = new Set(store.history().map((r) => r.runId));
      samples = forecastSamples(
        store,
        runs.filter((r) => ids.has(r.runId)).map((r) => r.runId),
      );
    }
  } catch {
    // Like token history, a missing or incompatible shared store supplies no samples.
    samples = [];
  } finally {
    store?.close();
  }
  sharedPrices.set(path, { stamp, samples });
  return samples;
}

/**
 * Price central feature estimates from measured stage usage before falling back to the default
 * mix. Current initiative samples take precedence for each stage and model; historical samples
 * fill unmeasured stages, including tasks a host-written skeleton did not run. No margin or
 * budget allocation belongs in a token's price.
 */
export function initiativePriceSamples(
  store: WorkflowStore,
  runIds: string[],
  history: PastRun[],
  paths: string[],
): AttemptUsageRow[] {
  const current = forecastSamples(store, runIds);
  const own = new Set(runIds);
  const past = [
    ...forecastSamples(
      store,
      history
        .filter((r) => r.source !== "shared" && r.status === "completed" && !own.has(r.runId))
        .map((r) => r.runId),
    ),
    ...paths.flatMap((path) => sharedPriceSamples(path, history)),
  ];
  const measured = new Set(
    current
      .filter((a) => a.status !== "running" && a.costUsd !== null && (a.usedTokens ?? 0) > 0)
      .map((a) => JSON.stringify([a.stage, a.model])),
  );
  const seen = new Set(current.map((a) => a.attemptId));
  return [
    ...current,
    ...past.filter(
      (a) =>
        !measured.has(JSON.stringify([a.stage, a.model])) &&
        !seen.has(a.attemptId) &&
        seen.add(a.attemptId),
    ),
  ];
}

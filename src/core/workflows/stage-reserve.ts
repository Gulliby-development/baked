import { verificationStages } from "./cost-forecast.js";
import { forecastStageCost, runForecastStages } from "./forecast-price.js";
import type { RunPolicy } from "./schemas.js";
import { runPrices } from "./stage-price.js";
import type { WorkflowStore } from "./store.js";

// What a feature run that finished its tasks still has to pay for (#2241). Part of the cap-growth
// hot module (.github/hot-modules.json). R71 xmlvet get-command stopped at its first review call
// with both tasks done: its dollar bound had chased the overrun of its last task by a few cents a
// step and held nothing for the review and convergence that follow, while the initiative was
// inside its cap.

/** Task states that leave nothing of the task to run. */
const DONE_TASKS = new Set(["implemented", "verified", "cancelled", "invalidated"]);
/** Step states that leave nothing of the stage to run. */
const DONE_STEPS = new Set(["completed", "skipped"]);

/** The stages a run still has to run after its last task, with what they are priced at. */
export interface StageReserve {
  /** The stages after the tasks stage not finished yet, in order (review, converge). */
  stages: string[];
  /** Their priced cost, as the cost forecast prices the final review and convergence. */
  usd: number;
  /** What the run spent and its open attempts hold, at the run's prices. */
  spentUsd: number;
  reservedUsd: number;
}

/**
 * The reserve of a run's remaining mandatory stages once every planned task is done, or null
 * while a task is still open (the cost forecast covers that run), before the plan is synced,
 * with nothing left after the tasks, or when a remaining stage has no known price. A stage counts
 * until one of its steps completed, so the review that is running counts whole: the reserve
 * errs toward the stage's full price rather than below it.
 */
export function stageReserve(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
): StageReserve | null {
  const tasks = store.tasks(runId);
  if (!tasks.length || tasks.some((t) => !DONE_TASKS.has(t.status))) return null;
  const done = new Set(
    store
      .steps(runId)
      .filter((s) => DONE_STEPS.has(s.status))
      .map((s) => s.stage_id),
  );
  const remaining = verificationStages(runForecastStages(store, runId, policy)).filter(
    (s) => !done.has(s.id),
  );
  if (!remaining.length) return null;
  const prices = runPrices(store, runId);
  const usd = forecastStageCost(prices.samples, remaining);
  if (usd === null || usd <= 0) return null;
  const { spentUsd, reservedUsd } = store.costUsage(runId, undefined, prices);
  return { stages: remaining.map((s) => s.id), usd, spentUsd, reservedUsd };
}

/** Rounds dollars up to the cent, so a suggested cap always covers the need. */
export const centsUp = (n: number): number => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;

/**
 * The dollar cap that lets a run finish its remaining stages (#2241): what it spent, what its open
 * attempts hold, and the larger of the stage reserve and the call that asked, rounded up to the
 * cent. The cost-ceiling block names it on its `extend` remedy (`suggestedUsd`), and the stage
 * reserve growth grows a feature run's bound to it.
 */
export function stageSuggestedUsd(
  reserve: Pick<StageReserve, "usd" | "spentUsd" | "reservedUsd">,
  requestedUsd: number,
): number {
  return centsUp(reserve.spentUsd + reserve.reservedUsd + Math.max(requestedUsd, reserve.usd));
}

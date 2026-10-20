import { canonical, hashJson } from "../specs/hash.js";
import { growCostCapToForecast } from "./budget.js";
import { costCeilingUsd, costToleranceOf, currentCostCap } from "./cost-tolerance.js";
import { WorkflowFault } from "./errors.js";
import { DEFAULT_STAGE_RANGES } from "./estimate.js";
import { forecastSamples, forecastStageCost, runForecastStages } from "./forecast-price.js";
import { hostGrowth } from "./host-growth.js";
import { PolicySchema, type RunPolicy } from "./schemas.js";
import { type SizingReport, verificationTokens } from "./sizing.js";
import type { WorkflowStore } from "./store.js";

/**
 * Finished priced tasks a forecast needs before it measures how far the plan's price is off, and
 * finished tasks of one kind before that kind's own ratio prices its open tasks (#1648).
 */
const MIN_MEASURED_TASKS = 3;

/**
 * How far a kind's open tasks follow its finished ones: not at all below `MIN_MEASURED_TASKS`,
 * then blended from the plan's price (1) toward the measured ratio until twice that many have
 * finished, as the initiative estimate calibrates (`calibrationRatio`). One test task carrying a
 * shared fixture at 3x does not price every other test task at 3x (#1648, #1595).
 */
export function kindRatio(measured: number, count: number): number {
  if (count < MIN_MEASURED_TASKS) return 1;
  const weight = Math.min(1, (count - MIN_MEASURED_TASKS + 1) / MIN_MEASURED_TASKS);
  return 1 + weight * (measured - 1);
}

/**
 * Where a run with a dollar cap is heading (#1246): what it spent, plus the planned tasks still
 * open at their price times how far the finished tasks of the same kind went over theirs, plus
 * the final review and convergence, in dollars at each remaining stage's routed model price.
 */
export interface CostForecast {
  capUsd: number;
  /** What the forecast is held to: the cap plus its `costTolerance` band (#1263). */
  ceilingUsd: number;
  spentUsd: number;
  projectedUsd: number;
  /** Tokens the finished priced tasks used over their priced midpoints, all kinds together. */
  ratio: number;
  measuredTasks: number;
  openTasks: number;
  /**
   * Tokens still expected: open tasks at their own kind's ratio (`kindRatio`) less what their
   * attempts already used or hold in flight, and verification.
   */
  remainingTokens: number;
}

const FINISHED = new Set(["implemented", "verified"]);

/** The latest plan sizing, or null before the plan is priced. */
function latestSizing(store: WorkflowStore, runId: string): Partial<SizingReport> | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-"))
    .at(-1);
  return latest
    ? (JSON.parse(store.readArtifact(runId, latest.id)) as Partial<SizingReport>)
    : null;
}

/**
 * The run's forecast, or null without a dollar cap, a priced plan, a measured price per token,
 * `MIN_MEASURED_TASKS` finished priced tasks, or a priced task still open.
 */
export function costForecast(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
): CostForecast | null {
  const cap = currentCostCap(store, runId, policy);
  if (cap === null) return null;
  const sized = latestSizing(store, runId)?.tasks ?? [];
  if (!sized.length) return null;
  const status = new Map(store.tasks(runId).map((t) => [t.id, t.status]));
  // Tokens each task's attempts used, over every generation: a rerun after an invalidation is
  // part of what the task cost. `committed` adds what an attempt in flight holds beyond its use,
  // the reservation `costUsage` already counts in dollars.
  const stageOf = new Map(store.steps(runId).map((step) => [step.id, step.stage_id]));
  const used = new Map<string, number>();
  const committed = new Map<string, number>();
  for (const attempt of store.attempts(runId)) {
    const stage = stageOf.get(attempt.step_id) ?? "";
    if (!stage.startsWith("task-")) continue;
    const taskId = stage.slice(5);
    const tokens = attempt.used_tokens ?? 0;
    const held =
      !attempt.usage_complete && attempt.model_id !== null
        ? Math.max(tokens, attempt.reserved_tokens)
        : tokens;
    used.set(taskId, (used.get(taskId) ?? 0) + tokens);
    committed.set(taskId, (committed.get(taskId) ?? 0) + held);
  }
  const mid = (t: (typeof sized)[number]) => (t.estimate.low + t.estimate.high) / 2;
  const measured = sized.filter((t) => FINISHED.has(status.get(t.taskId) ?? "") && mid(t) > 0);
  const open = sized.filter((t) => {
    const s = status.get(t.taskId);
    return s !== undefined && !FINISHED.has(s) && s !== "cancelled";
  });
  if (measured.length < MIN_MEASURED_TASKS || !open.length) return null;
  const ratioOf = (tasks: typeof sized): number => {
    const priced = tasks.reduce((sum, t) => sum + mid(t), 0);
    return priced > 0 ? tasks.reduce((sum, t) => sum + (used.get(t.taskId) ?? 0), 0) / priced : 0;
  };
  const ratio = ratioOf(measured);
  const byKind = new Map<string, number>();
  for (const kind of new Set(measured.map((t) => t.kind))) {
    const finished = measured.filter((t) => t.kind === kind);
    byKind.set(kind, kindRatio(ratioOf(finished), finished.length));
  }
  const stages = runForecastStages(store, runId, policy);
  const tasks = stages.find((s) => s.type === "tasks");
  if (!tasks) return null;
  const costs = open.map((t) => ({
    id: tasks.id,
    models: tasks.models,
    // A priced kind without a finished task keeps its own estimate. Another kind's overrun
    // does not measure it, and must not inflate the forecast or the initiative's held cap.
    // What the task's earlier attempts spent and its attempt in flight holds are already in
    // `spentUsd` and `reservedUsd`: a continuation after a token cap needs only the rest (#1648).
    tokens: Math.max(0, mid(t) * (byKind.get(t.kind) ?? 1) - (committed.get(t.taskId) ?? 0)),
  }));
  const later = stages.slice(stages.indexOf(tasks) + 1).filter((s) => s.models.length);
  const weights = later.map((s) => DEFAULT_STAGE_RANGES[s.id]?.high ?? 60_000);
  const total = weights.reduce((sum, n) => sum + n, 0);
  costs.push(
    ...later.map((s, i) => ({
      id: s.id,
      models: s.models,
      tokens: total > 0 ? (verificationTokens() * (weights[i] ?? 0)) / total : 0,
    })),
  );
  const remainingTokens = Math.round(costs.reduce((sum, s) => sum + s.tokens, 0));
  const { spentUsd, reservedUsd } = store.costUsage(runId);
  const remainingUsd = forecastStageCost(forecastSamples(store, [runId]), costs);
  if (remainingUsd === null) return null;
  return {
    capUsd: cap,
    ceilingUsd: costCeilingUsd(store, runId, policy) ?? cap,
    spentUsd,
    projectedUsd: spentUsd + reservedUsd + remainingUsd,
    ratio,
    measuredTasks: measured.length,
    openTasks: open.length,
    remainingTokens,
  };
}

/**
 * The forecast total the run stopped on at this cap, or null when it has not stopped on one: the
 * run screens name it as what stopped the run. A cap the host grew on its own since that stop
 * (`hostGrowth`) is the same cap: the person already chose to spend on, and the run stopped again
 * after every automatic growth step (#1433).
 */
export function askedForecast(store: WorkflowStore, runId: string, capUsd: number): number | null {
  const artifacts = store.artifacts(runId);
  const stored = PolicySchema.parse(JSON.parse(store.run(runId).policy_json));
  const caps = new Set([
    capUsd,
    ...hostGrowth(artifacts, (a) => store.readArtifact(runId, a.id), hashJson(stored)).caps,
  ]);
  const asked = artifacts
    .filter((a) => a.kind === "cost-forecast")
    .map((a) => JSON.parse(store.readArtifact(runId, a.id)) as Partial<CostForecast>)
    .find((f) => typeof f.capUsd === "number" && caps.has(f.capUsd));
  return typeof asked?.projectedUsd === "number" ? asked.projectedUsd : null;
}

/** Where the forecast at a count of finished priced tasks is kept. */
const progressPath = (measuredTasks: number): string =>
  `forecasts/progress-${String(measuredTasks).padStart(3, "0")}.json`;

/**
 * Keeps the forecast once for each count of finished priced tasks, whether or not it stops the
 * run, so a run that finished under its cap still shows what was projected along the way: bench
 * round 30 had no record of any forecast because only a stop wrote one.
 */
function recordProgress(store: WorkflowStore, runId: string, forecast: CostForecast): void {
  const path = progressPath(forecast.measuredTasks);
  if (store.latestArtifact(runId, path)) return;
  store.artifact(runId, "cost-forecast-progress", path, canonical(forecast));
}

/** The forecasts the run recorded as its tasks finished, oldest first. */
export function forecastProgress(store: WorkflowStore, runId: string): CostForecast[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === "cost-forecast-progress")
    .sort((a, b) => a.logical_path.localeCompare(b.logical_path))
    .map((a) => JSON.parse(store.readArtifact(runId, a.id)) as CostForecast);
}

/** How the message of a forecast stop begins. */
export const FORECAST_STOP = "The run is forecast to cost about";

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Checked before each attempt. When the forecast passes the dollar cap (with its tolerance band,
 * `costTolerance`, when the policy sets one) the run stops on its
 * budget while most of the money is unspent, and the person decides: extend it with a higher cap
 * (`extend --max-cost-usd`) or stop. Spending on to the cap left cfgtrace with tasks unfinished
 * and no review at $8.80 and $11.92 of $12 in two rounds, unfinishable from about $5.60 on. A cap
 * is asked about once: after an extension the forecast is checked against the new cap. A cap the
 * policy lets grow (`sizing.maxRunCostUsd`, an initiative feature's share of the unspent dollars)
 * grows to the forecast instead, when it can reach it; the stop names how far it could grow (#1503).
 */
export function assertForecastFits(store: WorkflowStore, runId: string, policy: RunPolicy): void {
  if (policy.costForecast === "off" || policy.maxCostUsd === null) return;
  const forecast = costForecast(store, runId, policy);
  if (forecast) recordProgress(store, runId, forecast);
  if (!forecast || forecast.projectedUsd <= forecast.ceilingUsd) return;
  if (askedForecast(store, runId, forecast.capUsd) !== null) return;
  const tolerance = costToleranceOf(store, runId, policy);
  if (growCostCapToForecast(store, runId, policy, forecast.projectedUsd, tolerance)) return;
  // An advisory forecast spends on: the dollar checks on spent and reserved money still hold.
  if (policy.costForecast === "advise") return;
  const bound = policy.sizing?.maxRunCostUsd;
  const spare =
    bound !== undefined && bound > forecast.capUsd
      ? ` The initiative can spare up to ${usd(bound)} for this run, which does not cover it.`
      : "";
  const n = store.artifacts(runId).filter((a) => a.kind === "cost-forecast").length;
  store.artifact(runId, "cost-forecast", `forecasts/cost-${n + 1}.json`, canonical(forecast));
  throw new WorkflowFault(
    "BUDGET_EXHAUSTED",
    `${FORECAST_STOP} ${usd(forecast.projectedUsd)}, above its ${forecast.ceilingUsd > forecast.capUsd ? `${usd(forecast.ceilingUsd)} ceiling (the ${usd(forecast.capUsd)} cap and its tolerance)` : `${usd(forecast.capUsd)} cap`}: ${usd(forecast.spentUsd)} spent, ${forecast.measuredTasks} finished tasks used ${forecast.ratio.toFixed(1)} times their price, ${forecast.openTasks} tasks and the final review still to run. Extend the run with a cap of at least ${usd(Math.ceil(forecast.projectedUsd))} to finish it, resume it to spend on to the current cap, or cancel it.${spare}`,
    { reason: "cost-forecast", ...forecast },
  );
}

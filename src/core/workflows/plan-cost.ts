import { findPricing } from "../llm/pricing.js";
import { DEFAULT_MIX, type TokenRange } from "./estimate.js";
import type { SizingReport } from "./sizing.js";
import type { WorkflowStore } from "./store.js";
import { runUsage } from "./usage.js";

/**
 * The dollars a plan approval shows (#1019): what planning cost so far, by model and stage, next
 * to what sizing expects the planned tasks to cost on the model they were priced for. Planning
 * (research, specify, plan, analyze) is spent by the time the plan waits for approval; on claude
 * runs it was most of the run (stmtsplit R18: $5.88 of $9.97), which only a split by model shows.
 */
export interface PlanCost {
  planning: {
    usd: number;
    /** False when some attempt ran on a model without a known price; `usd` leaves it out. */
    complete: boolean;
    /** Most expensive first. */
    models: { model: string; usd: number; stages: string[] }[];
  };
  /** The planned tasks priced from sizing's token range; null without sizing or a price. */
  implementation: { model: string; usd: TokenRange } | null;
}

/** Dollars per token of a model at the estimate's default mix of input, cache reads and output. */
function usdPerToken(model: string): number | null {
  const pricing = findPricing(model)?.pricing;
  if (!pricing) return null;
  return (
    (DEFAULT_MIX.input * pricing.input +
      DEFAULT_MIX.cacheRead * pricing.cacheRead +
      DEFAULT_MIX.output * pricing.output) /
    1e6
  );
}

/** The run's latest plan sizing report, or null before its plan is sized. */
function latestSizing(store: WorkflowStore, runId: string): Partial<SizingReport> | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-"))
    .at(-1);
  return latest
    ? (JSON.parse(store.readArtifact(runId, latest.id)) as Partial<SizingReport>)
    : null;
}

/** The tokens the run's latest plan sizing expects its planned tasks to use; null without one. */
export function plannedTaskTokens(store: WorkflowStore, runId: string): TokenRange | null {
  const tokens = latestSizing(store, runId)?.taskTokens;
  return tokens ? { low: tokens.low, high: tokens.high } : null;
}

/** The run's spend so far by model, and the latest plan sizing priced in dollars. */
export function planCostOf(store: WorkflowStore, runId: string): PlanCost {
  const byModel = new Map<string, { usd: number; stages: Set<string> }>();
  let complete = true;
  for (const attempt of runUsage(store, runId).attempts) {
    if (attempt.model === null) continue;
    if (attempt.costUsd === null) {
      complete = false;
      continue;
    }
    const entry = byModel.get(attempt.model) ?? { usd: 0, stages: new Set<string>() };
    entry.usd += attempt.costUsd;
    entry.stages.add(attempt.stage);
    byModel.set(attempt.model, entry);
  }
  const models = [...byModel.entries()]
    .map(([model, entry]) => ({ model, usd: entry.usd, stages: [...entry.stages] }))
    .sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
  const report = latestSizing(store, runId);
  const rate = report?.model ? usdPerToken(report.model) : null;
  return {
    planning: { usd: models.reduce((sum, m) => sum + m.usd, 0), complete, models },
    implementation:
      report?.model && report.taskTokens && rate !== null
        ? {
            model: report.model,
            usd: { low: report.taskTokens.low * rate, high: report.taskTokens.high * rate },
          }
        : null,
  };
}

const usd = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

/** The approval's line: `Planning so far about $X (model $Y, ...); the planned tasks about $A–$B on M`. */
export function planCostText(cost: PlanCost): string {
  const models = cost.planning.models.map((m) => `${m.model} ${usd(m.usd)}`).join(", ");
  const planning = `Planning so far about ${usd(cost.planning.usd)}${cost.planning.complete ? "" : " (partial: a model has no price)"}${models ? ` (${models})` : ""}`;
  const tasks = cost.implementation
    ? `; the planned tasks about ${usd(cost.implementation.usd.low)}–${usd(cost.implementation.usd.high)} on ${cost.implementation.model}`
    : "";
  return `${planning}${tasks}`;
}

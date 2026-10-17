import { findPricing } from "../llm/pricing.js";
import { DEFAULT_MIX, type TokenMix, type TokenRange } from "./estimate.js";
import { type SizingReport, taskTotal } from "./sizing.js";
import type { WorkflowStore } from "./store.js";
import { type AttemptUsageRow, runUsage } from "./usage.js";

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
  /**
   * The planned tasks priced from sizing's token range; null without sizing or a price. `rate`
   * says what priced a token: `run`, the dollars per token this run's attempts on the model paid
   * so far; `mix`, the model's prices at the mix of uncached input, cache reads and output this
   * run's attempts measured; `default`, the prices at the estimate's default mix. Absent on
   * approvals recorded before #1386, which used the default mix.
   */
  implementation: { model: string; usd: TokenRange; rate?: PlanCostRate } | null;
}

export type PlanCostRate = "run" | "mix" | "default";

/** Dollars per token of a model at a mix of input, cache reads and output. */
function usdPerToken(model: string, mix: TokenMix): number | null {
  const pricing = findPricing(model)?.pricing;
  if (!pricing) return null;
  return (
    (mix.input * pricing.input + mix.cacheRead * pricing.cacheRead + mix.output * pricing.output) /
    1e6
  );
}

/**
 * What a token of the planned tasks costs on `model`. Bench round 38 (stoptable): codex attempts
 * were 70 to 80 percent cache reads and cost $0.8 to $1.2 per million tokens, and the default mix
 * priced the four plans at $19.2 to $36.1 for features that cost $11.82 in all (#1386). The run's
 * own attempts on the model measure it best; otherwise their token mix, priced for the model.
 */
function rateOf(
  attempts: AttemptUsageRow[],
  model: string,
): { usd: number; rate: PlanCostRate } | null {
  const paid = attempts.filter(
    (a) => a.model === model && a.costUsd !== null && (a.usedTokens ?? 0) > 0,
  );
  const tokens = paid.reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
  if (tokens > 0 && findPricing(model))
    return { usd: paid.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) / tokens, rate: "run" };
  const measured = attempts.filter(
    (a) => a.model !== null && a.inputTokens !== null && a.outputTokens !== null,
  );
  const input = measured.reduce((sum, a) => sum + (a.inputTokens ?? 0), 0);
  const cacheRead = measured.reduce(
    (sum, a) => sum + Math.min(a.cacheReadTokens ?? 0, a.inputTokens ?? 0),
    0,
  );
  const output = measured.reduce((sum, a) => sum + (a.outputTokens ?? 0), 0);
  const total = input + output;
  const mix: TokenMix | null =
    total > 0
      ? { input: (input - cacheRead) / total, cacheRead: cacheRead / total, output: output / total }
      : null;
  const usd = usdPerToken(model, mix ?? DEFAULT_MIX);
  return usd === null ? null : { usd, rate: mix ? "mix" : "default" };
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

/**
 * The tokens the run's latest plan sizing expects the whole run to use; null without one. That is
 * what the run spent before its plan was sized, its tasks, and review and convergence (the parts
 * of `runTokens` beyond the tasks' price), plus the repair reserve at the high end. The tasks
 * alone left a run that had spent 2M on research, spec and plan forecast at 3M-5M for 3M-5M of
 * tasks (#1418). A report without `runTokens` gives its tasks alone.
 */
export function plannedRunTokens(store: WorkflowStore, runId: string): TokenRange | null {
  const report = latestSizing(store, runId);
  const tokens = report?.taskTokens;
  if (!tokens) return null;
  const around =
    report.runTokens !== undefined && report.tasks
      ? Math.max(0, report.runTokens - taskTotal(report.tasks.map((t) => t.estimate)).price)
      : 0;
  return {
    low: around + tokens.low,
    high: around + tokens.high + (report.repairReserve ?? 0),
  };
}

/** The run's spend so far by model, and the latest plan sizing priced in dollars. */
export function planCostOf(store: WorkflowStore, runId: string): PlanCost {
  const byModel = new Map<string, { usd: number; stages: Set<string> }>();
  let complete = true;
  const usage = runUsage(store, runId);
  for (const attempt of usage.attempts) {
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
  const priced = report?.model ? rateOf(usage.attempts, report.model) : null;
  return {
    planning: { usd: models.reduce((sum, m) => sum + m.usd, 0), complete, models },
    implementation:
      report?.model && report.taskTokens && priced
        ? {
            model: report.model,
            usd: {
              low: report.taskTokens.low * priced.usd,
              high: report.taskTokens.high * priced.usd,
            },
            rate: priced.rate,
          }
        : null,
  };
}

const RATE_TEXT: Record<PlanCostRate, string> = {
  run: " at this run's dollars per token so far",
  mix: " at this run's mix of cached and uncached tokens",
  default: "",
};

const usd = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

/** The approval's line: `Planning so far about $X (model $Y, ...); the planned tasks about $A–$B on M`. */
export function planCostText(cost: PlanCost): string {
  const models = cost.planning.models.map((m) => `${m.model} ${usd(m.usd)}`).join(", ");
  const planning = `Planning so far about ${usd(cost.planning.usd)}${cost.planning.complete ? "" : " (partial: a model has no price)"}${models ? ` (${models})` : ""}`;
  const tasks = cost.implementation
    ? `; the planned tasks about ${usd(cost.implementation.usd.low)}–${usd(cost.implementation.usd.high)} on ${cost.implementation.model}${RATE_TEXT[cost.implementation.rate ?? "default"]}`
    : "";
  return `${planning}${tasks}`;
}

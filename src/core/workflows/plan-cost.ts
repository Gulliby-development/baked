import { estimateHistory, historyStorePaths, type TokenRange } from "./estimate.js";
import { initiativePriceSamples } from "./initiatives/forecast.js";
import type { RunPolicy } from "./schemas.js";
import { type SizingReport, taskTotal } from "./sizing.js";
import { forecastRate, runPrices } from "./stage-price.js";
import type { WorkflowStore } from "./store.js";
import { type AttemptUsageRow, runUsage } from "./usage.js";

/** The stage task attempts are priced under (`costStageOf`). */
const IMPLEMENT = "implement";

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
   * so far on tasks; `history`, what finished task attempts on the model paid in this project's
   * earlier runs and `sizing.historyStores` (#1792); `mix`, the model's prices at the mix of
   * uncached input, cache reads and output this run's task attempts measured; `default`, the prices at a task loop's typical mix. Absent
   * on approvals recorded before #1386, which used the estimate's default mix. `otherModels`: the
   * sizing took some task kinds' token rates from other models' tasks, since the sized model had
   * too few of its own, so the range may be far off (#1712).
   */
  implementation: {
    model: string;
    usd: TokenRange;
    rate?: PlanCostRate;
    otherModels?: boolean;
  } | null;
}

export type PlanCostRate = "run" | "history" | "mix" | "default";

/**
 * What a token of the planned tasks costs on `model`, priced like the cost forecast prices the
 * task stage (`forecastRate`): what this run's task attempts on the model paid (`run`), else what
 * finished task attempts on the model paid in the history (`history`), else the model's prices at
 * the mix this run's task attempts of any model measured (`mix`), else at a task loop's typical
 * mix (`default`, `TASK_MIX`). Bench round 38 (stoptable) priced codex plans at the estimate's
 * default mix, about twice what the tasks paid (#1386). Round 51 (commitbump) took the mix of
 * one-step Opus planning calls, which never read the cache, and priced Sonnet tasks that read 91
 * percent of their input from it at $16 for a run that cost $2.72 (#1712): planning attempts never
 * price the tasks. A plan waits for approval before its first task runs, so only the history has
 * paid for tasks: codex task attempts of rounds 45 to 52 paid $0.81 per million tokens, 85 percent
 * of them cache reads and 2 percent output, where the typical mix said $1.33, and replayed with
 * the round before as history 65 of 109 approvals priced the tasks above what they cost, against
 * 36 at the history's rate (#1792).
 */
function rateOf(
  samples: AttemptUsageRow[],
  history: AttemptUsageRow[],
  model: string,
): { usd: number; rate: PlanCostRate } | null {
  const paid = (rows: AttemptUsageRow[]) =>
    rows.some(
      (a) =>
        a.stage === IMPLEMENT &&
        a.status !== "running" &&
        a.model === model &&
        a.costUsd !== null &&
        (a.usedTokens ?? 0) > 0,
    );
  if (!paid(samples) && paid(history)) {
    const usd = forecastRate(
      history.filter((a) => a.stage === IMPLEMENT && a.model === model),
      IMPLEMENT,
      model,
    );
    if (usd !== null) return { usd, rate: "history" };
  }
  const usd = forecastRate(samples, IMPLEMENT, model);
  if (usd === null) return null;
  const tasks = samples.filter((a) => a.stage === IMPLEMENT && a.status !== "running");
  const rate: PlanCostRate = paid(samples)
    ? "run"
    : tasks.some((a) => a.costUsd !== null && a.inputTokens !== null && a.outputTokens !== null)
      ? "mix"
      : "default";
  return { usd, rate };
}

/**
 * Finished attempts of this project's earlier runs and of the stores `sizing.historyStores` names,
 * the same history plan sizing reads its token rates from; empty without a policy.
 */
function historySamples(
  store: WorkflowStore,
  runId: string,
  policy: Pick<RunPolicy, "sizing"> | undefined,
): AttemptUsageRow[] {
  if (!policy) return [];
  return initiativePriceSamples(
    store,
    [],
    estimateHistory(store, store.workspace, policy).filter((r) => r.runId !== runId),
    historyStorePaths(store.workspace, policy),
  );
}

/**
 * True when the sizing priced some task kind from other models' tasks because the sized model had
 * too few of its own: its token range comes from another provider's history (#1712).
 */
function borrowedHistory(report: Partial<SizingReport>): boolean {
  if (!report.model || !report.rates) return false;
  return Object.values(report.rates).some((kind) =>
    Object.values(kind).some((rate) => rate.basis !== "defaults" && rate.model !== report.model),
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

/**
 * The tokens the run's latest plan sizing expects the whole run to use; null without one. That is
 * what the run spent before its plan was sized, its tasks, and review and convergence (the parts
 * of `runTokens` beyond the tasks' price), plus the repair reserve at the high end. The tasks
 * alone left a run that had spent 2M on research, spec and plan forecast at 3M-5M for 3M-5M of
 * tasks (#1418). A report without `runTokens` gives its tasks alone. `expected` is the plan's
 * expected tasks with the same run around them, when the report has it.
 */
export function plannedRunTokens(
  store: WorkflowStore,
  runId: string,
): (TokenRange & { expected?: number }) | null {
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
    // The plan's own expected tasks, with the same run around them (#2043); older reports lack it.
    ...(typeof tokens.expected === "number" ? { expected: around + tokens.expected } : {}),
  };
}

/**
 * The run's spend so far by model, and the latest plan sizing priced in dollars. With the run's
 * policy, the tasks are priced from the history before this run has paid for one.
 */
export function planCostOf(
  store: WorkflowStore,
  runId: string,
  policy?: Pick<RunPolicy, "sizing">,
): PlanCost {
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
  const priced = report?.model
    ? rateOf(runPrices(store, runId).samples, historySamples(store, runId, policy), report.model)
    : null;
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
            ...(borrowedHistory(report) ? { otherModels: true } : {}),
          }
        : null,
  };
}

const RATE_TEXT: Record<PlanCostRate, string> = {
  run: " at this run's dollars per token so far",
  history: " at what earlier runs' tasks on it paid per token",
  mix: " at this run's mix of cached and uncached tokens",
  default: "",
};

const OTHER_MODELS_TEXT =
  " (token range from other models' tasks: this model has too few of its own, so it may be far off)";

const usd = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

/**
 * A warning for a plan approval when the plan's priced high end (planning so far and the planned
 * tasks) passes the run's dollar ceiling: its cap, or what the cap may grow to
 * (`sizing.maxRunCostUsd`), with its tolerance. Null when it fits or nothing is priced. Bench round
 * 42 (fecsmith front): a plan priced $6.75-$11.29 against an $8 cap was approved without a word,
 * and the forecast stopped the run after five tasks (#1503).
 */
export function planCostWarning(
  cost: PlanCost,
  capUsd: number | null,
  tolerance: number,
  growToUsd?: number,
): string | null {
  if (capUsd === null || !cost.implementation) return null;
  const high = cost.planning.usd + cost.implementation.usd.high;
  const limit = Math.max(capUsd, growToUsd ?? 0);
  if (high <= limit * (1 + tolerance)) return null;
  const grows = limit > capUsd ? ` and the ${usd(limit)} it may grow to` : "";
  const band = tolerance > 0 ? " with its tolerance" : "";
  return `The plan is priced up to ${usd(high)} with planning, above the run's ${usd(capUsd)} cap${grows}${band}: the cost forecast may stop the run before it finishes. Approve a smaller plan, or extend the run's cap.`;
}

/** The approval's line: `Planning so far about $X (model $Y, ...); the planned tasks about $A–$B on M`. */
export function planCostText(cost: PlanCost): string {
  const models = cost.planning.models.map((m) => `${m.model} ${usd(m.usd)}`).join(", ");
  const planning = `Planning so far about ${usd(cost.planning.usd)}${cost.planning.complete ? "" : " (partial: a model has no price)"}${models ? ` (${models})` : ""}`;
  const tasks = cost.implementation
    ? `; the planned tasks about ${usd(cost.implementation.usd.low)}–${usd(cost.implementation.usd.high)} on ${cost.implementation.model}${RATE_TEXT[cost.implementation.rate ?? "default"]}${cost.implementation.otherModels ? OTHER_MODELS_TEXT : ""}`
    : "";
  return `${planning}${tasks}`;
}

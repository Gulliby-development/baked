import { ROUTING_ARTIFACT, type RoutingRecord } from "../llm/model-routing.js";
import type { PlannedStage } from "./estimate.js";
import { plannedStages } from "./pre-run.js";
import type { RunPolicy } from "./schemas.js";
import { forecastRate, type PriceSample } from "./stage-price.js";
import type { WorkflowStore } from "./store.js";
import type { AttemptUsageRow } from "./usage.js";
import type { Gate } from "./v2/definition.js";
import { parseRunDefinition } from "./v2/runtime.js";

export { forecastRate, forecastSamples } from "./stage-price.js";

/** Frozen definition and current routing, including reroutes, for an existing run. */
export function runForecastStages(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
): PlannedStage[] {
  const parsed = parseRunDefinition(store.run(runId).definition_json);
  const routing = store.latestArtifact(runId, ROUTING_ARTIFACT);
  if (!routing) return [];
  const gates = store.latestArtifact(runId, "definition/gates.json");
  return plannedStages({
    loaded: { ...parsed, id: parsed.definition.id, path: null },
    policy,
    routing: JSON.parse(store.readArtifact(runId, routing.id)) as RoutingRecord,
    gates: gates ? (JSON.parse(store.readArtifact(runId, gates.id)) as Gate[]) : [],
  });
}

/**
 * Sum stage costs. Unknown future prices leave the forecast unavailable rather than understated.
 * `perProvider` prices each model at its own provider family's mix (`forecastRate`, #2963).
 */
export function forecastStageCost(
  samples: AttemptUsageRow[],
  stages: { id: string; models: string[]; tokens: number }[],
  perProvider = false,
): number | null {
  let usd = 0;
  for (const stage of stages) {
    if (stage.tokens <= 0) continue;
    if (!stage.models.length) return null;
    for (const model of stage.models) {
      const rate = forecastRate(samples, stage.id, model, perProvider);
      if (rate === null) return null;
      usd += (stage.tokens / stage.models.length) * rate;
    }
  }
  return usd;
}

/**
 * `routedStageShare` (#2963): `off` prices a feature at the stage weights it used before,
 * `shadow` (the default) keeps that price and records the one at `routedStageWeights` beside it,
 * `on` uses that one.
 */
export type RoutedStageShareMode = "off" | "shadow" | "on";
export const DEFAULT_ROUTED_STAGE_SHARE: RoutedStageShareMode = "shadow";

/**
 * The planned stages weighted by the tokens a run spends on each of them on its routed models
 * (#2963). A stage some run of `samples` ran on one of its models weighs the mean of what those
 * runs spent there, times `scale` (a feature's size factor); a stage no such run measured keeps
 * its weight. A feature's price split its tokens by the history's stage ranges, measured on runs
 * of any route: R103's history was Codex runs whose task loops took 70 to 90 percent of the
 * tokens, while its Claude runs, with planning, review and convergence on an Opus-tier route at
 * $4 to $11 per Mtok and tasks on a Sonnet-tier one at about $1, spent half to two thirds of
 * theirs outside the tasks. Three quarters of the price sat on the cheap task stage, and R103's
 * first features were priced at $2.39 per Mtok and paid $3.32 to $3.90. Null when no stage with
 * tokens is measured. Unfinished attempts and attempts without tokens are left out.
 */
export function routedStageWeights(
  samples: readonly PriceSample[],
  stages: { id: string; models: string[]; tokens: number }[],
  scale: (stage: string) => number = () => 1,
): { id: string; models: string[]; tokens: number }[] | null {
  let measured = false;
  const weighted = stages.map((stage) => {
    if (stage.tokens <= 0) return stage;
    const models = new Set(stage.models);
    const byRun = new Map<string, number>();
    for (const a of samples) {
      if (a.stage !== stage.id || a.model === null || !models.has(a.model)) continue;
      if (a.status === "running" || !a.usedTokens) continue;
      const run = a.runId ?? "";
      byRun.set(run, (byRun.get(run) ?? 0) + a.usedTokens);
    }
    if (!byRun.size) return stage;
    measured = true;
    const total = [...byRun.values()].reduce((sum, n) => sum + n, 0);
    return { ...stage, tokens: (total / byRun.size) * scale(stage.id) };
  });
  return measured ? weighted : null;
}

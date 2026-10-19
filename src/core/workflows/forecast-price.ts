import { ROUTING_ARTIFACT, type RoutingRecord } from "../llm/model-routing.js";
import type { PlannedStage } from "./estimate.js";
import { plannedStages } from "./pre-run.js";
import type { RunPolicy } from "./schemas.js";
import { forecastRate } from "./stage-price.js";
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

/** Sum stage costs. Unknown future prices leave the forecast unavailable rather than understated. */
export function forecastStageCost(
  samples: AttemptUsageRow[],
  stages: { id: string; models: string[]; tokens: number }[],
): number | null {
  let usd = 0;
  for (const stage of stages) {
    if (stage.tokens <= 0) continue;
    if (!stage.models.length) return null;
    for (const model of stage.models) {
      const rate = forecastRate(samples, stage.id, model);
      if (rate === null) return null;
      usd += (stage.tokens / stage.models.length) * rate;
    }
  }
  return usd;
}

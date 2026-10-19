import { ROUTING_ARTIFACT, type RoutingRecord } from "../llm/model-routing.js";
import { findPricing } from "../llm/pricing.js";
import { DEFAULT_MIX, type PlannedStage } from "./estimate.js";
import { plannedStages } from "./pre-run.js";
import type { RunPolicy } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import { type AttemptUsageRow, runUsage } from "./usage.js";
import type { Gate } from "./v2/definition.js";
import { parseRunDefinition } from "./v2/runtime.js";

/** Child review and task calls inherit the workflow stage that owns them. */
export function forecastSamples(store: WorkflowStore, runIds: string[]): AttemptUsageRow[] {
  return runIds.flatMap((runId) => {
    const steps = new Map(store.steps(runId).map((s) => [s.id, s]));
    const stages = new Map(
      store.attempts(runId).map((a) => {
        let step = steps.get(a.step_id);
        while (step?.parent_step_id && steps.has(step.parent_step_id))
          step = steps.get(step.parent_step_id);
        const stage = step?.stage_id ?? "";
        return [a.id, stage.startsWith("task-") ? "implement" : stage];
      }),
    );
    return runUsage(store, runId).attempts.map((a) => ({
      ...a,
      stage: stages.get(a.attemptId) ?? a.stage,
    }));
  });
}

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
 * Price a future stage on its model. Matching paid samples preserve cache discounts and writes.
 * A new model uses the same stage's measured token mix at its own prices. Without stage samples,
 * use the default mix rather than another stage's price. No estimate margin belongs in this rate.
 */
export function forecastRate(
  samples: AttemptUsageRow[],
  stage: string,
  model: string,
): number | null {
  const priced = samples.filter(
    (a) => a.status !== "running" && a.costUsd !== null && (a.usedTokens ?? 0) > 0,
  );
  const sameStage = priced.filter((a) => a.stage === stage);
  const paid = sameStage.filter((a) => a.model === model);
  const tokens = paid.reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
  if (tokens > 0) return paid.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) / tokens;
  const pricing = findPricing(model)?.pricing;
  if (!pricing) return null;
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  for (const a of sameStage) {
    if (a.inputTokens === null || a.outputTokens === null) continue;
    input += a.inputTokens;
    output += a.outputTokens;
    const cached = Math.min(a.inputTokens, a.cacheReadTokens ?? 0);
    read += cached;
    write += Math.min(a.inputTokens - cached, a.cacheWriteTokens ?? 0);
  }
  if (input + output > 0)
    return (
      ((input - read - write) * pricing.input +
        read * pricing.cacheRead +
        write * pricing.cacheWrite +
        output * pricing.output) /
      (input + output) /
      1e6
    );
  return (
    (DEFAULT_MIX.input * pricing.input +
      DEFAULT_MIX.cacheRead * pricing.cacheRead +
      DEFAULT_MIX.output * pricing.output) /
    1e6
  );
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

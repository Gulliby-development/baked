import { findPricing } from "../llm/pricing.js";
import type { PastRun } from "./estimate.js";
import {
  estimatePreRun,
  type ModelPrice,
  type PlannedStage,
  type PreRunEstimate,
} from "./estimate.js";
import type { PreparedStart } from "./start.js";
import { asV2 } from "./v2/definitions.js";
import { reviewersOf } from "./v2/runtime.js";

/** Where a model is used in a run, for the doctor's per-model lines. */
export interface ModelUse {
  model: string;
  /** Stage IDs and profile IDs that run on this model. */
  usedBy: string[];
}

function profileModel(prepared: PreparedStart, profileId: string): string | null {
  return prepared.routing.profiles[profileId]?.model ?? null;
}

/** Review agents of a stage: the bound AI review gates of a v2 definition, else the policy's. */
function reviewProfiles(
  prepared: PreparedStart,
  stage: Parameters<typeof reviewersOf>[0],
): string[] {
  if (prepared.loaded.schemaVersion === 2) {
    try {
      return reviewersOf(stage, prepared.gates).flatMap((r) =>
        r.skepticProfileId ? [r.profileId, r.skepticProfileId] : [r.profileId],
      );
    } catch {
      // A v1 definition read through the upgrade binds built-in gates the run resolves later.
    }
  }
  const { correctness, security, language } = prepared.policy.reviewProfiles;
  return [correctness, security, ...(language ? [language] : []), prepared.policy.skepticProfileId];
}

/** The definition's stages with the models their agents use, as the run would resolve them. */
export function plannedStages(prepared: PreparedStart): PlannedStage[] {
  const definition = asV2(prepared.loaded, prepared.policy);
  return definition.stages.map((stage) => {
    const routed = prepared.routing.stages[stage.id]?.model;
    let profiles: string[] = [];
    if (stage.type === "agent" || stage.type === "reflection") profiles = [stage.profileId];
    else if (stage.type === "tasks") profiles = ["implementer"];
    else if (stage.type === "review") profiles = reviewProfiles(prepared, stage);
    else if (
      stage.type === "check" &&
      stage.gates.some(
        (b) => prepared.gates.find((g) => g.id === b.gateId)?.type === "ai-acceptance",
      )
    )
      profiles = ["acceptance-walker"];
    const models = routed
      ? [routed]
      : [
          ...new Set(
            profiles.map((id) => profileModel(prepared, id)).filter((m): m is string => m !== null),
          ),
        ];
    return { id: stage.id, type: stage.type, models };
  });
}

/**
 * Every model the run can call: the stages' models plus every profile that may be assigned a
 * task (the planner picks any profile returning an implementation).
 */
export function modelsInUse(prepared: PreparedStart): ModelUse[] {
  const uses = new Map<string, Set<string>>();
  const note = (model: string, by: string): void => {
    const set = uses.get(model) ?? new Set<string>();
    set.add(by);
    uses.set(model, set);
  };
  for (const stage of plannedStages(prepared))
    for (const model of stage.models) note(model, `stage ${stage.id}`);
  for (const entry of prepared.registry.list())
    if (entry.profile.output === "implementation")
      note(entry.profile.model, `profile ${entry.profile.id}`);
  return [...uses].map(([model, by]) => ({ model, usedBy: [...by] }));
}

export function tablePrice(model: string): ModelPrice | null {
  const found = findPricing(model);
  if (!found) return null;
  const { input, cacheRead, output } = found.pricing;
  return { input, cacheRead, output, match: found.match };
}

/** The pre-run estimate of a prepared start, priced from the model price table. */
export function estimatePrepared(
  prepared: PreparedStart,
  workflowId: string,
  history: PastRun[],
): PreRunEstimate {
  return estimatePreRun({
    history,
    workflowId,
    stages: plannedStages(prepared),
    maxTotalTokens: prepared.policy.maxTotalTokens,
    price: tablePrice,
  });
}

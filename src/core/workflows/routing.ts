import type { AppConfig } from "../../types/index.js";
import { ProfileRegistry, type RegisteredProfile } from "../agents/profiles/registry.js";
import {
  parseModelRouting,
  type RoutingInputs,
  type RoutingRecord,
  resolveStageRoutes,
} from "../llm/model-routing.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { PolicySchema } from "./schemas.js";
import { type LoadedDefinition, loadDefinition } from "./v2/definitions.js";

function inputs(config: AppConfig, model: string): RoutingInputs {
  return {
    runModel: model,
    routing: parseModelRouting(config.modelRouting),
    legacy: {
      coding: config.taskRouter?.ember ?? config.taskRouter?.coding ?? undefined,
      review: config.taskRouter?.verify ?? undefined,
    },
  };
}

/** Profiles with their models resolved through `modelRouting` and the legacy router slots. */
export function routedProfiles(
  workspace: string,
  config: AppConfig,
  model: string,
  globalDirectory?: string,
): ProfileRegistry {
  const routing = inputs(config, model);
  return new ProfileRegistry(
    workspace,
    {
      active: model,
      coding: routing.legacy?.coding,
      review: routing.legacy?.review,
      routing: routing.routing,
    },
    globalDirectory,
  );
}

/** What a run freezes at start: each profile's model and each routed stage's model, with sources. */
export function routingRecord(
  config: AppConfig,
  registry: ProfileRegistry,
  model: string,
  workflowId: string,
  stageIds: string[],
  overrides: Record<string, string> | undefined,
): RoutingRecord {
  const stages = resolveStageRoutes(workflowId, stageIds, overrides, inputs(config, model));
  return {
    schemaVersion: 1,
    runModel: model,
    profiles: Object.fromEntries(
      registry
        .list()
        .map((entry: RegisteredProfile) => [
          entry.profile.id,
          { model: entry.profile.model, source: entry.modelSource },
        ]),
    ),
    stages: Object.fromEntries(
      stages.map((route) => [route.stageId, { model: route.model, source: route.source }]),
    ),
  };
}

export interface RouteExplanation {
  workflowId: string;
  runModel: string;
  stages: {
    stageId: string;
    kind: string;
    /** The stage's own profile; tasks and review stages pick theirs from the plan and gates. */
    profileId: string | null;
    /** The model every agent of this stage uses, or null when each keeps its profile's model. */
    model: string | null;
    source: string | null;
  }[];
  profiles: RoutingRecord["profiles"];
}

/** The models a run of this workflow would use, without starting it (`baked workflow route`). */
export function explainRoute(
  workspace: string,
  config: AppConfig,
  request: { workflowId: string; model?: string | undefined; routes?: Record<string, string> },
): RouteExplanation {
  const model = request.model ?? config.defaultModel;
  if (!model?.trim() || model.trim() === "none")
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "Select a model (--model ID) to route a workflow",
    );
  const policy = PolicySchema.parse(config.workflows?.policy ?? defaultWorkflowPolicy);
  let loaded: LoadedDefinition;
  try {
    loaded = loadDefinition(workspace, request.workflowId, policy);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown workflow"))
      throw new WorkflowFault("NOT_FOUND", error.message);
    throw error;
  }
  const stages = loaded.definition.stages;
  const record = routingRecord(
    config,
    routedProfiles(workspace, config, model),
    model,
    request.workflowId,
    stages.map((stage) => stage.id),
    request.routes,
  );
  return {
    workflowId: request.workflowId,
    runModel: model,
    stages: stages.map((stage) => {
      const routed = record.stages[stage.id];
      return {
        stageId: stage.id,
        kind: "type" in stage ? stage.type : stage.kind,
        profileId: ("profileId" in stage ? stage.profileId : undefined) ?? null,
        model: routed?.model ?? null,
        source: routed?.source ?? null,
      };
    }),
    profiles: record.profiles,
  };
}

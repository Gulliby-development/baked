import type { AppConfig } from "../../types/index.js";
import { ProfileRegistry, type RegisteredProfile } from "../agents/profiles/registry.js";
import type { AgentProfile } from "../agents/profiles/schema.js";
import {
  parseModelRouting,
  type RoutingEntry,
  type RoutingInputs,
  type RoutingRecord,
  recordEntry,
  resolveStageRoutes,
} from "../llm/model-routing.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { PolicySchema, type RunPolicy } from "./schemas.js";
import type { Gate } from "./v2/definition.js";
import { type LoadedDefinition, loadDefinition } from "./v2/definitions.js";
import { loadGateLibrary } from "./v2/library.js";

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
  const chained = withModelFallback(config);
  return {
    schemaVersion: 1,
    runModel: model,
    profiles: Object.fromEntries(
      registry.list().map((entry: RegisteredProfile) => [entry.profile.id, chained(entry.route)]),
    ),
    stages: Object.fromEntries(
      stages.map(({ stageId, ...route }) => [stageId, chained(recordEntry(route))]),
    ),
  };
}

/**
 * A route without fallback models of its own takes the model's `modelFallback` chain, the same
 * chain chat uses, so a run fails over to it too.
 */
function withModelFallback(config: AppConfig): (entry: RoutingEntry) => RoutingEntry {
  const chains = config.modelFallback ?? {};
  return (entry) => {
    if (entry.fallback?.length) return entry;
    const chain = [...new Set((chains[entry.model] ?? []).map((id) => id.trim()))]
      .filter((id) => id && id !== entry.model)
      .slice(0, 3);
    return chain.length ? { ...entry, fallback: chain } : entry;
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
    effort: string | null;
    fallback: string[];
  }[];
  profiles: RoutingRecord["profiles"];
  /** Reviews that would share a model with the implementation (see `independentReview`). */
  warnings: string[];
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
  const registry = routedProfiles(workspace, config, model);
  const record = routingRecord(
    config,
    registry,
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
        effort: routed?.effort ?? null,
        fallback: routed?.fallback ?? [],
      };
    }),
    profiles: record.profiles,
    warnings:
      independentReviewMode(config) === "off"
        ? []
        : independenceWarnings(
            record,
            loaded.definition,
            policy,
            loadGateLibrary(workspace, policy).gates,
            registry.list().map((entry) => entry.profile),
          ),
  };
}

type Definition = LoadedDefinition["definition"];

/**
 * Which profiles each stage runs, split into implementation and review sides: task stages run the
 * implementation profiles; review, converge and reflection stages run their reviewers, skeptics
 * and auditors. Review gates on transitions have no stage and add their profiles to the review side.
 */
function boundSides(
  definition: Definition,
  policy: RunPolicy,
  gates: ReadonlyMap<string, Gate>,
  profiles: readonly AgentProfile[],
): { stageId: string | null; side: "implementation" | "review" | "other"; profileIds: string[] }[] {
  const implementation = profiles.filter((p) => p.output === "implementation").map((p) => p.id);
  const reviewers = (bindings: readonly { gateId: string }[]): string[] =>
    bindings.flatMap(({ gateId }) => {
      const gate = gates.get(gateId);
      if (gate?.type !== "ai-review") return [];
      return [
        gate.review.profileId,
        ...(gate.review.skepticProfileId ? [gate.review.skepticProfileId] : []),
      ];
    });
  const sides: ReturnType<typeof boundSides> = [];
  if (definition.schemaVersion === 1) {
    for (const stage of definition.stages) {
      if (stage.kind === "task-graph")
        sides.push({ stageId: stage.id, side: "implementation", profileIds: implementation });
      else if (stage.kind === "review")
        sides.push({
          stageId: stage.id,
          side: "review",
          profileIds: [
            ...(stage.profileId ? [stage.profileId] : []),
            ...Object.values(policy.reviewProfiles).filter((id): id is string => id !== null),
            policy.skepticProfileId,
          ],
        });
      else if (stage.kind === "converge" && stage.profileId)
        sides.push({ stageId: stage.id, side: "review", profileIds: [stage.profileId] });
      else if (stage.profileId)
        sides.push({ stageId: stage.id, side: "other", profileIds: [stage.profileId] });
    }
    return sides;
  }
  for (const stage of definition.stages) {
    if (stage.type === "tasks")
      sides.push({ stageId: stage.id, side: "implementation", profileIds: implementation });
    else if (stage.type === "review")
      sides.push({ stageId: stage.id, side: "review", profileIds: reviewers(stage.gates) });
    else if (stage.type === "reflection")
      sides.push({ stageId: stage.id, side: "review", profileIds: [stage.profileId] });
  }
  const onTransitions = definition.transitions.flatMap((t) => reviewers(t.gates));
  if (onTransitions.length)
    sides.push({ stageId: null, side: "review", profileIds: onTransitions });
  return sides;
}

/**
 * Reviews that would run on a model the implementation also uses, fallback models included. A
 * stage route replaces the models of every profile in its stage.
 */
export function independenceWarnings(
  record: RoutingRecord,
  definition: Definition,
  policy: RunPolicy,
  gates: ReadonlyMap<string, Gate>,
  profiles: readonly AgentProfile[],
): string[] {
  const chain = (entry: RoutingEntry | undefined): string[] =>
    entry ? [entry.model, ...(entry.fallback ?? [])] : [];
  const models = { implementation: new Map<string, string>(), review: new Map<string, string>() };
  for (const { stageId, side, profileIds } of boundSides(definition, policy, gates, profiles)) {
    if (side === "other") continue;
    const route = stageId ? record.stages[stageId] : undefined;
    if (route) {
      for (const model of chain(route)) models[side].set(model, `stage ${stageId}`);
      continue;
    }
    for (const id of profileIds)
      for (const model of chain(record.profiles[id])) models[side].set(model, `profile ${id}`);
  }
  return [...models.review]
    .filter(([model]) => models.implementation.has(model))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([model, reviewer]) =>
        `Review is not independent: ${reviewer} uses ${model}, which the implementation (${models.implementation.get(model)}) also uses`,
    );
}

/** The independent-review mode: configured, else `warn` once routing is configured, else `off`. */
export function independentReviewMode(config: AppConfig): "off" | "warn" | "require" {
  const routing = parseModelRouting(config.modelRouting);
  return routing?.independentReview ?? (routing ? "warn" : "off");
}

/**
 * The models a run of this definition can call, each with what uses it: `required` models are
 * primaries of bound profiles and stage routes, `optional` ones are fallback models and profiles
 * the definition does not bind.
 */
export function reachableModels(
  record: RoutingRecord,
  definition: Definition,
  policy: RunPolicy,
  gates: ReadonlyMap<string, Gate>,
  profiles: readonly AgentProfile[],
): { required: Map<string, string[]>; optional: Map<string, string[]> } {
  const required = new Map<string, string[]>();
  const optional = new Map<string, string[]>();
  const add = (into: Map<string, string[]>, model: string, user: string) => {
    const users = into.get(model) ?? [];
    if (!users.includes(user)) users.push(user);
    into.set(model, users);
  };
  const bound = new Set<string>();
  for (const { stageId, profileIds } of boundSides(definition, policy, gates, profiles)) {
    const route = stageId ? record.stages[stageId] : undefined;
    for (const id of profileIds) bound.add(id);
    const entries = route
      ? [[`stage ${stageId}`, route] as const]
      : profileIds.flatMap((id) => {
          const entry = record.profiles[id];
          return entry ? [[`profile ${id}`, entry] as const] : [];
        });
    for (const [user, entry] of entries) {
      add(required, entry.model, user);
      for (const model of entry.fallback ?? []) add(optional, model, `${user} (fallback)`);
    }
  }
  for (const [id, entry] of Object.entries(record.profiles))
    if (!bound.has(id) && !required.has(entry.model)) add(optional, entry.model, `profile ${id}`);
  for (const model of required.keys()) optional.delete(model);
  return { required, optional };
}

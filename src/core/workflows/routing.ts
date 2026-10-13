import type { AppConfig } from "../../types/index.js";
import { ProfileRegistry, type RegisteredProfile } from "../agents/profiles/registry.js";
import type { AgentProfile } from "../agents/profiles/schema.js";
import {
  type IndependentReview,
  parseModelRouting,
  type RoutingEntry,
  type RoutingInputs,
  type RoutingRecord,
  recordEntry,
  resolveStageRoutes,
} from "../llm/model-routing.js";
import { modelVendor } from "../llm/model-vendor.js";
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

/**
 * The configuration of a run whose model is strict: no configured route applies, so the run model
 * serves every class, role, profile and stage. Routes given for the run itself (`--route`) still do.
 */
export function strictRoutingConfig(config: AppConfig): AppConfig {
  const { modelRouting: _routing, taskRouter: _router, ...rest } = config;
  return rest;
}

/**
 * Warnings for an explicit run model that configured routes override: only the `active` class
 * follows the run model, so a configured class, role, profile or stage route silently wins unless
 * the operator is told. One line per route source, naming what runs on another model.
 */
export function shadowedModelWarnings(
  record: RoutingRecord,
  profiles: readonly Pick<AgentProfile, "id" | "role">[],
): string[] {
  const groups = new Map<string, { model: string; source: string; targets: string[] }>();
  const add = (target: string, entry: RoutingEntry): void => {
    if (entry.model === record.runModel || !/^(modelRouting|taskRouter)/.test(entry.source)) return;
    const key = `${entry.model}|${entry.source}`;
    const group = groups.get(key) ?? { model: entry.model, source: entry.source, targets: [] };
    if (!group.targets.includes(target)) group.targets.push(target);
    groups.set(key, group);
  };
  const roleOf = new Map(profiles.map((p) => [p.id, p.role]));
  for (const [id, entry] of Object.entries(record.profiles)) add(roleOf.get(id) ?? id, entry);
  for (const [id, entry] of Object.entries(record.stages)) add(`stage ${id}`, entry);
  return [...groups.values()].map(
    ({ model, source, targets }) =>
      `Model ${record.runModel} applies to the active class only; ${targets.join(", ")} use${targets.length === 1 ? "s" : ""} ${model} (${source}). Use --model-strict to run everything on ${record.runModel}.`,
  );
}

/** What a run effectively uses: the models by role (and stage), with where each came from. */
export interface RoutingSummary {
  runModel: string;
  /** The run model overrode the configured routes (`--model-strict`). */
  strict: boolean;
  warnings: string[];
  effective: { target: string; model: string; source: string; fallback?: string[] }[];
}

/** The effective models of a routing record by role and stage, one row per distinct route. */
export function routingSummary(
  record: RoutingRecord,
  profiles: readonly Pick<AgentProfile, "id" | "role">[],
): RoutingSummary {
  const roleOf = new Map(profiles.map((p) => [p.id, p.role]));
  const rows = new Map<string, RoutingSummary["effective"][number]>();
  const add = (target: string, entry: RoutingEntry): void => {
    const key = `${target}|${entry.model}|${entry.source}`;
    if (rows.has(key)) return;
    rows.set(key, {
      target,
      model: entry.model,
      source: entry.source,
      ...(entry.fallback?.length ? { fallback: entry.fallback } : {}),
    });
  };
  for (const [id, entry] of Object.entries(record.profiles)) add(roleOf.get(id) ?? id, entry);
  for (const [id, entry] of Object.entries(record.stages)) add(`stage ${id}`, entry);
  return {
    runModel: record.runModel,
    strict: record.strict === true,
    warnings: record.warnings ?? [],
    effective: [...rows.values()].sort((a, b) => a.target.localeCompare(b.target)),
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
  /**
   * Reviews that would share a model with the implementation, and reviews `independentReview:
   * provider` moved to another vendor (see `reviewIndependence`).
   */
  warnings: string[];
}

/** The models a run of this workflow would use, without starting it (`baked workflow route`). */
export function explainRoute(
  workspace: string,
  config: AppConfig,
  request: {
    workflowId: string;
    model?: string | undefined;
    routes?: Record<string, string>;
    /** Models of available providers a `provider` review may move to (`availableVendorModels`). */
    availableModels?: readonly string[];
  },
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
  const profiles = registry.list().map((entry) => entry.profile);
  const gates = loadGateLibrary(workspace, policy).gates;
  const checked = reviewIndependence(
    config,
    routingRecord(
      config,
      registry,
      model,
      request.workflowId,
      stages.map((stage) => stage.id),
      request.routes,
    ),
    loaded.definition,
    policy,
    gates,
    profiles,
    request.availableModels ?? [],
  );
  const record = checked.record;
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
    warnings: [...checked.moved, ...checked.warnings],
  };
}

/**
 * Applies the independent-review mode to a routing record: `provider` moves same-vendor reviews to
 * another vendor (see `routeReviewToOtherVendor`) and lists the moves; the other modes list the
 * reviews that share a model. `refuse` is set when `require` should stop the start.
 */
export function reviewIndependence(
  config: AppConfig,
  record: RoutingRecord,
  definition: Definition,
  policy: RunPolicy,
  gates: ReadonlyMap<string, Gate>,
  profiles: readonly AgentProfile[],
  availableModels: readonly string[],
): { record: RoutingRecord; moved: string[]; warnings: string[]; refuse: boolean } {
  const mode = independentReviewMode(config);
  if (mode === "off") return { record, moved: [], warnings: [], refuse: false };
  if (mode === "provider") {
    const routed = routeReviewToOtherVendor(
      record,
      definition,
      policy,
      gates,
      profiles,
      reviewCandidates(config, availableModels),
    );
    return {
      ...routed,
      moved: routed.moved.map((line) => `Cross-provider review: ${line}`),
      refuse: false,
    };
  }
  const warnings = independenceWarnings(record, definition, policy, gates, profiles);
  return { record, moved: [], warnings, refuse: mode === "require" && warnings.length > 0 };
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

/** Models of each side of a run, each with what uses it: a stage route or a profile. */
function sideModels(
  record: RoutingRecord,
  definition: Definition,
  policy: RunPolicy,
  gates: ReadonlyMap<string, Gate>,
  profiles: readonly AgentProfile[],
): { implementation: Map<string, string>; review: Map<string, string> } {
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
  return models;
}

/**
 * Reviews that would run on a model the implementation also uses, fallback models included. A
 * stage route replaces the models of every profile in its stage. At the `provider` level a review
 * on another model of the same vendor (see model-vendor.ts) is not independent either.
 */
export function independenceWarnings(
  record: RoutingRecord,
  definition: Definition,
  policy: RunPolicy,
  gates: ReadonlyMap<string, Gate>,
  profiles: readonly AgentProfile[],
  level: "model" | "provider" = "model",
): string[] {
  const models = sideModels(record, definition, policy, gates, profiles);
  if (level === "model")
    return [...models.review]
      .filter(([model]) => models.implementation.has(model))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([model, reviewer]) =>
          `Review is not independent: ${reviewer} uses ${model}, which the implementation (${models.implementation.get(model)}) also uses`,
      );
  const vendors = new Map<string, string>();
  for (const [model, user] of models.implementation)
    vendors.set(modelVendor(model), `${user}: ${model}`);
  return [...models.review]
    .filter(([model]) => vendors.has(modelVendor(model)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([model, reviewer]) =>
        `Review is not cross-provider: ${reviewer} uses ${model}, the same vendor (${modelVendor(model)}) as the implementation (${vendors.get(modelVendor(model))})`,
    );
}

/**
 * `independentReview: provider`: review-side routes that share a vendor with the implementation
 * move to the first candidate model of another vendor, without fallback models (a fallback could
 * land on the implementation's vendor again). Candidates come from `reviewCandidates`. Returns the
 * changed record and one line per move, or a warning when no candidate fits.
 */
export function routeReviewToOtherVendor(
  record: RoutingRecord,
  definition: Definition,
  policy: RunPolicy,
  gates: ReadonlyMap<string, Gate>,
  profiles: readonly AgentProfile[],
  candidates: readonly string[],
): { record: RoutingRecord; moved: string[]; warnings: string[] } {
  const models = sideModels(record, definition, policy, gates, profiles);
  const used = new Set([...models.implementation.keys()].map(modelVendor));
  if (![...models.review.keys()].some((model) => used.has(modelVendor(model))))
    return { record, moved: [], warnings: [] };
  const target = candidates.find((model) => !used.has(modelVendor(model)));
  if (!target)
    return {
      record,
      moved: [],
      warnings: [
        `Review runs on the implementation's vendor (${[...used].sort().join(", ")}): independentReview is "provider" but no model of another vendor is configured or available`,
      ],
    };
  const next: RoutingRecord = {
    ...record,
    profiles: { ...record.profiles },
    stages: { ...record.stages },
  };
  const moved: string[] = [];
  const shares = (entry: RoutingEntry | undefined): entry is RoutingEntry =>
    !!entry && [entry.model, ...(entry.fallback ?? [])].some((m) => used.has(modelVendor(m)));
  const moveTo = (entry: RoutingEntry): RoutingEntry => ({
    model: target,
    source: CROSS_PROVIDER_SOURCE,
    ...(entry.effort ? { effort: entry.effort } : {}),
  });
  for (const { stageId, side, profileIds } of boundSides(definition, policy, gates, profiles)) {
    if (side !== "review") continue;
    const route = stageId ? next.stages[stageId] : undefined;
    if (stageId && route) {
      if (!shares(route)) continue;
      next.stages[stageId] = moveTo(route);
      moved.push(`stage ${stageId}: ${route.model} -> ${target}`);
      continue;
    }
    for (const id of profileIds) {
      const entry = next.profiles[id];
      if (!shares(entry)) continue;
      next.profiles[id] = moveTo(entry);
      moved.push(`profile ${id}: ${entry.model} -> ${target}`);
    }
  }
  return { record: next, moved, warnings: [] };
}

/** The source of a route `independentReview: provider` moved to another vendor. */
export const CROSS_PROVIDER_SOURCE = "independentReview: provider";

/**
 * Models an automatic cross-provider review may use, best first: the `$review` class, then every
 * other model the configuration names, then `available` (see `availableVendorModels`).
 */
export function reviewCandidates(config: AppConfig, available: readonly string[] = []): string[] {
  const routing = parseModelRouting(config.modelRouting);
  const named: string[] = [];
  const add = (value: unknown) => {
    const model =
      typeof value === "string" ? value : (value as { model?: unknown } | null | undefined)?.model;
    if (typeof model === "string" && model.includes("/") && !model.startsWith("$"))
      named.push(model);
  };
  add(routing?.classes?.review);
  for (const value of Object.values(routing?.classes ?? {})) add(value);
  for (const value of Object.values(routing?.roles ?? {})) add(value);
  for (const value of Object.values(routing?.profiles ?? {})) add(value);
  for (const workflow of Object.values(routing?.workflows ?? {}))
    for (const value of Object.values(workflow.stages ?? {})) add(value);
  add(config.taskRouter?.verify);
  add(config.taskRouter?.ember ?? config.taskRouter?.coding);
  add(config.defaultModel);
  named.push(...available);
  return [...new Set(named)];
}

/**
 * The independent-review mode: configured, else `provider` when the configuration names models of
 * two known vendors (such as a Codex run model and a `claude-code` class), else `warn` once routing
 * is configured, else `off`.
 */
export function independentReviewMode(config: AppConfig): IndependentReview {
  const routing = parseModelRouting(config.modelRouting);
  if (routing?.independentReview) return routing.independentReview;
  const vendors = new Set(reviewCandidates(config).map(modelVendor));
  if ([...vendors].filter((vendor) => !vendor.includes(":")).length > 1) return "provider";
  return routing ? "warn" : "off";
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

export interface RerouteRequest {
  /** The new run model; omitted, the run keeps its run model. */
  model?: string | undefined;
  /** Stage routes for the rest of the run, as `--route` at start. */
  routes?: Record<string, string> | undefined;
}

/** One route a reroute changes: `stage ID` or `profile ID`, with its model before and after. */
export interface RouteChange {
  target: string;
  from: string;
  to: string;
}

const ROUTE_OVERRIDE = "route override ";

/**
 * The routing record a stopped run continues with. Routes resolve again through the current
 * `modelRouting` and `modelFallback` with the new run model, so everything that followed the old
 * run model follows the new one. Stage routes given at start stay, except that one naming the old
 * run model moves to the new one; `request.routes` replaces them stage by stage. Only the run's
 * own profiles are kept; one that no longer resolves keeps its entry, moved like a start route.
 */
export function rerouteRecord(
  workspace: string,
  configured: AppConfig,
  previous: RoutingRecord,
  workflowId: string,
  stageIds: string[],
  profileIds: string[],
  request: RerouteRequest,
): RoutingRecord {
  const model = request.model?.trim() || previous.runModel;
  const config = previous.strict ? strictRoutingConfig(configured) : configured;
  const moved = (id: string): string => (id === previous.runModel ? model : id);
  const carried: Record<string, string> = {};
  for (const [stageId, entry] of Object.entries(previous.stages))
    if (entry.source.startsWith(ROUTE_OVERRIDE)) carried[stageId] = moved(entry.model);
  const overrides = { ...carried, ...request.routes };
  const registry = routedProfiles(workspace, config, model);
  const fresh = routingRecord(config, registry, model, workflowId, stageIds, overrides);
  const profiles: RoutingRecord["profiles"] = {};
  for (const id of profileIds) {
    const entry = fresh.profiles[id] ?? previous.profiles[id];
    if (entry) profiles[id] = fresh.profiles[id] ? entry : { ...entry, model: moved(entry.model) };
  }
  return {
    schemaVersion: 1,
    runModel: model,
    profiles,
    stages: fresh.stages,
    ...(previous.strict ? { strict: true } : {}),
  };
}

/** The stage and profile routes whose model or fallback chain differ between two records. */
export function routeChanges(before: RoutingRecord, after: RoutingRecord): RouteChange[] {
  const chain = (entry: RoutingEntry | undefined): string =>
    entry ? [entry.model, ...(entry.fallback ?? [])].join(" > ") : "(profile model)";
  const changes: RouteChange[] = [];
  for (const [kind, a, b] of [
    ["stage", before.stages, after.stages],
    ["profile", before.profiles, after.profiles],
  ] as const)
    for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const from = chain(a[id]);
      const to = chain(b[id]);
      if (from !== to) changes.push({ target: `${kind} ${id}`, from, to });
    }
  return changes;
}

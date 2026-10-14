import {
  BUILTIN_CLASSES,
  type CriticMode,
  type ModelRouting,
  ModelRoutingSchema,
  mergeModelRouting,
  ROUTED_ROLES,
  type Route,
  type RoutedRole,
  RouteEffort,
  type RoutingInputs,
  resolveRef,
} from "../llm/model-routing.js";
import type { RouteExplanation } from "./routing.js";
import { DEFAULT_REVIEW_MIN_CONFIDENCE } from "./schemas.js";

/**
 * Editing `modelRouting` one route at a time, for the TUI routing screen and the local API. The functions are pure:
 * they take the routing of one configuration layer and return the next one, so a front end only
 * renders the rows and writes the result.
 */

/** One place in `modelRouting` that holds a route. */
export type RoutingTarget =
  | { kind: "class"; name: string }
  | { kind: "role"; role: RoutedRole }
  | { kind: "profile"; id: string }
  | { kind: "stage"; workflowId: string; stageId: string };

/** The editable fields of a route. `effort: null` leaves the effort unset (inherited). */
export interface RouteDraft {
  model: string;
  effort: RouteEffort | null;
  fallback: string[];
}

/** The effort choices of the edit form, in order; `null` means unset. */
export const EFFORT_CHOICES: readonly (RouteEffort | null)[] = [null, ...RouteEffort.options];

/** The configuration path of a target, as validation messages and the CLI name it. */
export function targetPath(target: RoutingTarget): string {
  switch (target.kind) {
    case "class":
      return `classes.${target.name}`;
    case "role":
      return `roles.${target.role}`;
    case "profile":
      return `profiles.${target.id}`;
    case "stage":
      return `workflows.${target.workflowId}.stages.${target.stageId}`;
  }
}

/** The route a layer sets for a target, if any. */
export function routeAt(
  routing: ModelRouting | undefined,
  target: RoutingTarget,
): Route | undefined {
  switch (target.kind) {
    case "class":
      return routing?.classes?.[target.name];
    case "role":
      return routing?.roles?.[target.role];
    case "profile":
      return routing?.profiles?.[target.id];
    case "stage":
      return routing?.workflows?.[target.workflowId]?.stages?.[target.stageId];
  }
}

export function draftOf(route: Route | undefined): RouteDraft {
  if (route === undefined) return { model: "", effort: null, fallback: [] };
  if (typeof route === "string") return { model: route, effort: null, fallback: [] };
  return { model: route.model, effort: route.effort ?? null, fallback: route.fallback ?? [] };
}

/** The shortest route for a draft: a plain string unless it sets effort or fallback models. */
export function routeOf(draft: RouteDraft): Route {
  const model = draft.model.trim();
  const fallback = draft.fallback.map((id) => id.trim()).filter(Boolean);
  if (!draft.effort && !fallback.length) return model;
  return {
    model,
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(fallback.length ? { fallback } : {}),
  };
}

/** One line for a route: `model · effort · → fallback, fallback`. */
export function describeRoute(route: Route | undefined): string {
  if (route === undefined) return "";
  const draft = draftOf(route);
  return [
    draft.model,
    ...(draft.effort ? [draft.effort] : []),
    ...(draft.fallback.length ? [`→ ${draft.fallback.join(", ")}`] : []),
  ].join(" · ");
}

/** Splits the fallback field: model IDs separated by commas or spaces. */
export function parseFallback(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function withoutEmpty<T extends object>(record: T | undefined): T | undefined {
  return record && Object.keys(record).length ? record : undefined;
}

/** Normalizes a layer: empty sections are dropped, and an empty layer becomes undefined. */
function compact(routing: ModelRouting): ModelRouting | undefined {
  const workflows: NonNullable<ModelRouting["workflows"]> = {};
  for (const [id, entry] of Object.entries(routing.workflows ?? {})) {
    const stages = withoutEmpty(entry.stages);
    if (stages) workflows[id] = { stages };
  }
  const next: ModelRouting = {};
  const classes = withoutEmpty(routing.classes);
  const roles = withoutEmpty(routing.roles);
  const profiles = withoutEmpty(routing.profiles);
  if (classes) next.classes = classes;
  if (roles) next.roles = roles;
  if (profiles) next.profiles = profiles;
  if (Object.keys(workflows).length) next.workflows = workflows;
  if (routing.independentReview) next.independentReview = routing.independentReview;
  if (routing.reviewMinConfidence !== undefined)
    next.reviewMinConfidence = routing.reviewMinConfidence;
  if (routing.critic) next.critic = routing.critic;
  if (routing.specifyOnSonnet !== undefined) next.specifyOnSonnet = routing.specifyOnSonnet;
  return Object.keys(next).length ? next : undefined;
}

/** Sets (or, with `null`, removes) the route of a target in one layer. */
export function setRoute(
  routing: ModelRouting | undefined,
  target: RoutingTarget,
  route: Route | null,
): ModelRouting | undefined {
  const base = routing ?? {};
  const put = <V>(record: Record<string, V> | undefined, key: string, value: V | null) => {
    const next = { ...record };
    if (value === null) delete next[key];
    else next[key] = value;
    return next;
  };
  switch (target.kind) {
    case "class":
      // A class route names a model; draftProblems refuses a class reference before this.
      return compact({
        ...base,
        classes: put(base.classes, target.name, route as ClassRoute | null),
      });
    case "role":
      return compact({ ...base, roles: put(base.roles, target.role, route) });
    case "profile":
      return compact({ ...base, profiles: put(base.profiles, target.id, route) });
    case "stage": {
      const entry = base.workflows?.[target.workflowId];
      const stages = put(entry?.stages, target.stageId, route);
      return compact({
        ...base,
        workflows: { ...base.workflows, [target.workflowId]: { stages } },
      });
    }
  }
}

/** Sets the independent-review mode of a layer; `null` removes it so the default applies. */
export function setIndependentReview(
  routing: ModelRouting | undefined,
  mode: ModelRouting["independentReview"] | null,
): ModelRouting | undefined {
  // compact() keeps independentReview only when it is set.
  return compact({
    ...routing,
    ...(mode ? { independentReview: mode } : { independentReview: undefined }),
  });
}

/** Sets (or, with `null`, removes) the review confidence threshold of a layer. */
export function setReviewMinConfidence(
  routing: ModelRouting | undefined,
  value: number | null,
): ModelRouting | undefined {
  const { reviewMinConfidence: _previous, ...rest } = routing ?? {};
  return compact(value === null ? rest : { ...rest, reviewMinConfidence: value });
}

/** Sets (or, with `null`, removes) the critic mode of a layer. */
export function setCritic(
  routing: ModelRouting | undefined,
  mode: CriticMode | null,
): ModelRouting | undefined {
  const { critic: _previous, ...rest } = routing ?? {};
  return compact(mode === null ? rest : { ...rest, critic: mode });
}

/** Sets (or, with `null`, removes) the opt-in `specify` route to Sonnet of a layer (#1173). */
export function setSpecifyOnSonnet(
  routing: ModelRouting | undefined,
  value: boolean | null,
): ModelRouting | undefined {
  const { specifyOnSonnet: _previous, ...rest } = routing ?? {};
  return compact(value === null ? rest : { ...rest, specifyOnSonnet: value });
}

type ClassRoute = NonNullable<ModelRouting["classes"]>[string];
const CLASS_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Problems with a draft before it is applied, so the form can say what to fix: an empty model, a
 * class naming another class, a malformed class reference, or a fallback that repeats a model.
 */
export function draftProblems(target: RoutingTarget, draft: RouteDraft): string[] {
  const problems: string[] = [];
  const model = draft.model.trim();
  if (!model) problems.push("Name a model (provider/model) or a class ($name)");
  else if (model.startsWith("$")) {
    if (target.kind === "class") problems.push("A class names a model, not another class");
    else if (!CLASS_NAME.test(model.slice(1)))
      problems.push("A class reference is $ followed by a lowercase name");
  }
  if (target.kind === "class" && !CLASS_NAME.test(target.name))
    problems.push("A class name is lowercase letters, digits and dashes, starting with a letter");
  const fallback = draft.fallback.map((id) => id.trim()).filter(Boolean);
  if (fallback.length > 3) problems.push("At most three fallback models");
  if (fallback.some((id) => id.startsWith("$")))
    problems.push("Fallbacks name models, not classes");
  if (fallback.includes(model)) problems.push("A fallback repeats the primary model");
  if (new Set(fallback).size !== fallback.length) problems.push("A fallback model is listed twice");
  return problems;
}

/** Every `$class` reference of a routing layer, with where it is used. */
function classReferences(routing: ModelRouting | undefined): { name: string; at: string }[] {
  const refs: { name: string; at: string }[] = [];
  const note = (route: Route, at: string) => {
    const model = typeof route === "string" ? route : route.model;
    if (model.startsWith("$")) refs.push({ name: model.slice(1), at });
  };
  for (const [role, route] of Object.entries(routing?.roles ?? {}))
    if (route) note(route, `roles.${role}`);
  for (const [id, route] of Object.entries(routing?.profiles ?? {})) note(route, `profiles.${id}`);
  for (const [workflowId, entry] of Object.entries(routing?.workflows ?? {}))
    for (const [stageId, route] of Object.entries(entry.stages ?? {}))
      note(route, `workflows.${workflowId}.stages.${stageId}`);
  return refs;
}

/**
 * Problems that would make a run refuse to start with this layer: anything the schema rejects,
 * and class references no layer defines. `other` is the other configuration layer, whose classes
 * also count; `layer` is validated as it would merge (`project` over `global`).
 */
export function routingProblems(
  routing: ModelRouting | undefined,
  other: ModelRouting | undefined,
  layer: "global" | "project",
): string[] {
  // An empty layer still counts: removing its last class can leave the other layer's references
  // without a definition.
  const parsed = ModelRoutingSchema.safeParse(routing ?? {});
  if (!parsed.success)
    return parsed.error.issues.map((i) => `${i.path.join(".") || "modelRouting"}: ${i.message}`);
  const merged =
    layer === "project" ? mergeModelRouting(other, routing) : mergeModelRouting(routing, other);
  const known = new Set<string>([...BUILTIN_CLASSES, ...Object.keys(merged?.classes ?? {})]);
  return classReferences(merged)
    .filter((ref) => !known.has(ref.name))
    .map((ref) => `${ref.at} uses $${ref.name}, which no class defines`);
}

/** The classes a routing screen lists: the built-in ones, then the configured ones by name. */
export function routingClasses(...layers: (ModelRouting | undefined)[]): string[] {
  const configured = new Set<string>();
  for (const layer of layers)
    for (const name of Object.keys(layer?.classes ?? {})) configured.add(name);
  const builtin = BUILTIN_CLASSES as readonly string[];
  return [...builtin, ...[...configured].filter((name) => !builtin.includes(name)).sort()];
}

export type RoutingScope = "global" | "project";
export type IndependentReviewMode = NonNullable<ModelRouting["independentReview"]>;

/** `modelRouting` of each configuration layer, as written in its own file. */
export interface RoutingLayers {
  global: ModelRouting | undefined;
  project: ModelRouting | undefined;
}

/**
 * One edit of a layer: a route set from a draft or cleared with `null`, or the independent-review
 * mode. `create` marks a new class, which must not exist yet.
 */
export type RoutingChange =
  | { target: RoutingTarget; route: RouteDraft | null; create?: boolean }
  | { independentReview: IndependentReviewMode | null }
  | { reviewMinConfidence: number | null }
  | { critic: CriticMode | null }
  | { specifyOnSonnet: boolean | null };

/**
 * Applies a change to one layer and lists what would stop it: the draft's own problems, then what
 * would make a run refuse to start with the result (such as removing a class still in use). The
 * layer is only written when `problems` is empty.
 */
export function applyRoutingChange(
  layers: RoutingLayers,
  scope: RoutingScope,
  change: RoutingChange,
): { routing: ModelRouting | undefined; problems: string[] } {
  const current = layers[scope];
  const other = layers[scope === "global" ? "project" : "global"];
  if ("independentReview" in change)
    return { routing: setIndependentReview(current, change.independentReview), problems: [] };
  if ("critic" in change) return { routing: setCritic(current, change.critic), problems: [] };
  if ("specifyOnSonnet" in change)
    return { routing: setSpecifyOnSonnet(current, change.specifyOnSonnet), problems: [] };
  if ("reviewMinConfidence" in change) {
    const value = change.reviewMinConfidence;
    if (value !== null && !(value >= 0 && value <= 1))
      return { routing: current, problems: ["reviewMinConfidence must be between 0 and 1"] };
    return { routing: setReviewMinConfidence(current, value), problems: [] };
  }
  const { target, route } = change;
  if (route === null) {
    const routing = setRoute(current, target, null);
    return { routing, problems: routingProblems(routing, other, scope) };
  }
  const problems = draftProblems(target, route);
  if (
    change.create &&
    target.kind === "class" &&
    routingClasses(layers.global, layers.project).includes(target.name)
  )
    problems.push(`Class $${target.name} already exists; select it to edit`);
  if (problems.length) return { routing: current, problems };
  const routing = setRoute(current, target, routeOf(route));
  return { routing, problems: routingProblems(routing, other, scope) };
}

/** What a route resolves to for a run: its model, the setting that chose it, effort, fallback. */
export interface ResolvedRoute {
  model: string;
  source: string;
  effort?: string | null | undefined;
  fallback?: string[] | undefined;
}

/**
 * What a target resolves to with both layers merged. Stages and profiles come from the workflow's
 * route explanation; classes and roles resolve against the run model.
 */
export function resolveTarget(
  target: RoutingTarget,
  inputs: {
    routing: ModelRouting | undefined;
    runModel: string | null;
    legacy?: RoutingInputs["legacy"];
    explanation: RouteExplanation | null;
  },
): ResolvedRoute | null {
  if (target.kind === "stage") {
    const stage = inputs.explanation?.stages.find((s) => s.stageId === target.stageId);
    return stage?.model ? { ...stage, model: stage.model, source: stage.source ?? "" } : null;
  }
  if (target.kind === "profile") return inputs.explanation?.profiles[target.id] ?? null;
  if (!inputs.runModel) return null;
  const resolving: RoutingInputs = {
    runModel: inputs.runModel,
    routing: inputs.routing,
    legacy: inputs.legacy,
  };
  try {
    if (target.kind === "class")
      return resolveRef(`$${target.name}`, targetPath(target), resolving);
    const route = inputs.routing?.roles?.[target.role];
    return route ? resolveRef(route, `modelRouting.roles.${target.role}`, resolving) : null;
  } catch {
    return null;
  }
}

/** One editable route as a routing screen lists it. */
export interface RoutingRow {
  target: RoutingTarget;
  /** The key under `modelRouting`, such as `roles.reviewer`. */
  path: string;
  label: string;
  global: Route | null;
  project: Route | null;
  resolved: ResolvedRoute | null;
}

/** Every route a routing screen edits, with each layer's value and what a run resolves. */
export interface RoutingOverview {
  layers: RoutingLayers;
  workflows: string[];
  workflowId: string | null;
  runModel: string | null;
  classes: RoutingRow[];
  roles: RoutingRow[];
  stages: RoutingRow[];
  profiles: RoutingRow[];
  independentReview: {
    global: IndependentReviewMode | null;
    project: IndependentReviewMode | null;
    effective: IndependentReviewMode;
  };
  /** Review findings below this confidence are notes; `effective` is 0.8 when no layer sets it. */
  reviewMinConfidence: {
    global: number | null;
    project: number | null;
    effective: number;
  };
  /** The task-attempt critic; `effective` is null when no layer sets it (the vendor rule decides). */
  critic: {
    global: CriticMode | null;
    project: CriticMode | null;
    effective: CriticMode | null;
  };
  /** The opt-in `specify` route to Sonnet on Claude Code Opus runs; `effective` is false when unset. */
  specifyOnSonnet: {
    global: boolean | null;
    project: boolean | null;
    effective: boolean;
  };
  /** Reviews that would share a model with the implementation. */
  warnings: string[];
  /** Why the workflow's stages and profiles could not be explained, such as no run model. */
  error: string | null;
}

export function routingOverview(input: {
  layers: RoutingLayers;
  workflows: string[];
  workflowId: string | null;
  runModel: string | null;
  legacy?: RoutingInputs["legacy"];
  explanation: RouteExplanation | null;
  error?: string | null;
  /** The mode a run would use when no layer sets one (`independentReviewMode`). */
  reviewMode?: IndependentReviewMode;
}): RoutingOverview {
  const { layers, explanation } = input;
  const routing = mergeModelRouting(layers.global, layers.project);
  const runModel = explanation?.runModel ?? input.runModel;
  const row = (target: RoutingTarget, label: string): RoutingRow => ({
    target,
    path: targetPath(target),
    label,
    global: routeAt(layers.global, target) ?? null,
    project: routeAt(layers.project, target) ?? null,
    resolved: resolveTarget(target, { routing, runModel, legacy: input.legacy, explanation }),
  });
  const workflowId = input.workflowId;
  return {
    layers,
    workflows: input.workflows,
    workflowId,
    runModel,
    classes: routingClasses(layers.global, layers.project).map((name) =>
      row({ kind: "class", name }, `$${name}`),
    ),
    roles: ROUTED_ROLES.map((role) => row({ kind: "role", role }, role)),
    stages: workflowId
      ? (explanation?.stages ?? []).map((stage) =>
          row({ kind: "stage", workflowId, stageId: stage.stageId }, stage.stageId),
        )
      : [],
    profiles: Object.keys(explanation?.profiles ?? {})
      .sort()
      .map((id) => row({ kind: "profile", id }, id)),
    independentReview: {
      global: layers.global?.independentReview ?? null,
      project: layers.project?.independentReview ?? null,
      effective: routing?.independentReview ?? input.reviewMode ?? (routing ? "warn" : "off"),
    },
    reviewMinConfidence: {
      global: layers.global?.reviewMinConfidence ?? null,
      project: layers.project?.reviewMinConfidence ?? null,
      effective: routing?.reviewMinConfidence ?? DEFAULT_REVIEW_MIN_CONFIDENCE,
    },
    critic: {
      global: layers.global?.critic ?? null,
      project: layers.project?.critic ?? null,
      effective: routing?.critic ?? null,
    },
    specifyOnSonnet: {
      global: layers.global?.specifyOnSonnet ?? null,
      project: layers.project?.specifyOnSonnet ?? null,
      effective: routing?.specifyOnSonnet ?? false,
    },
    warnings: explanation?.warnings ?? [],
    error: input.error ?? null,
  };
}

import {
  BUILTIN_CLASSES,
  type ModelRouting,
  ModelRoutingSchema,
  mergeModelRouting,
  type Route,
  type RoutedRole,
  RouteEffort,
} from "../llm/model-routing.js";

/**
 * Editing `modelRouting` one route at a time, for the TUI routing screen. The functions are pure:
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
  if (!routing) return [];
  const parsed = ModelRoutingSchema.safeParse(routing);
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

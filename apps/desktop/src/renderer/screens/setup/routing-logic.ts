/**
 * Pure helpers of the model routing section. Validation is the backend's (`PATCH
 * /v1/workflow/routing` refuses what a run start would); these only shape what the form shows.
 */
import type {
  Effort,
  ResolvedRoute,
  Route,
  RouteDraft,
  RoutingOverview,
  RoutingRow,
  RoutingScope,
} from "../../client/setup.js";

export function draftOf(route: Route | null | undefined): RouteDraft {
  if (route === null || route === undefined) return { model: "", effort: null, fallback: [] };
  if (typeof route === "string") return { model: route, effort: null, fallback: [] };
  return { model: route.model, effort: route.effort ?? null, fallback: route.fallback ?? [] };
}

/** One line for a route as configured: `model · effort · → fallback, fallback`. */
export function describeRoute(route: Route | null | undefined): string {
  if (route === null || route === undefined) return "";
  const draft = draftOf(route);
  return [
    draft.model,
    ...(draft.effort ? [draft.effort] : []),
    ...(draft.fallback.length ? [`→ ${draft.fallback.join(", ")}`] : []),
  ].join(" · ");
}

/** The resolved model of a row, with effort and fallback models when they are set. */
export function describeResolved(resolved: ResolvedRoute | null): string {
  if (!resolved) return "";
  return [
    resolved.model,
    ...(resolved.effort && resolved.effort !== "default" ? [resolved.effort] : []),
    ...(resolved.fallback?.length ? [`→ ${resolved.fallback.join(", ")}`] : []),
  ].join(" · ");
}

/** Splits the fallback field: model IDs separated by commas or spaces. */
export function parseFallback(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

/** The effort choices of the form: unset (inherit), then each effort. */
export const EFFORT_CHOICES: readonly (Effort | null)[] = [
  null,
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface RoutingGroup {
  id: "classes" | "roles" | "stages" | "profiles";
  title: string;
  note: string;
  rows: RoutingRow[];
}

/** The tables of the section, in the order the TUI screen lists them. */
export function routingGroups(view: RoutingOverview): RoutingGroup[] {
  return [
    {
      id: "classes",
      title: "Classes",
      note: "Named models that roles, stages and profiles refer to as $name.",
      rows: view.classes,
    },
    {
      id: "roles",
      title: "Roles",
      note: "The model each kind of agent uses, unless a stage or profile route says otherwise.",
      rows: view.roles,
    },
    {
      id: "stages",
      title: `Stages of ${view.workflowId ?? "—"}`,
      note: "A stage route wins over the roles of every agent in that stage.",
      rows: view.stages,
    },
    {
      id: "profiles",
      title: "Profiles",
      note: "A profile route wins over the profile's own model.",
      rows: view.profiles,
    },
  ];
}

/** What a row's own value is in a layer, for the cell of that layer. */
export function layerValue(row: RoutingRow, scope: RoutingScope): Route | null {
  return scope === "global" ? row.global : row.project;
}

/** The class names a model field can suggest, as `$name`. */
export function classSuggestions(view: RoutingOverview): string[] {
  return view.classes.map((row) => row.label);
}

/** Why a resolved row has no model: classes and roles without a run model, stages using profiles. */
export function unresolvedText(row: RoutingRow, view: RoutingOverview): string {
  if (row.target.kind === "stage") return "each agent's profile";
  if (row.target.kind === "role") return "the profile's own model";
  if (!view.runModel) return "needs a run model";
  return "";
}

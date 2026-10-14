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
  /** The key of `modelRouting` the group edits, shown next to the plain title. */
  term: string;
  note: string;
  /** A longer explanation for the hover hint. */
  hint: string;
  rows: RoutingRow[];
}

/** The tables of the section, in the order the TUI screen lists them. */
export function routingGroups(view: RoutingOverview): RoutingGroup[] {
  return [
    {
      id: "classes",
      title: "Model names",
      term: "classes",
      note: "Short names for models, used elsewhere as $name.",
      hint: "A class is a nickname for a model, such as $fast or $review. Roles, steps and profiles can use $name instead of a full model ID, so one change here moves all of them. The built-in ones fall back to the model you start the run with.",
      rows: view.classes,
    },
    {
      id: "roles",
      title: "Agent roles",
      term: "roles",
      note: "The model each kind of agent uses.",
      hint: "Every agent in a workflow has a role: researcher, spec author, planner, implementer, reviewer and so on. A model set here is used by every agent with that role, unless a workflow step or a profile below says otherwise.",
      rows: view.roles,
    },
    {
      id: "stages",
      title: `Workflow steps of ${view.workflowId ?? "—"}`,
      term: "stages",
      note: "A model for every agent in one step of this workflow.",
      hint: "A stage is one step of a workflow, such as research, spec, plan, implement or review. A model set here wins over the roles and profiles of every agent working in that step.",
      rows: view.stages,
    },
    {
      id: "profiles",
      title: "Agent profiles",
      term: "profiles",
      note: "Replaces the model a ready-made agent brings with it.",
      hint: "A profile is a ready-made agent (its instructions, tools and usual model). A model set here replaces the profile's own model wherever the workflow uses it; a step route still wins.",
      rows: view.profiles,
    },
  ];
}

const ROW_NOUN: Record<RoutingGroup["id"], string> = {
  classes: "model name",
  roles: "role",
  stages: "step",
  profiles: "profile",
};

/**
 * The accessible name of a row's Edit or Clear button. The table goes in the name because a
 * role and a profile can share one ("Reviewer"), and both tables are on the same page.
 */
export function routeActionLabel(
  action: "Edit" | "Clear",
  row: RoutingRow,
  group: RoutingGroup["id"],
): string {
  return `${action} ${plainName(row)} ${ROW_NOUN[group]}`;
}

/** What the built-in classes are for. */
export const CLASS_HINTS: Readonly<Record<string, string>> = {
  $active: "The model you start the run with: the chat tab's model or --model.",
  $fast: "Quick, cheap work such as the quick planner. Unset, it is the run model.",
  $coding: "Writing code. Unset, it uses the /router Code slot, then the run model.",
  $review: "Reviewing work. Unset, it uses the /router Review slot, then the run model.",
};

/** A readable name for a row: `spec-author` becomes `Spec author`; classes keep `$name`. */
export function plainName(row: RoutingRow): string {
  if (row.target.kind === "class") return row.label;
  const words = row.label.replace(/[-_]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : row.label;
}

/** How each effort choice reads in the form. */
export function effortLabel(effort: Effort | null): string {
  if (effort === null) return "inherit";
  if (effort === "default") return "model default";
  return effort;
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

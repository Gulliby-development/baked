/**
 * The stage table of `GET /v1/workflow/route`, shaped as `baked workflow route` prints it
 * (formatRoute in src/headless/workflow.ts): a stage without its own model shows its profile's
 * route, and one whose agents each keep their profile's model says so.
 */
import type { RouteExplanation } from "../../client/setup.js";

export interface RouteRow {
  stageId: string;
  kind: string;
  /** The model the stage runs, or null when each agent keeps its profile's model. */
  model: string | null;
  /** Why: the routing key, class or profile the model comes from. */
  source: string;
  effort: string | null;
  fallback: string[];
}

export function routeRows(route: RouteExplanation): RouteRow[] {
  return route.stages.map((stage) => {
    const own = stage.profileId ? route.profiles[stage.profileId] : undefined;
    if (stage.model)
      return {
        stageId: stage.stageId,
        kind: stage.kind,
        model: stage.model,
        source: stage.source ?? "-",
        effort: stage.effort,
        fallback: stage.fallback,
      };
    return {
      stageId: stage.stageId,
      kind: stage.kind,
      model: own?.model ?? null,
      source: own ? `${own.source} via ${stage.profileId}` : "each agent's profile",
      effort: own?.effort ?? null,
      fallback: own?.fallback ?? [],
    };
  });
}

/** Effort and fallback models of a row as one line, or "" when neither is set. */
export function routeExtras(row: Pick<RouteRow, "effort" | "fallback">): string {
  return [
    ...(row.effort && row.effort !== "default" ? [`${row.effort} effort`] : []),
    ...(row.fallback.length ? [`→ ${row.fallback.join(", ")}`] : []),
  ].join(" · ");
}

/** The distinct models a run would use, in stage order; for the panel's summary line. */
export function routeModels(rows: RouteRow[]): string[] {
  return [...new Set(rows.flatMap((row) => (row.model ? [row.model] : [])))];
}

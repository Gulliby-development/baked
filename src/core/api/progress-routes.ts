/**
 * Long-running work of this server (`GET /v1/progress`): opening the project, indexing the code
 * graph, starting a run. JSON answers the current list; otherwise the list streams as Server-Sent
 * Events whenever it changes. The producers report into src/core/progress.ts.
 */
import type { ProgressTracker } from "../progress.js";
import type { RouteContext } from "./route-context.js";

export interface ProgressRouteContext extends RouteContext {
  tracker: ProgressTracker;
}

/** Answers a progress request, or returns null when the path is not one. */
export function progressRoute(ctx: ProgressRouteContext): Response | null {
  if (ctx.path !== "/v1/progress") return null;
  ctx.only("GET");
  if (ctx.wantsJson()) return ctx.json(200, { items: ctx.tracker.list() });
  ctx.keepOpen();
  let last: string | null = null;
  return ctx.poll((send) => {
    const items = ctx.tracker.list();
    const key = JSON.stringify(items);
    if (key === last) return;
    last = key;
    send(`event: progress\ndata: ${JSON.stringify({ items })}\n\n`);
  });
}

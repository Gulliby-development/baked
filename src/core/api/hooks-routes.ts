/**
 * Hooks over the local API (`hooks` capability): the configured hooks of the workspace and the
 * events switched off for this server process, which is what `/hooks` does in the terminal UI.
 * The API only lists hooks and switches events on or off for the process; it never creates or
 * changes a hook command. Core logic is in src/core/hooks/overview.ts.
 */
import { z } from "zod";
import { hooksOverview, setHookEventEnabled } from "../hooks/overview.js";
import { HOOK_EVENTS } from "../hooks/types.js";
import type { RouteContext } from "./route-context.js";

export interface HooksRouteContext extends RouteContext {
  workspace: string;
}

const SessionBody = z.strictObject({ event: z.enum(HOOK_EVENTS), enabled: z.boolean() });

/** Answers a hooks request, or returns null when the path is not one. */
export async function hooksRoute(ctx: HooksRouteContext): Promise<Response | null> {
  if (ctx.path === "/v1/hooks") {
    ctx.only("GET");
    return ctx.json(200, hooksOverview(ctx.workspace));
  }
  if (ctx.path === "/v1/hooks/session") {
    ctx.only("POST");
    const body = SessionBody.parse(await ctx.readJson());
    setHookEventEnabled(body.event, body.enabled);
    return ctx.json(200, hooksOverview(ctx.workspace));
  }
  return null;
}

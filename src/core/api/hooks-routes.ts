/**
 * Hooks over the local API: the configured hooks of the workspace and the events switched off for
 * this server process (`hooks` capability), and creating, changing and removing hooks in BAKED's
 * own config files (`hooks-edit` capability). Claude Code's `.claude` files are never written.
 * Core logic is in src/core/hooks/overview.ts and src/core/hooks/edit.ts.
 */
import { z } from "zod";
import { addHook, HookEditError, MAX_HOOK_TIMEOUT, removeHook, updateHook } from "../hooks/edit.js";
import { hooksOverview, setHookEventEnabled } from "../hooks/overview.js";
import { HOOK_EVENTS } from "../hooks/types.js";
import type { RouteContext } from "./route-context.js";

export interface HooksRouteContext extends RouteContext {
  workspace: string;
}

const SessionBody = z.strictObject({ event: z.enum(HOOK_EVENTS), enabled: z.boolean() });

const Fields = {
  event: z.enum(HOOK_EVENTS),
  matcher: z.string().max(500).nullish(),
  timeout: z.number().int().min(1).max(MAX_HOOK_TIMEOUT).nullish(),
  async: z.boolean().optional(),
  once: z.boolean().optional(),
  if: z.string().max(500).nullish(),
};
const Scope = z.enum(["project", "user"]);
const AddBody = z.strictObject({ ...Fields, scope: Scope, command: z.string().max(10_000) });
const UpdateBody = z.strictObject({
  ...Fields,
  id: z.string().max(300),
  rev: z.string().max(64),
  scope: Scope.optional(),
  command: z.string().max(10_000).optional(),
});
const RemoveBody = z.strictObject({ id: z.string().max(300), rev: z.string().max(64) });

const STATUS = { invalid: 400, "not-found": 404, conflict: 409 } as const;
const CODE = {
  invalid: "INVALID_REQUEST",
  "not-found": "NOT_FOUND",
  conflict: "CONFLICT",
} as const;

/** Answers a hooks request, or returns null when the path is not one. */
export async function hooksRoute(ctx: HooksRouteContext): Promise<Response | null> {
  if (ctx.path === "/v1/hooks") {
    ctx.only("GET", "POST", "PUT", "DELETE");
    try {
      if (ctx.method === "POST") {
        const { scope, ...draft } = AddBody.parse(await ctx.readJson());
        addHook(ctx.workspace, scope, draft);
      } else if (ctx.method === "PUT") {
        const { id, rev, ...change } = UpdateBody.parse(await ctx.readJson());
        updateHook(ctx.workspace, id, rev, change);
      } else if (ctx.method === "DELETE") {
        const { id, rev } = RemoveBody.parse(await ctx.readJson());
        removeHook(ctx.workspace, id, rev);
      }
    } catch (error) {
      if (error instanceof HookEditError)
        ctx.fail(STATUS[error.kind], CODE[error.kind], error.message);
      throw error;
    }
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

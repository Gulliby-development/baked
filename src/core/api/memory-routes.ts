/**
 * Project memory over the local API (`/v1/workflow/memory`): what earlier runs taught new runs and
 * the notes people keep, with the changes `baked workflow memory` makes. Core logic lives in
 * src/core/workflows/project-memory.ts; the terminal UI's `/memory` Runs tab uses the same.
 */
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import { criticOutcomesView } from "../workflows/critic-outcomes.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { editProjectMemory, MAX_NOTE, projectMemoryView } from "../workflows/project-memory.js";
import { PolicySchema } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RouteContext } from "./route-context.js";

export interface MemoryRouteContext extends RouteContext {
  config: AppConfig;
  store: WorkflowStore;
}

const Id = z.string().regex(/^[a-z]-[0-9a-f]{10}$/);
const Text = z
  .string()
  .min(1)
  .max(MAX_NOTE * 4);
const EditBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("add"), text: Text }),
  z.strictObject({ action: z.literal("edit"), id: Id, text: Text }),
  z.strictObject({ action: z.literal("forget"), id: Id }),
  z.strictObject({ action: z.literal("restore"), id: Id }),
]);

/**
 * `GET /v1/workflow/critic[?runId=ID]`: the critic outcome log with its calibration, as
 * `baked workflow outcomes` shows it (capability `critic-outcomes`).
 */
export function criticOutcomesRoute(ctx: MemoryRouteContext): Response | null {
  if (ctx.path !== "/v1/workflow/critic") return null;
  ctx.only("GET");
  const runId = ctx.url.searchParams.get("runId") ?? undefined;
  return ctx.json(200, criticOutcomesView(ctx.store, runId));
}

/** Answers a project memory request, or returns null when the path is not one. */
export async function memoryRoute(ctx: MemoryRouteContext): Promise<Response | null> {
  if (ctx.path !== "/v1/workflow/memory") return null;
  ctx.only("GET", "POST");
  const policy = () => PolicySchema.parse(ctx.config.workflows?.policy ?? defaultWorkflowPolicy);
  if (ctx.method === "GET") return ctx.json(200, projectMemoryView(ctx.store, policy()));
  const id = editProjectMemory(ctx.store, EditBody.parse(await ctx.readJson()));
  return ctx.json(200, { id, ...projectMemoryView(ctx.store, policy()) });
}

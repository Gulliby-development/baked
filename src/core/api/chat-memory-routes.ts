/**
 * Long-term chat memory over the local API (`/v1/memory*`): what the chat agent remembers across
 * sessions, with the changes the terminal UI's `/memory` browser makes. Core logic lives in
 * src/core/memory/browse.ts. Workflow run memory is `/v1/workflow/memory` (memory-routes.ts).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  applyChatMemoryCleanup,
  chatMemoryCleanup,
  chatMemoryView,
  editChatMemory,
  setChatMemorySettings,
} from "../memory/browse.js";
import type { MemoryManager } from "../memory/manager.js";
import { MEMORY_CATEGORIES } from "../memory/types.js";
import type { RouteContext } from "./route-context.js";

export interface ChatMemoryRouteContext extends RouteContext {
  workspace: string;
  /** The memory store chat sessions use; opened on the first request. */
  memory: () => Promise<MemoryManager>;
}

const Scope = z.enum(["project", "global"]);
const Id = z.string().min(1).max(200);
const Target = { scope: Scope, id: Id };
const EditBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("pin"), ...Target }),
  z.strictObject({ action: z.literal("unpin"), ...Target }),
  z.strictObject({ action: z.literal("hide"), ...Target }),
  z.strictObject({ action: z.literal("restore"), ...Target }),
  z.strictObject({
    action: z.literal("edit"),
    ...Target,
    summary: z.string().trim().min(1).max(2000),
    details: z.string().max(20_000).optional(),
    category: z
      .enum(MEMORY_CATEGORIES as ["pref", "decision", "gotcha", "context"])
      .nullable()
      .optional(),
  }),
  z.strictObject({ action: z.literal("purge"), scope: z.enum(["project", "global", "all"]) }),
]);
const SettingsBody = z
  .strictObject({
    writeScope: z.enum(["project", "global", "none"]).optional(),
    readScope: z.enum(["project", "global", "all", "none"]).optional(),
    settingsScope: Scope.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Name at least one setting");
const CleanupBody = z.strictObject({
  actions: z.array(z.strictObject({ ...Target, action: z.enum(["hide", "pin"]) })).max(1000),
});

/** Answers a chat memory request, or returns null when the path is not one. */
export async function chatMemoryRoute(ctx: ChatMemoryRouteContext): Promise<Response | null> {
  if (ctx.path === "/v1/memory") {
    ctx.only("GET", "POST");
    const memory = await ctx.memory();
    if (ctx.method === "GET") return ctx.json(200, chatMemoryView(memory));
    const edit = EditBody.parse(await ctx.readJson());
    if (edit.action === "purge") {
      const cleared = memory.clearScope(edit.scope);
      return ctx.json(200, { cleared, ...chatMemoryView(memory) });
    }
    let found: boolean;
    try {
      found = editChatMemory(memory, edit);
    } catch (error) {
      // The only write failure an edit can hit: another memory already holds the same text.
      ctx.fail(409, "DUPLICATE_MEMORY", error instanceof Error ? error.message : String(error));
    }
    if (!found) ctx.fail(404, "NOT_FOUND", `No ${edit.scope} memory ${edit.id}`);
    return ctx.json(200, chatMemoryView(memory));
  }
  if (ctx.path === "/v1/memory/settings") {
    ctx.only("PUT");
    const memory = await ctx.memory();
    setChatMemorySettings(memory, SettingsBody.parse(await ctx.readJson()));
    return ctx.json(200, chatMemoryView(memory));
  }
  if (ctx.path === "/v1/memory/cleanup") {
    ctx.only("GET", "POST");
    const memory = await ctx.memory();
    if (ctx.method === "GET") {
      const fileExists = (path: string): boolean => {
        try {
          return existsSync(isAbsolute(path) ? path : join(ctx.workspace, path));
        } catch {
          return false;
        }
      };
      return ctx.json(200, { candidates: chatMemoryCleanup(memory, fileExists) });
    }
    const { actions } = CleanupBody.parse(await ctx.readJson());
    const applied = applyChatMemoryCleanup(memory, actions);
    return ctx.json(200, { applied, ...chatMemoryView(memory) });
  }
  return null;
}

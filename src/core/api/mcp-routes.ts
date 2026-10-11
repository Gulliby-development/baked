/**
 * MCP servers over the local API (`/v1/mcp`): the servers of the global and project config with
 * their live status and tools, and the changes `/mcp` makes in the terminal UI. Config edits go
 * through src/core/mcp/config.ts; connections through the process's MCPManager.
 */
import { join } from "node:path";
import { z } from "zod";
import { loadEffectiveProjectConfig, mergeMCPServers } from "../../config/index.js";
import { useMCPStore } from "../../stores/mcp.js";
import type { AppConfig } from "../../types/index.js";
import {
  applyMCPChange,
  type MCPChange,
  MCPChangeError,
  type MCPConfigFiles,
  type MCPLayers,
  MCPServerSchema,
  mcpServerViews,
  readMCPLayers,
  writeMCPLayers,
} from "../mcp/config.js";
import { getMCPManager, type MCPManager } from "../mcp/index.js";
import { configDir as defaultConfigDir } from "../platform/index.js";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import type { RouteContext } from "./route-context.js";

export interface McpRouteContext extends RouteContext {
  workspace: string;
  /** The running server's config; its `mcpServers` follow every change. */
  config: AppConfig;
  /** The user configuration directory; tests point it elsewhere. */
  configDir?: string;
  /** Defaults to the process's manager, which chats and runs use too. */
  manager?: MCPManager;
}

const Scope = z.enum(["global", "project"]);
const AddBody = z.strictObject({ scope: Scope, server: MCPServerSchema });
const PatchBody = z.union([
  z.strictObject({ scope: Scope, server: MCPServerSchema, toScope: Scope.optional() }),
  z.strictObject({ scope: Scope, disabled: z.boolean() }),
]);
const ScopeQuery = z.strictObject({ scope: Scope });
const ITEM = /^\/v1\/mcp\/([^/]+)(?:\/(reconnect|ping))?$/;

const CHANGE_STATUS = { NOT_FOUND: 404, CONFLICT: 409, INVALID: 400 } as const;

/** Answers an MCP request, or returns null when the path is not one. */
export async function mcpRoute(ctx: McpRouteContext): Promise<Response | null> {
  const { path, method, workspace } = ctx;
  if (path !== "/v1/mcp" && !path.startsWith("/v1/mcp/")) return null;
  const manager = ctx.manager ?? getMCPManager();
  const files: MCPConfigFiles = {
    global: join(ctx.configDir ?? defaultConfigDir(), "config.json"),
    project: join(workspace, ".baked", "config.json"),
  };
  const layers = (): MCPLayers => {
    try {
      return readMCPLayers(files);
    } catch (error) {
      return ctx.fail(409, "INPUT_CHANGED", error instanceof Error ? error.message : String(error));
    }
  };
  const view = (current = layers()) => ({
    servers: mcpServerViews(current, useMCPStore.getState().servers),
    started: manager.started,
    paths: files,
  });

  const change = (current: MCPLayers, edit: MCPChange) => {
    let lists: Partial<MCPLayers>;
    try {
      lists = applyMCPChange(current, edit);
    } catch (error) {
      if (error instanceof MCPChangeError)
        ctx.fail(
          CHANGE_STATUS[error.code],
          error.code === "INVALID" ? "INVALID_REQUEST" : error.code,
          error.message,
        );
      throw error;
    }
    if (lists.project) ensurebakedDir(workspace);
    writeMCPLayers(files, lists);
    const next = { ...current, ...lists };
    const project = loadEffectiveProjectConfig(workspace)?.mcpServers;
    const servers = mergeMCPServers(next.global, project);
    if (servers?.length) ctx.config.mcpServers = servers;
    else delete ctx.config.mcpServers;
    // Once anything connected, follow the config now: drop removed and disabled servers and
    // reconnect changed ones. Before that, the first chat message or run step connects them.
    if (manager.started) void manager.connectAll(ctx.config.mcpServers ?? []).catch(() => {});
    return ctx.json(200, view(next));
  };

  if (path === "/v1/mcp") {
    ctx.only("GET", "POST");
    if (method === "GET") return ctx.json(200, view());
    const body = AddBody.parse(await ctx.readJson());
    return change(layers(), { action: "add", scope: body.scope, server: body.server });
  }

  const match = ITEM.exec(path);
  if (!match) return ctx.fail(404, "NOT_FOUND", `No endpoint at ${path}`);
  const name = decodeURIComponent(match[1] ?? "");
  const action = match[2];

  if (action) {
    ctx.only("POST");
    const config = (ctx.config.mcpServers ?? []).find((s) => s.name === name);
    if (!config) return ctx.fail(404, "NOT_FOUND", `No MCP server named ${name}`);
    if (config.disabled)
      return ctx.fail(409, "DISABLED", `MCP server ${name} is disabled; enable it first`);
    if (action === "reconnect") {
      await manager.restart(config);
      return ctx.json(200, view());
    }
    if (!manager.isConnected(name))
      return ctx.fail(409, "NOT_CONNECTED", `MCP server ${name} is not connected`);
    let ms: number;
    try {
      ms = await manager.ping(name);
    } catch (error) {
      return ctx.fail(502, "PING_FAILED", error instanceof Error ? error.message : String(error));
    }
    return ctx.json(200, { ms, ...view() });
  }

  ctx.only("PATCH", "DELETE");
  if (method === "DELETE") {
    const { scope } = ctx.query(ScopeQuery);
    return change(layers(), { action: "remove", scope, name });
  }
  const body = PatchBody.parse(await ctx.readJson());
  if ("disabled" in body)
    return change(layers(), {
      action: "set-disabled",
      scope: body.scope,
      name,
      disabled: body.disabled,
    });
  return change(layers(), {
    action: "edit",
    scope: body.scope,
    name,
    server: body.server,
    ...(body.toScope ? { toScope: body.toScope } : {}),
  });
}

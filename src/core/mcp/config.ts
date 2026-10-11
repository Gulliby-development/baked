/**
 * MCP server entries of the global and project config: listing them with their live status and
 * changing them. The terminal UI's `/mcp`, the local API (`/v1/mcp`) and `baked mcp` use these, so
 * every surface edits the config the same way. Connections stay in MCPManager.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { MCPServerState, MCPServerStatus } from "../../stores/mcp.js";
import type { MCPServerConfig } from "../../types/index.js";

export type MCPScope = "global" | "project";

/** The `mcpServers` lists of the two config files. */
export interface MCPLayers {
  global: MCPServerConfig[];
  project: MCPServerConfig[];
}

export type MCPChange =
  | { action: "add"; scope: MCPScope; server: MCPServerConfig }
  /** Replaces the entry `name` of `scope`; `toScope` moves it to the other config file. */
  | { action: "edit"; scope: MCPScope; name: string; server: MCPServerConfig; toScope?: MCPScope }
  | { action: "remove"; scope: MCPScope; name: string }
  | { action: "set-disabled"; scope: MCPScope; name: string; disabled: boolean };

export type MCPChangeErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID";

export class MCPChangeError extends Error {
  constructor(
    readonly code: MCPChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MCPChangeError";
  }
}

export interface MCPToolView {
  name: string;
  description: string;
}

/** One server as the effective config sees it: a project entry replaces a global one. */
export interface MCPServerView {
  name: string;
  scope: MCPScope;
  /** A global entry with the same name that this project entry replaces. */
  overridesGlobal: boolean;
  transport: "stdio" | "http" | "sse";
  config: MCPServerConfig;
  /** `idle` until something connects the server (the first chat message or run step). */
  status: MCPServerStatus | "idle";
  error: string | null;
  tools: MCPToolView[];
  connectedAt: number | null;
  lastPingMs: number | null;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const Pairs = z.record(z.string().min(1).max(200), z.string().max(8192));

export const MCPServerSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .regex(NAME, "Use 1-64 letters, digits, dots, dashes or underscores, starting with one"),
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().trim().min(1).max(4096).optional(),
    args: z.array(z.string().max(4096)).max(200).optional(),
    env: Pairs.optional(),
    url: z.string().trim().max(4096).optional(),
    timeout: z.number().int().min(1000).max(3_600_000).optional(),
    disabled: z.boolean().optional(),
    headers: Pairs.optional(),
  })
  .superRefine((server, ctx) => {
    const transport = server.transport ?? "stdio";
    if (transport === "stdio") {
      if (!server.command)
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message: "A stdio server needs a command",
        });
      return;
    }
    let url: URL | null = null;
    try {
      url = server.url ? new URL(server.url) : null;
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: `An ${transport} server needs an http(s) URL`,
      });
  });

/** Drops fields the server's transport does not use and empty optional fields. */
export function normalizeMCPServer(server: MCPServerConfig): MCPServerConfig {
  const transport = server.transport ?? "stdio";
  const out: MCPServerConfig = { name: server.name.trim() };
  if (transport === "stdio") {
    if (server.command) out.command = server.command.trim();
    if (server.args?.length) out.args = server.args;
  } else {
    out.transport = transport;
    if (server.url) out.url = server.url.trim();
    if (server.headers && Object.keys(server.headers).length) out.headers = server.headers;
  }
  if (server.env && Object.keys(server.env).length) out.env = server.env;
  if (server.timeout !== undefined) out.timeout = server.timeout;
  if (server.disabled) out.disabled = true;
  return out;
}

function validated(server: MCPServerConfig): MCPServerConfig {
  const parsed = MCPServerSchema.safeParse(server);
  if (!parsed.success)
    throw new MCPChangeError(
      "INVALID",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  return normalizeMCPServer(parsed.data);
}

function find(layers: MCPLayers, scope: MCPScope, name: string): MCPServerConfig {
  const found = layers[scope].find((s) => s.name === name);
  if (!found) throw new MCPChangeError("NOT_FOUND", `No ${scope} MCP server named ${name}`);
  return found;
}

function taken(list: MCPServerConfig[], name: string, scope: MCPScope): void {
  if (list.some((s) => s.name === name))
    throw new MCPChangeError("CONFLICT", `A ${scope} MCP server named ${name} already exists`);
}

/** The new `mcpServers` list of each scope the change touches. */
export function applyMCPChange(layers: MCPLayers, change: MCPChange): Partial<MCPLayers> {
  const list = layers[change.scope];
  switch (change.action) {
    case "add": {
      const server = validated(change.server);
      taken(list, server.name, change.scope);
      return { [change.scope]: [...list, server] };
    }
    case "edit": {
      const before = find(layers, change.scope, change.name);
      const server = validated({
        ...change.server,
        disabled: change.server.disabled ?? before.disabled,
      });
      const target = change.toScope ?? change.scope;
      if (target === change.scope) {
        if (server.name !== change.name) taken(list, server.name, change.scope);
        return { [change.scope]: list.map((s) => (s.name === change.name ? server : s)) };
      }
      taken(layers[target], server.name, target);
      return {
        [change.scope]: list.filter((s) => s.name !== change.name),
        [target]: [...layers[target], server],
      };
    }
    case "remove":
      find(layers, change.scope, change.name);
      return { [change.scope]: list.filter((s) => s.name !== change.name) };
    case "set-disabled": {
      find(layers, change.scope, change.name);
      return {
        [change.scope]: list.map((s) => {
          if (s.name !== change.name) return s;
          const { disabled: _, ...rest } = s;
          return change.disabled ? { ...rest, disabled: true } : rest;
        }),
      };
    }
  }
}

/** The effective servers, project entries first in config order, then the remaining global ones. */
export function mcpServerViews(
  layers: MCPLayers,
  live: Record<string, MCPServerState>,
): MCPServerView[] {
  const projectNames = new Set(layers.project.map((s) => s.name));
  const globalNames = new Set(layers.global.map((s) => s.name));
  const entries: [MCPServerConfig, MCPScope][] = [
    ...layers.project.map((s): [MCPServerConfig, MCPScope] => [s, "project"]),
    ...layers.global
      .filter((s) => !projectNames.has(s.name))
      .map((s): [MCPServerConfig, MCPScope] => [s, "global"]),
  ];
  return entries.map(([config, scope]) => {
    const state = live[config.name];
    const status: MCPServerView["status"] = config.disabled
      ? "disabled"
      : state && state.status !== "disabled"
        ? state.status
        : "idle";
    const active = status !== "disabled" && status !== "idle";
    return {
      name: config.name,
      scope,
      overridesGlobal: scope === "project" && globalNames.has(config.name),
      transport: config.transport ?? "stdio",
      config,
      status,
      error: active ? (state?.error ?? null) : null,
      tools: active
        ? (state?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description }))
        : [],
      connectedAt: active ? (state?.connectedAt ?? null) : null,
      lastPingMs: active ? (state?.lastPingMs ?? null) : null,
    };
  });
}

function readObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${file} does not hold a JSON object`);
  return parsed as Record<string, unknown>;
}

function serversOf(file: string): MCPServerConfig[] {
  const value = readObject(file).mcpServers;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`mcpServers in ${file} is not a list`);
  return value.filter(
    (s): s is MCPServerConfig =>
      !!s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string",
  );
}

/** The config files that hold MCP servers. */
export interface MCPConfigFiles {
  global: string;
  project: string;
}

export function readMCPLayers(files: MCPConfigFiles): MCPLayers {
  return { global: serversOf(files.global), project: serversOf(files.project) };
}

/** Writes the changed lists into their files, keeping every other key; an empty list is removed. */
export function writeMCPLayers(files: MCPConfigFiles, lists: Partial<MCPLayers>): void {
  for (const scope of ["global", "project"] as const) {
    const list = lists[scope];
    if (!list) continue;
    const file = files[scope];
    const next = readObject(file);
    if (list.length) next.mcpServers = list;
    else delete next.mcpServers;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  }
}

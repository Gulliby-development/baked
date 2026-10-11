/**
 * MCP servers of the project's backend (`/v1/mcp`, `mcp` capability): the servers of the global
 * and project config with their status and tools, and the changes `/mcp` makes in the terminal.
 * Shapes follow `docs/desktop/api.md`.
 */
import { ApiError, call } from "./api.js";
import { MCP_CAPABILITY, offers } from "./capabilities.js";

export type McpScope = "global" | "project";
export type McpTransport = "stdio" | "http" | "sse";
export type McpStatus = "idle" | "disconnected" | "connecting" | "ready" | "error" | "disabled";

/** An entry of `mcpServers` in a config file. */
export interface McpServerConfig {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  disabled?: boolean;
}

export interface McpServer {
  name: string;
  scope: McpScope;
  /** A global server with the same name that this project server replaces. */
  overridesGlobal: boolean;
  transport: McpTransport;
  config: McpServerConfig;
  /** `idle`: nothing connected it yet; the first chat message or run step does. */
  status: McpStatus;
  error: string | null;
  tools: { name: string; description: string }[];
  connectedAt: number | null;
  lastPingMs: number | null;
}

export interface McpView {
  servers: McpServer[];
  /** Whether the backend connected servers yet; config changes reconnect them only then. */
  started: boolean;
  paths: { global: string; project: string };
}

const item = (name: string) => `/v1/mcp/${encodeURIComponent(name)}`;

async function offered(key: string): Promise<void> {
  let capabilities: string[] | null = null;
  try {
    capabilities =
      (await call<{ capabilities?: string[] }>(key, "GET", "/v1/health")).capabilities ?? null;
  } catch {
    capabilities = null;
  }
  if (offers(capabilities, MCP_CAPABILITY) === false)
    throw new ApiError(404, "NOT_FOUND", "This BAKED has no MCP endpoints");
}

export const mcp = {
  list: async (key: string) => {
    await offered(key);
    return call<McpView>(key, "GET", "/v1/mcp");
  },
  add: (key: string, scope: McpScope, server: McpServerConfig) =>
    call<McpView>(key, "POST", "/v1/mcp", { scope, server }),
  /** Replaces the server `name` of `scope`; `toScope` moves it to the other config file. */
  edit: (key: string, scope: McpScope, name: string, server: McpServerConfig, toScope?: McpScope) =>
    call<McpView>(key, "PATCH", item(name), { scope, server, ...(toScope ? { toScope } : {}) }),
  setDisabled: (key: string, scope: McpScope, name: string, disabled: boolean) =>
    call<McpView>(key, "PATCH", item(name), { scope, disabled }),
  remove: (key: string, scope: McpScope, name: string) =>
    call<McpView>(key, "DELETE", `${item(name)}?scope=${scope}`),
  /** Connects the server again and waits for its tools; 409 DISABLED for a disabled one. */
  reconnect: (key: string, name: string) =>
    call<McpView>(key, "POST", `${item(name)}/reconnect`, {}),
  /** 409 NOT_CONNECTED until the server is connected. */
  ping: (key: string, name: string) =>
    call<McpView & { ms: number }>(key, "POST", `${item(name)}/ping`, {}),
};

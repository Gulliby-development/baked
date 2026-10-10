import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "ai";
import { type MCPToolInfo, useMCPStore } from "../../stores/mcp.js";
import type { MCPServerConfig } from "../../types/index.js";

/** Max concurrent MCP server connections to avoid flooding the event loop */
const MAX_CONCURRENT = 4;

/**
 * Fetch for remote MCP transports. Redirects stay rejected (the @ai-sdk/mcp default, which
 * guards against a server steering requests and headers to another host), but the error names
 * the server and the redirect target instead of a bare fetch failure.
 */
export function redirectRejectingFetch(serverName: string): typeof fetch {
  const rejecting = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await fetch(input, { ...init, redirect: "manual" });
    const redirected =
      response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
    if (!redirected) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    const base = input instanceof Request ? input.url : String(input);
    let target = "";
    if (location) {
      try {
        target = ` to ${new URL(location, base).href}`;
      } catch {
        target = ` to ${location}`;
      }
    }
    throw new Error(
      `MCP server "${serverName}" redirected (HTTP ${String(response.status)})${target}. Redirects are not followed; set the server url to the final address.`,
    );
  };
  return rejecting as typeof fetch;
}

interface MCPConnection {
  client: MCPClient;
  config: MCPServerConfig;
  /** Cached AI SDK tools from the last .tools() call */
  toolSet: Record<string, Tool>;
}

export class MCPManager {
  private connections = new Map<string, MCPConnection>();
  private restartCounts = new Map<string, number>();
  private restartPending = new Set<string>();
  private disposed = false;
  private static MAX_RESTARTS = 3;
  private pendingSync: MCPServerConfig[] | null = null;
  private syncing = false;

  async connectAll(configs: MCPServerConfig[]): Promise<void> {
    // Serialize: if already syncing, queue the latest config and return.
    // Only the most recent config matters — intermediate states are skipped.
    if (this.syncing) {
      this.pendingSync = configs;
      return;
    }
    this.syncing = true;
    try {
      await this.doSync(configs);
    } finally {
      this.syncing = false;
      // If a new config arrived while we were syncing, process it now
      if (this.pendingSync) {
        const next = this.pendingSync;
        this.pendingSync = null;
        this.connectAll(next);
      }
    }
  }

  private async doSync(configs: MCPServerConfig[]): Promise<void> {
    const newNames = new Set(configs.map((c) => c.name));

    // 1. Disconnect servers removed from config or newly disabled
    const toDisconnect = [...this.connections.keys()].filter((n) => {
      if (!newNames.has(n)) return true; // removed
      const cfg = configs.find((c) => c.name === n);
      return cfg?.disabled === true; // newly disabled
    });
    await Promise.allSettled(toDisconnect.map((n) => this.disconnect(n)));

    // 2. Update store — setServers handles disabled/enabled transitions
    useMCPStore.getState().setServers(configs);

    // 3. Determine which servers need (re)connection
    const toConnect = configs.filter((c) => {
      if (c.disabled) return false;
      const conn = this.connections.get(c.name);
      if (!conn) return true; // new or disconnected — connect
      // Already connected — reconnect only if config changed
      const old = conn.config;
      return (
        old.command !== c.command ||
        old.url !== c.url ||
        old.transport !== c.transport ||
        JSON.stringify(old.args) !== JSON.stringify(c.args) ||
        JSON.stringify(old.env) !== JSON.stringify(c.env) ||
        JSON.stringify(old.headers) !== JSON.stringify(c.headers)
      );
    });

    // 4. Connect with bounded concurrency
    const queue = [...toConnect];
    const run = async () => {
      let config = queue.shift();
      while (config) {
        await this.connect(config);
        config = queue.shift();
      }
    };
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, toConnect.length) }, () => run());
    await Promise.allSettled(workers);
  }

  async connect(config: MCPServerConfig): Promise<void> {
    if (this.disposed) return;
    const { name } = config;

    await this.disconnect(name);
    useMCPStore.getState().setServerStatus(name, "connecting");

    let client: MCPClient | null = null;
    // stdio = custom MCPTransport with start/send/close. HTTP/SSE = plain config object.
    let isCustomTransport = false;
    try {
      const transport = this.createTransport(config);
      isCustomTransport = typeof transport === "object" && "start" in transport;
      if (isCustomTransport && "onclose" in transport) {
        const originalOnclose = transport.onclose;
        transport.onclose = () => {
          originalOnclose?.();
          this.connections.delete(name);
          if (!this.disposed) this.scheduleRestart(config);
        };
        transport.onerror = (err: Error) => {
          useMCPStore.getState().setServerStatus(name, "error", err.message);
        };
      }

      // Timeout the entire connect+tools handshake — a broken server shouldn't block the queue
      const connectTimeout = config.timeout ?? 30_000;
      client = await withTimeout(
        createMCPClient({
          transport,
          name: `baked-${name}`,
          // For stdio: onUncaughtError triggers restart (process crashed).
          // For http/sse: only log — transport errors are non-fatal (SSE probe 404, etc.)
          onUncaughtError: isCustomTransport
            ? (err) => {
                if (this.disposed) return;
                const msg = err instanceof Error ? err.message : String(err);
                useMCPStore.getState().setServerStatus(name, "error", msg);
                this.connections.delete(name);
                this.scheduleRestart(config);
              }
            : undefined,
        }),
        connectTimeout,
        `MCP server "${name}": connection timed out`,
      );

      const toolSet = await withTimeout(
        client.tools(),
        connectTimeout,
        `MCP server "${name}": tool discovery timed out`,
      );

      const toolInfos: MCPToolInfo[] = Object.entries(toolSet).map(([toolName, t]) => ({
        name: toolName,
        // MCP servers always send string descriptions; AI SDK 7 also allows functions.
        description: typeof t.description === "string" ? t.description : "",
        serverName: name,
        inputSchema: {} as Record<string, unknown>,
      }));

      this.connections.set(name, { client, config, toolSet: toolSet as Record<string, Tool> });
      client = null; // Ownership transferred — don't close in finally

      // Single batched store update — status + tools in one set() to avoid double re-render
      useMCPStore.setState((s) => {
        const srv = s.servers[name];
        if (!srv) return s;
        return {
          servers: {
            ...s.servers,
            [name]: {
              ...srv,
              status: "ready",
              error: null,
              connectedAt: Date.now(),
              tools: toolInfos,
            },
          },
        };
      });
      this.restartCounts.set(name, 0);
    } catch (err) {
      // Clean up the client if it was created but we failed during tool discovery
      if (client) {
        try {
          await client.close();
        } catch {}
      }
      const msg = err instanceof Error ? err.message : String(err);
      useMCPStore.getState().setServerStatus(name, "error", msg);
      // Only auto-restart stdio transports (local subprocesses that may have crashed).
      // HTTP/SSE are remote — if they fail, the user should retry manually.
      if (isCustomTransport) this.scheduleRestart(config);
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    try {
      await conn.client.close();
    } catch {}
  }

  async reconnect(name: string): Promise<void> {
    const state = useMCPStore.getState().servers[name];
    if (!state) return;
    this.restartCounts.set(name, 0);
    await this.connect(state.config);
  }

  /** Debounced restart — prevents double-restart when both onclose and onUncaughtError fire. */
  private scheduleRestart(config: MCPServerConfig): void {
    if (this.disposed || this.restartPending.has(config.name)) return;
    this.restartPending.add(config.name);

    const count = this.restartCounts.get(config.name) ?? 0;
    if (count >= MCPManager.MAX_RESTARTS) {
      this.restartPending.delete(config.name);
      useMCPStore.getState().setServerStatus(config.name, "error", "Max restarts exceeded");
      return;
    }
    this.restartCounts.set(config.name, count + 1);
    const delay = Math.min(1000 * 2 ** count, 8000);
    setTimeout(() => {
      this.restartPending.delete(config.name);
      if (!this.disposed) this.connect(config);
    }, delay);
  }

  private createTransport(config: MCPServerConfig) {
    const { transport = "stdio", url, command, args, env, headers } = config;

    // Streamable HTTP — modern remote transport (recommended)
    if (transport === "http") {
      if (!url) throw new Error(`MCP server "${config.name}": http transport requires a url`);
      return { type: "http" as const, url, headers, fetch: redirectRejectingFetch(config.name) };
    }

    // SSE — legacy remote transport
    if (transport === "sse") {
      if (!url) throw new Error(`MCP server "${config.name}": sse transport requires a url`);
      return { type: "sse" as const, url, headers, fetch: redirectRejectingFetch(config.name) };
    }

    // stdio — local subprocess (uses raw SDK transport as custom MCPTransport)
    if (!command)
      throw new Error(`MCP server "${config.name}": stdio transport requires a command`);
    return new StdioClientTransport({
      command,
      args,
      env: env
        ? Object.fromEntries(
            Object.entries({ ...process.env, ...env }).filter(
              (e): e is [string, string] => e[1] != null,
            ),
          )
        : undefined,
      stderr: "pipe",
    });
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);

    const t = conn.toolSet[toolName];
    if (!t?.execute) throw new Error(`MCP tool "${toolName}" not found on server "${serverName}"`);

    const timeout = conn.config.timeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const result = await t.execute(args, {
        toolCallId: `mcp-${Date.now()}`,
        messages: [],
        abortSignal: controller.signal,
        // MCP tools declare no contextSchema; the SDK passes undefined for them too.
        context: undefined,
      });
      if (typeof result === "string") return result;
      return JSON.stringify(result) || "(empty response)";
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(serverName: string): Promise<number> {
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);
    const start = performance.now();
    // Use listTools as a lightweight health check — the AI SDK client doesn't expose ping
    await conn.client.listTools();
    const ms = Math.round(performance.now() - start);
    useMCPStore.getState().setServerPing(serverName, ms);
    return ms;
  }

  getTools(): Record<string, Tool> {
    const result: Record<string, Tool> = {};
    const servers = useMCPStore.getState().servers;

    for (const [serverName, state] of Object.entries(servers)) {
      if (state.status !== "ready") continue;
      const conn = this.connections.get(serverName);
      if (!conn) continue;

      for (const [toolName, toolDef] of Object.entries(conn.toolSet)) {
        const qualifiedName = sanitizeToolName(`mcp__${serverName}__${toolName}`);
        result[qualifiedName] = {
          ...toolDef,
          description: `[mcp:${serverName}] ${toolDef.description ?? ""}`,
        } as Tool;
      }
    }
    return result;
  }

  getServerNames(): string[] {
    return [...this.connections.keys()];
  }

  isConnected(name: string): boolean {
    return this.connections.has(name);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }
}

/** Sanitize tool names to match API pattern: ^[a-zA-Z0-9_-]{1,128}$ */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

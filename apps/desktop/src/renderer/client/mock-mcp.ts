import type { McpScope, McpServer, McpServerConfig, McpView } from "./mcp.js";
import { type MockRequest, type MockRoute, response } from "./mock-routes.js";

interface McpState {
  layers: Record<McpScope, McpServerConfig[]>;
  live: Record<string, Pick<McpServer, "status" | "error" | "tools" | "connectedAt">>;
}

const TOOLS = {
  github: ["create_issue", "get_pull_request", "list_commits", "search_code"],
  postgres: ["query", "list_tables", "describe_table"],
};

const states = new Map<string, McpState>();

function initial(): McpState {
  const now = Date.now();
  return {
    layers: {
      global: [
        {
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "ghp_mock" },
        },
        { name: "docs", transport: "http", url: "https://mcp.example.com/mcp", disabled: true },
      ],
      project: [
        {
          name: "postgres",
          command: "uvx",
          args: ["mcp-server-postgres", "postgres://localhost/app"],
        },
        { name: "browser", transport: "http", url: "https://browser.example.com/mcp" },
      ],
    },
    live: {
      github: {
        status: "ready",
        error: null,
        connectedAt: now - 40 * 60_000,
        tools: TOOLS.github.map((name) => ({
          name,
          description: `GitHub: ${name.replace(/_/g, " ")}`,
        })),
      },
      postgres: {
        status: "ready",
        error: null,
        connectedAt: now - 12 * 60_000,
        tools: TOOLS.postgres.map((name) => ({
          name,
          description: `Postgres: ${name.replace(/_/g, " ")}`,
        })),
      },
      browser: {
        status: "error",
        error:
          'MCP server "browser" redirected (HTTP 302) to https://login.example.com/. Redirects are not followed; set the server url to the final address.',
        connectedAt: null,
        tools: [],
      },
    },
  };
}

function state(key: string): McpState {
  let s = states.get(key);
  if (!s) {
    s = initial();
    states.set(key, s);
  }
  return s;
}

function view(s: McpState): McpView {
  const projectNames = new Set(s.layers.project.map((c) => c.name));
  const globalNames = new Set(s.layers.global.map((c) => c.name));
  const entries: [McpServerConfig, McpScope][] = [
    ...s.layers.project.map((c): [McpServerConfig, McpScope] => [c, "project"]),
    ...s.layers.global
      .filter((c) => !projectNames.has(c.name))
      .map((c): [McpServerConfig, McpScope] => [c, "global"]),
  ];
  return {
    started: true,
    paths: {
      global: "C:\\Users\\you\\AppData\\Local\\baked\\config.json",
      project: "C:\\Project\\BAKED\\.baked\\config.json",
    },
    servers: entries.map(([config, scope]) => {
      const live = s.live[config.name];
      const status = config.disabled ? "disabled" : (live?.status ?? "idle");
      const active = status !== "disabled" && status !== "idle";
      return {
        name: config.name,
        scope,
        overridesGlobal: scope === "project" && globalNames.has(config.name),
        transport: config.transport ?? "stdio",
        config,
        status,
        error: active ? (live?.error ?? null) : null,
        tools: active ? (live?.tools ?? []) : [],
        connectedAt: active ? (live?.connectedAt ?? null) : null,
        lastPingMs: null,
      };
    }),
  };
}

const fail = (status: number, code: string, message: string) =>
  response(status, { error: { code, message } });

function invalid(server: McpServerConfig | undefined): string | null {
  if (!server?.name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(server.name))
    return "Use 1-64 letters, digits, dots, dashes or underscores, starting with one";
  const transport = server.transport ?? "stdio";
  if (transport === "stdio") return server.command ? null : "A stdio server needs a command";
  return /^https?:\/\/./.test(server.url ?? "")
    ? null
    : `An ${transport} server needs an http(s) URL`;
}

function connect(s: McpState, config: McpServerConfig): void {
  const known = TOOLS[config.name as keyof typeof TOOLS];
  s.live[config.name] = {
    status: "ready",
    error: null,
    connectedAt: Date.now(),
    tools: (known ?? ["search", "fetch"]).map((name) => ({
      name,
      description: `${config.name}: ${name}`,
    })),
  };
}

export const mcpRoutes: MockRoute = (request: MockRequest) => {
  const { key, method, path, query } = request;
  if (path !== "/v1/mcp" && !path.startsWith("/v1/mcp/")) return undefined;
  const s = state(key);
  const body = (request.body ?? {}) as {
    scope?: McpScope;
    toScope?: McpScope;
    server?: McpServerConfig;
    disabled?: boolean;
  };
  if (path === "/v1/mcp") {
    if (method === "GET") return response(200, view(s));
    if (method !== "POST" || !body.scope)
      return fail(400, "INVALID_REQUEST", "Send scope and server");
    const problem = invalid(body.server);
    if (problem || !body.server) return fail(400, "INVALID_REQUEST", problem ?? "Send a server");
    if (s.layers[body.scope].some((c) => c.name === body.server?.name))
      return fail(
        409,
        "CONFLICT",
        `A ${body.scope} MCP server named ${body.server.name} already exists`,
      );
    s.layers[body.scope].push(body.server);
    if (!body.server.disabled) connect(s, body.server);
    return response(200, view(s));
  }
  const match = /^\/v1\/mcp\/([^/]+)(?:\/(reconnect|ping))?$/.exec(path);
  if (!match) return undefined;
  const name = decodeURIComponent(match[1] ?? "");
  const current = view(s).servers.find((x) => x.name === name);
  if (match[2]) {
    if (!current) return fail(404, "NOT_FOUND", `No MCP server named ${name}`);
    if (current.status === "disabled")
      return fail(409, "DISABLED", `MCP server ${name} is disabled; enable it first`);
    if (match[2] === "reconnect") {
      connect(s, current.config);
      return response(200, view(s));
    }
    if (current.status !== "ready")
      return fail(409, "NOT_CONNECTED", `MCP server ${name} is not connected`);
    return response(200, { ms: 42, ...view(s) });
  }
  const scope = (method === "DELETE" ? query.get("scope") : body.scope) as
    | McpScope
    | null
    | undefined;
  if (!scope) return fail(400, "INVALID_REQUEST", "Send the scope");
  const list = s.layers[scope];
  const at = list.findIndex((c) => c.name === name);
  if (at < 0) return fail(404, "NOT_FOUND", `No ${scope} MCP server named ${name}`);
  if (method === "DELETE") {
    list.splice(at, 1);
    return response(200, view(s));
  }
  if (typeof body.disabled === "boolean") {
    const entry = list[at];
    if (entry) list[at] = { ...entry, disabled: body.disabled || undefined };
    return response(200, view(s));
  }
  const problem = invalid(body.server);
  if (problem || !body.server) return fail(400, "INVALID_REQUEST", problem ?? "Send a server");
  const server = { ...body.server, disabled: body.server.disabled ?? list[at]?.disabled };
  const target = body.toScope ?? scope;
  if (
    (target !== scope || server.name !== name) &&
    s.layers[target].some((c) => c.name === server.name)
  )
    return fail(409, "CONFLICT", `A ${target} MCP server named ${server.name} already exists`);
  if (target === scope) list[at] = server;
  else {
    list.splice(at, 1);
    s.layers[target].push(server);
  }
  if (!server.disabled) connect(s, server);
  return response(200, view(s));
};

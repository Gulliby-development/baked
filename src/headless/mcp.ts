import { join } from "node:path";
import { getCwd } from "../core/cwd.js";
import {
  applyMCPChange,
  type MCPChange,
  MCPChangeError,
  type MCPConfigFiles,
  type MCPScope,
  type MCPServerView,
  mcpServerViews,
  readMCPLayers,
  writeMCPLayers,
} from "../core/mcp/config.js";
import { configDir } from "../core/platform/index.js";
import { ensurebakedDir } from "../core/utils/ensure-baked-dir.js";
import { useMCPStore } from "../stores/mcp.js";

const help = `Usage: baked mcp [command]

Commands:
  list [--json] [--check]        MCP servers of the global and project config (the default);
                                 --check connects each enabled server and lists its tools,
                                 and exits 1 when one fails
  enable NAME [--scope SCOPE]    Turn a server back on
  disable NAME [--scope SCOPE]   Keep a server in the config without connecting it
  remove NAME [--scope SCOPE]    Delete a server from the config

SCOPE is project (.baked/config.json) or global (the user config); the default is the file that
defines NAME, the project one when both do. Add and edit servers with /mcp in the terminal UI,
the desktop app's MCP servers page, or by editing mcpServers in the config file.
`;

function flag(rest: string[], name: string): string | undefined {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
}

function line(server: MCPServerView): string {
  const target =
    server.transport === "stdio"
      ? [server.config.command, ...(server.config.args ?? [])].filter(Boolean).join(" ")
      : (server.config.url ?? "");
  const tools = server.status === "ready" ? `  ${server.tools.length} tools` : "";
  const error = server.error ? `  ${server.error}` : "";
  return `${server.name}  ${server.scope}  ${server.transport}  ${server.status}${tools}  ${target}${error}`;
}

export async function runMcpCli(argv: string[]): Promise<number> {
  const [command = "list", ...rest] = argv;
  if (command === "--help" || command === "-h" || rest.includes("--help")) {
    process.stdout.write(help);
    return 0;
  }
  const cwd = getCwd();
  const files: MCPConfigFiles = {
    global: join(configDir(), "config.json"),
    project: join(cwd, ".baked", "config.json"),
  };
  try {
    const layers = readMCPLayers(files);
    if (command === "list" || command === "--json" || command === "--check") {
      const args = [command, ...rest];
      const json = args.includes("--json");
      let failed = false;
      if (args.includes("--check")) {
        const { disposeMCPManager, getMCPManager } = await import("../core/mcp/index.js");
        const manager = getMCPManager();
        const enabled = mcpServerViews(layers, {})
          .filter((s) => s.status !== "disabled")
          .map((s) => s.config);
        // One attempt per server: a check reports, it does not wait for restarts.
        await Promise.allSettled(enabled.map((config) => manager.restart(config)));
        const servers = mcpServerViews(layers, useMCPStore.getState().servers);
        await disposeMCPManager();
        failed = servers.some((s) => s.status !== "ready" && s.status !== "disabled");
        output(servers, json);
      } else output(mcpServerViews(layers, {}), json);
      return failed ? 1 : 0;
    }
    if (command !== "enable" && command !== "disable" && command !== "remove") {
      process.stderr.write(`Unknown command: ${command}\n\n${help}`);
      return 2;
    }
    const name = rest.find((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--scope");
    if (!name) {
      process.stderr.write(`Name the server: baked mcp ${command} NAME\n`);
      return 2;
    }
    const given = flag(rest, "--scope");
    if (given !== undefined && given !== "global" && given !== "project") {
      process.stderr.write("--scope is global or project\n");
      return 2;
    }
    const scope: MCPScope =
      (given as MCPScope | undefined) ??
      (layers.project.some((s) => s.name === name) ? "project" : "global");
    const change: MCPChange =
      command === "remove"
        ? { action: "remove", scope, name }
        : { action: "set-disabled", scope, name, disabled: command === "disable" };
    const lists = applyMCPChange(layers, change);
    if (lists.project) ensurebakedDir(cwd);
    writeMCPLayers(files, lists);
    const done = command === "remove" ? "Removed" : command === "enable" ? "Enabled" : "Disabled";
    process.stdout.write(`${done} ${scope} MCP server ${name} (${files[scope]}).\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof MCPChangeError ? 2 : 1;
  }
}

function output(servers: MCPServerView[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ servers }, null, 2)}\n`);
    return;
  }
  if (servers.length === 0) {
    process.stdout.write("No MCP servers. Add one with /mcp in the terminal UI.\n");
    return;
  }
  for (const server of servers) process.stdout.write(`${line(server)}\n`);
}

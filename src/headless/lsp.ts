import { getCwd } from "../core/cwd.js";
import {
  installLspServer,
  type LspScope,
  type LspServerView,
  LspServiceError,
  type LspStatusView,
  lspStatus,
  setLspServerDisabled,
} from "../core/intelligence/lsp-service.js";

const help = `Usage: baked lsp [command]

Commands:
  status [--all] [--json]         Language servers for the project's languages (the default);
                                  --all lists every server baked knows
  install ID [--json]             Install a server from the Mason registry; ID is a server
                                  (gopls), a Mason package (pyright) or a language (go)
  enable ID [--scope SCOPE]       Turn a disabled server back on
  disable ID [--scope SCOPE]      Keep baked from starting a server
  check [ID] [--json]             Start the project's servers in this process, wait for them
                                  and report; exits 1 when a detected language has no working
                                  server. \`restart\` is the same: headless runs keep no servers
                                  between commands.

SCOPE is project (.baked/config.json) or global (the user config). disable defaults to the
project file when it has its own disabledLspServers (which replaces the global list), otherwise
the global one; enable removes the server from every list that names it. A running TUI or
\`baked serve\` applies these changes after its next restart of the server (/lsp restart, or
the desktop app's Language servers page). Exit codes: 2 for an unknown server or bad arguments.
`;

const CHECK_TIMEOUT_MS = 60_000;

function flag(rest: string[], name: string): string | undefined {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
}

function state(server: LspServerView): string {
  if (server.disabled) return "disabled";
  if (!server.installed) return "not installed";
  if (server.running) return server.ready ? "running" : "starting";
  if (server.lastError) return "failed";
  return "installed";
}

function line(server: LspServerView): string {
  const parts = [
    server.id,
    server.languages.join(","),
    state(server),
    server.source ? `(${server.source})` : "",
    !server.installed && server.package
      ? server.installable
        ? `install: baked lsp install ${server.id}`
        : `needs ${server.requiresToolchain ?? "a toolchain"} to install`
      : "",
    server.lastError ? server.lastError.message : "",
  ];
  return parts.filter(Boolean).join("  ");
}

function output(status: LspStatusView, json: boolean, all: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  const servers = all ? status.servers : status.servers.filter((s) => s.detected);
  process.stdout.write(
    `Languages: ${status.languages.length ? status.languages.join(", ") : "none detected"}\n`,
  );
  if (servers.length === 0)
    process.stdout.write(
      all ? "No language servers.\n" : "No servers for the detected languages.\n",
    );
  for (const server of servers) process.stdout.write(`${line(server)}\n`);
  if (status.uncovered.length)
    process.stdout.write(
      `No working server for: ${status.uncovered.join(", ")}. Install one with baked lsp install LANGUAGE.\n`,
    );
}

/** Servers the check expects to come up: enabled, installed servers of detected languages. */
function failing(status: LspStatusView, id?: string): LspServerView[] {
  return status.servers.filter(
    (s) =>
      s.detected &&
      s.installed &&
      !s.disabled &&
      !s.ready &&
      (!id || s.id === id || s.languages.includes(id as never)),
  );
}

async function check(workspace: string): Promise<LspStatusView> {
  const { IntelligenceClient } = await import("../core/workers/intelligence-client.js");
  const { setIntelligenceClient } = await import("../core/intelligence/instance.js");
  const client = new IntelligenceClient(workspace);
  setIntelligenceClient(client);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      client.routerWarmup(),
      new Promise<void>((done) => {
        timer = setTimeout(done, CHECK_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return await lspStatus({ workspace });
  } finally {
    setIntelligenceClient(null);
    await client.close().catch(() => {});
  }
}

export async function runLspCli(argv: string[]): Promise<number> {
  const [command = "status", ...rest] = argv;
  if (command === "--help" || command === "-h" || rest.includes("--help")) {
    process.stdout.write(help);
    return 0;
  }
  const workspace = getCwd();
  const args = [command, ...rest];
  const json = args.includes("--json");
  const id = rest.find((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--scope");
  try {
    if (command === "status" || command === "--json" || command === "--all") {
      output(await lspStatus({ workspace }), json, args.includes("--all"));
      return 0;
    }
    if (command === "check" || command === "restart") {
      const status = await check(workspace);
      output(status, json, false);
      const down = failing(status, id);
      if (!json)
        for (const server of down)
          process.stderr.write(
            `${server.id} did not start${server.lastError ? `: ${server.lastError.message}` : ""}\n`,
          );
      return down.length > 0 || status.uncovered.length > 0 ? 1 : 0;
    }
    if (command !== "install" && command !== "enable" && command !== "disable") {
      process.stderr.write(`Unknown command: ${command}\n\n${help}`);
      return 2;
    }
    if (!id) {
      process.stderr.write(`Name the server: baked lsp ${command} ID\n`);
      return 2;
    }
    if (command === "install") {
      const result = await installLspServer({ workspace }, id, (msg) => {
        if (!json) process.stdout.write(`${msg}\n`);
      });
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`Installed ${result.server} (${result.package}).\n`);
      return 0;
    }
    const given = flag(rest, "--scope");
    if (given !== undefined && given !== "global" && given !== "project") {
      process.stderr.write("--scope is global or project\n");
      return 2;
    }
    const result = await setLspServerDisabled(
      { workspace },
      id,
      command === "disable",
      given as LspScope | undefined,
    );
    const server = result.status.servers.find((s) => s.id === id || s.package === id);
    if (json) process.stdout.write(`${JSON.stringify(result.status, null, 2)}\n`);
    else
      process.stdout.write(
        `${command === "disable" ? "Disabled" : "Enabled"} ${server?.id ?? id}${
          command === "enable" && server?.disabledIn.length
            ? ` (still disabled in ${server.disabledIn.join(", ")})`
            : ""
        }.\n`,
      );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof LspServiceError && error.code === "NOT_FOUND" ? 2 : 1;
  }
}

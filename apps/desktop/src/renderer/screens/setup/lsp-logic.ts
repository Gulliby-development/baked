import type { LspServer, LspView } from "../../client/lsp.js";
import type { DotTone } from "../../components/ui/dot.js";

export type LspState = "running" | "starting" | "failed" | "installed" | "missing" | "disabled";

/** One state per server, the same words `baked lsp status` uses. */
export function lspState(server: LspServer): LspState {
  if (server.disabled) return "disabled";
  if (!server.installed) return "missing";
  if (server.running) return server.ready ? "running" : "starting";
  if (server.lastError) return "failed";
  return "installed";
}

export const LSP_STATE_LABEL: Record<LspState, string> = {
  running: "Running",
  starting: "Starting…",
  failed: "Failed to start",
  installed: "Installed, not running",
  missing: "Not installed",
  disabled: "Off",
};

export const LSP_STATE_TONE: Record<LspState, DotTone> = {
  running: "ok",
  starting: "busy",
  failed: "err",
  installed: "",
  missing: "warn",
  disabled: "",
};

/** Where a server comes from, for the row's second line. */
export function lspSourceLine(server: LspServer): string {
  if (server.installed)
    return server.source === "PATH"
      ? `on PATH (${server.path ?? server.id})`
      : `${server.source ?? ""} · ${server.path ?? ""}`;
  if (!server.package) return "no Mason package; install it yourself and put it on PATH";
  if (!server.installable)
    return `Mason package ${server.package} needs ${server.requiresToolchain ?? "a toolchain"} on PATH`;
  return `Mason package ${server.package}`;
}

/** The servers to list: the project's languages first, everything else only when asked. */
export function visibleServers(view: LspView, all: boolean): LspServer[] {
  return all ? view.servers : view.servers.filter((s) => s.detected);
}

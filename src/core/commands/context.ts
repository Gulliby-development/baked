import { useUIStore } from "../../stores/ui.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function openRepoMapMenu(_ctx: CommandContext): void {
  useUIStore.getState().openModal("repoMapStatus");
}

function openMemoryMenu(ctx: CommandContext): void {
  // Single popup: MemoryBrowser owns browse / cleanup / settings via tabs.
  // The legacy CommandPicker submenu was removed in favor of an integrated
  // Settings tab inside the browser itself.
  ctx.openMemoryBrowser();
}

function handleContextClear(input: string, ctx: CommandContext): void {
  const cmd = input.trim().toLowerCase();
  const what = cmd.includes("skills") ? "skills" : cmd.includes("memory") ? "memory" : "all";
  const cleared = ctx.contextManager.clearContext(what as "memory" | "skills" | "all");
  sysMsg(ctx, cleared.length > 0 ? `Cleared: ${cleared.join(", ")}` : "Nothing to clear.");
}

function handleContext(input: string, _ctx: CommandContext): void {
  const cmd = input.trim().toLowerCase();
  const tab = cmd.includes("dispatch")
    ? ("Dispatch" as const)
    : cmd.includes("system")
      ? ("System" as const)
      : ("Context" as const);
  useUIStore.setState({ statusDashboardTab: tab });
  useUIStore.getState().openModal("statusDashboard");
}

function handleDispatchStatus(_input: string, _ctx: CommandContext): void {
  useUIStore.setState({ statusDashboardTab: "Dispatch" });
  useUIStore.getState().openModal("statusDashboard");
}

function handleMemory(_input: string, ctx: CommandContext): void {
  openMemoryMenu(ctx);
}

function handleRepoMap(_input: string, ctx: CommandContext): void {
  openRepoMapMenu(ctx);
}

function handleTools(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("toolsPopup");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/context", handleContext);
  map.set("/dispatch-status", handleDispatchStatus);
  map.set("/memory", handleMemory);
  map.set("/repo-map", handleRepoMap);
  map.set("/tools", handleTools);
}

export function matchContextPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/context clear") || cmd === "/context reset") return handleContextClear;
  return null;
}

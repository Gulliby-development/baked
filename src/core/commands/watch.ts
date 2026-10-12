import { useWatchStore } from "../../stores/watch.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/**
 * `/watch on|off|status`: watch mode in the terminal app. Saving a `baked!` or `baked?` comment
 * starts a turn in the watching tab. See docs/watch.md.
 */

function status(ctx: CommandContext): string {
  const s = useWatchStore.getState();
  if (!s.tabId) return "Watch mode is off. /watch on starts it in this tab.";
  const where = s.tabId === ctx.tabMgr.activeTabId ? "this tab" : "another tab";
  const how = s.method === "poll" ? " by polling" : "";
  const turns = s.turns === 1 ? "1 turn" : `${String(s.turns)} turns`;
  const last = s.last ? ` Last: ${s.last}.` : "";
  const error = s.error ? ` Error: ${s.error}.` : "";
  return `Watching ${ctx.cwd}${how} in ${where}: ${turns} so far.${last}${error}`;
}

function handleWatch(input: string, ctx: CommandContext): void {
  const arg = input.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
  const store = useWatchStore.getState();
  if (arg === "on") {
    const moved = store.tabId !== null && store.tabId !== ctx.tabMgr.activeTabId;
    store.enable(ctx.tabMgr.activeTabId);
    sysMsg(
      ctx,
      `${moved ? "Watch mode moved to this tab." : "Watch mode is on."} Save a \`baked!\` comment to change code there, or \`baked?\` to ask about it. /watch off stops.`,
    );
    return;
  }
  if (arg === "off") {
    if (!store.tabId) {
      sysMsg(ctx, "Watch mode is already off.");
      return;
    }
    store.disable();
    sysMsg(ctx, "Watch mode is off.");
    return;
  }
  if (arg === "" || arg === "status") {
    sysMsg(ctx, status(ctx));
    return;
  }
  sysMsg(ctx, "Usage: /watch on | off | status");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/watch", handleWatch);
}

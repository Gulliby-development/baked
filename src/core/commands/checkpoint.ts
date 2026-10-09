import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import { useCheckpointStore } from "../../stores/checkpoints.js";
import { icon } from "../icons.js";
import { rebuildCoreMessages } from "../sessions/rebuild.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  return `${String(Math.floor(m / 60))}h`;
}

function handleCheckpointList(_input: string, ctx: CommandContext): void {
  const tabId = ctx.tabMgr.activeTabId;
  const store = useCheckpointStore.getState();
  const checkpoints = store.tabs[tabId]?.checkpoints ?? [];

  if (checkpoints.length === 0) {
    sysMsg(ctx, "No checkpoints yet.");
    return;
  }

  const t = getThemeTokens();
  const lines: InfoPopupLine[] = [];

  for (const cp of checkpoints) {
    if (lines.length > 0) lines.push({ type: "spacer" });
    const statusColor =
      cp.status === "running" ? t.brandSecondary : cp.status === "error" ? t.error : t.brand;
    lines.push({
      type: "entry",
      label: `#${String(cp.index)} ${cp.promptPreview}`,
      desc: `${cp.status} · ${String(cp.filesEdited.length)} edits${cp.gitTag ? ` · ${cp.gitTag}` : ""}${cp.durationMs ? ` · ${formatDuration(cp.durationMs)}` : ""}`,
      color: cp.undone ? t.textFaint : statusColor,
      descColor: t.textMuted,
    });
  }

  lines.push({ type: "spacer" });
  lines.push({
    type: "text",
    label: `${String(checkpoints.length)} checkpoint(s)`,
    color: t.textMuted,
  });

  ctx.openInfoPopup({ title: "Checkpoints", icon: icon("bookmark"), lines, labelWidth: 50 });
}

function handleCheckpointView(input: string, ctx: CommandContext): void {
  const tabId = ctx.tabMgr.activeTabId;
  const match = input.match(/\/checkpoint\s+(\d+)/);
  if (!match) {
    sysMsg(ctx, "Usage: /checkpoint <N>");
    return;
  }
  const n = parseInt(match[1] ?? "0", 10);
  const store = useCheckpointStore.getState();
  const checkpoints = store.tabs[tabId]?.checkpoints ?? [];
  const cp = checkpoints.find((c) => c.index === n);
  if (!cp || cp.undone) {
    sysMsg(ctx, `Checkpoint #${String(n)} not found.`);
    return;
  }
  store.setViewing(tabId, n);
  sysMsg(ctx, `Viewing checkpoint #${String(n)}: ${cp.promptPreview}`);
}

function handleCheckpointLive(_input: string, ctx: CommandContext): void {
  const tabId = ctx.tabMgr.activeTabId;
  useCheckpointStore.getState().setViewing(tabId, null);
  sysMsg(ctx, "Back to live view.");
}

async function handleCheckpointUndo(input: string, ctx: CommandContext): Promise<void> {
  const tabId = ctx.tabMgr.activeTabId;
  const store = useCheckpointStore.getState();
  const checkpoints = store.tabs[tabId]?.checkpoints ?? [];

  // Determine target index
  const numMatch = input.match(/\/checkpoint\s+undo\s+(\d+)/);
  let targetIndex: number;

  if (numMatch) {
    targetIndex = parseInt(numMatch[1] ?? "0", 10);
  } else {
    // Undo the last checkpoint — target is second-to-last active
    const active = checkpoints.filter((c) => !c.undone);
    if (active.length <= 1) {
      sysMsg(ctx, "Nothing to undo.");
      return;
    }
    targetIndex = active[active.length - 2]?.index ?? 1;
  }

  const result = await store.undoToCheckpoint(tabId, targetIndex, ctx.cwd, ctx.chat.messages);
  if (!result) {
    sysMsg(ctx, `Cannot undo to checkpoint #${String(targetIndex)}.`);
    return;
  }

  ctx.chat.setMessages(result.messages);
  ctx.chat.setCoreMessages(rebuildCoreMessages(result.messages));
  const conflictNote =
    result.conflicts.length > 0 ? ` (${String(result.conflicts.length)} conflict(s) skipped)` : "";
  sysMsg(
    ctx,
    `Undone to checkpoint #${String(targetIndex)}. Restored ${String(result.restoredFiles.length)} file(s).${conflictNote}`,
  );
}

async function handleCheckpointRedo(_input: string, ctx: CommandContext): Promise<void> {
  const tabId = ctx.tabMgr.activeTabId;
  const store = useCheckpointStore.getState();
  const result = await store.redo(tabId, ctx.cwd, ctx.chat.messages);
  if (!result) {
    sysMsg(ctx, "Nothing to redo.");
    return;
  }
  ctx.chat.setMessages(result.messages);
  ctx.chat.setCoreMessages(rebuildCoreMessages(result.messages));
  sysMsg(ctx, `Redo applied. Restored ${String(result.restoredFiles.length)} file(s).`);
}

async function handleCheckpointSave(_input: string, ctx: CommandContext): Promise<void> {
  const tabId = ctx.tabMgr.activeTabId;
  const store = useCheckpointStore.getState();
  const checkpoints = store.tabs[tabId]?.checkpoints ?? [];
  const active = checkpoints.filter((c) => !c.undone && c.status === "done");
  if (active.length === 0) {
    sysMsg(ctx, "No completed checkpoint to save.");
    return;
  }
  const latest = active[active.length - 1];
  if (!latest) {
    sysMsg(ctx, "No completed checkpoint to save.");
    return;
  }
  const ok = await store.createGitTag(tabId, latest.index, ctx.cwd);
  if (ok) {
    sysMsg(ctx, `Git tag created for checkpoint #${String(latest.index)}.`);
  } else {
    sysMsg(ctx, `Failed to create git tag for checkpoint #${String(latest.index)}.`);
  }
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/checkpoint", handleCheckpointList as CommandHandler);
  map.set("/checkpoint live", handleCheckpointLive);
  map.set("/checkpoint undo", handleCheckpointUndo as CommandHandler);
  map.set("/checkpoint redo", handleCheckpointRedo as CommandHandler);
  map.set("/checkpoint save", handleCheckpointSave as CommandHandler);
  map.set("/checkpoint list", handleCheckpointList as CommandHandler);
}

export function matchCheckpointPrefix(cmd: string): CommandHandler | null {
  if (/^\/checkpoint\s+\d+$/.test(cmd)) return handleCheckpointView;
  if (/^\/checkpoint\s+undo\s+\d+$/.test(cmd)) return handleCheckpointUndo as CommandHandler;
  return null;
}

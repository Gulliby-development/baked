import { relative } from "node:path";
import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import { useCheckpointStore } from "../../stores/checkpoints.js";
import {
  checkpointEndMessageId,
  copyCheckpointTags,
  forkPoint,
  type RollbackReport,
  rollbackToCheckpoint,
} from "../checkpoints/fork.js";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
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

function restoreSummary(report: RollbackReport | null, cwd: string): string {
  if (!report) return "No files changed.";
  return forkSummary(report, cwd);
}

function restoreFailed(ctx: CommandContext, action: string, err: unknown): void {
  sysMsg(ctx, `${action} failed: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * `/undo [N] [--force]`: keeps the turns up to and including checkpoint N (the one before the last
 * by default) and rolls back the files the later turns edited, as the local API rewind does.
 */
async function handleCheckpointUndo(input: string, ctx: CommandContext): Promise<void> {
  const tabId = ctx.tabMgr.activeTabId;
  const store = useCheckpointStore.getState();
  if (ctx.chat.isLoading) {
    sysMsg(ctx, "Wait for the turn to finish before undoing.");
    return;
  }
  const checkpoints = store.tabs[tabId]?.checkpoints ?? [];
  const numMatch = input.match(/^\/(?:checkpoint\s+)?undo\s+(\d+)/);
  const targetIndex = numMatch ? parseInt(numMatch[1] ?? "0", 10) : checkpoints.length - 1;
  if (targetIndex < 0 || targetIndex >= checkpoints.length) {
    sysMsg(
      ctx,
      numMatch ? `Cannot undo to checkpoint #${String(targetIndex)}.` : "Nothing to undo.",
    );
    return;
  }
  const force = /\s--force\b/.test(input);
  let result: Awaited<ReturnType<typeof store.undoToCheckpoint>>;
  try {
    result = await store.undoToCheckpoint(tabId, targetIndex, ctx.cwd, ctx.chat.messages, {
      force,
    });
  } catch (err) {
    restoreFailed(ctx, "Undo", err);
    return;
  }
  if (!result) {
    sysMsg(ctx, `Cannot undo to checkpoint #${String(targetIndex)}.`);
    return;
  }
  ctx.chat.setMessages(result.messages);
  ctx.chat.setCoreMessages(rebuildCoreMessages(result.messages));
  ctx.refreshGit();
  sysMsg(
    ctx,
    `Undone to checkpoint #${String(targetIndex)}. ${restoreSummary(result.rollback, ctx.cwd)}`,
  );
}

/** `/redo [--force]`: brings back the oldest turn `/undo` dropped, with its files. */
async function handleCheckpointRedo(input: string, ctx: CommandContext): Promise<void> {
  const tabId = ctx.tabMgr.activeTabId;
  const store = useCheckpointStore.getState();
  if (ctx.chat.isLoading) {
    sysMsg(ctx, "Wait for the turn to finish before redoing.");
    return;
  }
  let result: Awaited<ReturnType<typeof store.redo>>;
  try {
    result = await store.redo(tabId, ctx.cwd, ctx.chat.messages, {
      force: /\s--force\b/.test(input),
    });
  } catch (err) {
    restoreFailed(ctx, "Redo", err);
    return;
  }
  if (!result) {
    sysMsg(ctx, "Nothing to redo.");
    return;
  }
  ctx.chat.setMessages(result.messages);
  ctx.chat.setCoreMessages(rebuildCoreMessages(result.messages));
  ctx.refreshGit();
  sysMsg(
    ctx,
    `Redid checkpoint #${String(result.checkpoint)}. ${restoreSummary(result.rollback, ctx.cwd)}`,
  );
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

function forkSummary(report: RollbackReport, cwd: string): string {
  const rel = (p: string) => relative(cwd, p) || p;
  const parts = [`Restored ${String(report.restored.length)} file(s)`];
  if (report.removed.length > 0) parts.push(`removed ${String(report.removed.length)}`);
  let text = `${parts.join(", ")}.`;
  if (report.skipped.length > 0)
    text += `\nLeft in place:\n${report.skipped.map((s) => `  ${rel(s.path)}: ${s.reason}`).join("\n")}`;
  if (report.backupTag)
    text += `\nThe files before the rollback are in Git tag ${report.backupTag}.`;
  return text;
}

/** `/checkpoint fork [N] [--force]`: a new tab with history and files at checkpoint N. */
async function handleCheckpointFork(input: string, ctx: CommandContext): Promise<void> {
  const tabId = ctx.tabMgr.activeTabId;
  const store = useCheckpointStore.getState();
  if (ctx.chat.isLoading) {
    sysMsg(ctx, "Wait for the turn to finish before forking.");
    return;
  }
  const force = /\s--force\b/.test(input);
  const active = (store.tabs[tabId]?.checkpoints ?? []).filter((c) => !c.undone);
  const numMatch = input.match(/\/checkpoint\s+fork\s+(\d+)/);
  const index = numMatch
    ? parseInt(numMatch[1] ?? "0", 10)
    : (store.getViewing(tabId) ?? active.at(-1)?.index ?? 0);
  const messages = ctx.chat.messages;
  const endId = checkpointEndMessageId(messages, index);
  const point = endId ? forkPoint(messages, endId) : null;
  if (!point) {
    sysMsg(ctx, `Checkpoint #${String(index)} not found.`);
    return;
  }
  const source = ctx.tabMgr.getAllTabStates().find((t) => t.id === tabId);
  if (!source) return;
  if (!ctx.tabMgr.canCreateTab) {
    sysMsg(ctx, "Close a tab first: the tab limit is reached.");
    return;
  }

  const tags = store.snapshotTags(tabId);
  const coordinator = getWorkspaceCoordinator();
  let report: RollbackReport;
  try {
    report = await rollbackToCheckpoint({
      cwd: ctx.cwd,
      messages,
      checkpoint: point.checkpoint,
      tags,
      backupTag: `baked/fork-backup-${crypto.randomUUID().slice(0, 8)}`,
      force,
      claimedBy: (path) => coordinator.getConflicts(tabId, [path])[0]?.ownerTabLabel ?? null,
    });
  } catch (err) {
    sysMsg(ctx, `Fork failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const label = `${source.label}-fork`;
  const newId = ctx.tabMgr.createTab(label);
  if (!newId) return;
  const forkMessages = point.messages.map((m) => ({ ...m }));
  ctx.tabMgr.initialStates.current.set(newId, {
    ...source,
    id: newId,
    label,
    messages: forkMessages,
    coreMessages: rebuildCoreMessages(forkMessages),
    activePlan: null,
    sidebarPlan: null,
  });
  const copied = await copyCheckpointTags(ctx.cwd, tags, point.checkpoint, newId);
  if (copied.length > 0) store.restoreTagsFromMeta(newId, copied);
  ctx.refreshGit();
  sysMsg(ctx, `Forked checkpoint #${String(index)} into ${label}. ${forkSummary(report, ctx.cwd)}`);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/checkpoint", handleCheckpointList as CommandHandler);
  map.set("/checkpoint live", handleCheckpointLive);
  map.set("/checkpoint undo", handleCheckpointUndo as CommandHandler);
  map.set("/checkpoint redo", handleCheckpointRedo as CommandHandler);
  map.set("/undo", handleCheckpointUndo as CommandHandler);
  map.set("/redo", handleCheckpointRedo as CommandHandler);
  map.set("/checkpoint save", handleCheckpointSave as CommandHandler);
  map.set("/checkpoint list", handleCheckpointList as CommandHandler);
  map.set("/checkpoint fork", handleCheckpointFork as CommandHandler);
}

export function matchCheckpointPrefix(cmd: string): CommandHandler | null {
  if (/^\/checkpoint\s+\d+$/.test(cmd)) return handleCheckpointView;
  if (/^\/(checkpoint\s+)?undo(\s+\d+)?(\s+--force)?$/.test(cmd))
    return handleCheckpointUndo as CommandHandler;
  if (/^\/(checkpoint\s+)?redo(\s+--force)?$/.test(cmd))
    return handleCheckpointRedo as CommandHandler;
  if (/^\/checkpoint\s+fork(\s+\d+)?(\s+--force)?$/.test(cmd))
    return handleCheckpointFork as CommandHandler;
  return null;
}

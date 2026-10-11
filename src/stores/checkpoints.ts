import { create } from "zustand";
import {
  checkpointTagName,
  ensureBaseSnapshot,
  type RollbackReport,
} from "../core/checkpoints/fork.js";
import {
  type RedoTurn,
  RewindError,
  redoTurn,
  rewindConversation,
} from "../core/checkpoints/rewind.js";
import { isGitWorkspace, snapshotWorkspace } from "../core/checkpoints/snapshot.js";
import { type CheckpointTag, extractFilesFromToolCalls } from "../core/checkpoints/turns.js";
import { getWorkspaceCoordinator } from "../core/coordination/WorkspaceCoordinator.js";
import { run as gitRun } from "../core/git/status.js";
import type { ChatMessage } from "../types/index.js";

// ── Git mutex ──
// Serializes git operations per cwd to prevent concurrent add/commit/tag/reset
// from corrupting the working tree when multiple tabs finish simultaneously.
const _gitLocks = new Map<string, Promise<unknown>>();
function withGitLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = _gitLocks.get(cwd) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _gitLocks.set(cwd, next);
  return next;
}

// ── Types ──

export interface Checkpoint {
  index: number;
  /** First line of user prompt, truncated to 60 chars */
  promptPreview: string;
  prompt: string;
  /** ID of the user message that started this checkpoint */
  anchorMessageId: string;
  startedAt: number;
  durationMs: number;
  filesRead: string[];
  filesEdited: string[];
  lineDelta: [number, number];
  gitTag: string | null;
  status: "running" | "done" | "error";
  /** True when this checkpoint has been undone */
  undone: boolean;
}

/**
 * The outcome of `/undo` or `/redo`. `rollback` is null when no file had to change, or when the
 * workspace is not a Git repository and only the conversation moved.
 */
export interface RestoreResult {
  messages: ChatMessage[];
  checkpoint: number;
  rollback: RollbackReport | null;
}

// ── Store ──

interface PerTab {
  checkpoints: Checkpoint[];
  viewing: number | null; // null = live
  /** Turns `/undo` dropped, oldest first; a new turn clears them. */
  redo: RedoTurn[];
  /** Snapshots of the dropped turns, which a redo needs to move files forward. */
  redoTags: CheckpointTag[];
  lastSyncedLen: number;
  /** Snapshot of the workspace before the tab's first turn. */
  baseTag?: CheckpointTag;
  /** Tags waiting to be applied — set by restoreTagsFromMeta before syncFromMessages runs */
  _pendingTags?: Array<{ index: number; anchorMessageId: string; gitTag: string }>;
}

interface CheckpointState {
  tabs: Record<string, PerTab>;
  skipCleanupTabs: Set<string>;

  // Sync
  syncFromMessages(tabId: string, messages: ChatMessage[], isLoading: boolean): void;

  // Browsing
  setViewing(tabId: string, index: number | null): void;
  getViewing(tabId: string): number | null;
  getCheckpoints(tabId: string): Checkpoint[];
  getTab(tabId: string): PerTab;

  // Git operations
  createGitTag(tabId: string, index: number, cwd: string): Promise<boolean>;
  /** Snapshots the workspace before a turn when the tab has no snapshot yet. */
  ensureBaseTag(tabId: string, cwd: string, messages: ChatMessage[]): Promise<void>;
  /** Every snapshot of the tab (checkpoints, redo entries and the base), for saving and forks. */
  snapshotTags(tabId: string): CheckpointTag[];
  /**
   * Keeps the turns up to and including checkpoint `index` (0 keeps none) and rolls the files the
   * later turns edited back to their content there; null when there is nothing to undo.
   */
  undoToCheckpoint(
    tabId: string,
    index: number,
    cwd: string,
    liveMessages: ChatMessage[],
    options?: { force?: boolean },
  ): Promise<RestoreResult | null>;
  /** Brings back the oldest turn `/undo` dropped, and moves its files forward; null when none. */
  redo(
    tabId: string,
    cwd: string,
    liveMessages: ChatMessage[],
    options?: { force?: boolean },
  ): Promise<RestoreResult | null>;
  canRedo(tabId: string): boolean;
  getRedoCount(tabId: string): number;

  // Session persistence
  restoreTagsFromMeta(
    tabId: string,
    tags: Array<{ index: number; anchorMessageId: string; gitTag: string }>,
  ): void;
  skipCleanup(tabId: string): void;
  shouldSkipCleanup(tabId: string): boolean;

  // Cleanup
  cleanupGitTags(tabId: string, cwd: string): Promise<void>;
  clear(tabId: string): void;
}

function emptyTab(): PerTab {
  return { checkpoints: [], viewing: null, redo: [], redoTags: [], lastSyncedLen: 0 };
}

function getTab(tabs: Record<string, PerTab>, tabId: string): PerTab {
  return tabs[tabId] ?? emptyTab();
}

/** The tab's checkpoints rebuilt from its messages, keeping the snapshot tags already known. */
function buildCheckpoints(tab: PerTab, messages: ChatMessage[], isLoading: boolean): Checkpoint[] {
  // Rebuild checkpoints from scratch — messages can be mutated (trimmed, compacted)
  // so incremental sync is unreliable. This is cheap: just scanning message roles.
  const checkpoints: Checkpoint[] = [];
  let current: Checkpoint | null = null;

  for (const msg of messages) {
    if (msg.role === "user" && !msg.isSteering) {
      // Finalize previous checkpoint
      if (current) {
        if (current.status === "running") current.status = "done";
        if (current.startedAt && current.status === "done") {
          current.durationMs = msg.timestamp - current.startedAt;
        }
      }
      const preview = msg.content.split("\n")[0]?.slice(0, 60) ?? "";
      current = {
        index: checkpoints.length + 1,
        promptPreview: preview,
        prompt: msg.content,
        anchorMessageId: msg.id,
        startedAt: msg.timestamp,
        durationMs: 0,
        filesRead: [],
        filesEdited: [],
        lineDelta: [0, 0],
        gitTag: null,
        status: "running",
        undone: false,
      };
      checkpoints.push(current);
    }

    if (msg.role === "assistant" && current) {
      const { read, edited } = extractFilesFromToolCalls(msg);
      for (const f of read) {
        if (!current.filesRead.includes(f)) current.filesRead.push(f);
      }
      for (const f of edited) {
        if (!current.filesEdited.includes(f)) current.filesEdited.push(f);
      }
    }

    // Steering messages fold into current checkpoint
    if (msg.role === "user" && msg.isSteering && current) {
      // Don't start a new checkpoint — just continue
    }
  }

  // Finalize last checkpoint
  if (current) {
    if (!isLoading && current.status === "running") {
      current.status = "done";
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && current.startedAt) {
        current.durationMs = lastMsg.timestamp - current.startedAt;
      }
    }
  }

  // Preserve git tags and undone state from previous state
  for (const cp of checkpoints) {
    const prev = tab.checkpoints.find(
      (p) => p.index === cp.index && p.anchorMessageId === cp.anchorMessageId,
    );
    const dropped = tab.redoTags.find(
      (t) => t.index === cp.index && t.anchorMessageId === cp.anchorMessageId,
    );
    cp.gitTag = prev?.gitTag ?? dropped?.gitTag ?? null;
    if (prev?.undone) cp.undone = true;
  }

  // Also restore tags from pending session restore (tags arrive before sync builds checkpoints)
  if (tab._pendingTags) {
    for (const cp of checkpoints) {
      const saved = tab._pendingTags.find(
        (t) => t.anchorMessageId === cp.anchorMessageId || t.index === cp.index,
      );
      if (saved) cp.gitTag = saved.gitTag;
    }
  }
  return checkpoints;
}

/** The label of another tab editing a file, which leaves the file in place. */
function claimedBy(tabId: string): (absPath: string) => string | null {
  const coordinator = getWorkspaceCoordinator();
  return (path) => coordinator.getConflicts(tabId, [path])[0]?.ownerTabLabel ?? null;
}

export const useCheckpointStore = create<CheckpointState>()((set, get) => ({
  tabs: {},
  skipCleanupTabs: new Set(),

  syncFromMessages(tabId: string, messages: ChatMessage[], isLoading: boolean) {
    const state = get();
    const tab = getTab(state.tabs, tabId);
    const checkpoints = buildCheckpoints(tab, messages, isLoading);

    // A turn that is neither known nor redone is a new prompt after an undo: the redo list ends.
    const hasNewCheckpoints = checkpoints.some(
      (cp) => !cp.undone && !tab.checkpoints.find((p) => p.anchorMessageId === cp.anchorMessageId),
    );
    const redo = hasNewCheckpoints ? [] : tab.redo;
    const redoTags = hasNewCheckpoints ? [] : tab.redoTags;

    // Clear pending tags once ALL of them have been matched to checkpoints
    const pendingTags = tab._pendingTags;
    const clearedPending = pendingTags?.every((pt) =>
      checkpoints.some(
        (cp) =>
          cp.gitTag === pt.gitTag &&
          (cp.anchorMessageId === pt.anchorMessageId || cp.index === pt.index),
      ),
    )
      ? undefined
      : pendingTags;

    set({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...tab,
          checkpoints,
          redo,
          redoTags,
          lastSyncedLen: messages.length,
          _pendingTags: clearedPending,
        },
      },
    });
  },

  setViewing(tabId: string, index: number | null) {
    const state = get();
    const tab = getTab(state.tabs, tabId);
    set({
      tabs: {
        ...state.tabs,
        [tabId]: { ...tab, viewing: index },
      },
    });
  },

  getViewing(tabId: string): number | null {
    return get().tabs[tabId]?.viewing ?? null;
  },

  getCheckpoints(tabId: string): Checkpoint[] {
    return get().tabs[tabId]?.checkpoints ?? [];
  },

  getTab(tabId: string): PerTab {
    return get().tabs[tabId] ?? emptyTab();
  },

  async createGitTag(tabId: string, index: number, cwd: string): Promise<boolean> {
    const tab = getTab(get().tabs, tabId);
    const cp = tab.checkpoints.find((c) => c.index === index);
    if (!cp || cp.gitTag) return false;

    const tag = checkpointTagName(tabId, index, cp.prompt);

    // Serialize with restores so a snapshot never sees a partially restored working tree
    const ok = await withGitLock(cwd, () =>
      snapshotWorkspace(cwd, tag, `baked-cp-${String(index)}`),
    );

    if (!ok) return false;

    // Use functional updater to avoid overwriting concurrent syncs
    set((s) => {
      const freshTab = s.tabs[tabId];
      if (!freshTab) return s;
      const updatedCheckpoints = freshTab.checkpoints.map((c) =>
        c.index === index && c.anchorMessageId === cp.anchorMessageId ? { ...c, gitTag: tag } : c,
      );
      return {
        tabs: { ...s.tabs, [tabId]: { ...freshTab, checkpoints: updatedCheckpoints } },
      };
    });
    return true;
  },

  async ensureBaseTag(tabId: string, cwd: string, messages: ChatMessage[]): Promise<void> {
    const existing = get().snapshotTags(tabId);
    const base = await withGitLock(cwd, () => ensureBaseSnapshot(cwd, tabId, messages, existing));
    if (!base) return;
    set((s) => {
      const tab = s.tabs[tabId] ?? emptyTab();
      if (base.index === 0) return { tabs: { ...s.tabs, [tabId]: { ...tab, baseTag: base } } };
      const checkpoints = tab.checkpoints.map((c) =>
        c.index === base.index && c.anchorMessageId === base.anchorMessageId && !c.gitTag
          ? { ...c, gitTag: base.gitTag }
          : c,
      );
      return { tabs: { ...s.tabs, [tabId]: { ...tab, checkpoints } } };
    });
  },

  snapshotTags(tabId: string): CheckpointTag[] {
    const tab = getTab(get().tabs, tabId);
    const seen = new Set<string>();
    const out: CheckpointTag[] = [];
    const add = (cp: { index: number; anchorMessageId: string; gitTag: string | null }) => {
      if (!cp.gitTag || seen.has(cp.gitTag)) return;
      seen.add(cp.gitTag);
      out.push({ index: cp.index, anchorMessageId: cp.anchorMessageId, gitTag: cp.gitTag });
    };
    if (tab.baseTag) add(tab.baseTag);
    for (const cp of tab.checkpoints) add(cp);
    for (const tag of tab.redoTags) add(tag);
    return out;
  },

  async undoToCheckpoint(
    tabId: string,
    targetIndex: number,
    cwd: string,
    liveMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ): Promise<RestoreResult | null> {
    const tab = getTab(get().tabs, tabId);
    if (!tab.checkpoints.some((c) => c.index > targetIndex)) return null;
    const tags = get().snapshotTags(tabId);
    const dropped = tab.checkpoints
      .filter((c) => c.index > targetIndex && c.gitTag)
      .map((c) => ({ index: c.index, anchorMessageId: c.anchorMessageId, gitTag: c.gitTag ?? "" }));
    // Serialized with snapshots, so createGitTag never sees a partially restored working tree.
    const result = await withGitLock(cwd, async () =>
      rewindConversation({
        cwd,
        messages: liveMessages,
        redo: tab.redo,
        checkpoint: targetIndex,
        tags,
        rollbackFiles: await isGitWorkspace(cwd),
        backupTag: `baked/undo-backup-${crypto.randomUUID().slice(0, 8)}`,
        claimedBy: claimedBy(tabId),
        ...(options.force ? { force: true } : {}),
      }),
    ).catch((err: unknown) => {
      if (err instanceof RewindError) return null;
      throw err;
    });
    if (!result) return null;
    set((s) => {
      const fresh = s.tabs[tabId] ?? emptyTab();
      const known = new Set(fresh.redoTags.map((t) => t.gitTag));
      const next: PerTab = {
        ...fresh,
        redo: result.redo,
        redoTags: [...fresh.redoTags, ...dropped.filter((t) => !known.has(t.gitTag))],
        viewing: null,
      };
      next.checkpoints = buildCheckpoints(next, result.messages, false);
      return { tabs: { ...s.tabs, [tabId]: next } };
    });
    return { messages: result.messages, checkpoint: targetIndex, rollback: result.rollback };
  },

  async redo(
    tabId: string,
    cwd: string,
    liveMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ): Promise<RestoreResult | null> {
    const tab = getTab(get().tabs, tabId);
    if (tab.redo.length === 0) return null;
    const tags = get().snapshotTags(tabId);
    const result = await withGitLock(cwd, async () =>
      redoTurn({
        cwd,
        messages: liveMessages,
        redo: tab.redo,
        tags,
        backupTag: `baked/redo-backup-${crypto.randomUUID().slice(0, 8)}`,
        claimedBy: claimedBy(tabId),
        ...(options.force ? { force: true } : {}),
      }),
    );
    set((s) => {
      const fresh = s.tabs[tabId] ?? emptyTab();
      const next: PerTab = { ...fresh, redo: result.redo, viewing: null };
      // Rebuilt here so the next sync sees the redone turn as known, not as a new prompt.
      next.checkpoints = buildCheckpoints(next, result.messages, false);
      return { tabs: { ...s.tabs, [tabId]: next } };
    });
    return { messages: result.messages, checkpoint: result.checkpoint, rollback: result.rollback };
  },

  canRedo(tabId: string): boolean {
    return (get().tabs[tabId]?.redo.length ?? 0) > 0;
  },

  getRedoCount(tabId: string): number {
    return get().tabs[tabId]?.redo.length ?? 0;
  },

  async cleanupGitTags(tabId: string, cwd: string): Promise<void> {
    const prefix = `baked/cp-${tabId.slice(0, 8)}-`;
    const result = await gitRun(["tag", "-l", `${prefix}*`], cwd);
    if (!result.ok) return;
    const tags = result.stdout.trim().split("\n").filter(Boolean);
    for (const tag of tags) {
      await gitRun(["tag", "-d", tag], cwd);
    }
  },

  restoreTagsFromMeta(
    tabId: string,
    tags: Array<{ index: number; anchorMessageId: string; gitTag: string }>,
  ) {
    const baseTag = tags.find((t) => t.index === 0);
    const regular = tags.filter((t) => t.index !== 0);
    set((s) => {
      const tab = { ...(s.tabs[tabId] ?? emptyTab()), ...(baseTag ? { baseTag } : {}) };
      // Apply to existing checkpoints if any
      const updated = tab.checkpoints.map((cp) => {
        const saved = regular.find(
          (t) => t.anchorMessageId === cp.anchorMessageId || t.index === cp.index,
        );
        return saved ? { ...cp, gitTag: saved.gitTag } : cp;
      });
      // Also stash as pending so syncFromMessages can pick them up when it rebuilds
      return {
        tabs: {
          ...s.tabs,
          [tabId]: {
            ...tab,
            checkpoints: updated,
            ...(regular.length > 0 ? { _pendingTags: regular } : {}),
          },
        },
      };
    });
  },

  skipCleanup(tabId: string) {
    const next = new Set(get().skipCleanupTabs);
    next.add(tabId);
    set({ skipCleanupTabs: next });
  },

  shouldSkipCleanup(tabId: string): boolean {
    return get().skipCleanupTabs.has(tabId);
  },

  clear(tabId: string) {
    const state = get();
    const { [tabId]: _, ...rest } = state.tabs;
    const next = new Set(state.skipCleanupTabs);
    next.delete(tabId);
    set({ tabs: rest, skipCleanupTabs: next });
  },
}));

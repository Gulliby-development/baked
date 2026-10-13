import { create } from "zustand";
import {
  checkpointTagName,
  ensureBaseSnapshot,
  type RollbackReport,
} from "../core/checkpoints/fork.js";
import { snapshotWorkspace } from "../core/checkpoints/snapshot.js";
import { type CheckpointTag, extractFilesFromToolCalls } from "../core/checkpoints/turns.js";
import { type RedoTurn, redoTurn, TurnUndoError, undoTurns } from "../core/checkpoints/undo.js";
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
 * Redo entry: a turn an undo dropped, with its messages, and its checkpoint (which keeps the
 * turn's snapshot tag). Kept apart from the checkpoint list so that list never holds old messages.
 */
interface RedoEntry {
  checkpoint: Checkpoint;
  turn: RedoTurn;
}

export interface UndoResult {
  messages: ChatMessage[];
  rollback: RollbackReport;
}

export type RedoResult = UndoResult;

/** A checkpoint for a turn known only from its messages, such as a redo turn read from a session. */
function checkpointOf(turn: RedoTurn, gitTag: string | null): Checkpoint {
  const prompt = turn.messages[0]?.content ?? "";
  const edited = new Set<string>();
  for (const m of turn.messages)
    if (m.role === "assistant") for (const f of extractFilesFromToolCalls(m).edited) edited.add(f);
  return {
    index: turn.index,
    promptPreview: prompt.split("\n")[0]?.slice(0, 60) ?? "",
    prompt,
    anchorMessageId: turn.anchorMessageId,
    startedAt: turn.messages[0]?.timestamp ?? 0,
    durationMs: 0,
    filesRead: [],
    filesEdited: [...edited],
    lineDelta: [0, 0],
    gitTag,
    status: "done",
    undone: true,
  };
}

// ── Store ──

interface PerTab {
  checkpoints: Checkpoint[];
  viewing: number | null; // null = live
  redoStack: RedoEntry[];
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
  /** Snapshots every finished turn that edited files and has no snapshot yet. */
  tagFinishedTurns(tabId: string, cwd: string): Promise<void>;
  /** Snapshots the workspace before a turn when the tab has no snapshot yet. */
  ensureBaseTag(tabId: string, cwd: string, messages: ChatMessage[]): Promise<void>;
  /** Every snapshot of the tab (checkpoints, redo entries and the base), for saving and forks. */
  snapshotTags(tabId: string): CheckpointTag[];
  /** Undoes the turns after checkpoint `index`; null when there is no such turn to undo. */
  undoToCheckpoint(
    tabId: string,
    index: number,
    cwd: string,
    liveMessages: ChatMessage[],
    options?: { force?: boolean },
  ): Promise<UndoResult | null>;
  /** Puts back the oldest undone turn; null when there is none. */
  redo(
    tabId: string,
    cwd: string,
    liveMessages: ChatMessage[],
    options?: { force?: boolean },
  ): Promise<RedoResult | null>;
  /** The undone turns, oldest first, for saving with the session. */
  redoTurns(tabId: string): RedoTurn[];
  canRedo(tabId: string): boolean;
  getRedoCount(tabId: string): number;

  // Session persistence
  restoreTagsFromMeta(
    tabId: string,
    tags: Array<{ index: number; anchorMessageId: string; gitTag: string }>,
    redoTurns?: RedoTurn[],
  ): void;
  skipCleanup(tabId: string): void;
  shouldSkipCleanup(tabId: string): boolean;

  // Cleanup
  cleanupGitTags(tabId: string, cwd: string): Promise<void>;
  clear(tabId: string): void;
}

function emptyTab(): PerTab {
  return { checkpoints: [], viewing: null, redoStack: [], lastSyncedLen: 0 };
}

function getTab(tabs: Record<string, PerTab>, tabId: string): PerTab {
  return tabs[tabId] ?? emptyTab();
}

export const useCheckpointStore = create<CheckpointState>()((set, get) => ({
  tabs: {},
  skipCleanupTabs: new Set(),

  syncFromMessages(tabId: string, messages: ChatMessage[], isLoading: boolean) {
    const state = get();
    const tab = getTab(state.tabs, tabId);

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
      if (prev?.gitTag) cp.gitTag = prev.gitTag;
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

    // Clear the redo stack once the conversation moved on after the undo: a turn now holds the
    // place of an undone turn. Comparing with the undone turns rather than the previous sync
    // keeps a redo stack restored from a saved session through the first sync after a resume.
    const undoneAt = new Map(tab.redoStack.map((e) => [e.turn.index, e.turn.anchorMessageId]));
    const firstUndone = tab.redoStack[0]?.turn.index ?? Number.POSITIVE_INFINITY;
    const movedOn = checkpoints.some(
      (cp) => cp.index >= firstUndone && undoneAt.get(cp.index) !== cp.anchorMessageId,
    );
    const redoStack = movedOn ? [] : tab.redoStack;

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
          redoStack,
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

  async tagFinishedTurns(tabId: string, cwd: string): Promise<void> {
    for (const cp of get().getCheckpoints(tabId))
      if (cp.filesEdited.length > 0 && !cp.gitTag && !cp.undone)
        await get().createGitTag(tabId, cp.index, cwd);
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
    for (const entry of tab.redoStack) add(entry.checkpoint);
    return out;
  },

  async undoToCheckpoint(
    tabId: string,
    targetIndex: number,
    cwd: string,
    liveMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ): Promise<UndoResult | null> {
    const tab = getTab(get().tabs, tabId);
    const coordinator = getWorkspaceCoordinator();
    let result: Awaited<ReturnType<typeof undoTurns>>;
    try {
      // Serialized with snapshots so createGitTag never sees a partially restored working tree.
      result = await withGitLock(cwd, () =>
        undoTurns({
          cwd,
          messages: liveMessages,
          redo: tab.redoStack.map((e) => e.turn),
          toCheckpoint: targetIndex,
          tags: get().snapshotTags(tabId),
          backupTag: `baked/undo-backup-${crypto.randomUUID().slice(0, 8)}`,
          ...(options.force ? { force: true } : {}),
          claimedBy: (path) => coordinator.getConflicts(tabId, [path])[0]?.ownerTabLabel ?? null,
        }),
      );
    } catch (err) {
      if (err instanceof TurnUndoError) return null;
      throw err;
    }

    // Use functional updater: syncFromMessages may have run during the file I/O above.
    set((s) => {
      const freshTab = s.tabs[tabId] ?? emptyTab();
      const known = new Map<string, RedoEntry>();
      for (const e of freshTab.redoStack) known.set(e.turn.anchorMessageId, e);
      const redoStack = result.redo.map(
        (turn): RedoEntry =>
          known.get(turn.anchorMessageId) ?? {
            turn,
            checkpoint: {
              ...(freshTab.checkpoints.find((c) => c.anchorMessageId === turn.anchorMessageId) ??
                checkpointOf(turn, null)),
              undone: true,
            },
          },
      );
      return {
        tabs: {
          ...s.tabs,
          [tabId]: {
            ...freshTab,
            checkpoints: freshTab.checkpoints.map((cp) =>
              cp.index > targetIndex ? { ...cp, undone: true } : cp,
            ),
            redoStack,
            viewing: null,
          },
        },
      };
    });
    return { messages: result.messages, rollback: result.rollback };
  },

  async redo(
    tabId: string,
    cwd: string,
    liveMessages: ChatMessage[],
    options: { force?: boolean } = {},
  ): Promise<RedoResult | null> {
    const tab = getTab(get().tabs, tabId);
    const next = tab.redoStack[0];
    if (!next) return null;
    const coordinator = getWorkspaceCoordinator();
    let result: Awaited<ReturnType<typeof redoTurn>>;
    try {
      result = await withGitLock(cwd, () =>
        redoTurn({
          cwd,
          messages: liveMessages,
          redo: tab.redoStack.map((e) => e.turn),
          tags: get().snapshotTags(tabId),
          backupTag: `baked/redo-backup-${crypto.randomUUID().slice(0, 8)}`,
          ...(options.force ? { force: true } : {}),
          claimedBy: (path) => coordinator.getConflicts(tabId, [path])[0]?.ownerTabLabel ?? null,
        }),
      );
    } catch (err) {
      if (err instanceof TurnUndoError) return null;
      throw err;
    }

    set((s) => {
      const freshTab = s.tabs[tabId] ?? emptyTab();
      const redone = { ...next.checkpoint, undone: false };
      // The redone turn counts as known, so the next sync does not take it for a new turn.
      const checkpoints = [
        ...freshTab.checkpoints.filter(
          (cp) => cp.index < redone.index && cp.anchorMessageId !== redone.anchorMessageId,
        ),
        redone,
        ...freshTab.checkpoints.filter((cp) => cp.index > redone.index),
      ];
      return {
        tabs: {
          ...s.tabs,
          [tabId]: {
            ...freshTab,
            checkpoints,
            redoStack: freshTab.redoStack.filter(
              (e) => e.turn.anchorMessageId !== next.turn.anchorMessageId,
            ),
            viewing: null,
          },
        },
      };
    });
    return { messages: result.messages, rollback: result.rollback };
  },

  redoTurns(tabId: string): RedoTurn[] {
    return getTab(get().tabs, tabId).redoStack.map((e) => e.turn);
  },

  canRedo(tabId: string): boolean {
    return (get().tabs[tabId]?.redoStack.length ?? 0) > 0;
  },

  getRedoCount(tabId: string): number {
    return get().tabs[tabId]?.redoStack.length ?? 0;
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
    redoTurns: RedoTurn[] = [],
  ) {
    const baseTag = tags.find((t) => t.index === 0);
    const redoAnchors = new Set(redoTurns.map((t) => t.anchorMessageId));
    const regular = tags.filter((t) => t.index !== 0 && !redoAnchors.has(t.anchorMessageId));
    const redoStack = redoTurns.map(
      (turn): RedoEntry => ({
        turn,
        checkpoint: checkpointOf(
          turn,
          tags.find((t) => t.anchorMessageId === turn.anchorMessageId)?.gitTag ?? null,
        ),
      }),
    );
    set((s) => {
      const tab = {
        ...(s.tabs[tabId] ?? emptyTab()),
        ...(baseTag ? { baseTag } : {}),
        ...(redoStack.length > 0 ? { redoStack } : {}),
      };
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

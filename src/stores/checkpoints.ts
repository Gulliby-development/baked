import { relative } from "node:path";
import { create } from "zustand";
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
 * Redo entry — holds the messages that were dropped by an undo so they can be
 * restored. Kept separate from Checkpoint so the live checkpoint list never
 * retains historical message arrays.
 */
interface RedoEntry {
  checkpoint: Checkpoint;
  droppedMessages: ChatMessage[];
}

export interface FileConflict {
  path: string;
  ownerTabId: string;
  ownerTabLabel: string;
}

export interface UndoResult {
  messages: ChatMessage[];
  restoredFiles: string[];
  conflicts: FileConflict[];
}

export interface RedoResult {
  messages: ChatMessage[];
  restoredFiles: string[];
}

// ── Constants ──

const EDIT_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "rename_file",
  "rename_symbol",
  "move_symbol",
  "refactor",
  "undo_edit",
]);

const READ_TOOLS = new Set([
  "Read",
  "bake_grep",
  "navigate",
  "Grep",
  "Glob",
  "bake_find",
  "bake_analyze",
  "analyze",
]);

function slugify(text: string, maxLen = 30): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen);
}

function makeTagName(tabId: string, index: number, prompt: string): string {
  const slug = slugify(prompt);
  return `baked/cp-${tabId.slice(0, 8)}-${String(index)}-${slug}`;
}

function extractFilesFromToolCalls(msg: ChatMessage): { read: string[]; edited: string[] } {
  const read: string[] = [];
  const edited: string[] = [];
  if (!msg.toolCalls) return { read, edited };

  for (const tc of msg.toolCalls) {
    if (EDIT_TOOLS.has(tc.name) && tc.result?.success) {
      const p = tc.args.path ?? tc.args.file;
      if (typeof p === "string") edited.push(p);
      // rename_file has from/to
      if (typeof tc.args.from === "string") edited.push(tc.args.from);
      if (typeof tc.args.to === "string" && tc.name === "rename_file") edited.push(tc.args.to);
      // multi_edit path
      if (tc.name === "multi_edit" && typeof tc.args.path === "string") {
        if (!edited.includes(tc.args.path as string)) edited.push(tc.args.path as string);
      }
    }
    if (READ_TOOLS.has(tc.name)) {
      const p = tc.args.path ?? tc.args.file;
      if (typeof p === "string") read.push(p);
      // Read tool can have files array
      if (Array.isArray(tc.args.files)) {
        for (const f of tc.args.files) {
          if (typeof f === "object" && f && typeof (f as { path?: string }).path === "string") {
            read.push((f as { path: string }).path);
          }
        }
      }
    }
    // dispatch results
    if (tc.name === "dispatch" && tc.result?.filesEdited) {
      for (const f of tc.result.filesEdited as string[]) edited.push(f);
    }
  }
  return { read: [...new Set(read)], edited: [...new Set(edited)] };
}

// ── Store ──

interface PerTab {
  checkpoints: Checkpoint[];
  viewing: number | null; // null = live
  redoStack: RedoEntry[];
  lastSyncedLen: number;
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
  undoToCheckpoint(
    tabId: string,
    index: number,
    cwd: string,
    liveMessages: ChatMessage[],
  ): Promise<UndoResult | null>;
  redo(tabId: string, cwd: string, liveMessages: ChatMessage[]): Promise<RedoResult | null>;
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

    // Clear redo stack if new checkpoints appeared (user sent a new message after undo)
    const hasNewCheckpoints = checkpoints.some(
      (cp) => !cp.undone && !tab.checkpoints.find((p) => p.anchorMessageId === cp.anchorMessageId),
    );
    const redoStack = hasNewCheckpoints ? [] : tab.redoStack;

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

    const tag = makeTagName(tabId, index, cp.prompt);

    // Serialize git operations to prevent concurrent tabs from corrupting the tree
    const ok = await withGitLock(cwd, async () => {
      const add = await gitRun(["add", "-A"], cwd);
      if (!add.ok) return false;

      const commit = await gitRun(
        ["commit", "-m", `baked-cp-${String(index)}`, "--allow-empty"],
        cwd,
      );
      if (!commit.ok) return false;

      const tagResult = await gitRun(["tag", tag], cwd);
      if (!tagResult.ok) {
        await gitRun(["reset", "HEAD~1", "--mixed"], cwd);
        return false;
      }

      await gitRun(["reset", "HEAD~1", "--mixed"], cwd);
      return true;
    });

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

  async undoToCheckpoint(
    tabId: string,
    targetIndex: number,
    cwd: string,
    liveMessages: ChatMessage[],
  ): Promise<UndoResult | null> {
    const tab = getTab(get().tabs, tabId);
    const targetCp = tab.checkpoints.find((c) => c.index === targetIndex);
    if (!targetCp) return null;

    // Collect all checkpoints after target that will be undone
    const toUndo = tab.checkpoints.filter((c) => c.index > targetIndex && !c.undone);
    if (toUndo.length === 0) return null;

    // Slice messages at the target anchor. Everything after is "dropped" —
    // stashed into the redo stack so a subsequent redo can restore them.
    const anchorIdx = liveMessages.findIndex((m) => m.id === targetCp.anchorMessageId);
    const messages = anchorIdx >= 0 ? liveMessages.slice(0, anchorIdx + 1) : liveMessages;
    const droppedMessages = anchorIdx >= 0 ? liveMessages.slice(anchorIdx + 1) : [];

    // Bucket dropped messages by which undone checkpoint they belonged to,
    // so each RedoEntry only holds its own slice (not cumulative).
    const redoBuckets = new Map<string, ChatMessage[]>();
    for (const cp of toUndo) redoBuckets.set(cp.anchorMessageId, []);
    {
      let activeAnchor: string | null = null;
      for (const m of droppedMessages) {
        if (m.role === "user" && !m.isSteering) {
          // Start of a new undone checkpoint's messages
          if (redoBuckets.has(m.id)) activeAnchor = m.id;
        }
        if (activeAnchor) {
          const bucket = redoBuckets.get(activeAnchor);
          if (bucket) bucket.push(m);
        }
      }
    }

    // Collect all files that need reverting
    const filesToRevert = new Set<string>();
    for (const cp of toUndo) {
      for (const f of cp.filesEdited) filesToRevert.add(f);
    }

    // Check conflicts with other tabs
    const coordinator = getWorkspaceCoordinator();
    const conflicts: FileConflict[] = [];
    for (const filePath of filesToRevert) {
      const fileConflicts = coordinator.getConflicts(tabId, [filePath]);
      for (const c of fileConflicts) {
        conflicts.push({
          path: c.path,
          ownerTabId: c.ownerTabId,
          ownerTabLabel: c.ownerTabLabel,
        });
      }
    }

    // Restore files — use target's tag, or fall back to the nearest prior tagged
    // checkpoint, or HEAD if no tags exist (e.g. undoing to a chat-only checkpoint).
    const restoreTag =
      targetCp.gitTag ??
      tab.checkpoints
        .filter((c) => c.index < targetIndex && c.gitTag && !c.undone)
        .sort((a, b) => b.index - a.index)[0]?.gitTag ??
      null;

    // Serialize file restoration with the git lock so createGitTag can't
    // snapshot a partially-restored working tree.
    const restoredFiles: string[] = [];
    if (filesToRevert.size > 0) {
      await withGitLock(cwd, async () => {
        const { writeFile, unlink } = await import("node:fs/promises");
        const ref = restoreTag ?? "HEAD";
        for (const absPath of filesToRevert) {
          const relPath = relative(cwd, absPath);
          const result = await gitRun(["show", `${ref}:${relPath}`], cwd, 10_000);
          if (result.ok) {
            await writeFile(absPath, result.stdout);
            restoredFiles.push(absPath);
          } else {
            // File didn't exist at restore point — it was created by the undone
            // checkpoint(s) (new file or rename target). Remove it.
            try {
              await unlink(absPath);
              restoredFiles.push(absPath);
            } catch {
              // Already gone or permission error — best effort
            }
          }
        }
      });
    }

    // Use functional updater — async file I/O above may have allowed syncFromMessages to run
    set((s) => {
      const freshTab = s.tabs[tabId] ?? emptyTab();
      const newCheckpoints = freshTab.checkpoints.map((cp) =>
        cp.index > targetIndex ? { ...cp, undone: true } : cp,
      );
      const newEntries: RedoEntry[] = toUndo.map((cp) => ({
        checkpoint: { ...cp },
        droppedMessages: redoBuckets.get(cp.anchorMessageId) ?? [],
      }));
      // Redo stack: sorted ascending by index for FIFO redo order
      const newRedoStack = [...freshTab.redoStack, ...newEntries].sort(
        (a, b) => a.checkpoint.index - b.checkpoint.index,
      );
      return {
        tabs: {
          ...s.tabs,
          [tabId]: {
            ...freshTab,
            checkpoints: newCheckpoints,
            redoStack: newRedoStack,
            viewing: null,
          },
        },
      };
    });

    return { messages, restoredFiles, conflicts };
  },

  async redo(tabId: string, cwd: string, liveMessages: ChatMessage[]): Promise<RedoResult | null> {
    const tab = getTab(get().tabs, tabId);
    if (tab.redoStack.length === 0) return null;

    // Pop the FIRST undone entry (FIFO — redo in chronological order)
    const toRedo = tab.redoStack[0];
    if (!toRedo) return null;
    const redoCp = toRedo.checkpoint;

    // Restore files to the redo checkpoint's state.
    // Unlike undo, redo MUST use the checkpoint's own tag — a prior tag would
    // restore to the state BEFORE this checkpoint's edits, which is wrong.
    const allFiles = new Set(redoCp.filesEdited);
    const restoredFiles: string[] = [];
    if (redoCp.gitTag && allFiles.size > 0) {
      await withGitLock(cwd, async () => {
        const { writeFile } = await import("node:fs/promises");
        for (const absPath of allFiles) {
          const relPath = relative(cwd, absPath);
          const result = await gitRun(["show", `${redoCp.gitTag}:${relPath}`], cwd, 10_000);
          if (result.ok) {
            await writeFile(absPath, result.stdout);
            restoredFiles.push(absPath);
          }
        }
      });
    }

    // Messages = current live + this redo entry's dropped messages
    const messages = [...liveMessages, ...toRedo.droppedMessages];

    // Use functional updater for consistency after async I/O
    set((s) => {
      const freshTab = s.tabs[tabId] ?? emptyTab();
      const newCheckpoints = freshTab.checkpoints.map((cp) =>
        cp.anchorMessageId === redoCp.anchorMessageId ? { ...cp, undone: false } : cp,
      );
      const newRedoStack = freshTab.redoStack.slice(1); // FIFO: remove from front
      return {
        tabs: {
          ...s.tabs,
          [tabId]: {
            ...freshTab,
            checkpoints: newCheckpoints,
            redoStack: newRedoStack,
            viewing: null,
          },
        },
      };
    });

    return { messages, restoredFiles };
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
  ) {
    set((s) => {
      const tab = s.tabs[tabId] ?? emptyTab();
      // Apply to existing checkpoints if any
      const updated = tab.checkpoints.map((cp) => {
        const saved = tags.find(
          (t) => t.anchorMessageId === cp.anchorMessageId || t.index === cp.index,
        );
        return saved ? { ...cp, gitTag: saved.gitTag } : cp;
      });
      // Also stash as pending so syncFromMessages can pick them up when it rebuilds
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...tab, checkpoints: updated, _pendingTags: tags },
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

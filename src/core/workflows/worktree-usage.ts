/**
 * Disk use of run worktrees under `.baked/worktrees`, and their cleanup. With worktree execution
 * and several writers a run keeps one worktree for the run and one per task; they stay on disk
 * after a run ends until delivery or `discard-worktree` removes them, and benchmark rounds fill
 * the disk with them (#335).
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../specs/hash.js";
import type { RunState } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import { removeRunWorktree, runBranch, worktreePath } from "./worktree.js";

const ROOT = join(".baked", "worktrees");
const TERMINAL: readonly RunState[] = ["completed", "failed", "cancelled"];

/** One run's directory under `.baked/worktrees`. */
export interface WorktreeUsageEntry {
  runId: string;
  /** Null when the store has no such run any more (removed by `gc`): an orphaned directory. */
  featureId: string | null;
  status: RunState | null;
  branch: string;
  /** The run worktree (`main`) and each task worktree, relative to the project root. */
  directories: { path: string; task: string | null; bytes: number }[];
  bytes: number;
  /** Whether a cleanup removes it: the run ended (or is gone) and no delivery step is unsettled. */
  cleanable: boolean;
  /** Why a cleanup keeps it, when it does. */
  kept: string | null;
}

export interface WorktreeUsage {
  worktrees: WorktreeUsageEntry[];
  /** All worktree directories together. */
  bytes: number;
  /** Locked directories moved aside into `.baked/trash`, purged by the next removal. */
  trashBytes: number;
  /** Bytes a cleanup frees. */
  cleanableBytes: number;
}

/**
 * Bytes of the files below `path`. Links are not followed: a worktree links the project's
 * `node_modules` (a junction on Windows), which is not its own disk use.
 */
export function directoryBytes(path: string): number {
  let total = 0;
  const pending = [path];
  while (pending.length) {
    const current = pending.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(child);
      else
        try {
          total += lstatSync(child).size;
        } catch {
          /* removed meanwhile */
        }
    }
  }
  return total;
}

function entry(store: WorkflowStore, runId: string, active: ReadonlySet<string>) {
  const workspace = store.workspace;
  const runDirectory = join(workspace, ROOT, runId);
  const directories = readdirSync(runDirectory, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      path: `.baked/worktrees/${runId}/${d.name}`,
      task: d.name === "main" ? null : d.name,
      bytes: directoryBytes(join(runDirectory, d.name)),
    }))
    .sort((a, b) => (a.task ?? "").localeCompare(b.task ?? ""));
  let run: ReturnType<WorkflowStore["run"]> | null = null;
  try {
    run = store.run(runId);
  } catch {
    run = null;
  }
  const kept = !run
    ? null
    : !TERMINAL.includes(run.status) || active.has(runId)
      ? `run is ${run.status}`
      : store
            .effects(runId)
            .some((e) => e.kind === "delivery" && ["prepared", "unknown"].includes(e.status))
        ? "a delivery step is unsettled"
        : null;
  let branch = runBranch(runId);
  try {
    if (run) branch = store.state(runId).worktree?.branch ?? branch;
  } catch {
    /* a run without readable state keeps the default branch name */
  }
  return {
    runId,
    featureId: run?.feature_id ?? null,
    status: run?.status ?? null,
    branch,
    directories,
    bytes: directories.reduce((sum, d) => sum + d.bytes, 0),
    cleanable: kept === null,
    kept,
  } satisfies WorktreeUsageEntry;
}

/** Every run directory under `.baked/worktrees` with its size, owning run and status. */
export function worktreeUsage(
  store: WorkflowStore,
  active: ReadonlySet<string> = new Set(),
): WorktreeUsage {
  const root = join(store.workspace, ROOT);
  const worktrees = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => entry(store, d.name, active))
        .sort((a, b) => b.bytes - a.bytes || a.runId.localeCompare(b.runId))
    : [];
  return {
    worktrees,
    bytes: worktrees.reduce((sum, w) => sum + w.bytes, 0),
    trashBytes: directoryBytes(join(store.workspace, ".baked", "trash")),
    cleanableBytes: worktrees.filter((w) => w.cleanable).reduce((sum, w) => sum + w.bytes, 0),
  };
}

/**
 * Removes the worktrees of ended runs and orphaned run directories. Branches stay: a branch
 * carries the run's accepted commit, and only `discard-worktree` deletes it. Returns what was
 * removed and what stayed (a directory that is still locked is reported, not thrown).
 */
export async function cleanWorktrees(
  store: WorkflowStore,
  active: ReadonlySet<string> = new Set(),
): Promise<WorktreeCleanup> {
  const removed: string[] = [];
  const failed: { runId: string; error: string }[] = [];
  let bytes = 0;
  for (const worktree of worktreeUsage(store, active).worktrees.filter((w) => w.cleanable)) {
    try {
      await removeRunWorktree(
        store,
        worktree.runId,
        { path: worktreePath(worktree.runId), branch: worktree.branch },
        { deleteBranch: false },
      );
      if (worktree.status)
        store.transaction(() =>
          store.artifact(
            worktree.runId,
            "worktree",
            "worktree/cleaned.json",
            canonical({
              branch: worktree.branch,
              bytes: worktree.bytes,
              cleanedAt: new Date().toISOString(),
            }),
          ),
        );
      removed.push(worktree.runId);
      bytes += worktree.bytes;
    } catch (error) {
      failed.push({ runId: worktree.runId, error: (error as Error).message });
    }
  }
  return { removed, removedBytes: bytes, failed };
}

/** What `cleanWorktrees` removed and what it could not remove. */
export interface WorktreeCleanup {
  removed: string[];
  removedBytes: number;
  failed: { runId: string; error: string }[];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** The terminal listing of `baked workflow worktrees` and `/workflow worktrees`. */
export function formatWorktreeUsage(usage: WorktreeUsage & Partial<WorktreeCleanup>): string {
  const lines: string[] = [];
  if (usage.removed)
    lines.push(
      `Removed ${usage.removed.length} worktree director${usage.removed.length === 1 ? "y" : "ies"} (${formatSize(usage.removedBytes ?? 0)}); their branches stay.`,
      ...(usage.failed ?? []).map((f) => `Kept ${f.runId}: ${f.error}`),
      "",
    );
  if (!usage.worktrees.length) lines.push("No run worktrees under .baked/worktrees.");
  for (const w of usage.worktrees) {
    const owner = w.featureId ? `${w.featureId} ${w.status}` : "no run (removed by gc)";
    const tasks = w.directories.filter((d) => d.task).length;
    lines.push(
      `${formatSize(w.bytes).padStart(9)}  ${w.runId}  ${owner}${tasks ? `, ${tasks} task worktree${tasks === 1 ? "" : "s"}` : ""}${w.kept ? ` (kept: ${w.kept})` : ""}`,
    );
  }
  lines.push(
    "",
    `Total ${formatSize(usage.bytes)}; a cleanup frees ${formatSize(usage.cleanableBytes)}${usage.trashBytes ? `; ${formatSize(usage.trashBytes)} waits in .baked/trash` : ""}.`,
  );
  if (!usage.removed && usage.cleanableBytes)
    lines.push("`worktrees --clean` removes the worktrees of ended runs.");
  return `${lines.join("\n")}\n`;
}

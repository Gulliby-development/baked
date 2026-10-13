import { existsSync, readdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonical } from "../specs/hash.js";
import type { RunState } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import {
  purgeWorktreeTrash,
  removeDirectory,
  removeRunWorktree,
  removeTaskWorktree,
} from "./worktree.js";

/** Where run and task worktrees live, relative to the project root. */
const WORKTREES = join(".baked", "worktrees");
const TRASH = join(".baked", "trash");
const TERMINAL: readonly RunState[] = ["completed", "failed", "cancelled"];

/** The worktrees of one run on disk: its `main` worktree and the task worktrees of its writers. */
export interface RunWorktreeUsage {
  runId: string;
  /** The run's directory relative to the project root, `.baked/worktrees/RUN_ID`. */
  path: string;
  bytes: number;
  worktrees: { name: string; bytes: number }[];
  /** The run's status, or `orphan` when the project has no such run (removed by gc, or another database). */
  status: RunState | "orphan";
  featureId: string | null;
  /** True when a cleanup removes it: the run ended (or is unknown) and no delivery step is unsettled. */
  removable: boolean;
  /** Why a cleanup keeps it, when it is not removable. */
  kept?: string;
}

export interface WorktreeReport {
  worktrees: RunWorktreeUsage[];
  /** Bytes of every run's worktrees. */
  bytes: number;
  /** Bytes of locked worktree directories moved aside, deleted by the next cleanup. */
  trashBytes: number;
}

export interface WorktreeCleanup {
  runIds: string[];
  bytes: number;
  dryRun: boolean;
  /** Directories that stayed on disk, with the reason. */
  warnings: string[];
}

/** Bytes under a path, symbolic links counted as links; a file that disappears counts as zero. */
async function diskBytes(path: string): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length) {
    const current = pending.pop() as string;
    try {
      const info = await lstat(current);
      total += info.size;
      if (info.isDirectory())
        for (const entry of await readdir(current)) pending.push(join(current, entry));
    } catch {
      /* removed while counting */
    }
  }
  return total;
}

function runOf(store: WorkflowStore, runId: string) {
  try {
    return store.run(runId);
  } catch {
    return null;
  }
}

function worktreeOf(store: WorkflowStore, runId: string) {
  try {
    return store.state(runId).worktree;
  } catch {
    return undefined;
  }
}

/**
 * The run and task worktrees under `.baked/worktrees`, largest first, with their run's status. A
 * worktree run keeps its worktree until delivery or a discard removes it, and benchmark rounds with
 * several writers leave many behind.
 */
export async function worktreeUsage(
  store: WorkflowStore,
  isActive: (runId: string) => boolean = () => false,
): Promise<WorktreeReport> {
  const root = join(store.workspace, WORKTREES);
  const worktrees: RunWorktreeUsage[] = [];
  const entries = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  for (const entry of entries) {
    const directory = join(root, entry.name);
    const parts = await Promise.all(
      readdirSync(directory).map(async (name) => ({
        name,
        bytes: await diskBytes(join(directory, name)),
      })),
    );
    const run = runOf(store, entry.name);
    const status = run?.status ?? "orphan";
    const unsettled = run
      ? store
          .effects(run.id)
          .some((e) => e.kind === "delivery" && ["prepared", "unknown"].includes(e.status))
      : false;
    const kept =
      run && (!TERMINAL.includes(run.status) || isActive(run.id))
        ? `run is ${run.status}`
        : unsettled
          ? "a delivery step is unsettled"
          : undefined;
    worktrees.push({
      runId: entry.name,
      path: join(WORKTREES, entry.name).split("\\").join("/"),
      bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
      worktrees: parts.sort((a, b) => b.bytes - a.bytes),
      status,
      featureId: run?.feature_id ?? null,
      removable: kept === undefined,
      ...(kept ? { kept } : {}),
    });
  }
  worktrees.sort((a, b) => b.bytes - a.bytes);
  return {
    worktrees,
    bytes: worktrees.reduce((sum, w) => sum + w.bytes, 0),
    trashBytes: existsSync(join(store.workspace, TRASH))
      ? await diskBytes(join(store.workspace, TRASH))
      : 0,
  };
}

/**
 * Removes the worktrees of ended runs and of runs the project no longer has, and empties the
 * trash. Run branches stay: they carry the accepted commit, and `discard-worktree` deletes one on
 * purpose. Runs that are not ended, or have an unsettled delivery step, are kept.
 */
export async function cleanWorktrees(
  store: WorkflowStore,
  options: { dryRun: boolean; isActive?: (runId: string) => boolean },
): Promise<WorktreeCleanup> {
  const report = await worktreeUsage(store, options.isActive);
  const removable = report.worktrees.filter((w) => w.removable);
  const result: WorktreeCleanup = {
    runIds: removable.map((w) => w.runId),
    bytes: removable.reduce((sum, w) => sum + w.bytes, 0) + report.trashBytes,
    dryRun: options.dryRun,
    warnings: [],
  };
  if (options.dryRun) return result;
  purgeWorktreeTrash(store.workspace);
  const removed: string[] = [];
  for (const usage of removable) {
    try {
      const worktree = usage.status === "orphan" ? undefined : worktreeOf(store, usage.runId);
      if (worktree) {
        await removeRunWorktree(store, usage.runId, worktree, { deleteBranch: false });
        store.transaction(() =>
          store.artifact(
            usage.runId,
            "worktree",
            "worktree/cleaned.json",
            canonical({ ...worktree, cleanedAt: new Date().toISOString(), bytes: usage.bytes }),
          ),
        );
      } else {
        for (const part of usage.worktrees) {
          const left = await removeTaskWorktree(store.workspace, join(usage.path, part.name));
          if (left.warning) throw new Error(left.warning);
        }
        const left = await removeDirectory(join(store.workspace, usage.path));
        if (left) throw left;
      }
      removed.push(usage.runId);
    } catch (error) {
      result.warnings.push(
        `${usage.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const kept = new Set(removed);
  result.runIds = removed;
  result.bytes =
    removable.filter((w) => kept.has(w.runId)).reduce((sum, w) => sum + w.bytes, 0) +
    report.trashBytes;
  return result;
}

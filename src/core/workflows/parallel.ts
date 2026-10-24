/**
 * Helpers for runs with several writers (parallel worktrees, phases 2 and 3): forming task
 * batches, limiting concurrent checks and describing an integration conflict. The scheduler runs
 * the tasks of a batch as concurrent async workers in its own thread; each worker edits and checks
 * its own worktree, and the scheduler integrates the results one at a time.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../platform/index.js";
import { git } from "./delivery-git.js";
import type { Task } from "./types.js";

/** Task checks that may run at the same time across the task worktrees of a batch. */
export const MAX_CONCURRENT_TASK_CHECKS = 2;

/**
 * What a task claims in the run worktree: the paths it writes and the directories its creates
 * would bring into existence. Two tasks overlap when their claims intersect.
 */
export function writeClaims(task: Task, exists: (path: string) => boolean): Set<string> {
  const claims = new Set<string>();
  for (const write of task.writes) {
    claims.add(write.path);
    if (write.action !== "create") continue;
    for (let directory = dirname(write.path); directory !== "." && directory !== ""; ) {
      if (exists(directory)) break;
      claims.add(directory);
      directory = dirname(directory);
    }
  }
  return claims;
}

export interface BatchPlan {
  batch: Task[];
  /** Ready tasks left for a later batch because their writes overlap a task in this one. */
  overlapping: string[];
}

/**
 * The next batch: ready tasks in scheduling order, up to `limit`, pairwise disjoint by written paths
 * and created directories. An overlapping task moves to a later batch, unless the policy allows
 * overlapping writes; then it joins and a conflict is resolved at integration.
 */
export function planBatch(
  ready: Task[],
  limit: number,
  allowOverlap: boolean,
  exists: (path: string) => boolean,
): BatchPlan {
  const batch: Task[] = [];
  const overlapping: string[] = [];
  const claimed = new Set<string>();
  for (const task of ready) {
    if (batch.length >= limit) break;
    const claims = writeClaims(task, exists);
    if (!allowOverlap && [...claims].some((claim) => claimed.has(claim))) {
      overlapping.push(task.id);
      continue;
    }
    for (const claim of claims) claimed.add(claim);
    batch.push(task);
  }
  return { batch, overlapping };
}

/** A counting semaphore for async work in one thread. */
export class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await action();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/** A unified diff of one file between two versions; null stands for a missing file. */
export async function unifiedDiff(
  path: string,
  before: Uint8Array | null,
  after: Uint8Array | null,
): Promise<string> {
  const directory = mkdtempSync(join(tmpDir(), "baked-diff-"));
  try {
    writeFileSync(join(directory, "a"), before ?? new Uint8Array());
    writeFileSync(join(directory, "b"), after ?? new Uint8Array());
    const result = await git(directory, ["diff", "--no-index", "--no-color", "--", "a", "b"]);
    const body = result.stdout.split("\n").slice(4).join("\n");
    const from = before === null ? "/dev/null" : `a/${path}`;
    const to = after === null ? "/dev/null" : `b/${path}`;
    return body ? `--- ${from}\n+++ ${to}\n${body}` : "";
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

import { existsSync, readFileSync } from "node:fs";
import { workspacePath } from "../specs/validate.js";
import { unifiedDiff } from "./parallel.js";
import { readKept } from "./rollback.js";
import type { WorkflowStore } from "./store.js";

/** Characters of the review bundle's patch; the reviewers read what it cuts off. */
export const MAX_BUNDLE_PATCH_CHARS = 48_000;
/** Logical path prefix of a review bundle artifact; the snapshot id follows. */
export const REVIEW_BUNDLE_PATH = "review/bundle-";

export interface ReviewBundle {
  changed: string[];
  patch: string;
}

/**
 * Every file the run's journal edited, with the hash it had before the run's first edit of it,
 * in the order of the first edit. Failed and unknown effects changed nothing the run can claim.
 */
export function journaledBaseHashes(
  store: WorkflowStore,
  runId: string,
): Map<string, string | null> {
  const first = new Map<string, string | null>();
  for (const effect of store.effects(runId)) {
    if (effect.kind !== "file_patch" || !["applied", "reconciled"].includes(effect.status))
      continue;
    const path = (JSON.parse(effect.intent_json) as { path?: string }).path;
    if (path && !first.has(path)) first.set(path, effect.before_hash);
  }
  return first;
}

/**
 * One unified diff of the run's changes against what the files held before the run, built from
 * the edit journal and the pre-images it kept, so it needs no Git repository and is the same for
 * a run in a worktree. Files whose earlier content was not kept are listed without a diff.
 */
export async function buildReviewBundle(
  store: WorkflowStore,
  runId: string,
  root: string,
): Promise<ReviewBundle> {
  const parts: string[] = [];
  const changed: string[] = [];
  for (const [path, hash] of journaledBaseHashes(store, runId)) {
    const earlier = hash === null ? null : readKept(store, runId, hash);
    const absolute = workspacePath(root, path);
    const now = existsSync(absolute) ? readFileSync(absolute) : null;
    const part =
      hash !== null && earlier === null
        ? `--- ${path}: earlier content not kept, read the file`
        : await unifiedDiff(path, earlier, now);
    if (!part) continue;
    changed.push(path);
    parts.push(part);
  }
  const text = parts.join("\n");
  return {
    changed,
    patch:
      text.length > MAX_BUNDLE_PATCH_CHARS
        ? `${text.slice(0, MAX_BUNDLE_PATCH_CHARS)}\n... patch cut at ${MAX_BUNDLE_PATCH_CHARS} characters; read the files for the rest`
        : text,
  };
}

/**
 * The changed files of each task that changed any, so a reviewer ties a hunk of the bundle to its
 * task without reading the task graph.
 */
export function taskChangedFiles(
  tasks: readonly { id: string; writes: readonly { path: string }[] }[],
  changed: readonly string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const task of tasks) {
    const paths = task.writes.map((w) => w.path).filter((path) => changed.includes(path));
    if (paths.length) out[task.id] = paths;
  }
  return out;
}

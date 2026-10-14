import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { workspacePath } from "../specs/validate.js";

/**
 * Whole-project formatters (`cargo fmt`, `dotnet format`, a formatter given a directory) rewrite
 * files beyond the one they are given. A fixer pass keeps a copy of the files outside its scope
 * before it runs and puts back those the fixer changed, so a formatter never leaves another
 * task's file edited in the worktree (bench round 12, mdrefs T003: `cargo fmt` reformatted three
 * sibling files, the attempt was rejected `input_changed` and the next two were refused on the
 * edits it left behind).
 */
export function keepOutside(
  root: string,
  manifest: Record<string, string>,
  scope: ReadonlySet<string>,
): Map<string, Buffer> {
  const kept = new Map<string, Buffer>();
  for (const path of Object.keys(manifest))
    if (!scope.has(path)) kept.set(path, readFileSync(workspacePath(root, path)));
  return kept;
}

/**
 * Puts back the files outside the fixer's scope that it changed: a kept file gets its content
 * back and a file the fixer created is removed.
 */
export function restoreOutside(
  root: string,
  kept: ReadonlyMap<string, Buffer>,
  outside: readonly string[],
): void {
  for (const path of outside) {
    const target = workspacePath(root, path);
    const content = kept.get(path);
    if (content) writeFileSync(target, content);
    else if (existsSync(target)) unlinkSync(target);
  }
}

/**
 * The files outside a task's writes that changed in its worktree although no journaled edit of
 * the attempt wrote them: a host process (a whole-unit formatter run by a probe or a check) did,
 * not the task's own edits. The scope check puts them back instead of stopping the run on them
 * (bench round 25, bytelens T002: T001's unformatted `src/schema.rs` was rewritten in T002's
 * worktree, the run stopped `input_changed`, and a plain resume stopped on it again).
 */
export function unjournaledOutside(
  changed: readonly string[],
  writes: ReadonlySet<string>,
  journaled: ReadonlySet<string>,
): string[] {
  return changed.filter((path) => !writes.has(path) && !journaled.has(path));
}

/** A changed path with the short hashes it had before and after, for a stop's detail. */
export function describeChange(
  path: string,
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const short = (hash: string | undefined) => (hash ? hash.slice(0, 6) : "none");
  return `${path} (${short(before[path])} -> ${short(after[path])})`;
}

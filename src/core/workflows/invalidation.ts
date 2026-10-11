import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { WorkflowStore } from "./store.js";
import type { Task } from "./types.js";

const MAX_SOURCE_BYTES = 256 * 1024;
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|pyi|rs|go|rb|php|java|kt|cs|swift)$/i;
const SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+|\bmod\s+|\buse\s+|\binclude\s+|\bsource\s+)["']?([\w@./:-]+)/g;

/** A path without its extension and without a trailing `/index`, as imports name it. */
const stem = (path: string): string =>
  path
    .replaceAll("\\", "/")
    .replace(/\.[^./]+$/, "")
    .replace(/\/(?:index|__init__)$/, "");

/**
 * Files the corrective tasks of a repair chain changed, from their stored diffs; null when a
 * diff is missing, so the caller falls back to treating everything as changed.
 */
export function repairChangedFiles(
  store: WorkflowStore,
  runId: string,
  corrections: Pick<Task, "id">[],
): Set<string> | null {
  const changed = new Set<string>();
  for (const task of corrections) {
    const artifact = store.latestArtifact(runId, `tasks/${task.id}/diff.json`);
    if (!artifact) return null;
    try {
      const body = JSON.parse(store.readArtifact(runId, artifact.id)) as { changed?: unknown };
      if (!Array.isArray(body.changed)) return null;
      for (const path of body.changed) if (typeof path === "string") changed.add(path);
    } catch {
      return null;
    }
  }
  return changed;
}

/** Module names a source file imports, as written. */
function specifiers(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) if (match[1]) names.push(match[1]);
  return names;
}

/**
 * Whether a task reads or writes one of the changed files: it lists the file in its writes or
 * read hints, or one of the files it writes imports it (a relative specifier that resolves to
 * the file, or a dotted module name that ends in its path). A written file that cannot be read or
 * is not a source file the scan understands counts as touching the change, so the answer errs
 * toward rerunning.
 */
export function readsChangedFile(root: string, task: Task, changed: ReadonlySet<string>): boolean {
  const named = new Set([...task.writes.map((w) => w.path), ...task.readHints]);
  if ([...changed].some((path) => named.has(path))) return true;
  const stems = new Map([...changed].map((path) => [stem(path), path] as const));
  for (const write of task.writes) {
    if (write.action === "delete") continue;
    const file = join(root, write.path);
    if (!existsSync(file)) continue;
    if (!EXTENSIONS.test(write.path)) return true;
    let source: string;
    try {
      if (statSync(file).size > MAX_SOURCE_BYTES) return true;
      source = readFileSync(file, "utf8");
    } catch {
      return true;
    }
    for (const name of specifiers(source)) {
      const relative = name.startsWith(".")
        ? stem(posix.normalize(posix.join(dirname(write.path).replaceAll("\\", "/"), name)))
        : null;
      const dotted = name.replaceAll(".", "/");
      for (const [changedStem] of stems) {
        if (relative !== null && relative === changedStem) return true;
        if (
          relative === null &&
          (stem(name) === changedStem ||
            changedStem.endsWith(`/${dotted}`) ||
            changedStem === dotted)
        )
          return true;
      }
    }
  }
  return false;
}

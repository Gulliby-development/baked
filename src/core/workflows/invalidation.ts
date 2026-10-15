import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { WorkflowStore } from "./store.js";
import type { Task } from "./types.js";

const MAX_SOURCE_BYTES = 256 * 1024;
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|pyi|rs|go|rb|php|java|kt|cs|swift)$/i;
/** Prose a documentation writer produces; it reads only what its read hints and writes name. */
const DOCUMENTATION = /.(?:mdx?|rst|txt|adoc)$/i;
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
 * How a task is reached by a change to files: `named` when it lists one in its writes or read
 * hints, `imports` when only a file it writes imports one (a relative specifier that resolves to
 * the file, or a dotted module name that ends in its path), `unknown` when a written file cannot
 * be read or is not a file the scan understands, and `none` otherwise. A documentation file
 * (Markdown, reStructuredText, text) is understood: its writer reads what its read hints name,
 * so a change elsewhere does not reach it (md-site T004, T005; expenses-py A T003, T005 reran
 * for nothing).
 */
export type Reach = "named" | "imports" | "unknown" | "none";

export function changeReach(
  root: string,
  task: Pick<Task, "writes" | "readHints">,
  changed: ReadonlySet<string>,
): Reach {
  const named = new Set([...task.writes.map((w) => w.path), ...task.readHints]);
  if ([...changed].some((path) => named.has(path))) return "named";
  const stems = new Map([...changed].map((path) => [stem(path), path] as const));
  let reach: Reach = "none";
  for (const write of task.writes) {
    if (write.action === "delete") continue;
    if (DOCUMENTATION.test(write.path)) continue;
    const file = join(root, write.path);
    if (!existsSync(file)) continue;
    if (!EXTENSIONS.test(write.path)) return "unknown";
    let source: string;
    try {
      if (statSync(file).size > MAX_SOURCE_BYTES) return "unknown";
      source = readFileSync(file, "utf8");
    } catch {
      return "unknown";
    }
    for (const name of specifiers(source)) {
      const relative = name.startsWith(".")
        ? stem(posix.normalize(posix.join(dirname(write.path).replaceAll("\\", "/"), name)))
        : null;
      const dotted = name.replaceAll(".", "/");
      for (const [changedStem] of stems) {
        if (relative !== null && relative === changedStem) reach = "imports";
        if (
          relative === null &&
          (stem(name) === changedStem ||
            changedStem.endsWith(`/${dotted}`) ||
            changedStem === dotted)
        )
          reach = "imports";
      }
    }
  }
  return reach;
}

/** Whether a change reaches a task at all; the answer errs toward rerunning. */
export function readsChangedFile(root: string, task: Task, changed: ReadonlySet<string>): boolean {
  return changeReach(root, task, changed) !== "none";
}

/**
 * The `candidates` that `files` import, directly or through other candidates up to `depth` hops,
 * read from the files under `root`: the planned sources a failing test reaches (#1285).
 */
export function importedFiles(
  root: string,
  files: readonly string[],
  candidates: readonly string[],
  depth = 2,
): string[] {
  const found: string[] = [];
  let frontier = [...files];
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next = candidates.filter(
      (path) =>
        !found.includes(path) &&
        !files.includes(path) &&
        frontier.some(
          (from) =>
            changeReach(
              root,
              { writes: [{ path: from, action: "modify" }], readHints: [] },
              new Set([path]),
            ) === "imports",
        ),
    );
    found.push(...next);
    frontier = next;
  }
  return found;
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { WorkflowStore } from "./store.js";
import type { Task } from "./types.js";

const MAX_SOURCE_BYTES = 256 * 1024;
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|pyi|rs|go|rb|php|java|kt|cs|swift)$/i;
const JVM_FILE = /\.(?:java|kt|kts|scala|groovy)$/;
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
    if (reach !== "imports" && languageImports(write.path, source, changed)) reach = "imports";
  }
  return reach;
}

/**
 * Imports the specifier scan cannot resolve, by language (#1420): a Go file reaches the other
 * files of its package directory and the packages its import block names; a Rust file the
 * modules of its crate that `use crate::`, `use <crate>::`, `self::`, `super::` or `mod` name; a
 * Java, Kotlin or Scala file the classes of its own package it names; a Python file the modules
 * of a relative import (`from ..parser import x`, `from . import parser`).
 */
function languageImports(path: string, source: string, changed: ReadonlySet<string>): boolean {
  const file = path.replaceAll("\\", "/");
  const dir = posix.dirname(file);
  const others = [...changed].map((c) => c.replaceAll("\\", "/")).filter((c) => c !== file);
  if (file.endsWith(".go")) {
    const imports = [
      ...source.matchAll(/^\s*import\s*\(([\s\S]*?)\)|^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm),
    ].flatMap((m) =>
      m[2] ? [m[2]] : [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((q) => q[1] ?? ""),
    );
    return others.some((c) => {
      if (!c.endsWith(".go")) return false;
      const target = posix.dirname(c);
      return (
        target === dir ||
        (target !== "." && imports.some((i) => i === target || i.endsWith(`/${target}`)))
      );
    });
  }
  if (file.endsWith(".rs")) {
    const crate = /^(?:(.*)\/)?(?:src|tests|benches|examples)\//.exec(file);
    const src = crate?.[1] ? `${crate[1]}/src` : "src";
    const own = /(?:^|\/)(?:lib|main|mod)\.rs$/.test(file) ? dir : file.replace(/\.rs$/, "");
    const modules = new Set<string>();
    for (const m of source.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm))
      modules.add(`${own}/${m[1]}`);
    for (const m of source.matchAll(/\buse\s+([\w:]+)/g)) {
      const segments = (m[1] ?? "").split("::").filter(Boolean);
      const head = segments[0] ?? "";
      if (segments.length < 2 || ["std", "core", "alloc"].includes(head)) continue;
      const base = head === "self" ? own : head === "super" ? posix.dirname(own) : src;
      const rest = segments.slice(1);
      for (let n = 1; n <= rest.length; n++) modules.add(`${base}/${rest.slice(0, n).join("/")}`);
    }
    return others.some((c) => c.endsWith(".rs") && modules.has(stem(c).replace(/\/mod$/, "")));
  }
  if (JVM_FILE.test(file)) {
    const pkg = /^\s*package\s+([\w.]+)/m.exec(source)?.[1];
    if (!pkg) return false;
    const pkgPath = pkg.replaceAll(".", "/");
    return others.some((c) => {
      const s = stem(c);
      const name = s.slice(s.lastIndexOf("/") + 1);
      return (
        JVM_FILE.test(c) &&
        (posix.dirname(s) === pkgPath || posix.dirname(s).endsWith(`/${pkgPath}`)) &&
        new RegExp(`\\b${name}\\b`).test(source)
      );
    });
  }
  if (/\.pyi?$/.test(file)) {
    const modules = new Set<string>();
    for (const m of source.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+\(?([\w\s,]+)/gm)) {
      let base = dir;
      for (let up = 1; up < (m[1] ?? ".").length; up++) base = posix.dirname(base);
      const module = (m[2] ?? "").replaceAll(".", "/");
      modules.add(module ? posix.join(base, module) : base);
      if (!module)
        for (const name of (m[3] ?? "").split(",")) {
          const imported = name.trim().split(/\s+/)[0];
          if (imported) modules.add(posix.join(base, imported));
        }
    }
    return others.some((c) => /\.pyi?$/.test(c) && modules.has(stem(c)));
  }
  return false;
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

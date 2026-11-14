import { isAbsolute, relative, resolve } from "node:path";
import type { TaskGraph } from "./schemas.js";
import type { TaskRow } from "./store.js";
import { namesPath } from "./task-graph.js";
import type { Task } from "./types.js";

/**
 * Unresolved items a task's own tools can never resolve (#3021). A plan told the README task of
 * smoke caesar (run 886d9832) to write a sample file "in a scratch directory outside the
 * repository" and run the CLI on it; `edit_file` takes only paths inside the workspace and
 * `run_probe` runs the project's tools, so the worker wrote the README, its checks passed, and it
 * ended `blocked` on that one step at every resume. node-npm-wordfreq (8d80efd3) ended the same
 * way with only the later test task's file left. The host's documented-example run checks a
 * README example; a later task writes its own file.
 */
export type OutOfReach =
  | { item: string; reason: "outside_workspace"; paths: string[] }
  | { item: string; reason: "later_task"; tasks: string[]; paths: string[] };

/** Words that say a step needs a place outside the workspace. */
const OUTSIDE_WORDS =
  /\boutside (?:of )?(?:the |this |its )?(?:repository|repo|workspace|project(?: root| directory)?|checkout|working (?:tree|directory))\b/i;
/**
 * The top directories of an absolute path that is a place on the machine, not a route a program
 * serves (`/api/users`): temporary and home directories, and the system's own.
 */
const MACHINE_TOPS = new Set([
  "tmp",
  "var",
  "private",
  "home",
  "Users",
  "root",
  "usr",
  "opt",
  "etc",
  "mnt",
  "media",
  "Volumes",
  "srv",
]);
const PATH_CHAR = String.raw`[^\s"'\`()<>,;]`;
const SEGMENT = String.raw`[^\s"'\`()<>,;/]+`;
const POSIX_ABSOLUTE = new RegExp(String.raw`(?<![\w.:/\\-])/(${SEGMENT})/${PATH_CHAR}*`, "g");
const OTHER_OUTSIDE = new RegExp(
  String.raw`(?<![\w.:/\\-])(?:[A-Za-z]:[\\/]${PATH_CHAR}+|~[\\/]${PATH_CHAR}+|\.\.[\\/]${PATH_CHAR}*|(?:%TEMP%|%TMP%|\$TMPDIR|\$\{TMPDIR\}|\$HOME)[\\/]?${PATH_CHAR}*)`,
  "g",
);

/** Whether an absolute path, as this machine reads it, lies in the workspace `root`. */
function inWorkspace(path: string, root: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(resolve(root), resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** The paths an item names that lie outside the workspace `root`. */
export function outsidePaths(item: string, root: string): string[] {
  const found = [
    ...[...item.matchAll(POSIX_ABSOLUTE)]
      .filter((match) => MACHINE_TOPS.has(match[1] ?? ""))
      .map((match) => match[0]),
    ...[...item.matchAll(OTHER_OUTSIDE)].map((match) => match[0]),
  ]
    .map((path) => path.replace(/[.:]+$/, ""))
    // A path inside the workspace written out in full is the workspace's own.
    .filter((path) => !inWorkspace(path, root));
  return [...new Set(found)];
}

/** The unfinished tasks that depend on `task`, directly or through others. */
function laterTasks(graph: TaskGraph, rows: readonly TaskRow[], task: Task): Task[] {
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const later = new Set<string>([task.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const other of graph.tasks)
      if (!later.has(other.id) && other.dependsOn.some((id) => later.has(id))) {
        later.add(other.id);
        grew = true;
      }
  }
  return graph.tasks.filter(
    (other) =>
      other.id !== task.id &&
      later.has(other.id) &&
      !["implemented", "verified"].includes(status.get(other.id) ?? "pending"),
  );
}

/**
 * Each unresolved item with why the task cannot resolve it: it needs a path outside the
 * workspace (one it names, or "outside the repository"), or it names a file that a later,
 * unfinished task writes and the task does not. Null when any item is neither, so a gap in the
 * task's own scope still stops the run, and null for no items.
 */
export function outOfReach(
  unresolved: readonly string[],
  root: string,
  graph: TaskGraph,
  rows: readonly TaskRow[],
  task: Task,
): OutOfReach[] | null {
  if (!unresolved.length) return null;
  const later = laterTasks(graph, rows, task);
  const reached: OutOfReach[] = [];
  for (const item of unresolved) {
    const paths = outsidePaths(item, root);
    if (paths.length || OUTSIDE_WORDS.test(item)) {
      reached.push({ item, reason: "outside_workspace", paths });
      continue;
    }
    const owned = later.flatMap((other) =>
      other.writes
        .filter(
          (w) =>
            w.action !== "delete" &&
            !task.writes.some((own) => own.path === w.path) &&
            namesPath(item, w.path),
        )
        .map((w) => ({ task: other.id, path: w.path })),
    );
    if (!owned.length) return null;
    reached.push({
      item,
      reason: "later_task",
      tasks: [...new Set(owned.map((o) => o.task))],
      paths: [...new Set(owned.map((o) => o.path))],
    });
  }
  return reached;
}

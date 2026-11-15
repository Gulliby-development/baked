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
  | { item: string; reason: "later_task"; tasks: string[]; paths: string[] }
  | { item: string; reason: "settled"; checks: string[] };

/**
 * A step that only asks to look again: re-run a check, read a file, confirm or verify what the
 * host's checks decide (#3030). Smoke tagcount 852ccff2: T002's files were written and the host's
 * `pytest-written`, `ruff` and `pytest` passed in its last attempt, yet the worker, its own tool
 * results compacted away, ended `blocked` three times with only "Re-run pytest -q and ruff check
 * src tests ... confirm both pass", "Run request_check pytest-written", "Read README.md ... confirm
 * the Example section" left. Such an item is settled when every check it names is one the host
 * runs before finishing the task, and they all pass; an item that also asks for a change is not.
 */
const VERIFY_LEAD =
  /^\s*(?:[-*]\s*)?(?:please\s+)?(?:re-?run|run|re-?read|read|re-?check|check|double-check|confirm|verify|validate|ensure|make sure|inspect|look at|re-?test)\b/i;
const NOT_VERIFIED =
  /\b(?:not|never|could not|cannot|can't|unable to)\s+(?:be\s+)?(?:verif|confirm|re-?run|relied on)/i;
const CHANGE_VERBS =
  /\b(?:add|implement|fix|write|create|rename|remove|delete|refactor|change|replace|handle|support|update|edit|modify|correct|resolve|rewrite|append|insert)\b/i;

/** The checks a settled item may name: the ones the host runs, each by its id and command. */
export interface SettlingChecks {
  /** The checks the host runs (and requires to pass) before it finishes the task. */
  run: readonly { id: string; command: string }[];
  /** Every check id of the run's policy, so an item naming one the host does not run is kept. */
  known: readonly string[];
}

const namesWord = (text: string, word: string): boolean =>
  new RegExp(`(?<![\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text);

/** The checks a verify-only item names, or null when it is not one or names a check not run. */
export function settledBy(item: string, checks: SettlingChecks): string[] | null {
  if (!checks.run.length) return null;
  if (!(VERIFY_LEAD.test(item) || NOT_VERIFIED.test(item)) || CHANGE_VERBS.test(item)) return null;
  const run = checks.run.filter(
    (check) => namesWord(item, check.id) || (check.command && item.includes(check.command)),
  );
  const ran = new Set(checks.run.map((c) => c.id));
  if (checks.known.some((id) => !ran.has(id) && namesWord(item, id))) return null;
  return run.map((c) => c.id);
}

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
 * workspace (one it names, or "outside the repository"), it names a file that a later,
 * unfinished task writes and the task does not, or it only asks to verify what the host's checks
 * decide (`settled`, when `checks` is given). Null when any item is none of these, so a gap in the
 * task's own scope still stops the run, and null for no items.
 */
export function outOfReach(
  unresolved: readonly string[],
  root: string,
  graph: TaskGraph,
  rows: readonly TaskRow[],
  task: Task,
  checks?: SettlingChecks,
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
    if (!owned.length) {
      const settled = checks ? settledBy(item, checks) : null;
      if (!settled) return null;
      reached.push({ item, reason: "settled", checks: settled });
      continue;
    }
    reached.push({
      item,
      reason: "later_task",
      tasks: [...new Set(owned.map((o) => o.task))],
      paths: [...new Set(owned.map((o) => o.path))],
    });
  }
  return reached;
}

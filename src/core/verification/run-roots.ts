/**
 * Where a run's code lives, for the text recognizers that find another root of the run in a
 * repro or a check's output (#2697). Under `workflows.worktreeRoot` (#2461) a run's worktrees are
 * `<root>/<RUN>/main` and `<root>/<RUN>/T003`, outside the project and without the
 * `.baked/worktrees` spelling, so a recognizer reads the run's own directory instead of matching
 * that spelling.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The file in a run's worktree directory that names its run (#2454). */
export const RUN_MARKER = "RUN_ID";

export interface RunRoots {
  /** The project, absolute. */
  workspace: string;
  /**
   * The directory that holds the run's worktrees (`main` and one per task), absolute: the parent of
   * `state.worktree.path` joined to the workspace (`runRoots`); null for a run without a worktree.
   */
  worktrees: string | null;
}

/** `path` with forward slashes and no trailing one. */
export const slashes = (path: string): string => path.replace(/\\/g, "/").replace(/\/$/, "");

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern source for `path` in either separator spelling. */
export const pathPattern = (path: string): string =>
  escapeRegExp(slashes(path)).replace(/\//g, "[\\\\/]");

/**
 * A run worktree of `run` named in text: the run's worktree directory, a separator and one name
 * (`main`, a task id), each name ending at a separator, a quote, a space or `stop`.
 */
export function runWorktreePattern(run: RunRoots | undefined, stop = ""): RegExp | null {
  if (!run?.worktrees) return null;
  return new RegExp(`${pathPattern(run.worktrees)}[\\\\/][^\\\\/"'\`\\s${stop}]+`, "gi");
}

/** Whether `root` is one of `run`'s worktrees (or below one). */
export function inRunWorktrees(root: string, run: RunRoots | undefined): boolean {
  if (!run?.worktrees) return false;
  return slashes(root)
    .toLowerCase()
    .startsWith(`${slashes(run.worktrees).toLowerCase()}/`);
}

/**
 * The run worktree `path` is in, and the project it belongs to, for code that has no run state
 * (the language servers, an edit's importers; #2731): the nearest directory whose parent holds a
 * `RUN_MARKER` and whose `.git` file points into a project's `.git/worktrees`. It finds a worktree
 * under `workflows.worktreeRoot` as well as under `.baked/worktrees`, and in a root shared by
 * several projects it names the worktree's own project. Null outside a run worktree.
 */
export function runWorktreeAt(path: string): { worktree: string; project: string } | null {
  let dir = resolve(path);
  for (let parent = dirname(dir); parent !== dir; dir = parent, parent = dirname(dir)) {
    if (!isFile(resolve(parent, RUN_MARKER))) continue;
    const project = worktreeProject(dir);
    if (project) return { worktree: dir, project };
  }
  return null;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The project a Git worktree at `dir` belongs to, from its `.git` file; null when none. */
function worktreeProject(dir: string): string | null {
  const file = resolve(dir, ".git");
  if (!isFile(file)) return null;
  try {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(file, "utf8"))?.[1];
    if (!gitdir) return null;
    const match = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(resolve(dir, gitdir));
    return match?.[1] || null;
  } catch {
    return null;
  }
}

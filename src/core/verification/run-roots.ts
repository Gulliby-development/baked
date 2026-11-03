/**
 * Where a run's code lives, for the text recognizers that find another root of the run in a
 * repro or a check's output (#2697). Under `workflows.worktreeRoot` (#2461) a run's worktrees are
 * `<root>/<RUN>/main` and `<root>/<RUN>/T003`, outside the project and without the
 * `.baked/worktrees` spelling, so a recognizer reads the run's own directory instead of matching
 * that spelling.
 */
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

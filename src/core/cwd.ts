import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

/**
 * Single source of truth for the active workspace directory.
 *
 * Every consumer that means "the project we're working in" reads getCwd()
 * instead of process.cwd() directly. The holder is set once at boot (via
 * setCwd, called from resolve-cwd's applyCwd) and kept in lockstep with the
 * process cwd so spawned children and relative-path resolution agree.
 *
 * Defaults to the launch directory, so reads before boot's setCwd still work.
 */
let _cwd = process.cwd();

/** A tool call's own workspace, e.g. a chat session's worktree inside `baked serve`. */
const scoped = new AsyncLocalStorage<string>();

/** The active workspace directory (absolute): the calling tool's scope, else the process's. */
export function getCwd(): string {
  return scoped.getStore() ?? _cwd;
}

/** Runs `fn` with `getCwd()` returning `dir` for everything it awaits. */
export function runWithCwd<T>(dir: string, fn: () => T): T {
  return scoped.run(resolve(dir), fn);
}

/**
 * Set the active workspace directory. Worker threads opt out of process.chdir
 * because the OS working directory belongs to the entire process.
 * Returns the resolved absolute path.
 */
export function setCwd(dir: string, options: { changeProcess?: boolean } = {}): string {
  const abs = resolve(dir);
  if (options.changeProcess !== false) process.chdir(abs);
  _cwd = abs;
  return abs;
}

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

/** The active workspace directory (absolute). */
export function getCwd(): string {
  return _cwd;
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

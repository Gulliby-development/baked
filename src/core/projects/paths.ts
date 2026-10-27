import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The real path when it exists, else the resolved one, so symlinks cannot fake containment. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The real path of a file that may not exist yet: its nearest existing folder resolved through
 * links, then the rest of the path as given. `realPath` falls back to the path as given, which on
 * macOS keeps `/var/...` while the project's real root is `/private/var/...`, so a missing file
 * would read as outside the project.
 */
export function realPathOrParent(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realPathOrParent(parent), basename(full));
  }
}

/** Whether `path` is `root` or inside it; both are compared as given, so pass real paths. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Forward-slash relative path for display and globbing. Both sides are compared as real paths, so
 * a folder reached through a symlink (macOS `/var` is `/private/var`) still gives a short path.
 */
export function displayPath(from: string, path: string): string {
  return relative(realPath(from), realPath(path)).replaceAll("\\", "/") || ".";
}

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** The real path when it exists, else the resolved one, so symlinks cannot fake containment. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
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

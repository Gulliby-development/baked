import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The branch a `.git/HEAD` file names; null for a detached HEAD or anything else. */
export function parseHead(content: string): string | null {
  const match = /^ref: refs\/heads\/(.+)$/m.exec(content.trim());
  return match?.[1] ?? null;
}

/**
 * Reads the checked-out branch of a folder from its Git metadata without running Git, so listing
 * projects stays cheap. A linked worktree's `.git` file points at its own metadata folder.
 */
export function readGitBranch(folder: string): string | null {
  try {
    const dotGit = join(folder, ".git");
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (!pointer) return null;
      gitDir = resolve(folder, pointer);
    }
    return parseHead(readFileSync(join(gitDir, "HEAD"), "utf8"));
  } catch {
    return null;
  }
}

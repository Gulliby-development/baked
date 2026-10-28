import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../workflows/delivery-git.js";
import { linkDependencies } from "../workflows/dependency-dirs.js";

/**
 * A chat session's own Git worktree (#897). An editing session the coordinator launches works in
 * `.baked/session-worktrees/ID` on the branch `baked/session/ID`, checked out from HEAD, so two
 * such sessions, or a session and the user, do not overwrite each other's files. Run worktrees
 * live under `.baked/worktrees`, which the worktree cleanup owns; session worktrees stay apart.
 */
export interface SessionWorktree {
  /** Absolute path of the worktree. */
  path: string;
  branch: string;
  /** The commit the branch started from. */
  baseHead: string;
}

const shortId = (sessionId: string): string => sessionId.slice(0, 8);

export const sessionWorktreePath = (workspace: string, sessionId: string): string =>
  join(workspace, ".baked", "session-worktrees", shortId(sessionId));

export const sessionBranch = (sessionId: string): string => `baked/session/${shortId(sessionId)}`;

/**
 * Creates the session's worktree and branch from HEAD. Returns why not instead when the workspace
 * is not the root of a Git repository with a commit, or Git refuses; the session then works in the
 * shared folder. Hooks do not run: a post-checkout hook could write outside the worktree.
 */
export async function createSessionWorktree(
  workspace: string,
  sessionId: string,
): Promise<SessionWorktree | { unavailable: string }> {
  const prefix = await git(workspace, ["rev-parse", "--show-prefix"]);
  if (prefix.code !== 0) return { unavailable: "the project is not a Git repository" };
  if (prefix.stdout.trim())
    return { unavailable: "the project folder is not the root of its Git repository" };
  const baseHead = (
    await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"])
  ).stdout.trim();
  if (!baseHead) return { unavailable: "the repository has no commit yet" };
  const path = sessionWorktreePath(workspace, sessionId);
  const branch = sessionBranch(sessionId);
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(dirname(path), { recursive: true });
    const added = await git(workspace, [
      "-c",
      `core.hooksPath=${join(workspace, ".baked", "no-hooks")}`,
      "worktree",
      "add",
      "-b",
      branch,
      path,
      baseHead,
    ]);
    if (added.code !== 0)
      return { unavailable: `git worktree add failed: ${added.stderr.trim() || "no output"}` };
  }
  linkDependencies(workspace, path);
  return { path, branch, baseHead };
}

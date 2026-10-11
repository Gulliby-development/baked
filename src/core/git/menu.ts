/**
 * The Git menu's actions: commit, push, pull, stash, branches, and the two destructive steps the
 * terminal menu confirms first (force push with lease, hard reset). The terminal UI (`GitMenu`,
 * `GitCommitModal`, `/git` commands) and the local API (`/v1/git`) both run them from here, so
 * each surface only asks for confirmation and renders the result.
 */
import {
  commitMessage,
  type GitLogEntry,
  type GitStatus,
  getGitLog,
  getGitStatus,
  gitAdd,
  gitStashList,
  run,
  runGit,
} from "./status.js";

export const GIT_MENU_ACTIONS = [
  "commit",
  "push",
  "pull",
  "stash",
  "stash-pop",
  "create-branch",
  "switch-branch",
  "force-push",
  "reset-hard",
] as const;
export type GitMenuActionName = (typeof GIT_MENU_ACTIONS)[number];

/** Actions that can lose work or rewrite the remote; every surface asks before running them. */
export const DESTRUCTIVE_GIT_ACTIONS: readonly GitMenuActionName[] = ["force-push", "reset-hard"];

export const COMMIT_MESSAGE_MAX = 10_000;
export const STASH_MESSAGE_MAX = 200;
export const BRANCH_NAME_MAX = 200;

export type GitMenuAction =
  | { action: "commit"; message: string; stageAll?: boolean }
  | { action: "push" | "pull" | "stash-pop" | "force-push" | "reset-hard" }
  | { action: "stash"; message?: string }
  | { action: "create-branch" | "switch-branch"; name: string };

export interface GitActionResult {
  ok: boolean;
  /** One line for the person, e.g. "Push complete." or "Push failed: <git's reason>". */
  message: string;
  /** What Git printed, stdout then stderr. */
  output: string;
}

export interface GitOverview extends GitStatus {
  upstream: string | null;
  /** Local branches, most recently committed first. */
  branches: string[];
  /** `git stash list` lines, newest first. */
  stashes: string[];
  log: GitLogEntry[];
}

const NETWORK_TIMEOUT = 30_000;
const LOCAL_TIMEOUT = 15_000;
const BRANCH_LIST_MAX = 200;

function outputOf(result: { stdout: string; stderr: string }): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function finish(
  result: { ok: boolean; stdout: string; stderr: string },
  success: string,
  failPrefix: string,
): GitActionResult {
  const output = outputOf(result);
  return {
    ok: result.ok,
    message: result.ok ? success : `${failPrefix}: ${output || "git exited with an error"}`,
    output,
  };
}

const refused = (message: string): GitActionResult => ({ ok: false, message, output: "" });

/**
 * Why `name` cannot be a new branch, or null. Leading dashes would read as options and `@{`
 * would name a different ref (`@{-1}` is the previous branch), so both are refused before Git's
 * own `check-ref-format` rules.
 */
export async function branchNameProblem(cwd: string, name: string): Promise<string | null> {
  if (!name) return "Branch name required";
  if (name.length > BRANCH_NAME_MAX)
    return `Branch name is longer than ${String(BRANCH_NAME_MAX)} characters`;
  if (name.startsWith("-") || name.includes("@{") || /\s/.test(name))
    return `Not a valid branch name: ${name}`;
  const { ok } = await run(["check-ref-format", "--branch", name], cwd);
  return ok ? null : `Not a valid branch name: ${name}`;
}

export async function listBranches(cwd: string): Promise<string[]> {
  const { ok, stdout } = await run(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    cwd,
  );
  if (!ok) return [];
  return stdout.split("\n").filter(Boolean).slice(0, BRANCH_LIST_MAX);
}

export async function readGitOverview(cwd: string, logCount = 20): Promise<GitOverview> {
  const status = await getGitStatus(cwd);
  if (!status.isRepo) return { ...status, upstream: null, branches: [], stashes: [], log: [] };
  const [upstream, branches, stashes, log] = await Promise.all([
    run(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd),
    listBranches(cwd),
    gitStashList(cwd),
    getGitLog(cwd, logCount),
  ]);
  return {
    ...status,
    upstream: upstream.ok ? upstream.stdout.trim() || null : null,
    branches,
    stashes: stashes.entries,
    log,
  };
}

/**
 * Commits with `message`. With `stageAll`, or when nothing is staged yet, every modified and
 * untracked file is staged first, as the terminal commit form does.
 */
export async function commitChanges(
  cwd: string,
  options: { message: string; stageAll?: boolean; coAuthor?: boolean },
): Promise<GitActionResult> {
  const message = options.message.trim();
  if (!message) return refused("Commit message cannot be empty");
  const status = await getGitStatus(cwd);
  if (!status.isRepo) return refused("Not a git repository");
  if (options.stageAll || status.staged.length === 0) {
    const files = [...status.modified, ...status.untracked];
    if (files.length > 0 && !(await gitAdd(cwd, files)))
      return refused("Commit failed: could not stage the changes");
  }
  const result = await runGit(
    ["commit", "-m", commitMessage(message, options.coAuthor)],
    cwd,
    LOCAL_TIMEOUT,
  );
  return finish(result, `Committed: ${message.split("\n")[0] ?? message}`, "Commit failed");
}

/** Runs one Git menu action in `cwd`. Callers confirm `DESTRUCTIVE_GIT_ACTIONS` first. */
export async function runGitMenuAction(
  cwd: string,
  request: GitMenuAction,
  options: { coAuthor?: boolean } = {},
): Promise<GitActionResult> {
  switch (request.action) {
    case "commit":
      return commitChanges(cwd, {
        message: request.message,
        ...(options.coAuthor !== undefined ? { coAuthor: options.coAuthor } : {}),
        ...(request.stageAll !== undefined ? { stageAll: request.stageAll } : {}),
      });
    case "push":
      return finish(await runGit(["push"], cwd, NETWORK_TIMEOUT), "Push complete.", "Push failed");
    case "force-push":
      return finish(
        await runGit(["push", "--force-with-lease"], cwd, NETWORK_TIMEOUT),
        "Force push complete.",
        "Force push failed",
      );
    case "pull":
      return finish(await runGit(["pull"], cwd, NETWORK_TIMEOUT), "Pull complete.", "Pull failed");
    case "stash": {
      const message = request.message?.trim().replace(/\s+/g, " ").slice(0, STASH_MESSAGE_MAX);
      const args = message ? ["stash", "push", "-m", message] : ["stash", "push"];
      return finish(await runGit(args, cwd, LOCAL_TIMEOUT), "Changes stashed.", "Stash failed");
    }
    case "stash-pop":
      return finish(
        await runGit(["stash", "pop"], cwd, LOCAL_TIMEOUT),
        "Stash popped.",
        "Stash pop failed",
      );
    case "reset-hard":
      return finish(
        await runGit(["reset", "--hard", "HEAD"], cwd, LOCAL_TIMEOUT),
        "Reset complete.",
        "Reset failed",
      );
    case "create-branch": {
      const name = request.name.trim();
      const problem = await branchNameProblem(cwd, name);
      if (problem) return refused(problem);
      return finish(
        await runGit(["checkout", "-b", name], cwd, LOCAL_TIMEOUT),
        `Switched to new branch '${name}'`,
        "Branch failed",
      );
    }
    case "switch-branch": {
      const name = request.name.trim();
      // Only an existing local branch: `checkout <path>` would discard that file's changes.
      const exists =
        name.length > 0 &&
        !name.startsWith("-") &&
        (await run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd)).ok;
      if (!exists) return refused(`No local branch ${name}`);
      return finish(
        await runGit(["checkout", name, "--"], cwd, LOCAL_TIMEOUT),
        `Switched to branch '${name}'`,
        "Switch failed",
      );
    }
  }
}

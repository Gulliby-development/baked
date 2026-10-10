/**
 * Worktree execution mode: a run edits, checks and reviews its own Git worktree on the branch
 * `baked/wf/RUN_ID`, and the user's working copy is never written. Accepted changes are committed
 * on that branch; only an approved delivery moves them further.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonical } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { git, gitMode, internalPath, looksSecret, statusPaths } from "./delivery-git.js";
import { WorkflowFault } from "./errors.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState, WorktreeState } from "./types.js";

/** Worktree of a run, relative to the project root. */
export const worktreePath = (runId: string): string => `.baked/worktrees/${runId}/main`;
/** Worktree of one task of a run with several writers, relative to the project root. */
export const taskWorktreePath = (runId: string, taskId: string): string =>
  `.baked/worktrees/${runId}/${taskId}`;
/** The branch that carries a worktree run's accepted changes. */
export const runBranch = (runId: string): string => `baked/wf/${runId}`;

/** The directory a run reads, edits and checks in: its worktree once it exists, else the project. */
export function runRoot(workspace: string, state: Pick<RuntimeState, "worktree">): string {
  return state.worktree ? join(workspace, state.worktree.path) : workspace;
}

/** Fallback identity for the run branch commit when the repository configures none. */
const FALLBACK_IDENTITY = { name: "BAKED workflow", email: "workflow@baked.invalid" };

async function required(
  directory: string,
  args: string[],
  options: Parameters<typeof git>[2] = {},
): Promise<string> {
  const result = await git(directory, args, options);
  if (result.code !== 0)
    throw new WorkflowFault(
      "INPUT_CHANGED",
      `git ${args[0]} failed in the run worktree: ${result.stderr.trim()}`,
      { reason: "worktree_failed" },
    );
  return result.stdout.trim();
}

/**
 * The HEAD commit of the project repository. Worktree execution refuses a workspace that is not
 * the top level of a Git repository with at least one commit, rather than running inline: the
 * user asked for an untouched working copy, and an inline run would write it.
 */
export async function worktreeBase(workspace: string): Promise<string> {
  const refuse = (message: string) =>
    new WorkflowFault("INVALID_DEFINITION", message, { reason: "git_required" });
  const top = await git(workspace, ["rev-parse", "--show-prefix"]);
  if (top.code !== 0)
    throw refuse(
      "Worktree execution needs a Git repository. Run `git init` and commit a baseline, or run the workflow inline.",
    );
  if (top.stdout.trim())
    throw refuse("Worktree execution needs the workspace to be the root of its Git repository.");
  const head = (await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
  if (!head) throw refuse("Worktree execution needs a repository with at least one commit.");
  return head;
}

/** Shares the project's top-level `node_modules` with the worktree so checks can run there. */
function linkDependencies(workspace: string, root: string): void {
  const source = join(workspace, "node_modules");
  const target = join(root, "node_modules");
  if (!existsSync(source) || existsSync(target)) return;
  try {
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // A missing link only makes checks that need dependencies fail in the worktree.
  }
}

/**
 * Creates the run's worktree and branch from the current HEAD, or adopts them after a crash
 * between their creation and the state save. The baseline HEAD is recorded in the run state and
 * as the `worktree/created.json` artifact. Hooks do not run: a post-checkout hook could write
 * outside the worktree.
 */
export async function ensureRunWorktree(
  store: WorkflowStore,
  runId: string,
): Promise<WorktreeState> {
  const workspace = store.workspace;
  const recorded = store.state(runId).worktree;
  if (recorded) {
    if (!existsSync(join(workspace, recorded.path, ".git")))
      throw new WorkflowFault(
        "RECOVERY_REQUIRED",
        `The run worktree ${recorded.path} is missing. Cancel the run; its branch ${recorded.branch} keeps any committed result.`,
        { reason: "worktree_missing" },
      );
    return recorded;
  }
  const head = await worktreeBase(workspace);
  const path = worktreePath(runId);
  const branch = runBranch(runId);
  const absolute = join(workspace, path);
  const existing = (
    await git(workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  ).stdout.trim();
  // A branch from an interrupted creation has no commit of its own yet: its tip is the baseline.
  const baseHead = existing || head;
  if (!existsSync(join(absolute, ".git"))) {
    await git(workspace, ["worktree", "prune"]);
    mkdirSync(dirname(absolute), { recursive: true });
    const hooks = join(workspace, ".baked", "no-hooks");
    await required(workspace, [
      "-c",
      `core.hooksPath=${hooks}`,
      "worktree",
      "add",
      ...(existing ? [absolute, branch] : ["-b", branch, absolute, baseHead]),
    ]);
  }
  linkDependencies(workspace, absolute);
  const worktree: WorktreeState = {
    path,
    branch,
    baseHead,
    commit: null,
    excludedUserChanges: [],
  };
  store.transaction(() => {
    const state = store.state(runId);
    state.worktree = worktree;
    store.saveState(runId, state);
    store.artifact(
      runId,
      "worktree",
      "worktree/created.json",
      canonical({ ...worktree, createdAt: new Date().toISOString() }),
    );
  });
  return worktree;
}

/** Author, committer and dates of the commits a run makes: deterministic for the same content. */
async function commitEnv(store: WorkflowStore, runId: string): Promise<Record<string, string>> {
  const workspace = store.workspace;
  const name =
    (await git(workspace, ["config", "user.name"])).stdout.trim() || FALLBACK_IDENTITY.name;
  const email =
    (await git(workspace, ["config", "user.email"])).stdout.trim() || FALLBACK_IDENTITY.email;
  const date = `${Math.floor(store.run(runId).created_at / 1000)} +0000`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * A commit of the run worktree's current content, tracked and untracked files that are not
 * ignored, on top of its HEAD. No ref moves and the worktree's own index is not changed: the
 * commit is only the base a task worktree is checked out from, and the task worktree's detached
 * HEAD keeps it reachable while the task runs.
 */
export async function runContentCommit(
  store: WorkflowStore,
  runId: string,
  worktree: WorktreeState,
): Promise<string> {
  const root = join(store.workspace, worktree.path);
  const directory = mkdtempSync(join(tmpdir(), "baked-worktree-"));
  const index = join(directory, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    // The worktree's own index only speeds up hashing; the content comes from its files.
    const own = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (own.code === 0 && existsSync(own.stdout.trim())) copyFileSync(own.stdout.trim(), index);
    else await required(root, ["read-tree", "HEAD"], { env });
    // An exclude pathspec that names an ignored path fails the add ("paths are ignored"); the
    // linked node_modules is a junction on Windows, which .gitignore already covers.
    const ignored = (await git(root, ["check-ignore", "-q", "node_modules"])).code === 0;
    await required(
      root,
      ["add", "-A", "--", ".", ":(exclude).baked", ...(ignored ? [] : [":(exclude)node_modules"])],
      { env },
    );
    const tree = await required(root, ["write-tree"], { env });
    const head = await required(root, ["rev-parse", "HEAD"]);
    if (tree === (await required(root, ["rev-parse", "HEAD^{tree}"]))) return head;
    return await required(root, ["commit-tree", tree, "-p", head, "--no-gpg-sign", "-F", "-"], {
      input: `Content of run ${runId} for its task worktrees\n`,
      env: await commitEnv(store, runId),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Creates a task's worktree, detached at `base`, with the project's `node_modules` linked. A
 * worktree left by an interrupted attempt of the task is replaced: its edits were never
 * integrated, and recovery reconciled their effects before the run continued.
 */
export async function createTaskWorktree(
  store: WorkflowStore,
  runId: string,
  taskId: string,
  base: string,
): Promise<string> {
  const workspace = store.workspace;
  const path = taskWorktreePath(runId, taskId);
  await removeTaskWorktree(workspace, path);
  const absolute = join(workspace, path);
  mkdirSync(dirname(absolute), { recursive: true });
  const hooks = join(workspace, ".baked", "no-hooks");
  await required(workspace, [
    "-c",
    `core.hooksPath=${hooks}`,
    "worktree",
    "add",
    "--detach",
    absolute,
    base,
  ]);
  linkDependencies(workspace, absolute);
  return path;
}

/** Removes a task worktree, if present; its edits are integrated or abandoned by then. */
export async function removeTaskWorktree(workspace: string, path: string): Promise<void> {
  const absolute = join(workspace, path);
  if (existsSync(join(absolute, ".git")))
    await git(workspace, ["worktree", "remove", "--force", absolute]);
  rmSync(absolute, { recursive: true, force: true });
  await git(workspace, ["worktree", "prune"]);
}

/**
 * Approved write paths that have uncommitted changes in the user's working copy. Those changes do
 * not enter the worktree, so approving the plan needs an explicit choice to leave them out.
 */
export async function userChangesInScope(workspace: string, paths: string[]): Promise<string[]> {
  const status = await git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return [];
  const changed = new Set(statusPaths(status.stdout));
  return [...new Set(paths)].filter((path) => changed.has(path)).sort();
}

/**
 * Commits the accepted content of `paths` in the run worktree on the run branch, with the
 * baseline HEAD as parent. The commit is built in a temporary index, so commit hooks do not run,
 * and its dates are the run's creation time: the same accepted content always gives the same
 * commit, which makes a retry after a crash idempotent. Returns null when nothing changed.
 */
export async function commitRunBranch(
  store: WorkflowStore,
  runId: string,
  worktree: WorktreeState,
  paths: string[],
  message: string,
): Promise<string | null> {
  const workspace = store.workspace;
  const root = join(workspace, worktree.path);
  const directory = mkdtempSync(join(tmpdir(), "baked-worktree-"));
  const env = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    await required(root, ["read-tree", worktree.baseHead], { env });
    for (const path of [...new Set(paths)].sort()) {
      if (internalPath(path)) continue;
      const absolute = workspacePath(root, path);
      const stat = existsSync(absolute) ? lstatSync(absolute) : null;
      if (stat?.isSymbolicLink() || looksSecret(path)) continue;
      if (!stat) {
        await required(root, ["update-index", "--force-remove", "--", path], { env });
        continue;
      }
      const bytes = readFileSync(absolute);
      if (looksSecret(path, bytes)) continue;
      const blob = await required(root, ["hash-object", "-w", "--stdin", `--path=${path}`], {
        input: bytes,
      });
      const entry = (await git(root, ["ls-tree", worktree.baseHead, "--", path])).stdout;
      // A file the baseline has keeps its committed mode; a new file takes the working tree's.
      const mode = entry ? (entry.startsWith("100755") ? "100755" : "100644") : gitMode(stat.mode);
      await required(root, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], {
        env,
      });
    }
    const tree = await required(root, ["write-tree"], { env });
    if (tree === (await required(root, ["rev-parse", `${worktree.baseHead}^{tree}`]))) return null;
    const commit = await required(
      root,
      ["commit-tree", tree, "-p", worktree.baseHead, "--no-gpg-sign", "-F", "-"],
      { input: message, env: await commitEnv(store, runId) },
    );
    const tip = await required(workspace, [
      "rev-parse",
      "--verify",
      `refs/heads/${worktree.branch}`,
    ]);
    if (tip !== commit) {
      if (tip !== worktree.baseHead)
        throw new WorkflowFault(
          "INPUT_CHANGED",
          `Branch ${worktree.branch} moved to ${tip} outside the run; the run never overwrites it.`,
          { reason: "branch_moved" },
        );
      await required(workspace, [
        "update-ref",
        "-m",
        `baked workflow ${runId}`,
        `refs/heads/${worktree.branch}`,
        commit,
        tip,
      ]);
    }
    // The worktree's index follows its branch; its files already hold the committed content.
    await required(root, ["read-tree", "HEAD"]);
    return commit;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Removes a terminal run's worktree, and its branch when the user discards the result. Delivery
 * keeps the branch: it records the accepted commit the delivered one was built from.
 */
export async function removeRunWorktree(
  store: WorkflowStore,
  runId: string,
  worktree: WorktreeState,
  options: { deleteBranch: boolean },
): Promise<void> {
  const workspace = store.workspace;
  const absolute = join(workspace, worktree.path);
  // Task worktrees of a run with several writers go first; they never hold accepted content.
  const runDirectory = dirname(absolute);
  if (existsSync(runDirectory))
    for (const entry of readdirSync(runDirectory))
      if (join(runDirectory, entry) !== absolute)
        await removeTaskWorktree(workspace, join(dirname(worktree.path), entry));
  if (existsSync(absolute)) await required(workspace, ["worktree", "remove", "--force", absolute]);
  await git(workspace, ["worktree", "prune"]);
  rmSync(join(workspace, ".baked", "worktrees", runId), { recursive: true, force: true });
  if (options.deleteBranch) {
    const tip = (
      await git(workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`])
    ).stdout.trim();
    if (tip) await required(workspace, ["update-ref", "-d", `refs/heads/${worktree.branch}`, tip]);
  }
}

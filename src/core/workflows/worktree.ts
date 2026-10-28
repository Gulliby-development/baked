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
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { canonical } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import {
  git,
  gitMode,
  gitWorktreePaths,
  internalPath,
  looksSecret,
  runSpecPath,
  statusPaths,
  treeModes,
  treeShipsSpecs,
} from "./delivery-git.js";
import {
  ALL_DEPENDENCY_DIRS,
  isLinkedDependency,
  linkDependencies,
  unpreparedDependencies,
  unpreparedProblem,
} from "./dependency-dirs.js";
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

/** The run artifact that records packages a worktree's prepare command could not resolve (#2372). */
export const UNPREPARED_FINDING = "environment/dependencies-unprepared.json";

/**
 * Links the project's dependency folders into a new worktree or copy of a run and, when a prepare
 * command could not resolve its packages there, records that once for the run (#2372): its checks
 * of that toolchain then count as inconclusive instead of opening corrections for correct code.
 */
export function linkRunDependencies(store: WorkflowStore, runId: string, root: string): string[] {
  const linked = linkDependencies(store.workspace, root);
  const unprepared = unpreparedDependencies(root);
  if (unprepared.length && !store.latestArtifact(runId, UNPREPARED_FINDING))
    store.transaction(() =>
      store.artifact(
        runId,
        "diagnostic",
        UNPREPARED_FINDING,
        canonical({
          kind: "environment",
          worktree: relative(store.workspace, root).replaceAll("\\", "/"),
          problems: unprepared.map((u) => ({
            language: u.language,
            command: u.command,
            problem: unpreparedProblem(u),
            output: u.output,
          })),
        }),
      ),
    );
  return linked;
}

/** A run's worktree as the run screens show it; `present` turns false once delivery or a discard removed it. */
export interface RunWorktreeView {
  path: string;
  branch: string;
  present: boolean;
}
export function worktreeView(
  workspace: string,
  state: Pick<RuntimeState, "worktree">,
): RunWorktreeView | null {
  const worktree = state.worktree;
  if (!worktree) return null;
  return {
    path: worktree.path,
    branch: worktree.branch,
    present: existsSync(join(workspace, worktree.path)),
  };
}

/** The directory a run reads, edits and checks in: its worktree once it exists, else the project. */
export function runRoot(workspace: string, state: Pick<RuntimeState, "worktree">): string {
  return state.worktree ? join(workspace, state.worktree.path) : workspace;
}

/** Fallback identity for the run branch commit when the repository configures none. */
const FALLBACK_IDENTITY = { name: "BAKED workflow", email: "workflow@baked.invalid" };

/** The fallback identity at a fixed date, so a host-made commit is the same for the same inputs. */
const fixedIdentity = (date: number) => ({
  GIT_AUTHOR_NAME: FALLBACK_IDENTITY.name,
  GIT_AUTHOR_EMAIL: FALLBACK_IDENTITY.email,
  GIT_AUTHOR_DATE: `@${date} +0000`,
  GIT_COMMITTER_NAME: FALLBACK_IDENTITY.name,
  GIT_COMMITTER_EMAIL: FALLBACK_IDENTITY.email,
  GIT_COMMITTER_DATE: `@${date} +0000`,
});

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

/** The last `git worktree` command started for each repository; see `worktreeCommand`. */
const worktreeCommands = new Map<string, Promise<unknown>>();

/**
 * Runs `git worktree add`, `remove` or `prune` steps for a repository one at a time in this
 * process. Git does not guard `.git/worktrees` against concurrent commands: `add` reads every
 * entry, so one that another `add` is still creating fails it with "failed to read
 * .git/worktrees/main/commondir". Parallel runs and parallel task writers create worktrees at once.
 */
function worktreeCommand<T>(workspace: string, command: () => Promise<T>): Promise<T> {
  const key = resolve(workspace);
  const result = (worktreeCommands.get(key) ?? Promise.resolve()).then(command, command);
  const tail = result.catch(() => undefined);
  worktreeCommands.set(key, tail);
  void tail.then(() => {
    if (worktreeCommands.get(key) === tail) worktreeCommands.delete(key);
  });
  return result;
}

/**
 * The HEAD commit of the project repository. Worktree execution refuses a workspace that is not
 * the top level of a Git repository with at least one commit, rather than running inline: the
 * user asked for an untouched working copy, and an inline run would write it.
 */
export async function worktreeBase(workspace: string): Promise<string> {
  const refuse = (message: string, gitInit = false) =>
    new WorkflowFault("INVALID_DEFINITION", message, {
      reason: "git_required",
      ...(gitInit ? { gitInit } : {}),
    });
  const top = await gitWorktreePaths(workspace);
  if (!top)
    throw refuse(
      `Worktree execution needs a Git repository. ${GIT_INIT_HINT}, or run the workflow inline.`,
      true,
    );
  if (top.prefix)
    throw refuse("Worktree execution needs the workspace to be the root of its Git repository.");
  const head = (await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
  if (!head)
    throw refuse(
      `Worktree execution needs a repository with at least one commit. ${GIT_INIT_HINT}.`,
      true,
    );
  return head;
}

/** How each surface lets the person initialize Git (src/core/git/init.ts) after confirming. */
const GIT_INIT_HINT =
  "BAKED can initialize it with a .gitignore and a baseline commit: confirm Initialize Git in the desktop app, run /git init in the terminal app or baked workflow git-init";

/** The result of merging commits onto HEAD: the merged commit, or the files that conflict. */
export type MergedBase = { commit: string } | { conflicts: string[]; between: [string, string] };

/**
 * HEAD merged with each of `commits` in order, without a worktree or a ref: `git merge-tree`
 * merges the trees and `git commit-tree` records the merge. A commit already contained in the
 * result is skipped and one that contains it is taken as it is, so one upstream result gives its
 * own commit. Fixed author and dates (`date`, seconds) make the same inputs give the same commit.
 */
export async function mergedBase(
  workspace: string,
  commits: string[],
  date: number,
): Promise<MergedBase> {
  let base = await worktreeBase(workspace);
  const env = fixedIdentity(date);
  const ancestor = async (a: string, b: string): Promise<boolean> =>
    (await git(workspace, ["merge-base", "--is-ancestor", a, b])).code === 0;
  for (const commit of commits) {
    if (await ancestor(commit, base)) continue;
    if (await ancestor(base, commit)) {
      base = commit;
      continue;
    }
    const merged = await git(workspace, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      base,
      commit,
    ]);
    const [tree = "", ...files] = merged.stdout.trim().split("\n");
    if (merged.code === 1)
      return { conflicts: files.filter((f) => f.length > 0), between: [base, commit] };
    if (merged.code !== 0)
      throw new WorkflowFault("INPUT_CHANGED", `git merge-tree failed: ${merged.stderr.trim()}`, {
        reason: "worktree_failed",
      });
    base = await required(
      workspace,
      ["commit-tree", tree, "-p", base, "-p", commit, "-m", `Merge ${commit} for a dependent run`],
      { env },
    );
  }
  return { commit: base };
}

/**
 * `base` with `files` added where it has no file at their path: the provisional base of a feature
 * that plans ahead (#1834), so it plans against the host-written stubs of the features it depends
 * on that have not finished yet, which its tasks modify. A file the run only reads (the accepted
 * specs of its upstream features) never goes here: `placeBaseFiles` writes it untracked (#2046).
 * Built in a temporary index with a fixed author and date, as `mergedBase` is, so the same inputs
 * give the same commit; `base` itself when nothing is added.
 */
export async function provisionalBase(
  workspace: string,
  base: string,
  files: { path: string; content: string }[],
  date: number,
): Promise<string> {
  const present = new Set(
    (await required(workspace, ["ls-tree", "-r", "-z", "--name-only", base]))
      .split("\0")
      .filter(Boolean),
  );
  const added = [...new Map(files.map((f) => [f.path, f])).values()]
    .filter((f) => !present.has(f.path) && !internalPath(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!added.length) return base;
  const directory = mkdtempSync(join(tmpdir(), "baked-provisional-"));
  const env = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    await required(workspace, ["read-tree", base], { env });
    const updates: string[] = [];
    for (const file of added) {
      const blob = await required(workspace, ["hash-object", "-w", "--stdin"], {
        input: Buffer.from(file.content),
      });
      updates.push(`100644 ${blob}\t${file.path}\0`);
    }
    await required(workspace, ["update-index", "-z", "--index-info"], {
      env,
      input: updates.join(""),
    });
    const tree = await required(workspace, ["write-tree"], { env });
    return await required(
      workspace,
      [
        "commit-tree",
        tree,
        "-p",
        base,
        "--no-gpg-sign",
        "-m",
        "Stubs of unfinished upstream features",
      ],
      { env: { ...env, ...fixedIdentity(date) } },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Writes `files` into the run worktree as untracked files where `base` tracks no file at their
 * path and the worktree has none yet: what the host gives a run to read without it entering any
 * commit (an initiative feature's upstream specs, #2046). Before, they were a commit of the base
 * that the run's own commit deleted, so a kept history had `specs/` back at every dependent
 * base. The run's commits leave them out by `runSpecPath`; its task worktrees, built from the
 * worktree's content (`runContentCommit`), hold them as the run worktree does.
 */
export async function placeBaseFiles(
  workspace: string,
  worktree: Pick<WorktreeState, "path">,
  base: string,
  files: readonly { path: string; content: string }[],
): Promise<void> {
  if (!files.length) return;
  const root = join(workspace, worktree.path);
  const tracked = new Set(
    (await required(workspace, ["ls-tree", "-r", "-z", "--name-only", base]))
      .split("\0")
      .filter(Boolean),
  );
  for (const file of files) {
    if (tracked.has(file.path) || internalPath(file.path)) continue;
    const absolute = workspacePath(root, file.path);
    if (existsSync(absolute)) continue;
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content);
  }
}

/**
 * Moves a planned-ahead run's worktree and branch from its provisional base to `commit`, the
 * results of the features it depends on (#1834). Refused when a tracked file of the worktree
 * changed: no task has run yet, so only the run's untracked documents may differ, and they stay.
 */
export async function moveRunWorktree(
  workspace: string,
  worktree: WorktreeState,
  commit: string,
): Promise<void> {
  const root = join(workspace, worktree.path);
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  if (status.code !== 0)
    throw new WorkflowFault("INPUT_CHANGED", `git status failed: ${status.stderr.trim()}`, {
      reason: "worktree_failed",
    });
  const changed = statusPaths(status.stdout);
  if (changed.length)
    throw new WorkflowFault(
      "INPUT_CHANGED",
      `The planned-ahead run's worktree changed before its tasks: ${changed.slice(0, 10).join(", ")}`,
      { reason: "worktree_changed", paths: changed },
    );
  const hooks = join(workspace, ".baked", "no-hooks");
  await required(root, ["-c", `core.hooksPath=${hooks}`, "reset", "-q", "--hard", commit]);
}

/**
 * Creates the run's worktree and branch from the current HEAD, or from the run's `worktreeBase`
 * when it has one, or adopts them after a crash between their creation and the state save. The
 * baseline is recorded in the run state and as the `worktree/created.json` artifact. Hooks do not run: a post-checkout hook could write
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
  const start = store.state(runId).worktreeBase ?? head;
  const path = worktreePath(runId);
  const branch = runBranch(runId);
  const absolute = join(workspace, path);
  const existing = (
    await git(workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  ).stdout.trim();
  // A branch from an interrupted creation has no commit of its own yet: its tip is the baseline.
  const baseHead = existing || start;
  if (!existsSync(join(absolute, ".git"))) {
    mkdirSync(dirname(absolute), { recursive: true });
    const hooks = join(workspace, ".baked", "no-hooks");
    await worktreeCommand(workspace, async () => {
      await git(workspace, ["worktree", "prune"]);
      await required(workspace, [
        "-c",
        `core.hooksPath=${hooks}`,
        "worktree",
        "add",
        ...(existing ? [absolute, branch] : ["-b", branch, absolute, baseHead]),
      ]);
    });
  }
  linkRunDependencies(store, runId, absolute);
  await placeBaseFiles(workspace, { path }, baseHead, store.state(runId).baseFiles ?? []);
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

/**
 * Git settings for the run worktree's content commit and the task worktrees checked out from it:
 * no line-ending conversion, so a task worktree holds the same bytes as the run worktree. With
 * `core.autocrlf=true` (the Windows default) and no `.gitattributes`, a checkout would turn the
 * run's LF files into CRLF and every edit hash check would fail.
 */
const BYTE_EXACT = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.eol=lf"];

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
  worktree: Pick<WorktreeState, "path">,
): Promise<string> {
  const root = join(store.workspace, worktree.path);
  const directory = mkdtempSync(join(tmpdir(), "baked-worktree-"));
  const index = join(directory, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    // The worktree's own index only speeds up hashing; the content comes from its files.
    const own = await gitWorktreePaths(root);
    if (own && existsSync(own.index)) {
      copyFileSync(own.index, index);
      // The copy keeps the index's own time: git re-reads a file written in the same instant as
      // the index ("racily clean"); a fresh time made a same-size edit look unchanged (#1954).
      const { atime, mtime } = statSync(own.index);
      utimesSync(index, atime, mtime);
    } else await required(root, ["read-tree", "HEAD"], { env });
    // An exclude pathspec that names an ignored path fails the add ("paths are ignored"); the
    // linked node_modules is a junction on Windows, which .gitignore already covers. Git sees
    // another linked dependency folder as a file, which a `vendor/` rule does not cover (#2330).
    // The project root (a run without its own worktree) has `.baked`, usually ignored too.
    const ignored = async (path: string) =>
      (await git(root, ["check-ignore", "-q", path])).code === 0;
    await required(
      root,
      [
        ...BYTE_EXACT,
        "add",
        "-A",
        "--",
        ".",
        ...((await ignored(".baked")) ? [] : [":(exclude).baked"]),
        ...((await ignored("node_modules")) ? [] : [":(exclude)node_modules"]),
        ...(await linkedUnignored(root, ignored)).map((dir) => `:(exclude)${dir}`),
      ],
      { env },
    );
    const tree = await required(root, ["write-tree"], { env });
    const [head = "", headTree] = (
      await required(root, ["rev-parse", "HEAD", "HEAD^{tree}"])
    ).split("\n");
    if (tree === headTree) return head;
    return await required(root, ["commit-tree", tree, "-p", head, "--no-gpg-sign", "-F", "-"], {
      input: `Content of run ${runId} for its task worktrees\n`,
      env: await commitEnv(store, runId),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The dependency folders linked into `root` that its ignore rules do not cover. */
async function linkedUnignored(
  root: string,
  ignored: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const linked = ALL_DEPENDENCY_DIRS.filter(
    (dir) => dir !== "node_modules" && isLinkedDependency(root, dir),
  );
  const shown: string[] = [];
  for (const dir of linked) if (!(await ignored(dir))) shown.push(dir);
  return shown;
}

/**
 * Creates a task's worktree, detached at `base`, with the project's dependency folders linked. A
 * worktree left by an interrupted attempt of the task is replaced: its edits were never
 * integrated, and recovery reconciled their effects before the run continued.
 */
export async function createTaskWorktree(
  store: WorkflowStore,
  runId: string,
  taskId: string,
  base: string,
  files: string[] = [],
): Promise<string> {
  const workspace = store.workspace;
  const path = taskWorktreePath(runId, taskId);
  const stale = await removeTaskWorktree(workspace, path);
  if (!stale.removed)
    throw new WorkflowFault("INPUT_CHANGED", stale.warning ?? `${path} could not be removed`, {
      reason: "worktree_failed",
    });
  const absolute = join(workspace, path);
  mkdirSync(dirname(absolute), { recursive: true });
  const hooks = join(workspace, ".baked", "no-hooks");
  await worktreeCommand(workspace, () =>
    required(workspace, [
      ...BYTE_EXACT,
      "-c",
      `core.hooksPath=${hooks}`,
      "worktree",
      "add",
      "--detach",
      absolute,
      base,
    ]),
  );
  linkRunDependencies(store, runId, absolute);
  const source = store.state(runId).worktree;
  if (source) alignTaskFiles(join(workspace, source.path), absolute, files);
  return path;
}

/**
 * Self-check of a fresh task worktree: each file the task may write must hold the same bytes as in
 * the run worktree, and a file that does not (a checkout filter, an attribute rule) is replaced
 * by a byte copy, so the task's edit checks compare against what the run recorded.
 */
export function alignTaskFiles(from: string, to: string, files: string[]): string[] {
  const repaired: string[] = [];
  for (const file of files) {
    const source = join(from, file);
    const target = join(to, file);
    if (!existsSync(source)) continue;
    if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    repaired.push(file);
  }
  return repaired;
}

const BUSY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

/**
 * Removes a directory tree, retrying a Windows sharing violation (a build server, an indexer or
 * antivirus still holding a handle) with a short backoff. Returns the last error when it never
 * succeeded; a failure that is not a lock is thrown. `maxMs` bounds the whole removal.
 */
export async function removeDirectory(
  path: string,
  options: {
    rm?: (path: string) => void;
    attempts?: number;
    delayMs?: number;
    maxMs?: number;
  } = {},
): Promise<Error | null> {
  const rm = options.rm ?? ((target: string) => rmSync(target, { recursive: true, force: true }));
  const attempts = options.attempts ?? 8;
  const delay = options.delayMs ?? 150;
  const deadline = Date.now() + (options.maxMs ?? 20_000);
  let last: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rm(path);
      return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !BUSY_CODES.has(code)) throw error;
      last = error as Error;
      if (Date.now() + delay * (attempt + 1) > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, delay * (attempt + 1)));
    }
  }
  return last;
}

/** Directory (relative to the project root) that takes locked worktree directories aside. */
const TRASH = join(".baked", "trash");

/** Deletes what earlier runs moved aside; a directory that is still locked stays for the next call. */
export function purgeWorktreeTrash(workspace: string): void {
  const trash = join(workspace, TRASH);
  if (!existsSync(trash)) return;
  for (const entry of readdirSync(trash)) {
    try {
      rmSync(join(trash, entry), { recursive: true, force: true });
    } catch {
      /* still locked */
    }
  }
}

/** Renames a locked directory into the trash so its path is free again; false when that fails too. */
function moveAside(workspace: string, absolute: string): boolean {
  try {
    const trash = join(workspace, TRASH);
    mkdirSync(trash, { recursive: true });
    renameSync(absolute, join(trash, `${basename(absolute)}-${Date.now().toString(36)}`));
    return true;
  } catch {
    return false;
  }
}

/** Stops the language servers rooted below `absolute`, bounded in time; never throws. */
async function stopHolders(absolute: string): Promise<void> {
  try {
    const { stopLanguageServersUnder } = await import("../intelligence/instance.js");
    await Promise.race([
      stopLanguageServersUnder(absolute),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  } catch {
    /* a missing intelligence stack holds nothing */
  }
}

/**
 * Removes a task worktree, if present; its edits are integrated or abandoned by then. Processes
 * that hold the directory (language servers rooted in it) are stopped first. A directory that
 * stays locked after the retries is renamed into `.baked/trash` (purged later), so its path is
 * free for the next worktree; when even that fails it is left in place and reported in the return
 * value (the run goes on; `removeRunWorktree` removes it later).
 */
export async function removeTaskWorktree(
  workspace: string,
  path: string,
  options: Parameters<typeof removeDirectory>[1] & {
    stopHolders?: (path: string) => Promise<void>;
  } = {},
): Promise<{ removed: boolean; warning?: string; movedAside?: boolean }> {
  const absolute = join(workspace, path);
  purgeWorktreeTrash(workspace);
  await (options.stopHolders ?? stopHolders)(absolute);
  if (existsSync(join(absolute, ".git")))
    await worktreeCommand(workspace, () =>
      git(workspace, ["worktree", "remove", "--force", absolute]),
    );
  const locked = await removeDirectory(absolute, options);
  await worktreeCommand(workspace, () => git(workspace, ["worktree", "prune"]));
  if (!locked) return { removed: true };
  if (moveAside(workspace, absolute)) return { removed: true, movedAside: true };
  return { removed: false, warning: `${path} stays on disk: ${locked.message}` };
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
  options: { specs?: boolean; initiativeSpecs?: string | null } = {},
): Promise<string | null> {
  const workspace = store.workspace;
  const root = join(workspace, worktree.path);
  const directory = mkdtempSync(join(tmpdir(), "baked-worktree-"));
  const env = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    await required(root, ["read-tree", worktree.baseHead], { env });
    const modes = treeModes(await required(root, ["ls-tree", "-r", "-z", worktree.baseHead]));
    // The run's spec artifacts stay run artifacts unless the project already tracks specs/, as
    // in the delivery plan (#1998), or the caller needs them on the branch. An initiative
    // feature's upstream specs are untracked files of its worktree (`placeBaseFiles`, #2046); a
    // base made before that still tracks them, and they leave its commit too, so no branch of the
    // initiative carries a spec folder the project does not (#2017).
    const featureId = store.run(runId).feature_id;
    const prefix = options.initiativeSpecs ?? null;
    const withSpecs = options.specs ?? treeShipsSpecs(modes.keys(), prefix);
    const updates: string[] = [];
    if (!withSpecs && prefix) {
      // A spec folder the project's HEAD tracks (a branch merged before #2017) is its file now.
      const listed = await git(workspace, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "HEAD",
        "--",
        "specs",
      ]);
      const tracked = new Set(listed.stdout.split("\0"));
      for (const path of modes.keys())
        if (path.startsWith(prefix) && !tracked.has(path))
          updates.push(`0 ${"0".repeat(worktree.baseHead.length)}\t${path}\0`);
    }
    for (const path of [...new Set(paths)].sort()) {
      if (internalPath(path) || (!withSpecs && runSpecPath(path, featureId, prefix))) continue;
      const absolute = workspacePath(root, path);
      const stat = existsSync(absolute) ? lstatSync(absolute) : null;
      if (stat?.isSymbolicLink() || looksSecret(path)) continue;
      if (!stat) {
        updates.push(`0 ${"0".repeat(worktree.baseHead.length)}\t${path}\0`);
        continue;
      }
      const bytes = readFileSync(absolute);
      if (looksSecret(path, bytes)) continue;
      const blob = await required(root, ["hash-object", "-w", "--stdin", `--path=${path}`], {
        input: bytes,
      });
      // A file the baseline has keeps its committed mode; a new file takes the working tree's,
      // or is executable when it starts with a shebang (#2331).
      const mode = modes.get(path) ?? gitMode(stat.mode, bytes);
      updates.push(`${mode} ${blob}\t${path}\0`);
    }
    if (updates.length)
      await required(root, ["update-index", "-z", "--index-info"], {
        env,
        input: updates.join(""),
      });
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
  if (existsSync(absolute))
    await worktreeCommand(workspace, () =>
      required(workspace, ["worktree", "remove", "--force", absolute]),
    );
  await worktreeCommand(workspace, () => git(workspace, ["worktree", "prune"]));
  const runRoot = join(workspace, ".baked", "worktrees", runId);
  await stopHolders(runRoot);
  let left = await removeDirectory(runRoot);
  if (left && moveAside(workspace, runRoot)) left = null;
  if (left)
    throw new WorkflowFault(
      "INPUT_CHANGED",
      `The run worktrees could not be removed: ${left.message}`,
      { reason: "worktree_failed" },
    );
  if (options.deleteBranch) {
    const tip = (
      await git(workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`])
    ).stdout.trim();
    if (tip) await required(workspace, ["update-ref", "-d", `refs/heads/${worktree.branch}`, tip]);
  }
}

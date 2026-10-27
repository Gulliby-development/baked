/**
 * Git for a project folder that has none, so worktree execution (several writers, parallel
 * initiative features, best-of-N) can run there. Every surface asks the person first; this module
 * only reports the folder's state and performs the initialization they confirmed.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileHead, git, hasShebang, internalPath, looksSecret } from "../workflows/delivery-git.js";

/**
 * - `ready`: the folder is the top level of a repository with a commit; nothing to do.
 * - `missing`: no repository at or above the folder.
 * - `no-commit`: the folder is a repository without a commit yet.
 * - `nested`: the folder is inside another repository; a second one would nest in it.
 */
export type WorkspaceGitState =
  | { kind: "ready" }
  | { kind: "missing" }
  | { kind: "no-commit" }
  | { kind: "nested"; top: string };

/** Whether `initWorkspaceGit` can bring the folder to `ready`. */
export const canInitGit = (state: WorkspaceGitState): boolean =>
  state.kind === "missing" || state.kind === "no-commit";

/** Files above this size stay out of the baseline commit (and Git's object store). */
export const BASELINE_FILE_MAX = 50 * 1024 * 1024;
/** Content is scanned for private keys only in files up to this size. */
const SCAN_MAX = 1024 * 1024;
const TIMEOUT_MS = 120_000;
const FALLBACK = { name: "BAKED", email: "noreply@baked.invalid" };
export const BASELINE_MESSAGE = "Baseline before BAKED worktree runs";

/** What a new `.gitignore` holds: dependencies, build output, local tools and secrets. */
export const DEFAULT_GITIGNORE = `# Written by BAKED when it initialized Git for this folder; edit freely.
.baked/
node_modules/
dist/
build/
out/
target/
.venv/
venv/
__pycache__/
*.pyc
obj/
[Bb]in/Debug/
[Bb]in/Release/
.gradle/
.idea/
.DS_Store
Thumbs.db
.env
.env.*
*.pem
*.key
`;

export async function workspaceGitState(workspace: string): Promise<WorkspaceGitState> {
  const top = await git(workspace, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { kind: "missing" };
  const prefix = await git(workspace, ["rev-parse", "--show-prefix"]);
  if (prefix.stdout.trim()) return { kind: "nested", top: top.stdout.trim() };
  const head = await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.stdout.trim() ? { kind: "ready" } : { kind: "no-commit" };
}

export interface GitInitResult {
  /** `git init` ran; false for a repository that only lacked a commit. */
  initialized: boolean;
  /** A `.gitignore` was written because the folder had none. */
  gitignore: boolean;
  commit: string;
  /** Files committed in the baseline. */
  files: number;
  /** Files left out of the baseline and listed in `.git/info/exclude`, with the reason. */
  skipped: { path: string; reason: "secret" | "large" }[];
}

async function required(workspace: string, args: string[], input?: string): Promise<string> {
  const result = await git(workspace, args, {
    timeoutMs: TIMEOUT_MS,
    ...(input !== undefined ? { input } : {}),
  });
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || "exited with an error"}`,
    );
  return result.stdout;
}

/** Why the folder cannot be initialized, or null. */
export function gitInitProblem(state: WorkspaceGitState): string | null {
  if (state.kind === "ready") return "The project folder already has Git with a commit.";
  if (state.kind === "nested")
    return `The project folder is inside the Git repository ${state.top}. Open that folder as the project, or make this folder its own repository by hand.`;
  return null;
}

/**
 * Initializes Git in a folder without it, or commits the first baseline of a repository without
 * a commit. The baseline holds every file Git does not ignore, except internal paths, files that
 * look like credentials and files above `BASELINE_FILE_MAX`; those are listed in the
 * repository-local `.git/info/exclude` so they stay out of later commits too. Commit hooks do not
 * run, and a repository without `user.name`/`user.email` gets a fallback identity for this commit.
 */
export async function initWorkspaceGit(workspace: string): Promise<GitInitResult> {
  const state = await workspaceGitState(workspace);
  const problem = gitInitProblem(state);
  if (problem) throw new Error(problem);
  const initialized = state.kind === "missing";
  if (initialized) await required(workspace, ["init"]);
  const ignoreFile = join(workspace, ".gitignore");
  const gitignore = !existsSync(ignoreFile);
  if (gitignore) writeFileSync(ignoreFile, DEFAULT_GITIGNORE);
  const exclude = (await required(workspace, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const excludeFile = join(workspace, exclude);
  mkdirSync(dirname(excludeFile), { recursive: true });
  const excluded = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  if (!excluded.split(/\r?\n/).includes(".baked/"))
    appendFileSync(excludeFile, `${excluded && !excluded.endsWith("\n") ? "\n" : ""}.baked/\n`);

  await required(workspace, ["add", "-A"]);
  const staged = (await required(workspace, ["diff", "--cached", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean);
  const skipped: GitInitResult["skipped"] = [];
  for (const path of staged) {
    const absolute = join(workspace, path);
    const size = existsSync(absolute) ? statSync(absolute).size : 0;
    if (size > BASELINE_FILE_MAX) skipped.push({ path, reason: "large" });
    else if (
      internalPath(path) ||
      looksSecret(path, size <= SCAN_MAX && size > 0 ? readFileSync(absolute) : undefined)
    )
      skipped.push({ path, reason: "secret" });
  }
  if (skipped.length) {
    await required(
      workspace,
      [
        "--literal-pathspecs",
        "rm",
        "--cached",
        "-q",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      skipped.map((s) => s.path).join("\0"),
    );
    // Escaped, so a name with `*` or `[` excludes only itself.
    appendFileSync(excludeFile, skipped.map((s) => `/${escapeExclude(s.path)}\n`).join(""));
  }
  // A file this commit adds that starts with a shebang is executable, as a run's commits make it:
  // a Windows working tree has no executable bit to stage (#2331).
  const added = (
    await required(workspace, ["diff", "--cached", "--name-only", "--diff-filter=A", "-z"])
  )
    .split("\0")
    .filter((path) => path && hasShebang(fileHead(join(workspace, path))));
  if (added.length)
    await required(
      workspace,
      ["--literal-pathspecs", "update-index", "--chmod=+x", "-z", "--stdin"],
      added.join("\0"),
    );
  const identity = await Promise.all(
    ["user.name", "user.email"].map(
      async (key) => (await git(workspace, ["config", key])).stdout.trim() !== "",
    ),
  );
  const fallback = identity.every(Boolean)
    ? []
    : ["-c", `user.name=${FALLBACK.name}`, "-c", `user.email=${FALLBACK.email}`];
  await required(workspace, [
    ...fallback,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "--allow-empty",
    "-q",
    "-m",
    BASELINE_MESSAGE,
  ]);
  const commit = (await required(workspace, ["rev-parse", "HEAD"])).trim();
  return { initialized, gitignore, commit, files: staged.length - skipped.length, skipped };
}

/** An exclude line that matches `path` literally. */
function escapeExclude(path: string): string {
  return path.replace(/[\\*?[\]!#\s]/g, (c) => `\\${c}`);
}

/** One line for the person about what `initWorkspaceGit` did. */
export function gitInitSummary(result: GitInitResult): string {
  const parts = [
    result.initialized ? "Initialized Git" : "Committed a baseline",
    `with ${result.files} file${result.files === 1 ? "" : "s"} (${result.commit.slice(0, 7)})`,
  ];
  if (result.gitignore) parts.push("and wrote a .gitignore");
  let text = `${parts.join(" ")}.`;
  if (result.skipped.length)
    text += ` Left out ${result.skipped.length} secret or large file${result.skipped.length === 1 ? "" : "s"}: ${result.skipped
      .slice(0, 5)
      .map((s) => s.path)
      .join(", ")}${result.skipped.length > 5 ? ", …" : ""}.`;
  return text;
}

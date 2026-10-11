/**
 * Git snapshots of the working tree for chat checkpoints.
 *
 * A snapshot is a commit of every file Git would add (tracked and untracked, ignored files left
 * out), built in a temporary index so the user's index, HEAD and branch stay untouched, and kept
 * alive by a lightweight tag under `refs/tags/baked/`.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpDir } from "../platform/index.js";
import { buildSafeEnv } from "../spawn.js";

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "BAKED",
  GIT_AUTHOR_EMAIL: "noreply@github.com",
  GIT_COMMITTER_NAME: "BAKED",
  GIT_COMMITTER_EMAIL: "noreply@github.com",
};

interface GitResult {
  ok: boolean;
  stdout: Buffer;
}

function git(
  args: string[],
  cwd: string,
  options: { env?: Record<string, string>; timeout?: number } = {},
): Promise<GitResult> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    const proc = spawn("git", args, {
      cwd,
      timeout: options.timeout ?? 30_000,
      env: { ...buildSafeEnv(), ...options.env },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => done({ ok: code === 0, stdout: Buffer.concat(chunks) }));
    proc.on("error", () => done({ ok: false, stdout: Buffer.alloc(0) }));
  });
}

const text = (r: GitResult): string => r.stdout.toString("utf-8").trim();

/** True when `cwd` is inside a Git working tree. */
export async function isGitWorkspace(cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && text(r) === "true";
}

/**
 * Snapshots the working tree of `cwd` and points `refs/tags/<tag>` at it. Returns false when the
 * folder is not a Git repository or a Git step fails; the user's index and HEAD are not changed.
 */
export async function snapshotWorkspace(
  cwd: string,
  tag: string,
  message: string,
): Promise<boolean> {
  try {
    return await snapshot(cwd, tag, message);
  } catch {
    // A snapshot is best effort: callers continue without one, and rollback reports the gap.
    return false;
  }
}

async function snapshot(cwd: string, tag: string, message: string): Promise<boolean> {
  const indexPath = await git(["rev-parse", "--git-path", "index"], cwd);
  if (!indexPath.ok) return false;
  const dir = await mkdtemp(join(tmpDir(), "baked-snapshot-"));
  try {
    const tempIndex = join(dir, "index");
    // Starting from the real index reuses its stat cache, so only changed files are hashed.
    await copyFile(resolve(cwd, text(indexPath)), tempIndex).catch(() => {});
    const env = { GIT_INDEX_FILE: tempIndex, ...SNAPSHOT_IDENTITY };
    if (!(await git(["add", "-A"], cwd, { env, timeout: 120_000 })).ok) return false;
    const tree = await git(["write-tree"], cwd, { env });
    if (!tree.ok) return false;
    const head = await git(["rev-parse", "--verify", "-q", "HEAD"], cwd);
    const parent = head.ok && text(head) ? ["-p", text(head)] : [];
    const commit = await git(["commit-tree", text(tree), ...parent, "-m", message], cwd, { env });
    if (!commit.ok) return false;
    return (await git(["update-ref", `refs/tags/${tag}`, text(commit)], cwd)).ok;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Points `refs/tags/<to>` at the commit of tag `from`. */
export async function copyTag(cwd: string, from: string, to: string): Promise<boolean> {
  const target = await git(["rev-parse", "--verify", "-q", `refs/tags/${from}^{commit}`], cwd);
  if (!target.ok) return false;
  return (await git(["update-ref", `refs/tags/${to}`, text(target)], cwd)).ok;
}

/** Deletes the tag; true when it is gone. */
export async function deleteTag(cwd: string, tag: string): Promise<boolean> {
  return (
    (await git(["update-ref", "-d", `refs/tags/${tag}`], cwd)).ok || !(await tagExists(cwd, tag))
  );
}

/** True when the tag exists. */
export async function tagExists(cwd: string, tag: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "-q", `refs/tags/${tag}`], cwd)).ok;
}

/** The path of `absPath` relative to `cwd` with forward slashes, or null outside `cwd`. */
export function workspacePath(cwd: string, absPath: string): string | null {
  const rel = relative(cwd, resolve(cwd, absPath));
  if (!rel || isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
  return rel.split(sep).join("/");
}

/** The bytes of a workspace file in snapshot `ref`, or null when the snapshot has no such file. */
export async function readFileAt(cwd: string, ref: string, rel: string): Promise<Buffer | null> {
  const r = await git(["show", `refs/tags/${ref}:./${rel}`], cwd);
  return r.ok ? r.stdout : null;
}

/** True when Git ignores the workspace path, so snapshots never contain it. */
export async function isIgnored(cwd: string, rel: string): Promise<boolean> {
  return (await git(["check-ignore", "-q", "--no-index", "--", rel], cwd)).ok;
}

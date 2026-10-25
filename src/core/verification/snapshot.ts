import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import ignore from "ignore";
import { processOutput } from "../spawn.js";
import { hashBytes, hashJson } from "../specs/hash.js";
import {
  git,
  gitEnvironmentKey,
  gitFileStamp,
  gitWorktreePaths,
} from "../workflows/delivery-git.js";
import { WorkflowFault } from "../workflows/errors.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const trackedFiles = new Map<string, { stamp: string; files: string[] }>();

/** A source scan needs only tracked names, not HEAD or the working copy's status. */
async function gitTrackedFiles(workspace: string): Promise<string[]> {
  if (!existsSync(join(workspace, ".git"))) return [];
  const paths = await gitWorktreePaths(workspace);
  const key = `${resolve(workspace)}\0${paths?.index ?? ""}\0${gitEnvironmentKey()}`;
  const stamp = paths ? gitFileStamp(paths.index) : null;
  const cached = trackedFiles.get(key);
  if (stamp && cached?.stamp === stamp) return cached.files;
  const result = await git(workspace, ["ls-files", "-z", "--cached"], { timeoutMs: 10000 });
  if (result.code !== 0) throw new Error(`Cannot read repository baseline: ${result.stderr}`);
  const files = result.stdout.split("\0").filter(Boolean);
  // Do not cache a read raced by an index update, or a missing/unborn index.
  if (stamp && paths && gitFileStamp(paths.index) === stamp) {
    if (trackedFiles.size >= 128) trackedFiles.delete(trackedFiles.keys().next().value ?? "");
    trackedFiles.set(key, { stamp, files });
  }
  return files;
}

export async function gitBaseline(
  workspace: string,
): Promise<{ head: string | null; tracked: string[]; userChanges: string[] } | null> {
  if (!existsSync(join(workspace, ".git"))) return null;
  async function git(args: string[], allowFailure = false): Promise<string> {
    const proc = Bun.spawn(["git", "--no-optional-locks", "-C", workspace, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const result = await processOutput(proc);
    const [output, error, code] = [decode(result.stdout), decode(result.stderr), result.code];
    if (code !== 0 && !allowFailure) throw new Error(`Cannot read repository baseline: ${error}`);
    return code === 0 ? output : "";
  }
  return {
    head: (await git(["rev-parse", "--verify", "HEAD"], true)).trim() || null,
    tracked: (await git(["ls-files", "-z", "--cached"])).split("\0").filter(Boolean),
    userChanges: (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .split("\0")
      .filter(Boolean),
  };
}

/** Largest diff a review-only run freezes. */
export const MAX_REVIEW_DIFF_BYTES = 1024 * 1024;

/**
 * The diff a review-only run reviews: the uncommitted changes of tracked files against HEAD, or
 * the last commit when the tree is clean. Untracked files are not part of it.
 */
export async function hostDiff(workspace: string): Promise<{ text: string; files: string[] }> {
  if (!existsSync(join(workspace, ".git")))
    throw new WorkflowFault("INVALID_DEFINITION", "Review only needs a Git repository");
  async function git(args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", "--no-optional-locks", "-C", workspace, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const result = await processOutput(proc);
    const [output, error, code] = [decode(result.stdout), decode(result.stderr), result.code];
    if (code !== 0) throw new WorkflowFault("INVALID_DEFINITION", `Cannot read the diff: ${error}`);
    return output;
  }
  // BAKED's own state (`.baked/`, the workflow database and its WAL) is never part of the change,
  // even in a repository that tracks it (#1177).
  const own = ["--", ".", ":(exclude).baked"];
  let text = await git(["diff", "--no-color", "--no-ext-diff", "HEAD", ...own]);
  let files = (await git(["diff", "--name-only", "-z", "HEAD", ...own]))
    .split("\0")
    .filter(Boolean);
  if (!text.trim()) {
    text = await git([
      "show",
      "--no-color",
      "--no-ext-diff",
      "--format=",
      "--patch",
      "HEAD",
      ...own,
    ]);
    files = (await git(["show", "--format=", "--name-only", "-z", "HEAD", ...own]))
      .split("\0")
      .map((f) => f.trim())
      .filter(Boolean);
  }
  if (!text.trim())
    throw new WorkflowFault("INVALID_DEFINITION", "Review only found no change to review");
  if (Buffer.byteLength(text) > MAX_REVIEW_DIFF_BYTES)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "The diff is larger than 1 MiB; review a smaller change",
    );
  return { text, files };
}

/**
 * Directories only a toolchain writes, which no project edits: a check run that adds a file there
 * (a `.pyc` for a module a task added, when `.gitignore` does not cover `__pycache__/`) is not a
 * change of the project's sources (#1815).
 */
export const TOOL_CACHES = [
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".kotlin",
  // PHPUnit's result cache (10 and later a folder, 9 a file) and PHP-CS-Fixer's (#1491).
  ".phpunit.cache",
  ".phpunit.result.cache",
  ".php-cs-fixer.cache",
  // luacheck's cache (`cache = true`) and the LuaCov statistics `busted --coverage` writes (#1495).
  ".luacheckcache",
  "luacov.stats.out",
  "luacov.report.out",
];

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
};

export async function sourceManifest(
  workspace: string,
  generated: string[] = [],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const excluded = [".git", ".baked", "node_modules", ...TOOL_CACHES];
  const tracked = new Set(await gitTrackedFiles(workspace));
  type Rules = { base: string; matcher: ReturnType<typeof ignore> };
  async function walk(directory: string, inherited: Rules[]): Promise<void> {
    signal?.throwIfAborted();
    const rules = [...inherited];
    try {
      const local = await readFile(join(workspace, directory, ".gitignore"), "utf8");
      rules.push({ base: directory ? `${directory}/` : "", matcher: ignore().add(local) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const entries = await readdir(join(workspace, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (
        excluded.includes(entry.name) ||
        generated.some((g) => path === g || path.startsWith(`${g}/`))
      )
        continue;
      const trackedPath =
        tracked.has(path) ||
        (entry.isDirectory() && [...tracked].some((p) => p.startsWith(`${path}/`)));
      let ignored = false;
      for (const rule of rules) {
        const result = rule.matcher.test(
          path.slice(rule.base.length) + (entry.isDirectory() ? "/" : ""),
        );
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (ignored && !trackedPath) continue;
      const absolute = join(workspace, path);
      if (entry.isSymbolicLink()) {
        files[path] = `link:${hashBytes(await readlink(absolute))}`;
        continue;
      }
      if (entry.isDirectory()) {
        // A CMake build tree (#1490), wherever it is configured: every build rewrites it, so a
        // project that does not ignore `build/` would see each check change its sources.
        if (!trackedPath && (await isFile(join(absolute, "CMakeCache.txt")))) continue;
        await walk(path, rules);
        continue;
      }
      if (!entry.isFile()) continue;
      const before = await lstat(absolute);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) {
        signal?.throwIfAborted();
        hash.update(chunk);
      }
      const after = await lstat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error(`File changed while hashing: ${path}`);
      files[path] = hash.digest("hex");
    }
  }
  await walk("", []);
  return files;
}
export const snapshotHash = (files: Record<string, string>): string => hashJson(files);
export function changedPaths(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((p) => before[p] !== after[p])
    .sort();
}

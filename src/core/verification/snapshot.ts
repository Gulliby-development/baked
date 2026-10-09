import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import { hashBytes, hashJson } from "../specs/hash.js";

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
    const [output, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
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

export async function sourceManifest(
  workspace: string,
  generated: string[] = [],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const excluded = [".git", ".baked", "node_modules"];
  const tracked = new Set((await gitBaseline(workspace))?.tracked ?? []);
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

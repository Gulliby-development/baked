import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorkflowFault } from "./errors.js";
import type { WorkflowStore } from "./store.js";
import { runRoot } from "./worktree.js";

const MAX_DIFF_LINES = 2000;

export interface RunFileDiff {
  path: string;
  /** "git" when a diff against HEAD is available, otherwise "unavailable". */
  kind: "git" | "unavailable";
  text: string;
  /** The file already had uncommitted changes when the run's baseline was recorded. */
  preexistingChanges: boolean;
  truncated: boolean;
}

async function git(workspace: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", workspace, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
}

/** Status entries recorded at approval; porcelain v1 entries carry the path after 3 characters. */
function baselineChanges(store: WorkflowStore, runId: string): Set<string> {
  const paths = new Set<string>();
  for (const artifact of store.artifacts(runId).filter((a) => a.kind === "baseline"))
    try {
      const body = JSON.parse(store.readArtifact(runId, artifact.id)) as {
        repository?: { userChanges?: string[] } | null;
      };
      for (const entry of body.repository?.userChanges ?? []) paths.add(entry.slice(3));
    } catch {
      // A missing baseline only removes the warning; the diff itself is still read-only.
    }
  return paths;
}

/**
 * Read-only diff of one file the run touched. Paths outside the run's effect journal are refused,
 * so the panel cannot be used to read arbitrary workspace files.
 */
export async function readRunFileDiff(
  store: WorkflowStore,
  runId: string,
  path: string,
): Promise<RunFileDiff> {
  const touched = store
    .effects(runId)
    .some(
      (e) => e.kind !== "command" && (JSON.parse(e.intent_json) as { path?: string }).path === path,
    );
  if (!touched) throw new WorkflowFault("NOT_FOUND", `The run did not change ${path}`);
  const preexistingChanges = baselineChanges(store, runId).has(path);
  // A worktree run is compared with the HEAD it started from, in its own worktree.
  const worktree = store.state(runId).worktree;
  const root = runRoot(store.workspace, store.state(runId));
  const base = worktree?.baseHead ?? "HEAD";
  if (!existsSync(join(root, ".git")))
    return {
      path,
      kind: "unavailable",
      text: "Content diffs need a Git repository. The run journal records only content hashes.",
      preexistingChanges,
      truncated: false,
    };
  const tracked = (await git(root, ["cat-file", "-e", `${base}:${path}`])).code === 0;
  const result = tracked
    ? await git(root, ["diff", "--no-color", "--no-ext-diff", base, "--", path])
    : await git(root, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ]);
  const lines = result.out.split("\n");
  return {
    path,
    kind: "git",
    text:
      lines.slice(0, MAX_DIFF_LINES).join("\n") ||
      (existsSync(join(root, path)) ? "No difference from HEAD." : "The file does not exist now."),
    preexistingChanges,
    truncated: lines.length > MAX_DIFF_LINES,
  };
}

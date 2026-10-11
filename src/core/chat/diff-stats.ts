/**
 * Per-session diff statistics for the local API (`GET /v1/sessions/ID/diff`): the files a chat
 * session edited, each with the lines it now adds and removes against the last commit. Git
 * measures the change, so a file shows what is still uncommitted, whoever made it; a file the
 * session edited and that was committed or reverted since shows as unchanged.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ChatMessage } from "../../types/index.js";
import { run } from "../git/status.js";

/** Tools whose `path` (or `file`) argument names the file they wrote. */
const EDIT_TOOLS = new Set([
  "edit_file",
  "write_file",
  "create_file",
  "multi_edit",
  "undo_edit",
  "ast_edit",
  "structural_edit",
]);
const GIT_TIMEOUT_MS = 15_000;

export type FileDiffStatus = "modified" | "added" | "deleted" | "unchanged" | "outside" | "unknown";

export interface FileDiffStat {
  /** Relative to the workspace, with forward slashes; absolute for a file outside it. */
  path: string;
  status: FileDiffStatus;
  added: number;
  removed: number;
  /** Git reports no line counts for binary files. */
  binary?: boolean;
}

export interface SessionDiffStats {
  /** `HEAD` when git measured the files; null outside a repository, where only names are known. */
  base: "HEAD" | null;
  files: FileDiffStat[];
  totals: { files: number; added: number; removed: number };
}

/** The files a session's tool calls edited, as the tools named them. */
export function editedFiles(messages: ChatMessage[]): string[] {
  const files = new Set<string>();
  for (const message of messages)
    for (const call of message.toolCalls ?? []) {
      if (call.result?.success !== false && EDIT_TOOLS.has(call.name)) {
        const path = call.args.path ?? call.args.file;
        if (typeof path === "string") files.add(path);
      }
      if (call.name === "rename_file" && call.result?.success !== false) {
        if (typeof call.args.from === "string") files.add(call.args.from);
        if (typeof call.args.to === "string") files.add(call.args.to);
      }
      for (const file of call.result?.filesEdited ?? []) files.add(file);
    }
  return [...files].sort();
}

const toPosix = (path: string): string => path.split(sep).join("/");

/** Splits a NUL-separated git output into its fields. */
function fields(stdout: string): string[] {
  return stdout.split("\0").filter((f) => f.length > 0);
}

async function lineCount(path: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const bytes = await readFile(path);
    if (bytes.includes(0)) return { lines: 0, binary: true };
    const text = bytes.toString("utf8");
    if (text.length === 0) return { lines: 0, binary: false };
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { lines, binary: false };
  } catch {
    return { lines: 0, binary: false };
  }
}

/** Measures `files` (as the tools named them) against `HEAD` of the workspace's repository. */
export async function sessionDiffStats(
  workspace: string,
  files: string[],
): Promise<SessionDiffStats> {
  const outside: FileDiffStat[] = [];
  const inside = new Set<string>();
  for (const file of files) {
    const abs = resolve(workspace, file);
    const rel = relative(workspace, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      outside.push({ path: toPosix(abs), status: "outside", added: 0, removed: 0 });
    else inside.add(toPosix(rel));
  }
  const paths = [...inside].sort();
  const head = (await run(["rev-parse", "--verify", "HEAD"], workspace)).ok;
  let measured: FileDiffStat[];
  if (paths.length === 0) measured = [];
  else if (!head) {
    measured = paths.map((path) => ({ path, status: "unknown", added: 0, removed: 0 }));
  } else {
    const args = ["--no-renames", "-z", "HEAD", "--", ...paths];
    const [numstat, nameStatus, untracked] = await Promise.all([
      run(["diff", "--numstat", ...args], workspace, GIT_TIMEOUT_MS),
      run(["diff", "--name-status", ...args], workspace, GIT_TIMEOUT_MS),
      run(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths],
        workspace,
        GIT_TIMEOUT_MS,
      ),
    ]);
    const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
    // `--numstat -z` prints "ADDED\tREMOVED\tPATH" per file, with "-" counts for binary files.
    for (const entry of fields(numstat.stdout)) {
      const [added, removed, path] = entry.split("\t");
      if (!path || added === undefined || removed === undefined) continue;
      const binary = added === "-";
      counts.set(path, {
        added: binary ? 0 : Number(added),
        removed: binary ? 0 : Number(removed),
        binary,
      });
    }
    const kinds = new Map<string, string>();
    const status = fields(nameStatus.stdout);
    for (let i = 0; i + 1 < status.length; i += 2) {
      const kind = status[i];
      const path = status[i + 1];
      if (kind && path) kinds.set(path, kind);
    }
    const fresh = new Set(fields(untracked.stdout));
    measured = await Promise.all(
      paths.map(async (path): Promise<FileDiffStat> => {
        if (fresh.has(path)) {
          const { lines, binary } = await lineCount(resolve(workspace, path));
          return { path, status: "added", added: lines, removed: 0, ...(binary ? { binary } : {}) };
        }
        const count = counts.get(path);
        if (!count) return { path, status: "unchanged", added: 0, removed: 0 };
        const kind = kinds.get(path);
        return {
          path,
          status: kind === "A" ? "added" : kind === "D" ? "deleted" : "modified",
          added: count.added,
          removed: count.removed,
          ...(count.binary ? { binary: true } : {}),
        };
      }),
    );
  }
  const all = [...measured, ...outside];
  const changed = all.filter((f) => f.status !== "unchanged" && f.status !== "outside");
  return {
    base: head ? "HEAD" : null,
    files: all,
    totals: {
      files: changed.length,
      added: changed.reduce((sum, f) => sum + f.added, 0),
      removed: changed.reduce((sum, f) => sum + f.removed, 0),
    },
  };
}

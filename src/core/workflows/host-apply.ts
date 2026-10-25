import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git/status.js";
import { tmpDir } from "../platform/index.js";
import type { TaskGraph } from "./schemas.js";
import { suppliedBlocks } from "./sizing.js";
import type { WorkflowStore } from "./store.js";
import { hostWritten } from "./task-graph.js";
import type { Task } from "./types.js";

/**
 * The host's apply decision for a task whose content the request gives verbatim (#2023). Bench
 * round 65 spent 400k of eolscope-update's 580k tokens, 228k of seqmill-update's 276k and 170k of
 * aclvet-update's 742k on tasks that only applied the brief's exact diffs and whole files: only a
 * planner that retyped a file into `write.content` got a host-written task (`hostWritten`).
 *
 * It ships in shadow: before a planned task's first implementer session, the host reads the
 * request's verbatim blocks for each write (`suppliedBlocks`, the reader pricing uses), checks
 * each diff with `git apply --check` against the task's base in the run's root (changing no file),
 * and records `host-apply/tasks/<task>.json` (kind `host-apply`, kept in bench traces) with every
 * input and `wouldApply`. The implementer still runs. `replayHostApply` (`trace.ts`) decides each
 * record again; promoting the decision to skip the implementer is a pull request of its own.
 */
export const HOST_APPLY_KIND = "host-apply";
/** One record per planned task with a supplied write: `host-apply/tasks/<task>.json`. */
export const HOST_APPLY_DIR = "host-apply/tasks/";
/**
 * How the host checks a supplied diff: hand-written hunk counts are recounted, and the headers are
 * the `a/` and `b/` form `diffSections` writes.
 */
export const APPLY_CHECK_ARGS = ["apply", "--check", "--recount", "-p1"] as const;
/** The tail of git's refusal a record keeps. */
const REFUSAL_CHARS = 300;

/** What the decision knows of one write of the task. */
export interface HostApplyWrite {
  path: string;
  action: "create" | "modify" | "delete";
  /** Fenced whole-file blocks the request attributes to the path. */
  files: number;
  /** Fenced diff blocks with hunks for the path. */
  diffs: number;
  /** Whether the prose before the path's one fenced file says it is the whole file. */
  whole: boolean;
  /** Whether the path exists in the task's base. */
  exists: boolean;
  /** `git apply --check` of the path's hunks on the task's base; null without a diff. */
  applies: boolean | null;
  /** The last line of git's refusal when the hunks do not apply. */
  refusal?: string;
  /**
   * `crlf` when the hunks applied only with CRLF line ends: the base file is CRLF (a Git for
   * Windows worktree with `core.autocrlf=true`) and the brief's diff is LF (#2158).
   */
  eol?: "crlf";
}

export interface HostApplyVerdict {
  wouldApply: boolean;
  /** Why the host would start an implementer instead; null when it would apply. */
  reason: string | null;
}

/** What `host-apply/tasks/<task>.json` records: the decision's inputs and its verdict. */
export interface HostApplyRecord extends HostApplyVerdict {
  taskId: string;
  mode: "shadow";
  writes: HostApplyWrite[];
}

/** Decides from the recorded writes; `replayHostApply` takes another rule to replay. */
export type HostApplyRule = (writes: readonly HostApplyWrite[]) => HostApplyVerdict;

const no = (reason: string): HostApplyVerdict => ({ wouldApply: false, reason });

/**
 * The one function that decides whether the host would apply a task's content itself (#2023):
 * every write has exactly one kind of verbatim block, none deletes, a fenced file for a path that
 * exists says it is the whole file, and every diff applies to the task's base. Otherwise an
 * implementer starts, with the first write that keeps it as the reason.
 */
export const hostApplyDecision: HostApplyRule = (writes) => {
  if (!writes.length) return no("the task writes no file");
  for (const w of writes) {
    if (w.action === "delete") return no(`the task deletes ${w.path}`);
    if (!w.files && !w.diffs) return no(`the request gives no verbatim block for ${w.path}`);
    if (w.files && w.diffs)
      return no(`the request gives both a fenced file and a diff for ${w.path}`);
    if (w.files > 1) return no(`the request gives ${w.files} fenced blocks for ${w.path}`);
    if (w.files && w.exists && !w.whole)
      return no(
        `the fenced block for ${w.path}, which exists, may be an excerpt: the prose before it does not say it is the whole file`,
      );
    if (w.diffs && w.applies !== true)
      return no(
        `the diff for ${w.path} does not apply to the task's base${w.refusal ? `: ${w.refusal}` : ""}`,
      );
  }
  return { wouldApply: true, reason: null };
};

/** The record of a task's apply decision from its writes' inputs. */
export function hostApplyRecord(
  taskId: string,
  writes: HostApplyWrite[],
  decide: HostApplyRule = hostApplyDecision,
): HostApplyRecord {
  return { taskId, mode: "shadow", writes, ...decide(writes) };
}

/**
 * Gives a patch's hunk lines CRLF ends, the form a diff of a CRLF file has. Headers keep LF, as
 * `git diff` writes them.
 */
export function crlfPatch(patch: string): string {
  let hunk = false;
  return patch
    .split("\n")
    .map((line, i, lines) => {
      if (line.startsWith("@@")) hunk = true;
      else if (/^(?:diff |--- |\+\+\+ )/.test(line)) hunk = false;
      else if (hunk && i < lines.length - 1 && /^[ +-]/.test(line) && !line.endsWith("\r"))
        return `${line}\r`;
      return line;
    })
    .join("\n");
}

/** Whether the file at `path` in `root` has a CRLF line end. */
function crlfFile(root: string, path: string): boolean {
  try {
    return readFileSync(join(root, path), "utf8").includes("\r\n");
  } catch {
    return false;
  }
}

/**
 * `git apply --check` of a write's patch against the task's base. The check compares bytes, so an
 * LF diff from the brief fails on a CRLF checkout of the same content (Git for Windows checks task
 * worktrees out with `core.autocrlf=true`): when the base file is CRLF, the patch with CRLF hunk
 * lines is checked too, and `eol: "crlf"` records that it applied that way (#2158).
 */
async function applyWriteCheck(
  root: string,
  path: string,
  patch: string,
): Promise<{ applies: boolean; refusal?: string; eol?: "crlf" }> {
  const check = await applyCheck(root, patch);
  if (check.applies || !crlfFile(root, path)) return check;
  const crlf = crlfPatch(patch);
  if (crlf === patch) return check;
  return (await applyCheck(root, crlf)).applies ? { applies: true, eol: "crlf" } : check;
}

/** Runs `git apply --check` for a patch in `root`; changes no file. */
async function applyCheck(
  root: string,
  patch: string,
): Promise<{ applies: boolean; refusal?: string }> {
  const dir = mkdtempSync(join(tmpDir(), "baked-host-apply-"));
  try {
    const file = join(dir, "task.patch");
    writeFileSync(file, patch);
    // In a subdirectory of a repository git reads patch paths from the top: prefix them.
    const prefix = (await runGit(["rev-parse", "--show-prefix"], root)).stdout.trim();
    const result = await runGit(
      [...APPLY_CHECK_ARGS, ...(prefix ? [`--directory=${prefix}`] : []), file],
      root,
      30_000,
    );
    if (result.ok) return { applies: true };
    const last = result.stderr.trim().split("\n").at(-1)?.trim() ?? "";
    return { applies: false, ...(last ? { refusal: last.slice(-REFUSAL_CHARS) } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The inputs of a task's apply decision, read from the request and checked in `root` (the task's
 * base). Null when the request supplies none of the task's writes: nothing to decide.
 */
export async function hostApplyInputs(
  root: string,
  request: string,
  task: Pick<Task, "writes">,
): Promise<HostApplyWrite[] | null> {
  const supplied = suppliedBlocks(
    request,
    task.writes.map((w) => w.path),
  );
  if (!task.writes.some((w) => supplied.has(w.path))) return null;
  const writes: HostApplyWrite[] = [];
  for (const write of task.writes) {
    const blocks = supplied.get(write.path) ?? [];
    const files = blocks.filter((b) => b.kind === "file");
    const diffs = blocks.flatMap((b) => (b.kind === "diff" ? [b.patch] : []));
    const patch = diffs.join("");
    const check =
      diffs.length && !files.length && write.action !== "delete"
        ? patch
          ? await applyWriteCheck(root, write.path, patch)
          : { applies: false }
        : null;
    writes.push({
      path: write.path,
      action: write.action,
      files: files.length,
      diffs: diffs.length,
      whole: files.length === 1 && files[0]?.kind === "file" && files[0].whole,
      exists: existsSync(join(root, write.path)),
      applies: check ? check.applies : null,
      ...(check?.refusal ? { refusal: check.refusal } : {}),
      ...(check?.eol ? { eol: check.eol } : {}),
    });
  }
  return writes;
}

/**
 * Planned tasks whose every write the request supplies with one kind of verbatim block and none
 * deletes, for the plan approval (#2023). Reads the request only: whether a diff applies is
 * checked when the task starts, against its base then. Host-written tasks are left out.
 */
export function hostAppliableTasks(request: string, graph: Pick<TaskGraph, "tasks">): string[] {
  const supplied = suppliedBlocks(
    request,
    graph.tasks.flatMap((t) => t.writes.map((w) => w.path)),
  );
  return graph.tasks.flatMap((task) => {
    if (task.origin !== "planned" || hostWritten(task) || !task.writes.length) return [];
    const every = task.writes.every((w) => {
      const blocks = supplied.get(w.path) ?? [];
      return (
        w.action !== "delete" &&
        blocks.length > 0 &&
        (blocks.every((b) => b.kind === "diff") || blocks.length === 1)
      );
    });
    return every ? [task.id] : [];
  });
}

/** The approval's line naming the host-appliable tasks; null when there are none. */
export function hostApplyText(taskIds: readonly string[]): string | null {
  return taskIds.length
    ? `Host-appliable from the request's verbatim content: ${taskIds.join(", ")} (shadow: the host records whether each would apply, and an implementer still runs)`
    : null;
}

/** The run's recorded apply decisions, latest per task, in task order. */
export function hostApplyRecords(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): HostApplyRecord[] {
  const records = new Map<string, HostApplyRecord>();
  for (const artifact of store.artifacts(runId)) {
    if (artifact.kind !== HOST_APPLY_KIND || !artifact.logical_path.startsWith(HOST_APPLY_DIR))
      continue;
    try {
      const record = JSON.parse(store.readArtifact(runId, artifact.id)) as HostApplyRecord;
      records.set(record.taskId, record);
    } catch {}
  }
  return [...records.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** The recorded decisions as `baked workflow status` prints them. */
export function hostApplySummary(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): { taskId: string; wouldApply: boolean; reason: string | null }[] {
  return hostApplyRecords(store, runId).map(({ taskId, wouldApply, reason }) => ({
    taskId,
    wouldApply,
    reason,
  }));
}

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git/status.js";
import { tmpDir } from "../platform/index.js";
import type { TaskGraph } from "./schemas.js";
import { type MarkdownRegion, suppliedBlocks } from "./sizing.js";
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
   * The path's one fenced block is a Markdown section of a file that exists (`markdownRegion`,
   * #2101): its heading's level and how many sections of that heading and level the file holds
   * (0: the host would append it, 1: replace that section). The title is not recorded (#1715).
   * Absent for any other write, and in records before #2101.
   */
  region?: { level: number; matches: number };
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
    // A Markdown section the host writes into the file (#2101): appended, or in place of the one
    // section of its heading.
    if (w.files && w.region) {
      if (w.region.matches > 1)
        return no(
          `the section the request gives for ${w.path} has a heading that ${w.region.matches} sections of the file share`,
        );
      continue;
    }
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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * The sections of a Markdown text with `region`'s heading: each as its line range, from the
 * heading to the line before the next heading of the same or a higher level (headings inside
 * fenced blocks end nothing).
 */
export function regionSections(
  text: string,
  region: MarkdownRegion,
): { from: number; to: number }[] {
  const lines = text.split("\n");
  const headings: { index: number; level: number; title: string }[] = [];
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const open = FENCE.exec(line)?.[1];
    if (open && (fence === null || (open[0] === fence[0] && open.length >= fence.length))) {
      fence = fence === null ? open : null;
      continue;
    }
    if (fence !== null) continue;
    const heading = HEADING_LINE.exec(line.replace(/\r$/, ""));
    if (heading)
      headings.push({ index, level: heading[1]?.length ?? 1, title: (heading[2] ?? "").trim() });
  }
  return headings.flatMap((h, i) => {
    if (h.level !== region.level || h.title.toLowerCase() !== region.title.toLowerCase()) return [];
    const next = headings.slice(i + 1).find((n) => n.level <= h.level);
    return [{ from: h.index, to: next ? next.index : lines.length }];
  });
}

/**
 * A Markdown text with a section written in (#2101): in place of the one section of its heading,
 * or appended after a blank line when the text has none. The section's text ends in one newline
 * and is followed by a blank line before a next heading. Null when several sections share the
 * heading. What the host writes once the region decision is promoted; shadow until then.
 */
export function applyRegion(text: string, section: string, region: MarkdownRegion): string | null {
  const found = regionSections(text, region);
  if (found.length > 1) return null;
  const body = `${section.replace(/\s+$/, "")}\n`;
  const at = found[0];
  if (!at) return `${text.replace(/\s+$/, "")}${text.trim() ? "\n\n" : ""}${body}`;
  const lines = text.split("\n");
  const after = lines.slice(at.to).join("\n");
  const before = lines.slice(0, at.from).join("\n");
  return `${before}${before ? "\n" : ""}${body}${after ? `\n${after}` : ""}`;
}

/** The record of a task's apply decision from its writes' inputs. */
export function hostApplyRecord(
  taskId: string,
  writes: HostApplyWrite[],
  decide: HostApplyRule = hostApplyDecision,
): HostApplyRecord {
  return { taskId, mode: "shadow", writes, ...decide(writes) };
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
          ? await applyCheck(root, patch)
          : { applies: false }
        : null;
    const exists = existsSync(join(root, write.path));
    const only = files.length === 1 ? files[0] : undefined;
    const region = only?.kind === "file" && exists && only.region ? only.region : null;
    writes.push({
      path: write.path,
      action: write.action,
      files: files.length,
      diffs: diffs.length,
      whole: only?.kind === "file" && only.whole,
      exists,
      applies: check ? check.applies : null,
      ...(check?.refusal ? { refusal: check.refusal } : {}),
      ...(region
        ? {
            region: {
              level: region.level,
              matches: regionSections(readFileSync(join(root, write.path), "utf8"), region).length,
            },
          }
        : {}),
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

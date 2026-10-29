import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * record again.
 *
 * With the policy's `hostApply: "on"` (setting `quality.hostApply`, #2333) a task the decision
 * would apply skips its implementer: the host writes each file's final content
 * (`hostApplyContents`) through the run's journal, as for a host-written task, and the task's
 * checks decide it; a failing check opens the normal corrective. R73 and R74 had 12 `wouldApply`
 * decisions, all byte-identical to the reference trees, and one correct refusal; the sessions
 * cost 29 to 74 percent of those update runs' tokens.
 */
export const HOST_APPLY_KIND = "host-apply";
/** One record per planned task with a supplied write: `host-apply/tasks/<task>.json`. */
export const HOST_APPLY_DIR = "host-apply/tasks/";
/**
 * Whether a patch has a hunk with no context line, as `git diff -U0` writes them (#2412). A hunk of
 * a new or deleted file has none in any diff and is not one.
 */
export function zeroContextHunks(patch: string): boolean {
  let whole = false;
  let hunk: { context: boolean } | null = null;
  const zero = () => hunk !== null && !hunk.context && !whole;
  for (const line of patch.split("\n")) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      if (zero()) return true;
      hunk = { context: false };
    } else if (/^(?:diff |index |--- |\+\+\+ )/.test(line)) {
      if (zero()) return true;
      hunk = null;
      if (/^(?:--- |\+\+\+ )\/dev\/null\b/.test(line)) whole = true;
      else if (line.startsWith("diff ") || line.startsWith("index ")) whole = false;
    } else if (hunk && line.startsWith(" ")) hunk.context = true;
  }
  return zero();
}

/**
 * The one place that builds `git apply`'s arguments for the request's diffs (#2412): the check
 * against the task's base (`check`), host apply's scratch copy and the supplied-content checks.
 * Hand-written hunk counts are recounted, and the headers are the `a/` and `b/` form
 * `diffSections` writes. A patch with a zero-context hunk takes `--unidiff-zero`: without it git
 * pins a hunk with neither leading nor trailing context to both ends of the file, so a pure
 * addition lands at the end (and `--check` passes) and a replacement is refused. A patch whose
 * every hunk has context keeps git's default, which still pins a hunk without trailing context to
 * the end of the file.
 */
export function applyArgs(patch: string, check = false): string[] {
  return [
    "apply",
    ...(check ? ["--check"] : []),
    "--recount",
    "-p1",
    ...(zeroContextHunks(patch) ? ["--unidiff-zero"] : []),
  ];
}

const blobHash = (algorithm: "sha1" | "sha256", bytes: Buffer): string =>
  createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * Why a zero-context patch cannot be trusted on the file at `path` in `root`; null when it can
 * (#2412). With `--unidiff-zero` git places a hunk by its line numbers alone, so the base must be
 * the diff's pre-image: the first `index <old>..<new>` line's old blob is matched (as a prefix)
 * against the file's blob hash, of its bytes or of their LF form (a CRLF checkout of an LF blob),
 * in SHA-1 or SHA-256. A patch with context in every hunk, without an `index` line, or for a file
 * the base lacks is not checked.
 */
export function baseDrift(root: string, path: string, patch: string): string | null {
  if (!zeroContextHunks(patch)) return null;
  const old = /^index ([0-9a-f]{4,})\.\./m.exec(patch)?.[1];
  const file = join(root, path);
  if (!old || /^0+$/.test(old) || !existsSync(file)) return null;
  const bytes = readFileSync(file);
  const lf = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  const hashes = (["sha1", "sha256"] as const).flatMap((a) => [
    blobHash(a, bytes),
    blobHash(a, lf),
  ]);
  if (hashes.some((h) => h.startsWith(old))) return null;
  return `the zero-context diff for ${path} names pre-image ${old}, and the base file is ${hashes[0]?.slice(0, old.length)}: its hunks are placed by line number only, so they apply only to that pre-image`;
}
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
   * `crlf` when the hunks applied only with CRLF line ends: the base file is CRLF and git does
   * not convert it (committed as CRLF, or `core.autocrlf=false`), and the brief's diff is LF (#2158).
   */
  eol?: "crlf";
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
  /** `on` when the policy lets the host apply the task (#2333); `shadow` records only. */
  mode: "shadow" | "on";
  writes: HostApplyWrite[];
  /**
   * In `on` mode: whether the host wrote the task's files and skipped its implementer. False with
   * `applyError` when the decision said apply and the content could not be computed.
   */
  applied?: boolean;
  applyError?: string;
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
 * heading. What the host writes for a section under `hostApply: "on"` (#2333).
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
  mode: HostApplyRecord["mode"] = "shadow",
): HostApplyRecord {
  return { taskId, mode, writes, ...decide(writes) };
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

/**
 * The forms of a patch to try, in order, on a base (#2158, #2412): the request's LF form, then the
 * CRLF form for a base with a CRLF line end. A zero-context patch on a CRLF base tries the CRLF form
 * first: with no line to compare, its pure additions would apply in LF and leave mixed line ends.
 */
export function patchForms(patch: string, crlfBase: boolean): string[] {
  const crlf = crlfBase ? crlfPatch(patch) : patch;
  if (crlf === patch) return [patch];
  return zeroContextHunks(patch) ? [crlf, patch] : [patch, crlf];
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
 * `git apply --check` of a write's patch against the task's base, after `baseDrift` for a patch
 * with a zero-context hunk (#2412). The check compares bytes, so an
 * LF diff from the brief fails on a CRLF base of the same content that git does not convert (git
 * already converts a `core.autocrlf=true` worktree): when the base file is CRLF, the patch with
 * CRLF hunk lines is checked too, and `eol: "crlf"` records that it applied that way (#2158).
 */
async function applyWriteCheck(
  root: string,
  path: string,
  patch: string,
): Promise<{ applies: boolean; refusal?: string; eol?: "crlf" }> {
  const drift = baseDrift(root, path, patch);
  if (drift) return { applies: false, refusal: drift.slice(-REFUSAL_CHARS) };
  let refused: { applies: boolean; refusal?: string } | null = null;
  for (const form of patchForms(patch, crlfFile(root, path))) {
    const check = await applyCheck(root, form);
    if (check.applies) return form === patch ? check : { applies: true, eol: "crlf" };
    // The refusal of the request's own form is the one a record keeps.
    if (form === patch || !refused) refused = check;
  }
  return refused ?? { applies: false };
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
      [...applyArgs(patch, true), ...(prefix ? [`--directory=${prefix}`] : []), file],
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
      ...(check?.eol ? { eol: check.eol } : {}),
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
 * The content each write of a task has once the host applies the request's verbatim blocks to
 * the task's base in `root` (#2333): a whole file as given, a Markdown section written in place
 * of its heading's one section or appended (`applyRegion`), and diffs applied with `git apply` to
 * a scratch copy of the file (CRLF hunk lines for a CRLF base, as the decision checked them;
 * `core.autocrlf` off, so the bytes are the request's). Changes no file of `root`. Throws with
 * the write that cannot be computed; call it only for a task `hostApplyDecision` would apply.
 */
export async function hostApplyContents(
  root: string,
  request: string,
  task: Pick<Task, "writes">,
): Promise<{ path: string; content: string }[]> {
  const supplied = suppliedBlocks(
    request,
    task.writes.map((w) => w.path),
  );
  const out: { path: string; content: string }[] = [];
  for (const write of task.writes) {
    const blocks = supplied.get(write.path) ?? [];
    const target = join(root, write.path);
    const base = existsSync(target) ? readFileSync(target, "utf8") : null;
    const [only] = blocks;
    if (blocks.length === 1 && only?.kind === "file") {
      const content =
        base !== null && only.region ? applyRegion(base, only.content, only.region) : only.content;
      if (content === null) throw new Error(`several sections of ${write.path} share the heading`);
      out.push({ path: write.path, content });
      continue;
    }
    const patch = blocks.flatMap((b) => (b.kind === "diff" ? [b.patch] : [])).join("");
    if (!patch || blocks.some((b) => b.kind !== "diff"))
      throw new Error(`no verbatim block to apply for ${write.path}`);
    out.push({ path: write.path, content: await appliedPatch(write.path, base, patch) });
  }
  return out;
}

/** A file's text after `git apply` of its patch to a scratch copy of `base` (null: a new file). */
async function appliedPatch(path: string, base: string | null, patch: string): Promise<string> {
  const dir = mkdtempSync(join(tmpDir(), "baked-host-apply-"));
  try {
    const copy = join(dir, "tree");
    const file = join(copy, path);
    mkdirSync(dirname(file), { recursive: true });
    if (base !== null) writeFileSync(file, base);
    const apply = async (text: string) => {
      writeFileSync(join(dir, "task.patch"), text);
      return runGit(
        ["-c", "core.autocrlf=false", ...applyArgs(text), join(dir, "task.patch")],
        copy,
        30_000,
      );
    };
    const [first, ...rest] = patchForms(patch, base?.includes("\r\n") ?? false);
    let applied = await apply(first ?? patch);
    for (const form of rest) if (!applied.ok) applied = await apply(form);
    if (!applied.ok)
      throw new Error(
        `the diff for ${path} does not apply: ${applied.stderr.trim().split("\n").at(-1) ?? ""}`,
      );
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
export function hostApplyText(
  taskIds: readonly string[],
  mode: HostApplyRecord["mode"] = "shadow",
): string | null {
  if (!taskIds.length) return null;
  return mode === "on"
    ? `Host-applied from the request's verbatim content: ${taskIds.join(", ")} (the host writes each one whose diffs apply to its base when it starts, with no implementer session; its checks decide it)`
    : `Host-appliable from the request's verbatim content: ${taskIds.join(", ")} (shadow: the host records whether each would apply, and an implementer still runs)`;
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
): {
  taskId: string;
  wouldApply: boolean;
  reason: string | null;
  applied?: boolean;
  applyError?: string;
}[] {
  return hostApplyRecords(store, runId).map(
    ({ taskId, wouldApply, reason, applied, applyError }) => ({
      taskId,
      wouldApply,
      reason,
      ...(applied !== undefined ? { applied } : {}),
      ...(applyError ? { applyError } : {}),
    }),
  );
}

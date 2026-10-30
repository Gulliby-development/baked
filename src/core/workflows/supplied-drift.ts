import { type HostApplyRecord, type HostApplyWrite, regionSections } from "./host-apply.js";
import type { TaskGraph } from "./schemas.js";
import { type SuppliedBlock, suppliedBlocks } from "./sizing.js";
import type { Task } from "./types.js";

/**
 * Delivered files compared with the blocks the request gives verbatim (#2332, part 2). Bench round
 * 74 ewvet-update: the request gave the README change as an exact diff, the implementer wrote its
 * printf example with a doubled backslash (`...=\\n'` where the diff has `...=\n'`), the reviewer
 * rated the deviation low, and no check read the README: the run completed with AC-005 and AC-006
 * failing. The host holds the verbatim blocks (`suppliedBlocks`) and its apply decision already
 * says which writes they fix (`host-apply/tasks/<task>.json`, #2023), so it can compare.
 *
 * At the checks stage, for each write of a recorded task whose content the request fixes, the
 * delivered file is compared with its block: a whole file line by line, a Markdown section with
 * the one section of its heading (`regionSections`), and a diff by finding each hunk's new lines
 * (context and added lines) in order as consecutive lines of the file. Line ends and trailing
 * blank lines are not compared. A write the request does not fix is left out: a fenced block that
 * may be an excerpt, a diff that did not apply to the task's base, a section whose heading several
 * sections share, a deleted file, and a path another planned task also writes.
 *
 * The `supplied_drift` reason records each mismatch as a would-stop (shadow); its promotion makes
 * it a finding of severity high on the task's file, which a repair task rewrites.
 */

export interface SuppliedDrift {
  task: string;
  path: string;
  /** The block the file is compared with. */
  block: "file" | "section" | "diff";
  /** The diff's hunk, from 1; absent for a file or a section. */
  hunk?: number;
  /**
   * `differs`: a line of the file is not the block's; `missing`: the file, the section or a
   * hunk's added line is not there; `moved`: every added line is there, but not as the hunk's
   * consecutive lines.
   */
  problem: "differs" | "missing" | "moved";
  /** The line of the file the block gives, from 1 (a diff's from its hunk header). */
  line: number;
  /** The block's text of that line, cut to `EXCERPT` characters. */
  expected: string;
  /** The file's line closest to it and its number, or null when none is close. */
  actual: { line: number; text: string } | null;
}

const EXCERPT = 200;
const cut = (text: string) => (text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text);

/** Lines without their line ends and without trailing blank lines. */
function lines(text: string): string[] {
  const out = text.split("\n").map((line) => line.replace(/\r$/, ""));
  while (out.length && !out[out.length - 1]?.trim()) out.pop();
  return out;
}

/**
 * Whether the request's block fixes the write's delivered content, from the inputs the host's
 * apply decision recorded: one whole file (or a new one), one Markdown section of a heading the
 * file has at most once, or diffs that applied to the task's base.
 */
export function comparableWrite(write: HostApplyWrite): boolean {
  if (write.action === "delete" || write.listing) return false;
  if (write.files === 1 && !write.diffs) {
    if (write.region) return write.region.matches <= 1;
    return write.whole || !write.exists;
  }
  return write.diffs > 0 && !write.files && write.applies === true;
}

/** The file's line most like `expected`: the longest shared start and end, at least half of it. */
function closest(file: readonly string[], expected: string): SuppliedDrift["actual"] {
  let best: SuppliedDrift["actual"] = null;
  let score = 0;
  for (const [index, text] of file.entries()) {
    const max = Math.min(text.length, expected.length);
    let start = 0;
    while (start < max && text[start] === expected[start]) start++;
    let end = 0;
    while (end < max - start && text[text.length - 1 - end] === expected[expected.length - 1 - end])
      end++;
    if (start + end > score) {
      score = start + end;
      best = { line: index + 1, text: cut(text) };
    }
  }
  return score * 2 >= expected.length && score > 0 ? best : null;
}

/** The first line where `delivered` (starting at file line `offset`) leaves `expected`. */
function firstDifference(
  expected: readonly string[],
  delivered: readonly string[],
  offset: number,
): { line: number; expected: string; actual: SuppliedDrift["actual"] } | null {
  const length = Math.max(expected.length, delivered.length);
  for (let i = 0; i < length; i++) {
    if (expected[i] === delivered[i]) continue;
    const text = delivered[i];
    return {
      line: offset + i + 1,
      expected: cut(expected[i] ?? ""),
      actual: text === undefined ? null : { line: offset + i + 1, text: cut(text) },
    };
  }
  return null;
}

interface Hunk {
  /** The hunk's first line in the new file, from 1. */
  start: number;
  /** Its new lines, with whether each is added. */
  lines: { text: string; added: boolean }[];
}

/** The hunks of a patch (`diffSections`' form): new lines only, trailing blank context dropped. */
export function patchHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  const close = () => {
    if (!hunk) return;
    while (
      hunk.lines.length &&
      !hunk.lines[hunk.lines.length - 1]?.added &&
      !hunk.lines.at(-1)?.text
    )
      hunk.lines.pop();
    hunks.push(hunk);
    hunk = null;
  };
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      close();
      hunk = { start: Number(header[1]), lines: [] };
      continue;
    }
    if (!hunk || /^(?:diff |--- |\+\+\+ |\\ )/.test(line)) {
      if (/^(?:diff |--- |\+\+\+ )/.test(line)) close();
      continue;
    }
    if (line.startsWith("+")) hunk.lines.push({ text: line.slice(1), added: true });
    else if (line.startsWith(" ")) hunk.lines.push({ text: line.slice(1), added: false });
    else if (line === "") hunk.lines.push({ text: "", added: false });
  }
  close();
  return hunks;
}

/** Where `needle` first sits as consecutive lines of `file` at or after `from`; -1 when nowhere. */
function findRun(file: readonly string[], needle: readonly string[], from: number): number {
  for (let i = from; i + needle.length <= file.length; i++)
    if (needle.every((line, j) => file[i + j] === line)) return i;
  return -1;
}

/**
 * How the delivered text of a write leaves the request's block, or null when it keeps it.
 * `delivered` null: the file is not there.
 */
export function blockDrift(
  task: string,
  path: string,
  block: SuppliedBlock,
  delivered: string | null,
): SuppliedDrift | null {
  const kind = block.kind === "diff" ? "diff" : block.region ? "section" : "file";
  if (delivered === null) {
    const first =
      block.kind === "file"
        ? (lines(block.content)[0] ?? "")
        : (patchHunks(block.patch)
            .flatMap((h) => h.lines)
            .find((l) => l.added)?.text ?? "");
    return {
      task,
      path,
      block: kind,
      problem: "missing",
      line: 1,
      expected: cut(first),
      actual: null,
    };
  }
  const file = lines(delivered);
  if (block.kind === "file" && !block.region) {
    const diff = firstDifference(lines(block.content), file, 0);
    return diff ? { task, path, block: kind, problem: "differs", ...diff } : null;
  }
  if (block.kind === "file" && block.region) {
    const expected = lines(block.content);
    const found = regionSections(delivered, block.region);
    // Several sections of the heading: which one the block is cannot be told.
    if (found.length > 1) return null;
    const at = found[0];
    if (!at)
      return {
        task,
        path,
        block: kind,
        problem: "missing",
        line: 1,
        expected: cut(expected[0] ?? ""),
        actual: null,
      };
    const section = lines(file.slice(at.from, at.to).join("\n"));
    const diff = firstDifference(expected, section, at.from);
    return diff ? { task, path, block: kind, problem: "differs", ...diff } : null;
  }
  if (block.kind !== "diff") return null;
  let cursor = 0;
  for (const [index, hunk] of patchHunks(block.patch).entries()) {
    const needle = hunk.lines.map((l) => l.text);
    if (!needle.length) continue;
    const at = findRun(file, needle, cursor);
    if (at >= 0) {
      cursor = at + needle.length;
      continue;
    }
    const present = new Set(file);
    const offset = hunk.lines.findIndex((l) => l.added && !present.has(l.text));
    const line = hunk.lines[offset];
    return {
      task,
      path,
      block: kind,
      hunk: index + 1,
      problem: line ? "missing" : "moved",
      line: hunk.start + Math.max(offset, 0),
      expected: cut(line ? line.text : (needle[0] ?? "")),
      actual: line ? closest(file, line.text) : null,
    };
  }
  return null;
}

/**
 * Every recorded task's writes that leave the request's verbatim blocks, read through `read`
 * (null: no file). Records of tasks the graph no longer has, and paths other planned tasks also
 * write, are left out.
 */
export function suppliedDrifts(
  request: string,
  records: readonly HostApplyRecord[],
  graph: Pick<TaskGraph, "tasks">,
  read: (path: string) => string | null,
): SuppliedDrift[] {
  const out: SuppliedDrift[] = [];
  for (const record of records) {
    const task = graph.tasks.find((t) => t.id === record.taskId);
    if (!task) continue;
    const writes = record.writes.filter(
      (w) =>
        comparableWrite(w) &&
        !graph.tasks.some(
          (other) =>
            other.id !== task.id &&
            other.origin === "planned" &&
            other.writes.some((o) => o.path === w.path),
        ),
    );
    if (!writes.length) continue;
    const supplied = suppliedBlocks(
      request,
      writes.map((w) => w.path),
    );
    for (const write of writes) {
      const blocks = supplied.get(write.path) ?? [];
      const delivered = read(write.path);
      if (blocks.every((b) => b.kind === "diff") && blocks.length > 1) {
        // Several diff blocks for one path: the host applies them as one patch.
        const patch = blocks.map((b) => (b.kind === "diff" ? b.patch : "")).join("");
        const drift = blockDrift(task.id, write.path, { kind: "diff", lines: 0, patch }, delivered);
        if (drift) out.push(drift);
        continue;
      }
      const [block] = blocks;
      // A listing is not the file's content (#2438): R77 trailspin's signatures drifted falsely.
      if (blocks.length !== 1 || !block || (block.kind === "file" && block.listing)) continue;
      const drift = blockDrift(task.id, write.path, block, delivered);
      if (drift) out.push(drift);
    }
  }
  return out;
}

/**
 * The writes of a host-written task whose plan content leaves the request's verbatim block for the
 * file (#2472), compared as `suppliedDrifts` compares a delivered file, from the task's apply
 * inputs (`hostApplyInputs`). R79 trailspin-update: the brief gave `summary_top_test.go` as a new
 * file's diff, the planner retyped it into T003's `content` with one extra blank line, and the host
 * wrote that copy with no session; `suppliedDrifts` reads only host apply records and never saw it.
 */
export function planContentDrifts(
  request: string,
  task: Pick<Task, "id" | "writes">,
  inputs: HostApplyWrite[],
  graph: Pick<TaskGraph, "tasks">,
): SuppliedDrift[] {
  const content = new Map(task.writes.map((w) => [w.path, w.content ?? null]));
  const record: HostApplyRecord = {
    taskId: task.id,
    mode: "shadow",
    writes: inputs,
    wouldApply: false,
    reason: null,
  };
  return suppliedDrifts(request, [record], graph, (path) => content.get(path) ?? null);
}

/**
 * A drift in the words a stop would use: of a delivered file, or of a host-written task's plan
 * content before the host writes it (`planContentDrifts`).
 */
export function suppliedDriftSummary(
  drift: SuppliedDrift,
  of: "delivered" | "plan" = "delivered",
): string {
  const source =
    drift.block === "diff"
      ? `the request's verbatim diff (hunk ${drift.hunk ?? 1})`
      : drift.block === "section"
        ? "the request's verbatim section"
        : "the request's verbatim file";
  const what =
    drift.problem === "moved"
      ? `does not hold the new lines of ${source} as consecutive lines from line ${drift.line}`
      : drift.problem === "missing" && !drift.actual
        ? `lacks line ${drift.line} of ${source}: ${JSON.stringify(drift.expected)}`
        : `has ${JSON.stringify(drift.actual?.text ?? "")} at line ${drift.actual?.line ?? drift.line} where ${source} gives ${JSON.stringify(drift.expected)}`;
  if (of === "plan")
    return `${drift.task}'s plan content for ${drift.path}, which the host writes with no session, ${what}. Under hostApply "on" the host writes the request's bytes instead.`;
  return `${drift.task} delivered ${drift.path}, which ${what}. A repair task would rewrite it from the request's text.`;
}

/**
 * The 0-based lines of a delivered file that the request gives verbatim for its path (#2489): a
 * line whose trimmed text is a line of a fenced block attributed to the path, or an added line of
 * its diff. A listing is not the file's content (#2438) and supplies nothing; blank lines are
 * never supplied. Quality findings on these lines (the rule pack, Semgrep, the duplication
 * ratchet) are notes: nobody may change them, so a corrective for them can only end in a person's
 * clarification. R80 deltaglue cli: the brief's `src/main.ts` returned its contract's sentinel
 * from two `catch` clauses, `catch-return-default` blocked line 10, and corrective T025 spent
 * 313k tokens and a clarification to change nothing.
 */
export function suppliedLineNumbers(request: string, path: string, content: string): Set<number> {
  const out = new Set<number>();
  if (!request) return out;
  const pool = new Set<string>();
  for (const blocks of suppliedBlocks(request, [path]).values())
    for (const block of blocks) {
      const lines =
        block.kind === "diff"
          ? block.patch
              .split("\n")
              .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
              .map((line) => line.slice(1))
          : block.listing
            ? []
            : block.content.split("\n");
      for (const line of lines) if (line.trim()) pool.add(line.trim());
    }
  if (!pool.size) return out;
  content.split("\n").forEach((line, i) => {
    if (line.trim() && pool.has(line.trim())) out.add(i);
  });
  return out;
}

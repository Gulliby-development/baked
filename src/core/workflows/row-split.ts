import { measureFileRows, rowPlaces } from "./row-block-drift.js";
import type { RunPolicy } from "./schemas.js";
import { DEFAULT_MAX_SIZED_ATTEMPT, rowVolumePrice, suppliedRows } from "./sizing.js";
import type { WorkflowStore } from "./store.js";
import type { Task } from "./types.js";

/**
 * Whether the host would split a test task that keeps ending unfinished into slices of the rows
 * its file still lacks, instead of resuming it whole (#2458, follow-up to #2455 item 3). R78
 * deltaglue cli T007 (`tests/problems.test.ts`, 63 prescribed rows) ran 7 attempts and 6.89M
 * tokens: `repeats/tasks/T007.json` recorded four unfinished ends (#2437), the result summaries
 * said "add the remaining 55 prescribed literal rows", and each resume started over with the
 * whole task and the whole growing file in context. Plan-time row pricing (#2455) cannot help a
 * task whose rows it did not read, or whose slices still end unfinished.
 *
 * At each unfinished end of a test task whose file the request prescribes rows for
 * (`suppliedRows`, the one reader of row blocks), once the task has ended unfinished
 * `MIN_UNFINISHED_ENDS` times, the host compares those rows with the delivered file (the rows no
 * file row takes the place of, `measureFileRows` and `rowPlaces`, the drift's own pairing) and
 * records `row-splits/tasks/<task>.json` (kind `row-split`, kept in bench traces, counts and row
 * numbers only): the missing rows, the slices `rowVolumePrice` would cut them into at the sized
 * attempt cap, and the decision. A split decision also records the `unfinished_row_split`
 * would-stop. Shadow only: the resume still takes the whole task. `replayRowSplits` (`trace.ts`)
 * decides each record again. Making the next attempt take the missing rows only (row slices of the
 * missing set, modify only, chained) is a pull request of its own after a bench round with no
 * false decision.
 */
export const ROW_SPLIT_KIND = "row-split";
/** One record per test task, rewritten at each of its unfinished ends: `row-splits/tasks/<task>.json`. */
export const ROW_SPLIT_DIR = "row-splits/tasks/";
/** Unfinished ends before the host would stop resuming a rows task whole. */
export const MIN_UNFINISHED_ENDS = 2;

/** The decision's inputs: counts and row numbers, no row text. */
export interface RowSplitInputs {
  /** How many times the task has ended unfinished (`repeats/tasks/<task>.json`, `end: "unfinished"`). */
  ends: number;
  /** The prescribed rows the task owns: the file's whole block, or its slice's rows. */
  rows: number;
  /** Those of them (by their place in the request's block, from 1) no row of the file holds. */
  missing: number[];
  /** The characters of the missing rows, which price them (`ROW_TEXT_PER_CHAR`). */
  missingChars: number;
  /** The sized attempt cap the slices are cut to (`sizing.maxAttemptTokens`). */
  cap: number;
}

export interface RowSplitVerdict {
  decision: "split" | "resume";
  /** The missing rows of each slice the host would start, in order; empty on resume. */
  slices: number[][];
  reason: string;
}

/** What `row-splits/tasks/<task>.json` records. */
export interface RowSplitRecord extends RowSplitInputs, RowSplitVerdict {
  schemaVersion: 1;
  taskId: string;
  mode: "shadow";
  /** The test file the rows are prescribed for. */
  path: string;
  /** Whether the file was there to compare; a missing file lacks every row. */
  delivered: boolean;
}

export type RowSplitRule = (inputs: RowSplitInputs) => RowSplitVerdict;

/**
 * The one function that decides it: a task that ended unfinished at least `MIN_UNFINISHED_ENDS`
 * times with prescribed rows its file still lacks would be split into the slices of those rows
 * that fit one attempt each (`rowVolumePrice` on the missing rows' characters, never more slices
 * than rows), dealt out evenly in the block's order as `rowSlices` deals a plan-time split.
 */
export const rowSplitDecision: RowSplitRule = (inputs) => {
  if (inputs.ends < MIN_UNFINISHED_ENDS)
    return {
      decision: "resume",
      slices: [],
      reason: `ended unfinished ${inputs.ends} time${inputs.ends === 1 ? "" : "s"}, below ${MIN_UNFINISHED_ENDS}`,
    };
  if (!inputs.missing.length)
    return { decision: "resume", slices: [], reason: "the file holds every prescribed row" };
  const count = rowVolumePrice(inputs.missingChars, inputs.missing.length, inputs.cap).slices;
  const bound = (index: number) => Math.floor((index * inputs.missing.length) / count);
  const slices = Array.from({ length: count }, (_, index) =>
    inputs.missing.slice(bound(index), bound(index + 1)),
  );
  return {
    decision: "split",
    slices,
    reason: `ended unfinished ${inputs.ends} times with ${inputs.missing.length} of ${inputs.rows} prescribed rows missing: the host would start ${count} slice${count === 1 ? "" : "s"} of the missing rows instead of resuming the whole task`,
  };
};

const plainPath = (path: string) => path.trim().replace(/^(?:\.\/)+/, "");

/**
 * The record of a task's split decision at an unfinished end, from the request's rows for its
 * test file and the delivered file read through `read` (null: not there). Null when the request
 * prescribes no rows for a file the task writes, or the task's rows are host rows
 * (`rowsAsData`, whose rows the host writes).
 */
export function rowSplitRecord(
  task: Pick<Task, "id" | "writes" | "rows" | "sizingSlice">,
  request: string,
  ends: number,
  read: (path: string) => string | null,
  policy: Pick<RunPolicy, "sizing">,
  decide: RowSplitRule = rowSplitDecision,
): RowSplitRecord | null {
  if (task.rows?.length) return null;
  const paths = task.writes.filter((w) => w.action !== "delete").map((w) => plainPath(w.path));
  const prescribed = suppliedRows(request, paths);
  const found = [...prescribed].sort((a, b) => b[1].chars - a[1].chars)[0];
  if (!found) return null;
  const [path, block] = found;
  // A slice owns its own rows (`sizingSlice.rows`, #2466); their places in the block, from 1.
  const own = task.sizingSlice?.rows;
  const owned: number[] = own?.length
    ? own.flatMap((line) => {
        const at = block.lines.indexOf(line.trim());
        return at < 0 ? [] : [at + 1];
      })
    : block.lines.map((_, index) => index + 1);
  const file = read(path);
  const placed =
    file === null ? new Map<number, number>() : rowPlaces(measureFileRows(block.lines, file));
  const missing = owned.filter((row) => !placed.has(row));
  const inputs: RowSplitInputs = {
    ends,
    rows: owned.length,
    missing,
    missingChars: missing.reduce((sum, row) => sum + [...(block.lines[row - 1] ?? "")].length, 0),
    cap: policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT,
  };
  return {
    schemaVersion: 1,
    taskId: task.id,
    mode: "shadow",
    path,
    delivered: file !== null,
    ...inputs,
    ...decide(inputs),
  };
}

/** The run's split records, latest per task, in task order. */
export function rowSplitRecords(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): RowSplitRecord[] {
  const records = new Map<string, RowSplitRecord>();
  for (const artifact of store.artifacts(runId)) {
    if (artifact.kind !== ROW_SPLIT_KIND || !artifact.logical_path.startsWith(ROW_SPLIT_DIR))
      continue;
    try {
      const record = JSON.parse(store.readArtifact(runId, artifact.id)) as RowSplitRecord;
      if (record.schemaVersion === 1) records.set(record.taskId, record);
    } catch {}
  }
  return [...records.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** The would-stop's summary for a split decision. */
export function rowSplitSummary(record: RowSplitRecord): string {
  return `unfinished_row_split: ${record.taskId} (${record.path}) ${record.reason}`;
}

import { hashBytes } from "../specs/hash.js";
import {
  CONTINUES,
  measureFileRows,
  measureRows,
  type RowBlockDrift,
  rowBlockDecision,
  rowBlockDrifts,
  rowHead,
} from "./row-block-drift.js";
import type { TaskGraph } from "./schemas.js";
import { suppliedRows } from "./sizing.js";

/**
 * The host's own restore of a prescribed row a delivered test file changed (#2522). The host holds
 * every row the request prescribes (`suppliedRows`), and `rowBlockDrifts` knows which file line
 * takes the place of a row it does not hold, yet a drifting row went to a model session to copy
 * again. Bench round 82: transcribing prescribed row files was 5.1M of the two initiatives' 18.1M
 * tokens and correcting their copies another 3.0M; tinyflate deflate T007 (2.43M) never got
 * `tests/deflate_match_test.c`'s long hex runs right (303 bytes of `78` for the row's 300, 238 of
 * `71` for 259), and slotprompt core T009 and T010 (0.57M) put back omitted arguments of Dart rows.
 *
 * At each checks stage, before the checks run, every prescribed row of a test file the plan writes
 * that drifts (`rowBlockDecision`) or that no file row holds while one takes its place (a changed
 * row, `FileRowMeasure.replaces`) is a site. The host restores a site's line from the request's
 * text when (`rowRestoreDecision`): a file line takes the row's place; that file row is the one
 * line (nothing continues its strings); the line starts with the row's own head (`{`, `row(`,
 * `Arguments.of(`), so the request's notation is the file's; and, with the line replaced by the
 * row as the request gives it (the file line's indentation and trailing `,` or `;` kept), the file
 * holds the row and no other row drifts that did not before. A file with rows spread over lines
 * (a bats `@test` per row, a formatter's wrapped row) or written in another notation than the
 * request's records the site and is not restored.
 *
 * Every comparison with a site records `row-restores/<path>.json` (kind `row-restore`, counts and
 * flags only). With the policy field `rowRestore` absent the decision is shadow (`would_restore`):
 * recorded, the file stays as written and `row_block_drift` records its would-stop as before. With
 * `rowRestore: "on"` the host writes the restored lines as a journaled edit and runs the writing
 * task's required checks on it; when one fails the edit is put back (`put_back`).
 */
export const ROW_RESTORE_KIND = "row-restore";
export const ROW_RESTORE_DIR = "row-restores/";

/** One prescribed row the file does not keep as given: flags only, as the trace keeps them. */
export interface RowRestoreSite {
  /** The row's place in the request's block(s) for the file, from 1. */
  row: number;
  /** The file line that takes the row's place, from 1; null when none does. */
  line: number | null;
  /** That file row is the one line: no line after it continues its strings. */
  oneLine: boolean;
  /** The line starts with the row's own head, so the request spells the row as the file does. */
  sameHead: boolean;
  /** With the line restored the file holds the row, and no other row drifts that did not. */
  held: boolean;
}

export interface RowRestoreRecord {
  schemaVersion: 1;
  path: string;
  /** The planned and corrective tasks that write the file. */
  tasks: string[];
  /** `shadow`: recorded only; `on`: the host restores the rows the decision names. */
  mode: "shadow" | "on";
  sites: RowRestoreSite[];
  /** The rows (from 1) the decision restores, or would restore in shadow. */
  restore: number[];
  /**
   * `would_restore`: shadow, rows to restore; `restored`: on, written and the checks pass;
   * `put_back`: on, a required check failed on the edit; `declined`: no row the host can restore.
   */
  verdict: "would_restore" | "restored" | "put_back" | "declined";
  /** The writing task's required checks on the edit; null when the host did not edit. */
  checks: "passed" | "failed" | "none" | null;
  /**
   * Where the comparison ran when not at the checks stage (#2543): `resume`, a resume of a run
   * blocked `invalid_output` (recorded under `row-restores/resume/`, never written); `drive`,
   * before the task-graph stage drives its tasks; `task`, at the start of a task's session.
   * Absent at the checks stage (and in records before it).
   */
  at?: "resume" | "drive" | "task";
  /** The tasks blocked when the run was resumed (`at: "resume"`); the task (`at: "task"`). */
  blocked?: string[];
  /** The hash of the file the sites were read from (#2543): the same file records nothing new. */
  file?: string;
}

/** The rows the host restores: each with a one-line file row in the row's notation that then holds. */
export type RowRestoreRule = (sites: readonly RowRestoreSite[]) => number[];
export function rowRestoreDecision(sites: readonly RowRestoreSite[]): number[] {
  return sites.flatMap((s) =>
    s.line !== null && s.oneLine && s.sameHead && s.held ? [s.row] : [],
  );
}

/** The prescribed `row` in place of the file line `text`: its indentation and separator kept. */
export function restoredLine(text: string, row: string): string {
  const eol = text.endsWith("\r") ? "\r" : "";
  const body = eol ? text.slice(0, -1) : text;
  const indent = /^\s*/.exec(body)?.[0] ?? "";
  const separator = /([,;])\s*$/.exec(body)?.[1] ?? "";
  const tail = separator && !row.trimEnd().endsWith(separator) ? separator : "";
  return `${indent}${row.trim()}${tail}${eol}`;
}

const withLines = (lines: readonly string[], edits: ReadonlyMap<number, string>) =>
  lines.map((text, i) => edits.get(i + 1) ?? text).join("\n");

/**
 * The sites of a delivered file against its prescribed `rows`, the rows the decision restores and
 * the file with them restored (the file as it is when none).
 */
export function rowRestorePlan(
  rows: readonly string[],
  file: string,
  decide: RowRestoreRule = rowRestoreDecision,
): { sites: RowRestoreSite[]; restore: number[]; after: string } {
  const drifting = new Set(rowBlockDecision(measureRows(rows, file)));
  const fileRows = measureFileRows(rows, file);
  const lines = file.split("\n");
  const candidates = rows.flatMap((_, index) => {
    const row = index + 1;
    const line = fileRows.find((r) => r.replaces === row)?.line ?? null;
    return drifting.has(row) || line !== null ? [{ row, line }] : [];
  });
  const restoring = new Map<number, string>();
  const sites = candidates.map(({ row, line }): RowRestoreSite => {
    const prescribed = rows[row - 1] ?? "";
    const text = line === null ? undefined : lines[line - 1];
    if (line === null || text === undefined)
      return { row, line: null, oneLine: false, sameHead: false, held: false };
    const oneLine = !CONTINUES.test(lines[line] ?? "");
    const head = rowHead(text);
    const sameHead = head !== "" && head === rowHead(prescribed);
    const restored = restoredLine(text, prescribed);
    const after = withLines(lines, new Map([[line, restored]]));
    const still = rowBlockDecision(measureRows(rows, after));
    const held =
      !still.includes(row) &&
      still.every((n) => drifting.has(n)) &&
      measureFileRows(rows, after).some((r) => r.line === line && r.matches.includes(row));
    restoring.set(row, restored);
    return { row, line, oneLine, sameHead, held };
  });
  const restore = decide(sites);
  const edits = new Map(
    sites.flatMap((s) =>
      restore.includes(s.row) && s.line !== null ? [[s.line, restoring.get(s.row) ?? ""]] : [],
    ) as [number, string][],
  );
  return { sites, restore, after: edits.size ? withLines(lines, edits) : file };
}

/**
 * For each test file the graph writes, the request prescribes rows for and the file does not keep
 * as given, its record and the file before and after the restore (read through `read`; a file
 * that is not there has no site).
 */
export function rowRestores(
  request: string,
  graph: Pick<TaskGraph, "tasks">,
  read: (path: string) => string | null,
  mode: RowRestoreRecord["mode"] = "shadow",
  decide: RowRestoreRule = rowRestoreDecision,
): { record: RowRestoreRecord; before: string; after: string }[] {
  const compared = rowBlockDrifts(request, graph, read).filter((c) => c.record.delivered);
  if (!compared.length) return [];
  const blocks = suppliedRows(
    request,
    compared.map((c) => c.record.path),
  );
  return compared.flatMap(({ record: { path, tasks } }) => {
    const block = blocks.get(path);
    const before = read(path);
    if (!block || before === null) return [];
    const { sites, restore, after } = rowRestorePlan(block.lines, before, decide);
    if (!sites.length) return [];
    const verdict = !restore.length ? "declined" : mode === "on" ? "restored" : "would_restore";
    return [
      {
        record: { schemaVersion: 1, path, tasks, mode, sites, restore, verdict, checks: null },
        before,
        after,
      },
    ];
  });
}

/** Where the resume records its comparison of the miscounted rows (`rowRunRestores`, #2543). */
export const ROW_RESTORE_RESUME_DIR = `${ROW_RESTORE_DIR}resume/`;

/**
 * The rows of the delivered test files whose long byte runs the file counts differently (#2515,
 * `RowMeasure.runs`), outside the checks stage (#2543): on resume of a run blocked
 * `invalid_output` and at the start of a task's session. R82 tinyflate deflate 82f19908 blocked at
 * T007 on `tests/deflate_match_test.c` (303 bytes of `78` for the row's 300, 238 of `71` for 259);
 * resumed after #2515 and #2522 it blocked again within a minute, because both run only at the
 * checks stage, which a run blocked at a task never reaches. The sites are `rowRestorePlan`'s for
 * those rows only (the restore of #2522, its decision unchanged), so the replay of the record
 * reads them as the checks stage's. `paths` limits the files (all the graph writes when absent).
 * Each result carries the run drifts its file has, restored or not, for the brief.
 */
export function rowRunRestores(
  request: string,
  graph: Pick<TaskGraph, "tasks">,
  read: (path: string) => string | null,
  mode: RowRestoreRecord["mode"],
  paths?: readonly string[],
): { record: RowRestoreRecord; before: string; after: string; drifts: RowBlockDrift[] }[] {
  const plain = (path: string) => path.trim().replace(/^(?:\.\/)+/, "");
  const wanted = paths?.map(plain);
  // Only the wanted files are read and compared: this runs before every task's session.
  const scoped = wanted
    ? {
        tasks: graph.tasks.map((t) => ({
          ...t,
          writes: t.writes.filter((w) => wanted.includes(plain(w.path))),
        })),
      }
    : graph;
  const compared = rowBlockDrifts(request, scoped, read).filter((c) => c.record.delivered);
  const runs = compared.flatMap((c) => {
    const drifts = c.drifts.filter((d) => d.runs.length);
    return drifts.length ? [{ path: c.record.path, tasks: c.record.tasks, drifts }] : [];
  });
  if (!runs.length) return [];
  const blocks = suppliedRows(
    request,
    runs.map((r) => r.path),
  );
  return runs.flatMap(({ path, tasks, drifts }) => {
    const block = blocks.get(path);
    const before = read(path);
    if (!block || before === null) return [];
    const rows = new Set(drifts.map((d) => d.row));
    const plan = rowRestorePlan(block.lines, before, (sites) =>
      rowRestoreDecision(sites.filter((s) => rows.has(s.row))),
    );
    const sites = plan.sites.filter((s) => rows.has(s.row));
    const verdict = !plan.restore.length
      ? "declined"
      : mode === "on"
        ? "restored"
        : "would_restore";
    return [
      {
        record: {
          schemaVersion: 1,
          path,
          tasks,
          mode,
          sites,
          restore: plan.restore,
          verdict,
          checks: null,
          file: hashBytes(before),
        },
        before,
        after: plan.after,
        drifts,
      },
    ];
  });
}

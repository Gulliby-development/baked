import { verbatimHeld } from "../verification/criteria-cases.js";
import type { TaskGraph } from "./schemas.js";
import { suppliedRows } from "./sizing.js";

/**
 * Delivered test files compared with the rows the request prescribes for them (#2486). The case
 * walk demands only the literals a criterion cites, and the prescribed row blocks were read only
 * for pricing (`suppliedRows`, #2455) and row slices (#2466), so a literal of a row no criterion
 * cites could be changed or dropped and the task was accepted. Bench round 80: deltaglue cli T010
 * transcribed row 2 of `tests/problems-choices-b.test.ts` without the input's final
 * `data: [DONE]\n\n` event and then changed the expected output to match its own program (152 of
 * 153 rows delivered identical); ratdec core T014 rewrote row 9 of `test/stdin_test.exs` to expect
 * an error the brief never names. Both were accepted.
 *
 * At the checks stage, for each test file the run's plan writes and the request gives a row block
 * for (`suppliedRows`, the one reader of row blocks), every quoted literal of every row is decoded
 * and looked up in the delivered file (`verbatimHeld`: both sides decoded until no escape layer is
 * left, adjacent strings joined, a heredoc's lines trimmed). A row with a literal the file lacks
 * drifts. It runs at the checks stage, not at task end, because a row file split into row slices
 * (#2466) is whole only after its last slice. A literal is looked up in the whole file, so a
 * literal another row also holds is not missed; an empty literal (`""`) says nothing.
 *
 * The `row_block_drift` reason records each drifting row as a would-stop (shadow), and
 * `row-blocks/<path>.json` records the counts its decision reads (no text) for the replay.
 */

export const ROW_BLOCK_KIND = "row-block";
export const ROW_BLOCK_DIR = "row-blocks/";

/** One prescribed row against the delivered file: counts only, as the trace keeps them. */
export interface RowMeasure {
  /** The row's place in the request's block(s) for the file, from 1. */
  row: number;
  /** Its quoted literals that say something (not empty). */
  literals: number;
  /** Which of them (from 1) the delivered file does not hold. */
  missing: number[];
}

export interface RowBlockRecord {
  schemaVersion: 1;
  path: string;
  /** The planned and corrective tasks that write the file. */
  tasks: string[];
  mode: "shadow" | "advisory" | "enforce";
  /** Whether the file was there to compare; a missing file records no rows. */
  delivered: boolean;
  rows: RowMeasure[];
  /** The rows (from 1) the decision says drift. */
  drifting: number[];
}

/** The rows that drift: those with a literal the delivered file does not hold. */
export type RowBlockRule = (rows: readonly RowMeasure[]) => number[];
export function rowBlockDecision(rows: readonly RowMeasure[]): number[] {
  return rows.flatMap((r) => (r.missing.length ? [r.row] : []));
}

export interface RowBlockDrift {
  path: string;
  tasks: string[];
  row: number;
  /** The row as the request gives it, cut to `EXCERPT` characters. */
  text: string;
  /** Each literal the file lacks, from 1, as the request spells it (cut). */
  missing: { literal: number; text: string }[];
}

const EXCERPT = 200;
const cut = (text: string) => (text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text);

/**
 * The quoted literals of a row line, as the row spells them (escapes not decoded): double-quoted
 * strings in every notation (Elixir `row(["eval"], "7/3\n", 0, "2 1/3\n", "")`, TypeScript object
 * rows, Go table rows, bats `run` lines), and single-quoted ones not inside a word (`it's` is no
 * quote). A backslash escapes the next character in both.
 */
export function rowLiterals(line: string): string[] {
  return [...line.matchAll(/"((?:\\.|[^"\\])*)"|(?<![\p{L}\p{N}_])'((?:\\.|[^'\\])*)'/gu)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

/** A `<name>` placeholder of a row: text the test chooses (a temporary directory). */
const PLACEHOLDER = /<[^<>\s][^<>]*>/g;

/** Whether `file` holds a row literal: every part between its placeholders, verbatim. */
function literalHeld(file: string, literal: string): boolean {
  return literal
    .split(PLACEHOLDER)
    .filter((part) => part.trim())
    .every((part) => verbatimHeld(file, part));
}

/** A literal that says something: not empty and not only spaces once decoded. */
const meaningful = (literal: string) => literal.replace(/\\[nrt]|\s/g, "") !== "";

/** Each prescribed row of `rows` against a delivered file's text. */
export function measureRows(rows: readonly string[], file: string): RowMeasure[] {
  return rows.map((line, index) => {
    const literals = rowLiterals(line).filter(meaningful);
    const missing = literals.flatMap((literal, i) => (literalHeld(file, literal) ? [] : [i + 1]));
    return { row: index + 1, literals: literals.length, missing };
  });
}

const plainPath = (path: string) => path.trim().replace(/^(?:\.\/)+/, "");

/**
 * For each test file the graph writes and the request prescribes rows for, its record and the
 * drifting rows, the file read through `read` (null: not there, which records no rows).
 */
export function rowBlockDrifts(
  request: string,
  graph: Pick<TaskGraph, "tasks">,
  read: (path: string) => string | null,
  mode: RowBlockRecord["mode"] = "shadow",
  decide: RowBlockRule = rowBlockDecision,
): { record: RowBlockRecord; drifts: RowBlockDrift[] }[] {
  const writers = new Map<string, string[]>();
  for (const task of graph.tasks)
    for (const write of task.writes) {
      if (write.action === "delete") continue;
      const path = plainPath(write.path);
      const ids = writers.get(path) ?? [];
      if (!ids.includes(task.id)) writers.set(path, [...ids, task.id]);
    }
  if (!writers.size) return [];
  const out: { record: RowBlockRecord; drifts: RowBlockDrift[] }[] = [];
  for (const [path, block] of suppliedRows(request, [...writers.keys()])) {
    const tasks = writers.get(path) ?? [];
    const file = read(path);
    const rows = file === null ? [] : measureRows(block.lines, file);
    const drifting = decide(rows);
    const record: RowBlockRecord = {
      schemaVersion: 1,
      path,
      tasks,
      mode,
      delivered: file !== null,
      rows,
      drifting,
    };
    const drifts = drifting.flatMap((n) => {
      const measure = rows[n - 1];
      const line = block.lines[n - 1];
      if (!measure || line === undefined) return [];
      const literals = rowLiterals(line).filter(meaningful);
      return [
        {
          path,
          tasks,
          row: n,
          text: cut(line),
          missing: measure.missing.map((i) => ({ literal: i, text: cut(literals[i - 1] ?? "") })),
        },
      ];
    });
    out.push({ record, drifts });
  }
  return out;
}

/** A drifting row in the words a stop would use. */
export function rowBlockDriftSummary(drift: RowBlockDrift): string {
  const lacks = drift.missing.map((m) => `"${m.text}"`).join(", ");
  const by = drift.tasks.length ? `${drift.tasks.join(", ")} delivered ` : "";
  return `${by}${drift.path} without row ${drift.row} of the request's row block as given: the file lacks ${lacks} (row: ${drift.text}). A repair task would restore the row from the request's text; the prescribed row wins over a test this run wrote.`;
}

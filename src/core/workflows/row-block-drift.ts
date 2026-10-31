import { type RunDiff, runDiffText, runLengthCompare } from "../verification/byte-runs.js";
import { verbatimHeld } from "../verification/criteria-cases.js";
import type { Review, TaskGraph } from "./schemas.js";
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
 * The comparison also reads the file's rows back against the block (#2503): a row the request does
 * not prescribe was invisible to it. Bench round 81: ratdec exact-cli T011 added
 * `row(["eval", "--as", "frac", "7/3"], "", 0, "7/3\n", "")` to `test/cli_test.exs` as a 14th row
 * of 13 prescribed (to satisfy a criterion case), every prescribed row was held, nothing was
 * recorded, and the review's `prescribed-row-count` corrective cost 368,154 tokens to remove one
 * line. A row of the file is a line that starts with the head of a line that matches a prescribed
 * row (`row(`, `assert_row(`, `{`, `(`), with the lines that continue its strings; it matches a
 * prescribed row when the row holds every literal of it and either each of its literals is one of
 * the row's or it holds every literal of the row. A file row that matches none and does not take
 * the place of a prescribed row nothing matches (a changed row, which `missing` already names) is
 * `added`; a second file row for a prescribed row is `duplicated`; a file row before one for a
 * later prescribed row is `reordered`. A test whose rows are not one per line (a bats `@test` per
 * row, Java `@CsvSource` strings) has no head that matches, and records no file rows.
 *
 * A long byte run of a row (a hex string, a byte list, a repeat expression) is compared by its
 * count (#2515, `runLengthCompare` in byte-runs.ts, the one comparison the literal lookup, the
 * case walk and `misquotation` share). Bench round 82: tinyflate deflate T007 wrote
 * `tests/deflate_match_test.c` with 303 bytes of `0x78` for a row's 300 and 238 bytes of `0x71`
 * for another's 259; 300 bytes read verbatim are held inside 303, so nothing was recorded, the
 * failing check read as a source failure and every corrective rewrote a correct `src/deflate.c`.
 * A row whose run the file counts differently drifts with the file line, the byte and both
 * counts (`RowMeasure.runs`), and a failing check of the same checks stage says so in its
 * corrective (`rowRunFindings`): "the test's input literal differs from the criterion row by N
 * bytes". With the policy field `rowRunRoute: "on"` the correction goes to the test's task only;
 * absent, the route is recorded (`row-runs/<check>.json`) and the findings keep their files.
 *
 * The `row_block_drift` reason records each drifting row, and each added or duplicated row, as a
 * would-stop (shadow); a reordered row is only recorded. `row-blocks/<path>.json` records the
 * counts its decisions read (no text) for the replay.
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
  /**
   * Its long byte runs the file counts differently (#2515): the file line, the byte and both
   * counts; absent when there is none (and in records before it).
   */
  runs?: RowRunMeasure[];
}

/** A long run of a prescribed row that a file line counts differently (#2515). */
export interface RowRunMeasure extends RunDiff {
  /** The file line, from 1. */
  line: number;
}

/** One row of the delivered file against the block (#2503): counts only, as the trace keeps them. */
export interface FileRowMeasure {
  /** The file line the row starts on, from 1. */
  line: number;
  /** Its quoted literals that say something (not empty). */
  literals: number;
  /** The prescribed rows (from 1) it matches; empty when it matches none. */
  matches: number[];
  /** The prescribed row nothing matches whose place it takes (a changed row), or null. */
  replaces: number | null;
}

/** File rows (their lines, from 1) beyond the block: the would-stop kinds `added`, `duplicated`. */
export interface RowMoves {
  /** Rows that match no prescribed row and take the place of none. */
  added: number[];
  /** Rows for a prescribed row an earlier file row already holds. */
  duplicated: number[];
  /** Rows for a prescribed row before one an earlier file row holds (recorded, no would-stop). */
  reordered: number[];
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
  /** The file's rows against the block (#2503); absent in records before it. */
  fileRows?: FileRowMeasure[];
  /** The file rows the move decision places beyond the block (#2503); absent before it. */
  moves?: RowMoves;
}

/**
 * The rows that drift: those with a literal the delivered file does not hold, or a long byte run
 * it counts differently (#2515).
 */
export type RowBlockRule = (rows: readonly RowMeasure[]) => number[];
export function rowBlockDecision(rows: readonly RowMeasure[]): number[] {
  return rows.flatMap((r) => (r.missing.length || r.runs?.length ? [r.row] : []));
}

/** Places each file row: unmatched (added unless it replaces a row), repeated, or out of order. */
export type RowMoveRule = (fileRows: readonly FileRowMeasure[]) => RowMoves;
export function rowMoveDecision(fileRows: readonly FileRowMeasure[]): RowMoves {
  const moves: RowMoves = { added: [], duplicated: [], reordered: [] };
  const held = new Set<number>();
  let last = 0;
  for (const fileRow of fileRows) {
    if (!fileRow.matches.length) {
      if (fileRow.replaces === null) moves.added.push(fileRow.line);
      continue;
    }
    const row = fileRow.matches.find((n) => !held.has(n));
    if (row === undefined) {
      moves.duplicated.push(fileRow.line);
      continue;
    }
    held.add(row);
    if (row < last) moves.reordered.push(fileRow.line);
    last = Math.max(last, row);
  }
  return moves;
}

export interface RowBlockDrift {
  path: string;
  tasks: string[];
  row: number;
  /** The row as the request gives it, cut to `EXCERPT` characters. */
  text: string;
  /** Each literal the file lacks, from 1, as the request spells it (cut). */
  missing: { literal: number; text: string }[];
  /** Each long byte run the file counts differently (#2515), by the bytes it is off. */
  runs: RowRunDrift[];
}

/** A long byte run of a row the file counts differently (#2515). */
export interface RowRunDrift {
  /** The file line, from 1. */
  line: number;
  /** How many bytes the file's literal differs from the row by. */
  bytes: number;
  diffs: RunDiff[];
}

/** A file row beyond the block (#2503): added, or a second copy of a prescribed row. */
export interface RowBlockExtra {
  path: string;
  tasks: string[];
  kind: "added" | "duplicated";
  /** The file line the row starts on, from 1. */
  line: number;
  /** The row as the file spells it, cut to `EXCERPT` characters. */
  text: string;
  /** The prescribed row it repeats (`duplicated`), or null. */
  row: number | null;
  /** How many rows the request prescribes for the file. */
  prescribed: number;
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
    const runs = rowRuns(line, file).flatMap((d) =>
      d.diffs.map((diff) => ({ line: d.line, ...diff })),
    );
    return { row: index + 1, literals: literals.length, missing, ...(runs.length ? { runs } : {}) };
  });
}

/** The long byte runs of a prescribed row the file counts differently (#2515). */
function rowRuns(line: string, file: string): RowRunDrift[] {
  return (runLengthCompare(file, line)?.drifts ?? []).map((d) => ({
    line: d.line,
    bytes: d.bytes,
    diffs: d.diffs,
  }));
}

/** A row of the delivered file: its first line, its head and its text with continued strings. */
interface FileRow {
  line: number;
  head: string;
  text: string;
}

/**
 * A line's head: its first token up to and including its first bracket (`row(`, `assert_row(`,
 * `{`, `(`), or its first word (`run`); empty for a line that starts with a quote.
 */
export function rowHead(line: string): string {
  return /^\s*([^\s"'`([{]*[([{]?)/.exec(line)?.[1] ?? "";
}

/** A line that continues the previous line's strings: a quote or a concatenation operator first. */
export const CONTINUES = /^\s*(?:["']|\+|<>|\.\.)/;

/** The delivered file as rows: each line with a head, with the lines that continue its strings. */
function fileRowsOf(file: string): FileRow[] {
  const out: FileRow[] = [];
  let open: FileRow | null = null;
  for (const [i, text] of file.split(/\r?\n/).entries()) {
    if (open && CONTINUES.test(text)) {
      open.text += `\n${text}`;
      continue;
    }
    const head = rowHead(text);
    open = head ? { line: i + 1, head, text } : null;
    if (open) out.push(open);
  }
  return out;
}

const meaningfulLiterals = (text: string) => rowLiterals(text).filter(meaningful);
const sameLiteral = (a: string, b: string) => verbatimHeld(a, b) && verbatimHeld(b, a);

/**
 * How a file row stands to a prescribed row: `exact` when the row holds every literal of the file
 * row and the file row holds every literal of the row; `loose` when the row holds them and each is
 * one of the row's (a heredoc whose lines follow); null otherwise.
 */
function rowMatch(
  fileRow: FileRow,
  literals: readonly string[],
  line: string,
): "exact" | "loose" | null {
  const own = meaningfulLiterals(line);
  if (!literals.length || !own.length) return null;
  // A literal of the file the row holds, or one a `<name>` literal of the row stands for.
  const inRow = (literal: string) =>
    verbatimHeld(line, literal) ||
    own.some((o) => new RegExp(PLACEHOLDER.source).test(o) && literalHeld(literal, o));
  if (!literals.every(inRow)) return null;
  if (own.every((literal) => literalHeld(fileRow.text, literal))) return "exact";
  return literals.every((literal) => own.some((o) => sameLiteral(literal, o))) ? "loose" : null;
}

/**
 * The delivered file's rows against the prescribed `rows` (#2503): the rows of the file whose head
 * is the head of a file row that matches a prescribed row with two literals or more, each with the
 * prescribed rows it matches (exact matches first, else loose ones). A file row that matches none
 * takes the place of a prescribed row nothing holds when it shares the most literals with it.
 */
export function measureFileRows(rows: readonly string[], file: string): FileRowMeasure[] {
  const all = fileRowsOf(file).map((fileRow) => {
    const literals = meaningfulLiterals(fileRow.text);
    const exact: number[] = [];
    const loose: number[] = [];
    rows.forEach((line, index) => {
      const match = rowMatch(fileRow, literals, line);
      if (match === "exact") exact.push(index + 1);
      else if (match === "loose") loose.push(index + 1);
    });
    return { fileRow, literals, matches: exact.length ? exact : loose };
  });
  const heads = new Set(
    all.filter((r) => r.matches.length && r.literals.length >= 2).map((r) => r.fileRow.head),
  );
  const kept = all.filter((r) => heads.has(r.fileRow.head) && r.literals.length);
  const measures: FileRowMeasure[] = kept.map((r) => ({
    line: r.fileRow.line,
    literals: r.literals.length,
    matches: r.matches,
    replaces: null,
  }));
  // The prescribed rows no file row holds, each paired with the unmatched file row that shares the
  // most of its literals (a row changed in place, which `missing` names).
  const held = new Set<number>();
  for (const m of measures) {
    const row = m.matches.find((n) => !held.has(n));
    if (row !== undefined) held.add(row);
  }
  rows.forEach((line, index) => {
    if (held.has(index + 1)) return;
    const own = meaningfulLiterals(line);
    let best: { at: number; shared: number } | null = null;
    for (const [at, r] of kept.entries()) {
      const measure = measures[at];
      if (!measure || measure.matches.length || measure.replaces !== null) continue;
      const shared = r.literals.filter((l) => own.some((o) => sameLiteral(l, o))).length;
      if (shared && (!best || shared > best.shared)) best = { at, shared };
    }
    const paired = best ? measures[best.at] : undefined;
    if (paired) paired.replaces = index + 1;
  });
  return measures;
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
  move: RowMoveRule = rowMoveDecision,
): { record: RowBlockRecord; drifts: RowBlockDrift[]; extras: RowBlockExtra[] }[] {
  const writers = new Map<string, string[]>();
  for (const task of graph.tasks)
    for (const write of task.writes) {
      if (write.action === "delete") continue;
      const path = plainPath(write.path);
      const ids = writers.get(path) ?? [];
      if (!ids.includes(task.id)) writers.set(path, [...ids, task.id]);
    }
  if (!writers.size) return [];
  const out: { record: RowBlockRecord; drifts: RowBlockDrift[]; extras: RowBlockExtra[] }[] = [];
  for (const [path, block] of suppliedRows(request, [...writers.keys()])) {
    const tasks = writers.get(path) ?? [];
    const file = read(path);
    const rows = file === null ? [] : measureRows(block.lines, file);
    const drifting = decide(rows);
    const fileRows = file === null ? [] : measureFileRows(block.lines, file);
    const moves = move(fileRows);
    const record: RowBlockRecord = {
      schemaVersion: 1,
      path,
      tasks,
      mode,
      delivered: file !== null,
      rows,
      drifting,
      fileRows,
      moves,
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
          runs: file === null ? [] : rowRuns(line, file),
        },
      ];
    });
    const lines = file?.split(/\r?\n/) ?? [];
    const extra = (kind: RowBlockExtra["kind"], line: number): RowBlockExtra => ({
      path,
      tasks,
      kind,
      line,
      text: cut((lines[line - 1] ?? "").trim()),
      row:
        kind === "duplicated" ? (fileRows.find((r) => r.line === line)?.matches[0] ?? null) : null,
      prescribed: block.lines.length,
    });
    const extras = [
      ...moves.added.map((line) => extra("added", line)),
      ...moves.duplicated.map((line) => extra("duplicated", line)),
    ];
    out.push({ record, drifts, extras });
  }
  return out;
}

/** A drifting row in the words a stop would use. */
export function rowBlockDriftSummary(drift: RowBlockDrift): string {
  const lacks = drift.missing.map((m) => `"${m.text}"`).join(", ");
  const by = drift.tasks.length ? `${drift.tasks.join(", ")} delivered ` : "";
  const what = lacks ? `the file lacks ${lacks}` : "";
  const runs = rowRunText(drift);
  const why = [what, runs].filter(Boolean).join("; ");
  return `${by}${drift.path} without row ${drift.row} of the request's row block as given: ${why} (row: ${drift.text}). A repair task would restore the row from the request's text; the prescribed row wins over a test this run wrote.`;
}

/**
 * A row's long runs the file counts differently, plainly (#2515): `the test's input literal
 * differs from the criterion row by 3 bytes (tests/deflate_match_test.c line 11: 303 bytes of
 * 0x78 where row 1 of the request's row block gives 300)`. Empty when there is none.
 */
export function rowRunText(drift: Pick<RowBlockDrift, "path" | "row" | "runs">): string {
  return drift.runs
    .map(
      (r) =>
        `the test's input literal differs from the criterion row by ${r.bytes} byte${r.bytes === 1 ? "" : "s"} (${drift.path} line ${r.line}: ${r.diffs.map((d) => runDiffText(d, `row ${drift.row} of the request's row block`)).join(", ")})`,
    )
    .join("; ");
}

export const ROW_RUN_KIND = "row-run-route";
export const ROW_RUN_DIR = "row-runs/";

/** What `row-runs/<check>.json` records: a failing check's route with run drifts (#2515), no text. */
export interface RowRunRouteRecord {
  schemaVersion: 1;
  checkId: string;
  /** `shadow`: recorded, the findings keep their files; `on`: the test's task corrects. */
  mode: "shadow" | "on";
  /** The test files with a run drift, and the tasks that write them. */
  tests: string[];
  tasks: string[];
  /** Each drift's bytes off, in order. */
  bytes: number[];
  /** The files of the check's findings as built, and those the route gives them (or would). */
  before: (string | null)[];
  after: (string | null)[];
}

/**
 * A failing check's findings when the same checks stage found a long run of a prescribed row
 * counted differently in a test file (#2515). Every finding's corrective says so first, in plain
 * words with the line and the byte (it only adds what the host knows). With `route` (the policy
 * field `rowRunRoute: "on"`), the findings go to the drifting test files only, each from the task
 * that writes it, and the source findings are dropped; without it the route is only recorded.
 * Null record when no drift has a run.
 */
export function rowRunFindings(
  checkId: string,
  findings: Review["findings"],
  drifts: readonly RowBlockDrift[],
  tasks: readonly Pick<
    TaskGraph["tasks"][number],
    "id" | "writes" | "requirementIds" | "criterionIds"
  >[],
  route: boolean,
  newId: () => string,
): { findings: Review["findings"]; record: RowRunRouteRecord | null } {
  const runs = drifts.filter((d) => d.runs.length);
  const [template] = findings;
  if (!runs.length || !template) return { findings, record: null };
  const said = runs.map(rowRunText).join("; ");
  const note = `${said.charAt(0).toUpperCase()}${said.slice(1)}. Correct the test's literal to the row as the request gives it; the source is not what differs.`;
  const tests = [...new Set(runs.map((d) => d.path))];
  const routed: Review["findings"] = route
    ? tests.map((path) => {
        const own = findings.find((f) => f.file === path);
        const owner = tasks.find((t) => t.writes.some((w) => plainPath(w.path) === path));
        return {
          ...(own ?? template),
          id: own?.id ?? newId(),
          file: path,
          ...(owner
            ? { requirementIds: owner.requirementIds, criterionIds: owner.criterionIds }
            : {}),
          suggestedFix: `${note} Edit ${path} only; the other rows and the source stay as written.`,
        };
      })
    : findings.map((f) => ({ ...f, suggestedFix: `${note} ${f.suggestedFix}` }));
  return {
    findings: routed,
    record: {
      schemaVersion: 1,
      checkId,
      mode: route ? "on" : "shadow",
      tests,
      tasks: [...new Set(runs.flatMap((d) => d.tasks))],
      bytes: runs.flatMap((d) => d.runs.map((r) => r.bytes)),
      before: findings.map((f) => f.file),
      after: tests,
    },
  };
}

/** A file row beyond the block in the words a stop would use (#2503). */
export function rowBlockExtraSummary(extra: RowBlockExtra): string {
  const by = extra.tasks.length ? `${extra.tasks.join(", ")} delivered ` : "";
  const what =
    extra.kind === "duplicated"
      ? `row ${extra.row} of the request's row block a second time`
      : "a row the request's row block does not prescribe";
  return `${by}${extra.path} with ${what} (line ${extra.line}: ${extra.text}); the block prescribes ${extra.prescribed} rows. A repair would remove the line; the prescribed rows win over a row this run added.`;
}

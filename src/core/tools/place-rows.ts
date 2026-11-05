import { z } from "zod";
import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { formatRowList, framedFeatureRows } from "../workflows/feature-rows.js";
import { rowNotation } from "../workflows/row-block-drift.js";
import { ROW_FILE_SHAPES } from "../workflows/row-file.js";
import { restoredLine } from "../workflows/row-restore.js";
import { suppliedRows } from "../workflows/sizing.js";
import type { Task } from "../workflows/types.js";

/**
 * `place_rows`, a workflow implementer's tool beside `edit_file` and `multi_edit` (#2564): it
 * inserts the request's prescribed rows n to m verbatim after a line of an existing file, so a
 * session never retypes a row. The host's own write of a row file (`rowFilePlan`, #2528) needs a
 * `ROW_FILE_SHAPES` row per language; until a language has one, a session transcribed the rows
 * through its edit tool, where every backslash passes through the model's JSON. Bench round 83:
 * pnmforge (C++) `cli` T004 spent 2.74M tokens on nine rows (the two usage rows through four
 * escape layers), bytemerge (Java) `model` T003 failed `verify-written` on a row one escape layer
 * off; the row tasks were 39 and 29 percent of the two initiatives' tokens.
 *
 * The rows come from `suppliedRows` only, and each line from `restoredLine` (the indentation and
 * separator of a template line): the tool never parses a row, so a new language needs no entry.
 * It is offered with the policy's `rowFileWrite: "on"` to an implementer whose task writes a file
 * the request prescribes rows for (`placeRowTargets`); in shadow `place-rows/<task>.json` records
 * what would have been offered. A language with a `ROW_FILE_SHAPES` row keeps the host's write
 * first: a session opens for its file only when that write declines.
 *
 * It places only rows the request already writes in the file language's code (#2583). A row in
 * the request's own notation (`run "cols" "3" stdin="…" => 0 "…" ""`, `rowNotation`) is a line no
 * test framework parses: R84 wrapsmith T002 got such rows placed into a Pester file, Pester failed
 * to parse it, and the run stuck. Such a row is refused with the change to make (write it as the
 * framework's call with edit_file), and a task whose rows are all notation is not offered the tool.
 */

export const PLACE_ROWS = "place_rows";
export const PLACE_ROWS_KIND = "place-rows";
export const PLACE_ROWS_DIR = "place-rows/";

/** The files of `task` the request prescribes rows for, each with its rows (`suppliedRows`). */
export function placeRowTargets(
  request: string,
  task: Pick<Task, "writes">,
): Map<string, readonly string[]> {
  const paths = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
  const blocks = suppliedRows(request, paths);
  return new Map(
    paths.flatMap((path) => {
      const block = blocks.get(path);
      return block ? [[path, block.lines] as [string, readonly string[]]] : [];
    }),
  );
}

/**
 * The request's number (from 1, in its block) of each target row, for the files whose rows a
 * feature's run holds only some of (#2939 follow-up): `suppliedRows` keeps the rows the feature
 * prompt states under `FEATURE_ROWS_HEADING`, in block order, and the prompt names them by the
 * block's numbers (`rows 5, 8 of 8`), so the tool takes and names those numbers too. A file the
 * framing does not name holds the whole block, rows 1 to n, and is absent.
 */
export function placeRowNumbers(
  request: string,
  targets: ReadonlyMap<string, readonly string[]>,
): Map<string, number[]> {
  const framed = framedFeatureRows(request);
  const out = new Map<string, number[]>();
  for (const [path, rows] of targets) {
    const numbers = [...(framed?.get(path) ?? [])].sort((a, b) => a - b);
    if (numbers.length === rows.length && numbers.some((n, i) => n !== i + 1))
      out.set(path, numbers);
  }
  return out;
}

/** The request's numbers of a target's rows: `placeRowNumbers`', else 1 to n. */
function numbersOf(
  numbers: ReadonlyMap<string, readonly number[]>,
  path: string,
  rows: readonly string[],
): readonly number[] {
  const given = numbers.get(path);
  return given?.length === rows.length ? given : rows.map((_, i) => i + 1);
}

/** A list of row numbers as the tool names it: `1 to 9`, or `5, 8` when it has gaps. */
export function rowsText(numbers: readonly number[]): string {
  const first = numbers[0] ?? 1;
  const last = numbers.at(-1) ?? first;
  return last - first + 1 === numbers.length ? `${first} to ${last}` : formatRowList(numbers);
}

/**
 * The indentation the request writes each target's rows with (`SuppliedRows.indent`, #2618), for
 * the files of `task` whose row block is indented past its header.
 */
export function placeRowIndents(request: string, task: Pick<Task, "writes">): Map<string, string> {
  const paths = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
  const blocks = suppliedRows(request, paths);
  return new Map(
    paths.flatMap((path) => {
      const indent = blocks.get(path)?.indent;
      return indent ? [[path, indent] as [string, string]] : [];
    }),
  );
}

/**
 * The indentation one level of a row list takes in each language's formatter convention (#2618):
 * the default of `place_rows` after a line that opens the list, when neither the request's rows
 * nor the file show one. Bench round 85 csp (ReScript) `cli` T004 got eight rows with four spaces
 * from the old fixed fallback against a request that wrote them with two; the corrective session
 * cost 574k tokens. A `none` row falls back to four spaces.
 */
export const ROW_INDENT: LanguageRecord<string> = {
  typescript: "  ",
  javascript: "  ",
  python: "    ",
  go: "\t",
  rust: "    ",
  java: "    ",
  kotlin: "    ",
  scala: "  ",
  csharp: "    ",
  c: none("clang-format styles differ (LLVM two spaces, others four or tabs)"),
  cpp: none("clang-format styles differ (LLVM two spaces, others four or tabs)"),
  ruby: "  ",
  php: "    ",
  swift: "    ",
  lua: none("StyLua indents with tabs, many projects with two spaces"),
  elixir: "  ",
  dart: "  ",
  zig: "    ",
  bash: "  ",
  ocaml: "  ",
  objc: none("clang-format styles differ (LLVM two spaces, Xcode four)"),
  vue: none("a component's rows are tested from a TypeScript or JavaScript test file"),
  svelte: none("a component's rows are tested from a TypeScript or JavaScript test file"),
  rescript: "  ",
  solidity: "    ",
  sql: none("an SQL test file holds no row list to place rows into"),
  powershell: "    ",
  r: "  ",
};

/**
 * The targets by the form of their rows (#2583): `code`, the files with a row place_rows can insert
 * (written in the file language's code); `notation`, each file's rows (by the request's numbers,
 * `placeRowNumbers`) in the request's own notation, which only the session can write, as the test
 * framework's call.
 */
export function placeRowForms(
  targets: ReadonlyMap<string, readonly string[]>,
  numbers: ReadonlyMap<string, readonly number[]> = new Map(),
): {
  code: Map<string, readonly string[]>;
  notation: Map<string, number[]>;
} {
  const code = new Map<string, readonly string[]>();
  const notation = new Map<string, number[]>();
  for (const [path, rows] of targets) {
    const named = numbersOf(numbers, path, rows);
    const own = rows.flatMap((row, i) => (rowNotation(row) ? [named[i] ?? i + 1] : []));
    if (own.length) notation.set(path, own);
    if (own.length < rows.length) code.set(path, rows);
  }
  return { code, notation };
}

/** What a task was (or, in shadow, would have been) offered, once per task. */
export interface PlaceRowsRecord {
  schemaVersion: 1;
  taskId: string;
  /** `on` with `rowFileWrite: "on"`, otherwise `shadow`. */
  mode: "on" | "shadow";
  /**
   * Whether the session got the tool: false in shadow (the would-record), and when every target
   * row is in the request's notation (#2583).
   */
  offered: boolean;
  /**
   * Each target file, its prescribed row count, whether its language has a row shape, and how many
   * of its rows are in the request's notation (#2583; absent when none), which the tool refuses.
   */
  files: { path: string; rows: number; shaped: boolean; notation?: number }[];
}

export function placeRowsRecord(
  taskId: string,
  targets: ReadonlyMap<string, readonly string[]>,
  on: boolean,
): PlaceRowsRecord {
  const { code, notation } = placeRowForms(targets);
  return {
    schemaVersion: 1,
    taskId,
    mode: on ? "on" : "shadow",
    offered: on && code.size > 0,
    files: [...targets].map(([path, rows]) => ({
      path,
      rows: rows.length,
      shaped: rowOf(ROW_FILE_SHAPES, detectLanguageFromPath(path)) !== null,
      ...(notation.get(path)?.length ? { notation: notation.get(path)?.length } : {}),
    })),
  };
}

/** The default indentation, as the description and the scheduler's note state it (#2618). */
export const INDENT_DEFAULT =
  "the line's own; after a line that opens the list, one level deeper, the level being the indentation of the request's own row lines, else the file's smallest indentation, else the language's convention (two spaces in TypeScript, JavaScript, Ruby, Scala, OCaml, R, Bash, Dart, Elixir and ReScript, a tab in Go, otherwise four spaces)";

/**
 * The default separator, as the description and the scheduler's note state it: a row the request
 * ends with `,` or `;` (a C statement row, a row copied with its comma) keeps it, and an explicit
 * `separator` or `lastSeparator` replaces it, so a placed line never ends in two (`...;,`).
 */
export const SEPARATOR_DEFAULT = "the row's own trailing comma or semicolon, else a comma";

export const placeRowsInput = z
  .object({
    path: z.string().describe("The task's prescribed row file, which must already exist."),
    line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "The file line (from 1) the rows go after; 0 puts them before the first line. Every insert moves the lines below it, so for a second call give after instead.",
      ),
    after: z
      .string()
      .min(1)
      .max(400)
      .optional()
      .describe(
        "The text of the line the rows go after, as the file holds it (surrounding whitespace ignored), such as the opening line of the list the rows belong in. It survives an earlier insert, unlike line; when the file holds it more than once, line picks the nearest.",
      ),
    rows: z
      .array(z.number().int())
      .min(1)
      .max(2)
      .describe("[first, last]: the request's rows to place, from 1, inclusive; [n] for one row."),
    indent: z
      .string()
      .regex(/^[ \t]*$/)
      .max(32)
      .optional()
      .describe(`The indentation of each row line; by default ${INDENT_DEFAULT}.`),
    reindent: z
      .boolean()
      .optional()
      .describe(
        "Re-indent rows [first, last] the file already holds (their lines equal the request's rows apart from leading whitespace) to indent, in place; line is not used. For a layout correction in one call.",
      ),
    move: z
      .boolean()
      .optional()
      .describe(
        "Move rows [first, last] the file already holds (each must be held) to after the given line (after or line, a line of the file as it is now and not one of the moved rows), in one write: they leave their lines and go there as a fresh placement writes them. For a correction of the rows' order or list; an edit_file that only deletes a held row is put back.",
      ),
    separator: z
      .enum([",", ";", ""])
      .optional()
      .describe(
        `What ends each row line, as the language lists rows, in place of the row's own; by default ${SEPARATOR_DEFAULT}.`,
      ),
    lastSeparator: z
      .enum([",", ";", ""])
      .optional()
      .describe(
        "What ends the last placed row's line, in place of the row's own, when the list takes no separator after its last item; by default the separator.",
      ),
  })
  .strict();
export type PlaceRowsInput = z.infer<typeof placeRowsInput>;

/**
 * How a held row changes place (#2955), as the description, the brief's note and the row guard's
 * answer state it: the guard judges each call alone, so a deletion alone is put back, and a move
 * is one call that leaves every prescribed row in the file.
 */
export const MOVE_NOTE =
  "To move rows the file already holds (another order, or another list of the file), call place_rows with move: true, rows [first, last] and the line they go after (after, or line): the rows leave their lines and go there in one write. An edit that only deletes a held row is put back.";

/** The tool's description for a task with these targets. */
export function placeRowsDescription(
  targets: ReadonlyMap<string, readonly string[]>,
  numbers: ReadonlyMap<string, readonly number[]> = new Map(),
): string {
  const files = [...targets]
    .map(([path, rows]) => `${path} (rows ${rowsText(numbersOf(numbers, path, rows))})`)
    .join(", ");
  return `Insert the request's prescribed rows verbatim into ${files}: rows [first, last] go after the given line of the existing file, one row per line, in the request's order, exactly as the request writes them. Never type a prescribed row with edit_file or multi_edit: write everything else (imports, the row type, the list's opening and close, the harness calls) with edit_file, leaving the rows out, then place them with this tool. Give indent and separator when the defaults do not fit the language or the request's layout: indent by default is ${INDENT_DEFAULT}; the separator that ends each row is by default ${SEPARATOR_DEFAULT}. A file with more than one list, or rows placed in more than one call: give after (the opening line of the list the rows belong in, such as \`static const std::vector<Row> totals = {\`) instead of line, since every insert moves the lines below it, or place the rows of the last list first. The result names the line the rows follow and the list that holds them, and shows the first placed line with its indentation; to fix the indentation of rows already placed, call again with reindent: true and the indent they take. ${MOVE_NOTE}`;
}

/**
 * The answer to rows in the request's notation (#2583): place_rows inserts only code, so the
 * session writes each such row itself as the test framework's call.
 */
export function notationRefusal(path: string, rows: readonly number[], example: string): string {
  const shown = example.length > 120 ? `${example.slice(0, 117)}...` : example;
  const which = rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.join(", ")}`;
  return `${path}: the request gives ${which} in its own notation (${shown}), not as code of the file's language, and no test framework parses that line. place_rows inserts only rows the request writes as code. Write ${rows.length === 1 ? "this row" : "these rows"} yourself with edit_file as the test framework's call, one test per row in the request's order, with the row's arguments, input, expected exit code and output, each string in the language's own quoting and escapes.`;
}

/** The leading whitespace one nesting level adds in `lines`: a tab, the smallest space run, or none. */
function indentUnit(lines: readonly string[]): string | undefined {
  let spaces = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (lead.startsWith("\t")) return "\t";
    if (lead.length && (!spaces || lead.length < spaces)) spaces = lead.length;
  }
  return spaces ? " ".repeat(spaces) : undefined;
}

/**
 * One level of `path`'s row list (#2618): the request's own row indentation, the file's smallest,
 * the language's `ROW_INDENT`, and four spaces only where the language states none.
 */
function levelOf(path: string, requested: string | undefined, lines: readonly string[]): string {
  return (
    requested ?? indentUnit(lines) ?? rowOf(ROW_INDENT, detectLanguageFromPath(path)) ?? "    "
  );
}

/** A row's text as a line holds it: trimmed, a trailing separator dropped. */
const bare = (text: string) => text.trim().replace(/[,;]$/, "").trimEnd();

/**
 * The file line (from 0, -1 when not held) that holds each of `rows`: a row the request gives more
 * than once takes the next equal line after the ones its earlier copies take, so a duplicate counts
 * as held only when the file holds it as often.
 */
function heldLines(rows: readonly string[], lines: readonly string[]): number[] {
  const taken = new Map<string, number[]>();
  for (const [i, line] of lines.entries()) {
    const text = bare(line);
    if (!text) continue;
    const at = taken.get(text);
    if (at) at.push(i);
    else taken.set(text, [i]);
  }
  const used = new Map<string, number>();
  return rows.map((row) => {
    const want = bare(row);
    const k = used.get(want) ?? 0;
    used.set(want, k + 1);
    return taken.get(want)?.[k] ?? -1;
  });
}

/** A line that opens a row list: `= {`, `List.of(`, `ROWS = [`. */
const OPENS_LIST = /[[({=]$/;

/**
 * The line (from 1, 0 before the first line) the rows go after (#2956): the line whose text is
 * `input.after`, else `input.line`, or why neither names one. An absolute line moves with every
 * insert above it: R102 tailcut filters T002 placed a two-list C++ file in two calls, computed the
 * second list's line before the first insert, and put its rows inside the first list. A quoted
 * line survives the insert; when the file holds it more than once, `line` picks the nearest.
 */
export function anchorLine(
  input: Pick<PlaceRowsInput, "line" | "after">,
  lines: readonly string[],
): number | string {
  if (input.after === undefined) {
    if (input.line === undefined)
      return "give the line the rows go after: after with its text (such as the list's opening line), or line with its number.";
    return input.line;
  }
  const want = input.after.trim();
  const matches = lines.flatMap((line, i) => (line.trim() === want ? [i + 1] : []));
  if (!matches.length)
    return `no line reads ${JSON.stringify(want)}. Give after as the whole text of one line of the file (such as the list's opening line), or line with its number.`;
  if (matches.length === 1) return matches[0] as number;
  const near = input.line;
  if (near === undefined)
    return `lines ${matches.join(", ")} all read ${JSON.stringify(want)}. Give line too, and the nearest of them is used.`;
  return matches.reduce((best, m) => (Math.abs(m - near) < Math.abs(best - near) ? m : best));
}

/**
 * The nearest line above line `at` (from 0) that opens a list, from 1 with its text (#2956); none
 * when a list's close comes first.
 */
function listOf(lines: readonly string[], at: number): { list?: { line: number; text: string } } {
  for (let i = at - 1; i >= 0; i--) {
    const text = (lines[i] ?? "").replace(/\r$/, "");
    if (OPENS_LIST.test(text.trimEnd())) return { list: { line: i + 1, text: text.trim() } };
    // A list's close (`};`, `]`, `)`): the rows are after that list, in none above it.
    if (/^[\])}]/.test(text.trim())) return {};
  }
  return {};
}

/**
 * The file with rows `input.rows` of `rows` placed after `input.line`, or the refusal with the
 * change the worker can make. `text` is the file's content, null when it does not exist. `indents`
 * holds the indentation the request writes each target's rows with (`placeRowIndents`). `first` is
 * the first placed (or re-indented) line as written, so the result can show its indentation.
 * `numbers` gives a target's rows the request's numbers (`placeRowNumbers`): `input.rows`, the
 * refusals and `placed` use them, and [first, last] spans the target's rows between the two.
 */
export function placeRows(
  input: PlaceRowsInput,
  targets: ReadonlyMap<string, readonly string[]>,
  text: string | null,
  indents: ReadonlyMap<string, string> = new Map(),
  numbers: ReadonlyMap<string, readonly number[]> = new Map(),
):
  | {
      content: string;
      placed: number[];
      lines: [number, number];
      first: string;
      reindented?: true;
      /** The rows were held and moved (`move: true`, #2955). */
      moved?: true;
      /** The line the rows follow, as the file holds it ("" before the first line, #2956). */
      follows?: string;
      /** The line (from 1) and text of the nearest list opening above the rows (#2956). */
      list?: { line: number; text: string };
    }
  | { refusal: string } {
  const { path } = input;
  const rows = targets.get(path);
  if (!rows)
    return {
      refusal: `${path} is not a file this task's prescribed rows go in; place_rows writes the request's rows only into ${[...targets.keys()].join(", ")}. Change ${path} with edit_file.`,
    };
  const named = numbersOf(numbers, path, rows);
  // A row's request number, from its place (from 1) in `rows`.
  const label = (n: number) => named[n - 1] ?? n;
  const [first = 0, last = first] = input.rows;
  const outside = [first, last].find((n) => !named.includes(n));
  if (outside !== undefined) {
    const listed = rowsText(named);
    const between = listed.includes(" to ")
      ? `between ${listed.replace(" to ", " and ")}`
      : `from ${listed}`;
    return {
      refusal: `The request prescribes rows ${listed} for ${path}; row ${outside} is not one of them. Call place_rows with rows [first, last] ${between}.`,
    };
  }
  if (last < first)
    return {
      refusal: `rows [${first}, ${last}] end before they start. Call place_rows with rows [first, last], first not after last.`,
    };
  const from = named.indexOf(first) + 1;
  const span = Array.from({ length: named.indexOf(last) + 1 - from + 1 }, (_, i) => from + i);
  const notation = span.filter((n) => rowNotation(rows[n - 1] ?? ""));
  if (notation.length)
    return {
      refusal: notationRefusal(path, notation.map(label), rows[(notation[0] ?? 1) - 1] ?? ""),
    };
  if (text === null)
    return {
      refusal: `${path} does not exist yet. Create it with edit_file holding everything but the rows (imports, the row type, the list's opening and close, the harness calls), then call place_rows with the line the rows follow.`,
    };
  const lines = text.split("\n");
  const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const where = input.reindent ? 0 : anchorLine(input, lines.slice(0, count));
  if (typeof where === "string") return { refusal: `${path}: ${where}` };
  if (where > count)
    return {
      refusal: `${path} has ${count} line${count === 1 ? "" : "s"}; line ${where} is not one of them. Give the line the rows follow (0 puts them before the first line).`,
    };
  const placed = span;
  const lineOf = heldLines(rows, lines);
  // Keyed by the request's number, as the result and the refusals name a row.
  const at = new Map(placed.map((n) => [label(n), lineOf[n - 1] ?? -1] as const));
  const held = [...at].flatMap(([n, line]) => (line < 0 ? [] : [`row ${n} (line ${line + 1})`]));
  if (input.reindent) return reindented(input, lines, at, indents.get(path));
  if (input.move) return moved(input, where, lines, at, targets, indents, numbers);
  if (held.length)
    return {
      refusal: `${path} already holds ${held.join(", ")}. Place only the rows the file does not hold yet; to move held rows to another place or list, call place_rows with move: true and the line they go after; to change only the indentation of placed rows, call place_rows with reindent: true and their indent.`,
    };
  const anchor = where > 0 ? (lines[where - 1] ?? "") : "";
  const eol = (anchor || (lines[0] ?? "")).endsWith("\r") ? "\r" : "";
  const anchorIndent = /^[ \t]*/.exec(anchor)?.[0] ?? "";
  // After a line that opens the list (`= {`, `List.of(`, `ROWS = [`) a row is one level deeper;
  // after a row or any other line it keeps that line's indentation.
  const opens = OPENS_LIST.test(anchor.trimEnd());
  const indent =
    input.indent ?? (opens ? anchorIndent + levelOf(path, indents.get(path), lines) : anchorIndent);
  // The line form of a restored row: the template's indentation and separator around the row. A
  // separator the row ends with is layout, not content: kept by default, replaced by the caller's.
  const written = placed.map((n, i) => {
    const row = (rows[n - 1] ?? "").trim();
    const own = /[,;]$/.exec(row)?.[0];
    const given =
      i === placed.length - 1 ? (input.lastSeparator ?? input.separator) : input.separator;
    const separator = given ?? own ?? ",";
    return restoredLine(`${indent}row${separator}${eol}`, own ? row.slice(0, -1).trimEnd() : row);
  });
  lines.splice(where, 0, ...written);
  return {
    content: lines.join("\n"),
    placed: placed.map(label),
    lines: [where + 1, where + written.length],
    first: (written[0] ?? "").replace(/\r$/, ""),
    follows: anchor.replace(/\r$/, ""),
    ...listOf(lines, where),
  };
}

/**
 * Rows the file already holds, moved after line `where` (from 1, as `anchorLine` resolved it in the
 * file as it is) in one write (#2955). R102 tailcut `filters` T003 had to restore the order of
 * three C++ two-list row files and split their rows between the lists: the row guard (#2558)
 * judges each edit alone and put back every deletion of a held row, and place_rows refused rows
 * the file held, so no route could finish the move (4.34M tokens, four `invalid_output` stops).
 * Each row of the span must be held; its line is taken out, and the rows are placed again after
 * the same line by the same insertion (indent, separators, the result's `follows` and `list`).
 */
function moved(
  input: PlaceRowsInput,
  where: number,
  lines: readonly string[],
  at: ReadonlyMap<number, number>,
  targets: ReadonlyMap<string, readonly string[]>,
  indents: ReadonlyMap<string, string>,
  numbers: ReadonlyMap<string, readonly number[]>,
): ReturnType<typeof placeRows> {
  const { path } = input;
  const missing = [...at].filter(([, line]) => line < 0).map(([n]) => n);
  if (missing.length)
    return {
      refusal: `${path} does not hold ${missing.length === 1 ? `row ${missing[0]}` : `rows ${missing.join(", ")}`} yet, so there is nothing to move. Place ${missing.length === 1 ? "it" : "them"} with place_rows without move first.`,
    };
  const taken = new Set(at.values());
  if (where > 0 && taken.has(where - 1))
    return {
      refusal: `line ${where} of ${path} is one of the rows to move. Give the line the rows go after that is not one of them, such as the opening line of the list they belong in.`,
    };
  const rest = lines.filter((_, i) => !taken.has(i));
  const line = where - [...taken].filter((i) => i < where).length;
  const { after: _, ...others } = input;
  const placed = placeRows(
    { ...others, move: undefined, line },
    targets,
    rest.join("\n"),
    indents,
    numbers,
  );
  return "refusal" in placed ? placed : { ...placed, moved: true };
}

/**
 * Rows the file already holds, re-indented in place (#2618): a layout correction in one call. Each
 * row of the span must be held; its line keeps its text and separator and takes `input.indent`, by
 * default the indentation of the line before the first held row, one level deeper when that line
 * opens the list (the level from the request's rows, then the language, never the file's own).
 */
function reindented(
  input: PlaceRowsInput,
  lines: string[],
  at: ReadonlyMap<number, number>,
  requested: string | undefined,
):
  | { content: string; placed: number[]; lines: [number, number]; first: string; reindented: true }
  | { refusal: string } {
  const { path } = input;
  const missing = [...at].filter(([, line]) => line < 0).map(([n]) => n);
  if (missing.length)
    return {
      refusal: `${path} does not hold ${missing.length === 1 ? `row ${missing[0]}` : `rows ${missing.join(", ")}`} yet, so there is nothing to re-indent. Place ${missing.length === 1 ? "it" : "them"} with place_rows without reindent first.`,
    };
  const held = [...at.values()].sort((a, b) => a - b);
  const top = held[0] ?? 0;
  const before = lines[top - 1] ?? "";
  const beforeIndent = /^[ \t]*/.exec(before)?.[0] ?? "";
  const level = requested ?? rowOf(ROW_INDENT, detectLanguageFromPath(path)) ?? "    ";
  const indent =
    input.indent ?? (/[[({=]$/.test(before.trimEnd()) ? beforeIndent + level : beforeIndent);
  for (const line of held) lines[line] = indent + (lines[line] ?? "").trimStart();
  return {
    content: lines.join("\n"),
    placed: [...at.keys()],
    lines: [top + 1, (held.at(-1) ?? top) + 1],
    first: (lines[top] ?? "").replace(/\r$/, ""),
    reindented: true,
  };
}

/**
 * Where placed rows went, for the result (#2956): the line they follow and the list that holds
 * them, so a call that put rows in the wrong list shows it at once. Empty for a re-indent.
 */
export function placedWhere(placed: {
  lines: [number, number];
  reindented?: true;
  follows?: string;
  list?: { line: number; text: string };
}): string {
  if (placed.reindented || placed.follows === undefined) return "";
  const [from] = placed.lines;
  const after =
    from > 1
      ? ` They follow line ${from - 1}, ${JSON.stringify(placed.follows.trim())}`
      : " They are the file's first lines";
  const list = placed.list
    ? placed.list.line === from - 1
      ? ", which opens their list."
      : `, in the list opened at line ${placed.list.line}, ${JSON.stringify(placed.list.text)}.`
    : ", under no line that opens a list.";
  return `${after}${list}`;
}

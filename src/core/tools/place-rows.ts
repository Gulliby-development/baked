import { z } from "zod";
import { rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
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
 * The targets by the form of their rows (#2583): `code`, the files with a row place_rows can insert
 * (written in the file language's code); `notation`, each file's rows (from 1) in the request's own
 * notation, which only the session can write, as the test framework's call.
 */
export function placeRowForms(targets: ReadonlyMap<string, readonly string[]>): {
  code: Map<string, readonly string[]>;
  notation: Map<string, number[]>;
} {
  const code = new Map<string, readonly string[]>();
  const notation = new Map<string, number[]>();
  for (const [path, rows] of targets) {
    const own = rows.flatMap((row, i) => (rowNotation(row) ? [i + 1] : []));
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

export const placeRowsInput = z
  .object({
    path: z.string().describe("The task's prescribed row file, which must already exist."),
    line: z
      .number()
      .int()
      .min(0)
      .describe("The file line (from 1) the rows go after; 0 puts them before the first line."),
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
      .describe(
        "The indentation of each row line; by default the line's own, one level deeper after a line that opens the list.",
      ),
    separator: z
      .enum([",", ";", ""])
      .optional()
      .describe("What ends each row line, as the language lists rows; by default a comma."),
    lastSeparator: z
      .enum([",", ";", ""])
      .optional()
      .describe(
        "What ends the last placed row's line, when the list takes no separator after its last item; by default the separator.",
      ),
  })
  .strict();
export type PlaceRowsInput = z.infer<typeof placeRowsInput>;

/** The tool's description for a task with these targets. */
export function placeRowsDescription(targets: ReadonlyMap<string, readonly string[]>): string {
  const files = [...targets].map(([path, rows]) => `${path} (rows 1 to ${rows.length})`).join(", ");
  return `Insert the request's prescribed rows verbatim into ${files}: rows [first, last] go after the given line of the existing file, one row per line, in the request's order, exactly as the request writes them. Never type a prescribed row with edit_file or multi_edit: write everything else (imports, the row type, the list's opening and close, the harness calls) with edit_file, leaving the rows out, then place them with this tool. Give indent and separator when the defaults (the line's indentation, one level deeper after a line that opens the list; a comma after each row) do not fit the language.`;
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

/** The leading whitespace one nesting level adds in `lines`: a tab, or the smallest space run. */
function indentUnit(lines: readonly string[]): string {
  let spaces = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (lead.startsWith("\t")) return "\t";
    if (lead.length && (!spaces || lead.length < spaces)) spaces = lead.length;
  }
  return " ".repeat(spaces || 4);
}

/** A row's text as a line holds it: trimmed, a trailing separator dropped. */
const bare = (text: string) => text.trim().replace(/[,;]$/, "").trimEnd();

/**
 * The file with rows `input.rows` of `rows` placed after `input.line`, or the refusal with the
 * change the worker can make. `text` is the file's content, null when it does not exist.
 */
export function placeRows(
  input: PlaceRowsInput,
  targets: ReadonlyMap<string, readonly string[]>,
  text: string | null,
): { content: string; placed: number[]; lines: [number, number] } | { refusal: string } {
  const { path } = input;
  const rows = targets.get(path);
  if (!rows)
    return {
      refusal: `${path} is not a file this task's prescribed rows go in; place_rows writes the request's rows only into ${[...targets.keys()].join(", ")}. Change ${path} with edit_file.`,
    };
  const [first = 0, last = first] = input.rows;
  const outside = [first, last].find((n) => n < 1 || n > rows.length);
  if (outside !== undefined)
    return {
      refusal: `The request prescribes rows 1 to ${rows.length} for ${path}; row ${outside} is not one of them. Call place_rows with rows [first, last] between 1 and ${rows.length}.`,
    };
  if (last < first)
    return {
      refusal: `rows [${first}, ${last}] end before they start. Call place_rows with rows [first, last], first not after last.`,
    };
  const span = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const notation = span.filter((n) => rowNotation(rows[n - 1] ?? ""));
  if (notation.length)
    return { refusal: notationRefusal(path, notation, rows[(notation[0] ?? 1) - 1] ?? "") };
  if (text === null)
    return {
      refusal: `${path} does not exist yet. Create it with edit_file holding everything but the rows (imports, the row type, the list's opening and close, the harness calls), then call place_rows with the line the rows follow.`,
    };
  const lines = text.split("\n");
  const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
  if (input.line > count)
    return {
      refusal: `${path} has ${count} line${count === 1 ? "" : "s"}; line ${input.line} is not one of them. Give the line the rows follow (0 puts them before the first line).`,
    };
  const placed = span;
  const held = placed.flatMap((n) => {
    const want = bare(rows[n - 1] ?? "");
    const at = lines.findIndex((l) => bare(l) === want);
    return at < 0 ? [] : [`row ${n} (line ${at + 1})`];
  });
  if (held.length)
    return {
      refusal: `${path} already holds ${held.join(", ")}. Place only the rows the file does not hold yet; to change a placed row, leave it as the request gives it.`,
    };
  const anchor = input.line > 0 ? (lines[input.line - 1] ?? "") : "";
  const eol = (anchor || (lines[0] ?? "")).endsWith("\r") ? "\r" : "";
  const anchorIndent = /^[ \t]*/.exec(anchor)?.[0] ?? "";
  // After a line that opens the list (`= {`, `List.of(`, `ROWS = [`) a row is one level deeper;
  // after a row or any other line it keeps that line's indentation.
  const opens = /[[({=]$/.test(anchor.trimEnd());
  const indent = input.indent ?? (opens ? anchorIndent + indentUnit(lines) : anchorIndent);
  const separator = input.separator ?? ",";
  const lastSeparator = input.lastSeparator ?? separator;
  // The line form of a restored row: the template's indentation and separator around the row.
  const written = placed.map((n, i) =>
    restoredLine(
      `${indent}row${i === placed.length - 1 ? lastSeparator : separator}${eol}`,
      rows[n - 1] ?? "",
    ),
  );
  lines.splice(input.line, 0, ...written);
  return {
    content: lines.join("\n"),
    placed,
    lines: [input.line + 1, input.line + written.length],
  };
}

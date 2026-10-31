import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { stripComments } from "./quality/code-mask.js";
import { CONTINUES, rowHead } from "./row-block-drift.js";
import { restoredLine } from "./row-restore.js";

/**
 * The host's own write of a prescribed row file (#2528, step 2 of #2522). A task whose only content
 * is the rows a request prescribes for a test file still opened a model session that copied them
 * into the file: in bench round 82 those tasks were 5.1M of the two initiatives' 18.1M tokens
 * (tinyflate core T006-T009 1.16M, inflate T002-T005 1.75M, deflate T003-T006 1.0M, slotprompt
 * core T004-T008 1.18M), and a model cannot reliably copy a 300-byte run of one hex byte.
 *
 * The host holds every row (`suppliedRows`) and the task names the file's shape: the file itself
 * when the task's base already has it, otherwise the task's `reference` file (R82:
 * `tests/scaffold_test.c`). The shape is one run of row lines in the rows' own notation (each
 * starts with the rows' head, `{`, `row(`, `INFLATE_ROW(`, and closes on its line), with the
 * lines before it (the preamble: imports, the row type, the list's opening) and after it (the
 * epilogue: the list's close, the harness call). The written file is the preamble, one prescribed
 * row per line with the shape's indentation and separator (`restoredLine`, the last row the
 * shape's last separator), and the epilogue. A shape the host cannot read declines with a reason:
 * no shape file, no run or several, a row spread over lines, rows of another head or argument
 * count, or no separator between rows.
 *
 * The decision is part of the host apply decision (`hostApplyDecision`, `rows` of a write) and is
 * recorded in `host-apply/tasks/<task>.json`; the host writes the file and skips the session only
 * with the policy's `rowFileWrite: "on"` (setting `quality.rowFileWrite`, shadow otherwise).
 */

/** How a language's row files hold their rows: the row-line recogniser and a golden example. */
export interface RowFileShape {
  /**
   * The forms a row line takes in the language's test files: a braced initialiser, a call, a
   * tuple. A shape line is a row line when it starts with the prescribed rows' head and matches.
   */
  rowLine: RegExp;
  /** A shape file and the rows its golden writes into it (`tests/language-parity.test.ts`). */
  example: { path: string; reference: string; rows: readonly string[] };
}

/** A call (`row(`, `INFLATE_ROW(`, `pytest.param(`) or a bracketed literal. */
const CALL_OR_LITERAL = /^\s*(?:[A-Za-z_][\w.]*\s*[({]|[[{(])/;

const FOLLOW_UP =
  "row files are host-written for C, Dart, TypeScript, JavaScript, Go, Python and Elixir first (#2528); this language's row notation and its formatter's fixed point are #2553";

/**
 * One row per supported language (AGENTS.md: a new row notation adds its row here, a case to
 * `RESTORE_SHAPES` in `tests/workflow-scenario-row-restore.test.ts` and a host-write case to
 * `tests/workflow-scenario-row-file-write.test.ts`).
 */
export const ROW_FILE_SHAPES: LanguageRecord<RowFileShape> = {
  c: {
    // A struct initialiser (`{ "hex", "hex" },`) or a macro row (`INFLATE_ROW("a", "b");`).
    rowLine: /^\s*(?:\{|[A-Za-z_]\w*\s*\()/,
    example: {
      path: "tests/deflate_match_test.c",
      reference: [
        '#include "check.h"',
        "",
        "struct row {",
        "  const char *input_hex;",
        "  const char *output_hex;",
        "};",
        "",
        "static const struct row rows[] = {",
        '    {"00", "0300"},',
        "};",
        "",
        "int main(void) { return check_rows(rows, sizeof rows / sizeof rows[0]); }",
        "",
      ].join("\n"),
      rows: ['{"616263", "4b4c4a0600"}', '{"7878787878", "abaa50120400"}'],
    },
  },
  dart: {
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "test/text_test.dart",
      reference: [
        "import 'package:slotprompt/slotprompt.dart';",
        "import 'package:test/test.dart';",
        "",
        "import 'rows.dart';",
        "",
        "final rows = [",
        "  row('', {}, ''),",
        "];",
        "",
        "void main() => runRows(rows, render);",
        "",
      ].join("\n"),
      rows: [
        "row('Hello {{name}}', {'name': 'Ann'}, 'Hello Ann')",
        // Dart's `\$` escapes the dollar before the template's `{{p}}`.
        "row('Price: \\$\u007b{p}}', {'p': '5'}, 'Price: \\$5')",
      ],
    },
  },
  typescript: {
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "tests/problems-rows.test.ts",
      reference: [
        'import { expect, test } from "bun:test";',
        'import { run } from "./helpers/run";',
        "",
        "const rows = [",
        '  { args: ["help"], code: 0, out: "" },',
        '  { args: ["help", "--all"], code: 0, out: "" },',
        "];",
        "",
        "for (const row of rows)",
        '  test(row.args.join(" "), async () => expect(await run(row)).toEqual(row));',
        "",
      ].join("\n"),
      rows: [
        '{ args: ["problems"], code: 0, out: "1\\n" }',
        '{ args: ["problems", "--all"], code: 0, out: "2\\n" }',
      ],
    },
  },
  javascript: {
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "test/split-rows.test.js",
      reference: [
        'import { expect, test } from "vitest";',
        'import { split } from "../src/split.js";',
        "",
        "const rows = [",
        '  ["", []],',
        '  [",", ["", ""]],',
        '  ["a,", ["a", ""]],',
        "];",
        "",
        'test.each(rows)("split(%j)", (input, out) => expect(split(input)).toEqual(out));',
        "",
      ].join("\n"),
      rows: ['["a,b", ["a", "b"]]', '["a,,b", ["a", "", "b"]]'],
    },
  },
  go: {
    rowLine: /^\s*(?:[A-Za-z_][\w.]*)?[{(]/,
    example: {
      path: "cmd/split_rows_test.go",
      reference: [
        "package main",
        "",
        'import "testing"',
        "",
        "var rows = []struct{ in, out string }{",
        '\t{"", ""},',
        "}",
        "",
        "func TestRows(t *testing.T) { checkRows(t, rows) }",
        "",
      ].join("\n"),
      rows: ['{"a,b", "a|b"}', '{"a,,b", "a||b"}'],
    },
  },
  python: {
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "tests/test_split_rows.py",
      reference: [
        "import pytest",
        "",
        "from split import split",
        "",
        "ROWS = [",
        '    ("", []),',
        "]",
        "",
        "",
        '@pytest.mark.parametrize(("text", "out"), ROWS)',
        "def test_rows(text, out):",
        "    assert split(text) == out",
        "",
      ].join("\n"),
      rows: ['("a,b", ["a", "b"])', '("a,,b", ["a", "", "b"])'],
    },
  },
  elixir: {
    rowLine: /^\s*(?:%?\{|[A-Za-z_][\w.]*\(|\[)/,
    example: {
      path: "test/eval_rows_test.exs",
      reference: [
        "defmodule Ratdec.EvalRowsTest do",
        "  use Ratdec.RowCase",
        "",
        "  rows([",
        '    row(["eval"], "", 0, "", ""),',
        '    row(["eval"], "1\\n", 0, "1\\n", "")',
        "  ])",
        "end",
        "",
      ].join("\n"),
      rows: [
        'row(["eval"], "7/3\\n", 0, "7/3\\n", "")',
        'row(["eval", "--as", "mixed"], "7/3\\n", 0, "2 1/3\\n", "")',
      ],
    },
  },
  cpp: none(FOLLOW_UP),
  rust: none(FOLLOW_UP),
  java: none(FOLLOW_UP),
  kotlin: none(FOLLOW_UP),
  scala: none(FOLLOW_UP),
  csharp: none(FOLLOW_UP),
  ruby: none(FOLLOW_UP),
  php: none(FOLLOW_UP),
  swift: none(FOLLOW_UP),
  lua: none(FOLLOW_UP),
  zig: none(FOLLOW_UP),
  bash: none(FOLLOW_UP),
  ocaml: none(FOLLOW_UP),
  objc: none(FOLLOW_UP),
  r: none(FOLLOW_UP),
  vue: none("a Vue single-file component is not a test file of prescribed rows"),
  svelte: none("a Svelte component is not a test file of prescribed rows"),
  rescript: none(FOLLOW_UP),
  solidity: none(FOLLOW_UP),
  sql: none("SQL tests (pgTAP) assert per statement, with no list of rows"),
  powershell: none(FOLLOW_UP),
};

/** What the decision knows of a prescribed row file's shape: counts and flags only. */
export interface RowFileInputs {
  /** The rows the request prescribes for the file. */
  count: number;
  /** The language has a `ROW_FILE_SHAPES` row. */
  language: boolean;
  /** The shape's source: the file in the task's base, the task's `reference`, or none. */
  shape: "file" | "reference" | null;
  /** The runs of row lines in the rows' notation the shape holds. */
  runs: number;
  /** Every shape line that starts with the rows' head closes its row on that line. */
  oneLine: boolean;
  /** Every prescribed row has one head, and it is a row line of the language. */
  sameHead: boolean;
  /** Every prescribed row has the argument count of the shape's rows. */
  arity: boolean;
  /** A separator between rows is known: the shape has two rows, or its one row has one. */
  separated: boolean;
}

/** Why the host does not write the row file; null when it would. */
export function rowFileRefusal(path: string, rows: RowFileInputs): string | null {
  if (!rows.language) return `the host does not write row files for ${path}'s language yet`;
  if (!rows.shape)
    return `no shape for ${path}: the file is not in the task's base and the task names no reference of its language`;
  if (!rows.sameHead)
    return `the prescribed rows for ${path} do not share one row head the language writes rows with`;
  if (rows.runs !== 1)
    return `the ${rows.shape === "file" ? "file" : "reference"} for ${path} holds ${rows.runs} runs of rows in the request's notation, not one`;
  if (!rows.oneLine) return `the shape for ${path} spreads a row over lines`;
  if (!rows.arity)
    return `the prescribed rows for ${path} have another argument count than the shape's rows`;
  if (!rows.separated)
    return `the shape for ${path} has one row with no separator, so the separator between rows is not known`;
  return null;
}

/**
 * The top-level argument count of a row line (`{ "a", "b" }` 2, `row(x, [y, z])` 2), or null when
 * the row's bracket does not close on the line. Strings are skipped with their escapes.
 */
export function rowArity(line: string): number | null {
  const head = rowHead(line);
  const open = /[([{]$/.test(head) ? line.indexOf(head) + head.length - 1 : -1;
  if (open < 0) return null;
  let depth = 0;
  let count = 0;
  let content = false;
  for (let i = open; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      if (j >= line.length) return null;
      i = j;
      if (depth === 1) content = true;
      continue;
    }
    if ("([{".includes(ch)) {
      depth++;
      if (depth > 1) content = true;
      continue;
    }
    if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) return count + (content ? 1 : 0);
      continue;
    }
    if (depth === 1 && ch === ",") {
      // A trailing comma before the close adds no argument.
      if (content) count++;
      content = false;
    } else if (depth === 1 && ch.trim()) content = true;
  }
  return null;
}

interface ShapeRun {
  /** Row lines of the run, 0-based, in order. */
  rows: number[];
  /** Their text without comments, with each line's end (`\r`) dropped. */
  texts: string[];
}

/** The runs of row lines with `head` in a shape file: blank and comment lines continue a run. */
function shapeRuns(
  path: string,
  text: string,
  head: string,
  shape: RowFileShape,
): { runs: ShapeRun[]; oneLine: boolean } {
  const lines = text.split("\n");
  const code = stripComments(path, text).split("\n");
  const runs: ShapeRun[] = [];
  let open: ShapeRun | null = null;
  let oneLine = true;
  for (const [i, line] of lines.entries()) {
    const bare = (code[i] ?? line).replace(/\r$/, "");
    if (!bare.trim()) continue;
    // A line that only opens a bracket (an Allman-style `{`) holds no row.
    if (rowHead(bare) === head && shape.rowLine.test(bare) && bare.trim().length > head.length) {
      if (rowArity(bare) === null || CONTINUES.test(lines[i + 1] ?? "")) oneLine = false;
      if (!open) {
        open = { rows: [], texts: [] };
        runs.push(open);
      }
      open.rows.push(i);
      open.texts.push(bare.trimEnd());
      continue;
    }
    open = null;
  }
  return { runs, oneLine };
}

/** The text of a prescribed row file from its shape, with the decision's inputs. */
export function rowFilePlan(
  path: string,
  rows: readonly string[],
  shape: { source: "file" | "reference"; text: string } | null,
): { inputs: RowFileInputs; content: string | null } {
  const record = rowOf(ROW_FILE_SHAPES, detectLanguageFromPath(path));
  const inputs: RowFileInputs = {
    count: rows.length,
    language: record !== null,
    shape: shape?.source ?? null,
    runs: 0,
    oneLine: false,
    sameHead: false,
    arity: false,
    separated: false,
  };
  if (!record || !shape || !rows.length) return { inputs, content: null };
  const heads = new Set(rows.map((r) => rowHead(r.trim())));
  const [head = ""] = heads;
  inputs.sameHead =
    heads.size === 1 && head !== "" && rows.every((r) => record.rowLine.test(r.trim()));
  if (!inputs.sameHead) return { inputs, content: null };
  const { runs, oneLine } = shapeRuns(path, shape.text, head, record);
  inputs.runs = runs.length;
  inputs.oneLine = oneLine;
  const [run] = runs;
  if (runs.length !== 1 || !run || !oneLine) return { inputs, content: null };
  const lines = shape.text.split("\n");
  const rowLines = run.texts;
  const arities = new Set([...rowLines.map((l) => rowArity(l)), ...rows.map((r) => rowArity(r))]);
  inputs.arity = arities.size === 1;
  const first = rowLines[0] ?? "";
  const last = rowLines[rowLines.length - 1] ?? "";
  const separator = (line: string) => /([,;])\s*$/.exec(line)?.[1] ?? "";
  // The shape's line end (CRLF) is kept on every written row.
  const eol = (lines[run.rows[0] ?? 0] ?? "").endsWith("\r") ? "\r" : "";
  inputs.separated = rows.length === 1 || rowLines.length > 1 || separator(first) !== "";
  if (!inputs.arity || !inputs.separated) return { inputs, content: null };
  const from = run.rows[0] ?? 0;
  const to = run.rows[run.rows.length - 1] ?? from;
  const written = rows.map(
    (row, i) => `${restoredLine(i === rows.length - 1 ? last : first, row)}${eol}`,
  );
  const content = [...lines.slice(0, from), ...written, ...lines.slice(to + 1)].join("\n");
  return { inputs, content };
}

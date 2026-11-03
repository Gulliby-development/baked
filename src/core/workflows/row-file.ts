import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { stripComments } from "./quality/code-mask.js";
import { CONTINUES, rowHead } from "./row-block-drift.js";
import { restoredLine, rowSpan, rowTail } from "./row-restore.js";

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
  "row files are host-written for C, C++, Dart, TypeScript, JavaScript, Go, Python, Elixir, Java, C#, Kotlin, Scala, PHP, R, OCaml, Zig, Objective-C and Solidity first (#2528, #2553); this language's row notation and its formatter's fixed point are #2553";

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
  cpp: {
    // A braced initialiser in a `std::vector`/array or a Catch2 `GENERATE(table<...>({...}))` list
    // (`{{"--help"}, 0, "usage\\n", ""},`), a typed one in a gtest `::testing::Values(` call
    // (`CliRow{...},`, the last row `CliRow{...}));`) or a `std::make_tuple(...)` row.
    rowLine: /^\s*(?:[A-Za-z_:][\w:]*)?[{(]/,
    example: {
      path: "tests/cli_test.cpp",
      reference: [
        "#include <gtest/gtest.h>",
        "",
        '#include "cli.h"',
        "",
        "struct CliRow {",
        "  std::vector<std::string> args;",
        "  int code;",
        "  std::string out;",
        "  std::string err;",
        "};",
        "",
        "static const std::vector<CliRow> rows = {",
        '    {{"--version"}, 0, "pnmforge 0.1.0\\n", ""},',
        "};",
        "",
        "TEST(CliTest, Rows) {",
        "  for (const auto &row : rows)",
        "    EXPECT_EQ(run(row.args), (Result{row.code, row.out, row.err}));",
        "}",
        "",
      ].join("\n"),
      // pnmforge (R83) `cli` T004: usage rows whose `\n` escapes are the file's text as given.
      rows: [
        '{{}, 2, "", "usage: pnmforge <command> [options]\\n"}',
        '{{"--help"}, 0, "usage: pnmforge <command> [options]\\n", ""}',
      ],
    },
  },
  rust: none(FOLLOW_UP),
  java: {
    // `Arguments.of(...)` rows in a `Stream.of(` (the last row `Arguments.of(...));`). A JUnit
    // `@CsvSource` row is a bare string, which `rowHead` reads no head from: #2553.
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "src/test/java/bytemerge/EncodeIdsTest.java",
      reference: [
        "package bytemerge;",
        "",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "",
        "import java.util.stream.Stream;",
        "import org.junit.jupiter.params.ParameterizedTest;",
        "import org.junit.jupiter.params.provider.Arguments;",
        "import org.junit.jupiter.params.provider.MethodSource;",
        "",
        "class EncodeIdsTest {",
        "  static Stream<Arguments> rows() {",
        "    return Stream.of(",
        '        Arguments.of("hello", "[104, 101, 108, 108, 111]"),',
        '        Arguments.of("", "[]"));',
        "  }",
        "",
        "  @ParameterizedTest",
        '  @MethodSource("rows")',
        "  void encodesIds(String text, String ids) {",
        "    assertEquals(ids, Encoder.encodeIds(text).toString());",
        "  }",
        "}",
        "",
      ].join("\n"),
      // bytemerge (R83) `encoding` T006: Java escapes written as the request gives them.
      rows: [
        'Arguments.of("256 \\\\ n \\n", "[50, 53, 54, 32, 92, 32, 110, 32, 10]")',
        'Arguments.of("tab\\there", "[116, 97, 98, 9, 104, 101, 114, 101]")',
      ],
    },
  },
  kotlin: {
    // `Arguments.of(...)` rows in a `listOf(` or `Stream.of(` (ktlint's trailing comma on each).
    // A JUnit `@CsvSource` row is a bare string, which `rowHead` reads no head from (as for Java).
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "src/test/kotlin/wordcount/CountRowsTest.kt",
      reference: [
        "package wordcount",
        "",
        "import org.junit.jupiter.api.Assertions.assertEquals",
        "import org.junit.jupiter.params.ParameterizedTest",
        "import org.junit.jupiter.params.provider.Arguments",
        "import org.junit.jupiter.params.provider.MethodSource",
        "",
        "class CountRowsTest {",
        "    @ParameterizedTest",
        '    @MethodSource("rows")',
        "    fun countsWords(",
        "        text: String,",
        "        count: Int,",
        "    ) {",
        "        assertEquals(count, countWords(text))",
        "    }",
        "",
        "    companion object {",
        "        @JvmStatic",
        "        fun rows() =",
        "            listOf(",
        '                Arguments.of("", 0),',
        '                Arguments.of("a b", 2),',
        "            )",
        "    }",
        "}",
        "",
      ].join("\n"),
      // Kotlin's `\$` escapes a dollar in a string.
      rows: ['Arguments.of("a\\tb\\nc", 3)', 'Arguments.of("\\$x \\"q\\"", 2)'],
    },
  },
  scala: {
    // Tuples in a `Seq(` (`("a", 0),`; scalafmt's default writes no comma after the last row).
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "src/test/scala/wordcount/CountRowsSuite.scala",
      reference: [
        "package wordcount",
        "",
        "import org.scalatest.funsuite.AnyFunSuite",
        "",
        "class CountRowsSuite extends AnyFunSuite {",
        "  val rows = Seq(",
        '    ("", 0),',
        '    ("a b", 2)',
        "  )",
        "",
        "  rows.foreach { case (text, count) =>",
        '    test(s"count($text)") {',
        "      assert(Words.count(text) == count)",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      rows: ['("a\\tb\\nc", 3)', '("  lead \\"q\\"", 2)'],
    },
  },
  csharp: {
    // xUnit `[InlineData(...)]` attribute rows (no separator, so a shape of one such row declines),
    // `TheoryData` initialiser rows (`{ "a", 0 },`) and `TheoryData` `Add(...);` rows. Other
    // attributes (`[Theory]`) are not rows. An `[InlineData(` row's arguments are one argument of
    // the bracket `rowArity` reads, so its argument count does not tell two row shapes apart.
    rowLine: /^\s*(?:\[\s*InlineData\s*\(|\{|Add\s*\()/,
    example: {
      path: "tests/Wordcount.Tests/CountRowsTests.cs",
      reference: [
        "using Xunit;",
        "",
        "namespace Wordcount.Tests;",
        "",
        "public class CountRowsTests",
        "{",
        "    [Theory]",
        '    [InlineData("", 0)]',
        '    [InlineData("a b", 2)]',
        "    public void CountsWords(string text, int count)",
        "    {",
        "        Assert.Equal(count, Words.Count(text));",
        "    }",
        "}",
        "",
      ].join("\n"),
      // C# escapes written as the request gives them, one attribute per row.
      rows: ['[InlineData("a\\tb\\nc", 3)]', '[InlineData("  lead \\"q\\"", 2)]'],
    },
  },
  ruby: none(FOLLOW_UP),
  php: {
    // Arrays returned (or listed) by a PHPUnit data provider (`['a', 0],`). A keyed row
    // (`'name' => [...]`) starts with a string and a `yield [...];` row with a word, which
    // `rowHead` reads no bracket head from: those shapes decline.
    rowLine: /^\s*\[/,
    example: {
      path: "tests/CountRowsTest.php",
      reference: [
        "<?php",
        "",
        "declare(strict_types=1);",
        "",
        "namespace Tests;",
        "",
        "use PHPUnit\\Framework\\Attributes\\DataProvider;",
        "use PHPUnit\\Framework\\TestCase;",
        "use Wordcount\\Words;",
        "",
        "final class CountRowsTest extends TestCase",
        "{",
        "    public static function rows(): array",
        "    {",
        "        return [",
        "            ['', 0],",
        "            ['a b', 2],",
        "        ];",
        "    }",
        "",
        "    #[DataProvider('rows')]",
        "    public function testCountsWords(string $text, int $count): void",
        "    {",
        "        self::assertSame($count, Words::count($text));",
        "    }",
        "}",
        "",
      ].join("\n"),
      // PHP: double quotes where the row has escapes, single quotes otherwise (pint).
      rows: ['["a\\tb\\nc", 3]', "['  lead', 1]"],
    },
  },
  swift: none(FOLLOW_UP),
  lua: none(FOLLOW_UP),
  zig: {
    // Struct literals in a `std.testing` table (`.{ .text = "a", .count = 0 },` or a typed
    // `Row{ ... },`), zig fmt's trailing comma after every row.
    rowLine: /^\s*(?:\.|[A-Za-z_][\w.]*)?\{/,
    example: {
      path: "src/count_rows_test.zig",
      reference: [
        'const std = @import("std");',
        'const words = @import("words.zig");',
        "",
        "const Row = struct { text: []const u8, count: usize };",
        "",
        "const rows = [_]Row{",
        '    .{ .text = "", .count = 0 },',
        '    .{ .text = "a b", .count = 2 },',
        "};",
        "",
        'test "rows" {',
        "    for (rows) |row| {",
        "        try std.testing.expectEqual(row.count, words.count(row.text));",
        "    }",
        "}",
        "",
      ].join("\n"),
      rows: ['.{ .text = "a\\tb\\nc", .count = 3 }', '.{ .text = "  lead \\"q\\"", .count = 2 }'],
    },
  },
  bash: none(FOLLOW_UP),
  ocaml: {
    // Tuples in an alcotest row list, each closed by `;` (`("a", 0);`), the brackets on their own
    // lines as ocamlformat writes a list longer than its margin.
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "test/test_count_rows.ml",
      reference: [
        "let rows =",
        "  [",
        '    ("", 0);',
        '    ("a b", 2);',
        "  ]",
        "",
        "let check (text, count) = Alcotest.(check int) text count (Words.count text)",
        "",
        "let test_rows () = List.iter check rows",
        "",
        'let () = Alcotest.run "count" [ ("rows", [ ("rows", `Quick, test_rows) ]) ]',
        "",
      ].join("\n"),
      // Rows long enough that ocamlformat keeps the list vertical (one row per line).
      rows: [
        '("the quick brown fox jumps over the lazy dog", 9)',
        '("tab\\tand\\nnewline \\"q\\"", 3)',
      ],
    },
  },
  objc: {
    // XCTest rows as array or dictionary literals in an `@[` list (`@[ @"a", @"b" ],`), C struct
    // initialisers (`{@"a", 0},`) or macro rows (`ROW(@"a", 0);`), clang-format's layout.
    rowLine: /^\s*(?:@?[[{]|[A-Za-z_]\w*\s*\()/,
    example: {
      path: "Tests/HexRowsTests.m",
      reference: [
        "#import <XCTest/XCTest.h>",
        "",
        '#import "HexCodec.h"',
        "",
        "@interface HexRowsTests : XCTestCase",
        "@end",
        "",
        "@implementation HexRowsTests",
        "",
        "- (void)testRows {",
        "  NSArray<NSArray<NSString *> *> *rows = @[",
        '    @[ @"", @"" ],',
        '    @[ @"abc", @"616263" ],',
        "  ];",
        "  for (NSArray<NSString *> *row in rows) {",
        "    XCTAssertEqualObjects([HexCodec encode:row[0]], row[1]);",
        "  }",
        "}",
        "",
        "@end",
        "",
      ].join("\n"),
      rows: ['@[ @"a\\tb", @"610962" ]', '@[ @"\\"q\\"", @"227122" ]'],
    },
  },
  r: {
    // `list(...)` (or `c(...)`, `data.frame(...)`) call rows in a list (styler). A
    // `tibble::tribble(` row is bare cells (`"a", 0,`) with no bracket of its own, which `rowHead`
    // reads no head from: such a shape declines.
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "tests/testthat/test-count-rows.R",
      reference: [
        'test_that("words are counted", {',
        "  rows <- list(",
        '    list("", 0),',
        '    list("a b", 2)',
        "  )",
        "  for (row in rows) {",
        "    expect_equal(count_words(row[[1]]), row[[2]])",
        "  }",
        "})",
        "",
      ].join("\n"),
      rows: ['list("a\\tb\\nc", 3)', 'list("  lead \\"q\\"", 2)'],
    },
  },
  vue: none("a Vue single-file component is not a test file of prescribed rows"),
  svelte: none("a Svelte component is not a test file of prescribed rows"),
  rescript: none(FOLLOW_UP),
  solidity: {
    // Foundry rows pushed onto a storage array of structs in `setUp` (`rows.push(Row("a", 0));`) or
    // helper call rows (`add("a", 0);`). A struct array literal names its length in its type
    // (`Row[2] memory`), which rows of another count break, so the push form is the list form.
    rowLine: CALL_OR_LITERAL,
    example: {
      path: "test/CountRows.t.sol",
      reference: [
        "// SPDX-License-Identifier: MIT",
        "pragma solidity ^0.8.20;",
        "",
        'import {Test} from "forge-std/Test.sol";',
        'import {Words} from "../src/Words.sol";',
        "",
        "contract CountRowsTest is Test {",
        "    struct Row {",
        "        string text;",
        "        uint256 count;",
        "    }",
        "",
        "    Row[] internal rows;",
        "",
        "    function setUp() public {",
        '        rows.push(Row("", 0));',
        '        rows.push(Row("a b", 2));',
        "    }",
        "",
        "    function test_rows() public view {",
        "        for (uint256 i = 0; i < rows.length; i++) {",
        "            assertEq(Words.count(rows[i].text), rows[i].count);",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
      rows: ['rows.push(Row("a\\tb\\nc", 3))', 'rows.push(Row("  lead \\"q\\"", 2))'],
    },
  },
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
  return rowSpan(line)?.count ?? null;
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

/** Whether the host writes row files of `path`'s language: its `ROW_FILE_SHAPES` row (#2633). */
export function rowFileLanguage(path: string): boolean {
  return rowOf(ROW_FILE_SHAPES, detectLanguageFromPath(path)) !== null;
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
  // The shape's line end (CRLF) is kept on every written row.
  const eol = (lines[run.rows[0] ?? 0] ?? "").endsWith("\r") ? "\r" : "";
  // One shape row gives the separator between rows only when nothing else follows its close: the
  // `));` after a Java `Stream.of(` list's one row closes the list, it does not separate rows.
  inputs.separated =
    rows.length === 1 || rowLines.length > 1 || /^[,;]$/.test(rowTail(first) ?? "");
  if (!inputs.arity || !inputs.separated) return { inputs, content: null };
  const from = run.rows[0] ?? 0;
  const to = run.rows[run.rows.length - 1] ?? from;
  const written = rows.map(
    (row, i) => `${restoredLine(i === rows.length - 1 ? last : first, row)}${eol}`,
  );
  const content = [...lines.slice(0, from), ...written, ...lines.slice(to + 1)].join("\n");
  return { inputs, content };
}

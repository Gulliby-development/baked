import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tableCells } from "../src/core/specs/table-cells.js";

// #2044: one splitter for every Markdown table row in a spec.

describe("tableCells", () => {
  test("a pipe in a code span, a double-quoted string or escaped as \\| is not a separator", () => {
    expect(tableCells('| `"$[?@[0,0]==2 || @.b]"` | `[1]` |')).toEqual(['`"$[?@[0,0]==2 || @.b]"`', "`[1]`"]);
    expect(tableCells('| "a|b" | “c|d” | e \\| f |')).toEqual(['"a|b"', "“c|d”", "e | f"]);
    expect(tableCells('| "a\\"|" | x |')).toEqual(['"a\\"|"', "x"]);
    expect(tableCells("Input | Expected")).toEqual(["Input", "Expected"]);
    expect(tableCells("| a | b | c |")).toEqual(["a", "b", "c"]);
    expect(tableCells("no table")).toEqual(["no table"]);
  });

  test("an unpaired backtick or quote is a character, as quotedSpans reads it", () => {
    expect(tableCells('| "a  `b" | "c" |')).toEqual(['"a  `b"', '"c"']);
    expect(tableCells('| 5" | x |')).toEqual(['5"', "x"]);
  });

  test("with the header's width, a split of that width wins; otherwise the mismatch shows", () => {
    // A quote that pairs across two cells: the plain split has the width.
    expect(tableCells('| 5" | "x |', 2)).toEqual(['5"', '"x']);
    expect(tableCells("| `a | b` | c |", 2)).toEqual(["`a | b`", "c"]);
    expect(tableCells('| `broken | "x | y" | 3 |', 2)).toHaveLength(3);
  });
});

/**
 * Non-table uses of `.split("|")` in src/core: a settings row id, a hook matcher and a search
 * pattern. A new table reader takes its cells from src/core/specs/table-cells.ts instead.
 */
const NOT_TABLES = new Set([
  "src/core/specs/table-cells.ts",
  "src/core/commands/config.ts",
  "src/core/hooks/tool-names.ts",
  "src/core/tools/repo-map-intercept.ts",
]);

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("no table reader in src/core splits a row with .split(\"|\") outside the shared splitter", () => {
  const root = join(import.meta.dir, "..");
  const offenders = files(join(root, "src/core"))
    .map((path) => relative(root, path).replace(/\\/g, "/"))
    .filter((path) => !NOT_TABLES.has(path))
    .filter((path) => /\.split\(\s*(?:"\|"|'\|'|`\|`|\/\\s\*\\\|\\s\*\/|\/\\\|\/)\s*\)/.test(readFileSync(join(root, path), "utf8")));
  expect(offenders).toEqual([]);
});

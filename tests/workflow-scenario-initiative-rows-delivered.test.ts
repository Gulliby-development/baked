import { describe, expect, test } from "bun:test";
import { undeliveredRows, undeliveredSummary } from "../src/core/workflows/initiatives/delivered-rows.js";

// #3071: the rows of each prescribed row file that no accepted copy of the file holds. R111
// skillgate's Outline block (13 rows) ended with rows 6 and 8 only; Lint (8 rows) with none.

const fence = "```";
const row = (name: string, n: number) => `@{ Argv = @('${name}', '${n}'); Out = "${name} ok ${n}\`n" }`;
const block = (name: string, path: string, total: number) =>
  [`${fence}powershell`, `${name} in ${path} (${total} rows)`, ...Array.from({ length: total }, (_, i) => row(name, i + 1)), fence].join("\n");
const OUTLINE = "tests/Outline.Tests.ps1";
const LINT = "tests/Lint.Tests.ps1";
const request = `Build skillgate.\n\n${block("outline", OUTLINE, 13)}\n\n${block("lint", LINT, 8)}\n`;
const file = (name: string, rows: number[]) =>
  ["Describe 'x' {", "    It 'part 2' -TestCases @(", ...rows.map((n) => `        ${row(name, n)}`), "    ) { }", "}", ""].join("\n");

describe("prescribed rows no accepted feature delivered (#3071)", () => {
  test("R111 skillgate: Outline holds rows 6 and 8 of 13, Lint holds none of 8", () => {
    const copies = new Map([
      [OUTLINE, [file("outline", [6, 8])]],
      [LINT, [file("lint", [])]],
    ]);
    const found = undeliveredRows(request, (path) => copies.get(path) ?? null);
    expect(found).toEqual([
      { path: OUTLINE, total: 13, missing: [1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13], copies: 1 },
      { path: LINT, total: 8, missing: [1, 2, 3, 4, 5, 6, 7, 8], copies: 1 },
    ]);
    expect(undeliveredSummary(found[0]!)).toBe(`${OUTLINE}: rows 1-5, 7, 9-13 of 13 are in no accepted feature's copy of the file: the request prescribes them, and no feature delivered them.`);
  });

  test("rows spread over several copies count once delivered in any", () => {
    const copies = new Map([
      [OUTLINE, [file("outline", [1, 2, 3, 4, 5, 6]), file("outline", [7, 8, 9, 10, 11, 12, 13])]],
      [LINT, [file("lint", [1, 2, 3, 4, 5, 6, 7, 8])]],
    ]);
    expect(undeliveredRows(request, (path) => copies.get(path) ?? null)).toEqual([]);
  });

  test("a file no copy holds is reported whole; an unreadable path is skipped", () => {
    const found = undeliveredRows(request, (path) => (path === OUTLINE ? [] : null));
    expect(found).toEqual([{ path: OUTLINE, total: 13, missing: Array.from({ length: 13 }, (_, i) => i + 1), copies: 0 }]);
    expect(undeliveredSummary(found[0]!)).toBe(`${OUTLINE}: no accepted feature wrote the file, so none of its 13 prescribed rows is delivered.`);
  });

  test("a block in the request's own notation is skipped: the run translates it", () => {
    const notation = `Build it.\n\n${fence}text\nrows in tests/cli.bats (2 rows)\nrun "cols" "3" => 0 "a"\nrun "cols" "x" => 2 ""\n${fence}\n`;
    expect(undeliveredRows(notation, () => [""])).toEqual([]);
  });

  test("a single missing row reads in the singular", () => {
    const copies = new Map([[OUTLINE, [file("outline", [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13])]], [LINT, [file("lint", [1, 2, 3, 4, 5, 6, 7, 8])]]]);
    const [found] = undeliveredRows(request, (path) => copies.get(path) ?? null);
    expect(found?.missing).toEqual([7]);
    expect(undeliveredSummary(found!)).toContain("row 7 of 13 is in no accepted feature's copy");
  });
});

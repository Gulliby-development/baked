import { describe, expect, test } from "bun:test";
import { placeRows, placeRowTargets } from "../src/core/tools/place-rows.js";

// Bench round 106 (#2980). tokenpare (C#) bars T003 placed BarsRows.cs, whose 16 prescribed rows
// fill two theories: rows 1-10 `Bars`, rows 11-16 `Totals`, and row 12 repeats row 4. It placed
// rows 11-16 first, as the tool description advises (last list first), then the first list.
// place_rows took row 12's line as row 4's, refused row 4 as held, and the `move: true` retry
// lifted row 12 out of `Totals`: 15 rows of 16, while the session reported all 16 placed.

function targetsOf(path: string, rows: readonly string[]) {
  const request = ["The rows:", "", "```text", `Rows in ${path} (${rows.length} rows)`, ...rows, "```", ""].join("\n");
  return placeRowTargets(request, { writes: [{ path, action: "create" as const }] });
}

function place(targets: ReturnType<typeof targetsOf>, text: string, input: Parameters<typeof placeRows>[0]) {
  const placed = placeRows(input, targets, text);
  if ("refusal" in placed) throw new Error(placed.refusal);
  return placed.content;
}

const inline = (args: string, input: string, output: string) => `[InlineData("${args}", "${input}", "${output}")]`;
const BARS = [
  inline("bars", "1 2", "# ##"),
  inline("bars", "3", "###"),
  inline("bars", "", ""),
  inline("bars --width 4", "4", "####"),
  inline("bars", "0", ""),
  inline("bars", "1 1", "# #"),
  inline("bars --char *", "2", "**"),
  inline("bars", "5", "#####"),
  inline("bars", "2 0", "##"),
  inline("bars", "x", "error"),
];
const TOTALS = [inline("totals", "1 2", "3"), BARS[3] as string, inline("totals", "", "0"), inline("totals", "4", "4"), inline("totals", "x", "error"), inline("totals", "5 5", "10")];
const ROWS = [...BARS, ...TOTALS];
const CS = "tests/BarsRows.cs";
const FRAME = [
  "namespace Tokenpare.Tests;",
  "",
  "public class BarsRows",
  "{",
  "    [Theory]",
  "    public void Bars(string args, string input, string output) => Check(args, input, output);",
  "",
  "    [Theory]",
  "    public void Totals(string args, string input, string output) => Check(args, input, output);",
  "}",
  "",
].join("\n");

/** The rows of each theory, in file order. */
function theories(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "[Theory]") out.push((current = []));
    else if (current && line.trim().startsWith("[InlineData")) current.push(line.trim());
    else current = null;
  }
  return out;
}

describe("scenario: R106 tokenpare bars T003, a row whose text another list's row repeats (#2980)", () => {
  const targets = targetsOf(CS, ROWS);
  const totals = place(targets, FRAME, { path: CS, after: "[Theory]", occurrence: 2, rows: [11, 16], separator: "" });

  test("the first list in one call, after the second: all 16 rows, each in its own theory", () => {
    const done = place(targets, totals, { path: CS, after: "[Theory]", occurrence: 1, rows: [1, 10], separator: "" });
    expect(theories(done)).toEqual([BARS, TOTALS]);
  });

  test("row 4 alone, after rows 1-3 and 5-10: placed, not refused as held at row 12's line", () => {
    const head = place(targets, totals, { path: CS, after: "[Theory]", occurrence: 1, rows: [1, 3], separator: "" });
    const rest = place(targets, head, { path: CS, after: BARS[2] as string, rows: [5, 10], separator: "" });
    const placed = placeRows({ path: CS, after: BARS[2] as string, rows: [4], separator: "" }, targets, rest);
    if ("refusal" in placed) throw new Error(placed.refusal);
    expect(theories(placed.content)).toEqual([BARS, TOTALS]);
  });

  test("move: true of the absent row 4 is refused and row 12 stays in its theory", () => {
    const head = place(targets, totals, { path: CS, after: "[Theory]", occurrence: 1, rows: [1, 3], separator: "" });
    const moved = placeRows({ path: CS, after: BARS[2] as string, rows: [4], separator: "", move: true }, targets, head);
    expect("refusal" in moved ? moved.refusal : moved.content).toStartWith(`${CS} does not hold row 4 yet`);
  });

  test("a held twin is still refused: row 4 placed, then placed again", () => {
    const done = place(targets, totals, { path: CS, after: "[Theory]", occurrence: 1, rows: [1, 10], separator: "" });
    const again = placeRows({ path: CS, after: BARS[2] as string, rows: [4], separator: "" }, targets, done);
    expect("refusal" in again ? again.refusal : "").toStartWith(`${CS} already holds row 4 (line 9)`);
    // Row 12 is held at its own line, in Totals.
    const twelve = placeRows({ path: CS, after: "[Theory]", occurrence: 2, rows: [12], separator: "" }, targets, done);
    expect("refusal" in twelve ? twelve.refusal : "").toStartWith(`${CS} already holds row 12 (line 20)`);
  });

  test("move: true of a held row with a twin moves that row, not the twin", () => {
    // Rows 1-10 placed, then row 4 moved to the end of Bars: row 12 stays in Totals.
    const done = place(targets, totals, { path: CS, after: "[Theory]", occurrence: 1, rows: [1, 10], separator: "" });
    const moved = place(targets, done, { path: CS, after: BARS[9] as string, rows: [4], separator: "", move: true });
    expect(theories(moved)).toEqual([[...BARS.slice(0, 3), ...BARS.slice(4), BARS[3] as string], TOTALS]);
  });
});

describe("Scala: a tuple row repeated across `val rows` and `val totals` (#2980)", () => {
  const SC = "src/test/scala/RowsSpec.scala";
  const rows = ['("a", 1),', '("b", 2),', '("c", 3),', '("t", 0),', '("b", 2),', '("u", 9),'];
  const targets = targetsOf(SC, rows);
  const frame = ["class RowsSpec {", "  val rows = Seq(", "  )", "  val totals = Seq(", "  )", "}", ""].join("\n");
  test("totals first, then rows: each list gets its own copy", () => {
    const second = place(targets, frame, { path: SC, after: "val totals = Seq(", rows: [4, 6], lastSeparator: "" });
    const both = place(targets, second, { path: SC, after: "val rows = Seq(", rows: [1, 3], lastSeparator: "" });
    expect(both).toContain('  val rows = Seq(\n    ("a", 1),\n    ("b", 2),\n    ("c", 3)\n  )');
    expect(both).toContain('  val totals = Seq(\n    ("t", 0),\n    ("b", 2),\n    ("u", 9)\n  )');
  });
});

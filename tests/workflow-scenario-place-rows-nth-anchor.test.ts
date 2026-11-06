import { describe, expect, test } from "bun:test";
import { anchorLine, placedWhere, placeRows, placeRowsDescription, placeRowTargets } from "../src/core/tools/place-rows.js";

// Bench round 105 (#2977). cutpick2 `bars` T003 placed the rows of BarsRowsTest.php, a PHP file
// whose two data providers both open with `return [`. No `after` text named one list, so the
// session fell back to absolute lines, which every insert moves, and spent 19 place_rows calls on
// the file. `occurrence` names the n-th matching line from the top, which an insert into the first
// list does not change.

const PATH = "tests/BarsRowsTest.php";
const ROWS = ["['bars 2', '1 2', '##']", "['bars 3', '3', '###']", "['total', '1 2', '3']", "['total', '4', '4']"];
const request = ["The rows:", "", "```text", `BarsRowsTest in ${PATH} (4 rows)`, ...ROWS, "```", ""].join("\n");
const targets = placeRowTargets(request, { writes: [{ path: PATH, action: "create" as const }] });
const frame = [
  "<?php",
  "final class BarsRowsTest extends TestCase",
  "{",
  "    public static function bars(): array",
  "    {",
  "        return [",
  "        ];",
  "    }",
  "",
  "    public static function totals(): array",
  "    {",
  "        return [",
  "        ];",
  "    }",
  "}",
  "",
].join("\n");

/** The rows of each `return [` list, in file order. */
function lists(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "return [") out.push((current = []));
    else if (line.trim() === "];") current = null;
    else if (current) current.push(line.trim().replace(/,$/, ""));
  }
  return out;
}

function place(text: string, input: Parameters<typeof placeRows>[0]) {
  const placed = placeRows(input, targets, text);
  if ("refusal" in placed) throw new Error(placed.refusal);
  return placed;
}

describe("scenario: R105 cutpick2 bars T003, two PHP lists that open with `return [` (#2977)", () => {
  test("after alone is refused with the occurrences to give", () => {
    const refused = placeRows({ path: PATH, after: "return [", rows: [3, 4] }, targets, frame);
    expect(refused).toEqual({
      refusal: `${PATH}: lines 6, 12 all read "return [". Give occurrence (1 for line 6, 2 for line 12, from the top), or line and the nearest of them is used.`,
    });
  });

  test("occurrence puts each block in its own list, in either order of the calls", () => {
    const want = [ROWS.slice(0, 2), ROWS.slice(2)];
    const first = place(frame, { path: PATH, after: "return [", occurrence: 1, rows: [1, 2] });
    const second = place(first.content, { path: PATH, after: "return [", occurrence: 2, rows: [3, 4] });
    expect(lists(second.content)).toEqual(want);
    expect(placedWhere(second)).toBe(' They follow line 14, "return [", which opens their list.');
    const reversed = place(place(frame, { path: PATH, after: "return [", occurrence: 2, rows: [3, 4] }).content, {
      path: PATH,
      after: "return [",
      occurrence: 1,
      rows: [1, 2],
    });
    expect(lists(reversed.content)).toEqual(want);
  });

  test("move takes the same anchor: rows placed in the first list go to the second", () => {
    const wrong = place(frame, { path: PATH, after: "return [", occurrence: 1, rows: [1, 4] });
    const moved = place(wrong.content, { path: PATH, after: "return [", occurrence: 2, rows: [3, 4], move: true });
    expect(lists(moved.content)).toEqual([ROWS.slice(0, 2), ROWS.slice(2)]);
  });
});

describe("place_rows occurrence (#2977)", () => {
  const lines = frame.split("\n").slice(0, -1);
  test("the n-th matching line from the top; past the last match is refused with the range", () => {
    expect(anchorLine({ after: "return [", occurrence: 1 }, lines)).toBe(6);
    expect(anchorLine({ after: "return [", occurrence: 2 }, lines)).toBe(12);
    // occurrence wins over line: line is the fallback for a repeated text, not a second anchor.
    expect(anchorLine({ after: "return [", occurrence: 2, line: 1 }, lines)).toBe(12);
    expect(anchorLine({ after: "return [", occurrence: 3 }, lines)).toBe('only 2 lines (6, 12) read "return ["; give occurrence from 1 to 2.');
    expect(anchorLine({ after: "<?php", occurrence: 2 }, lines)).toBe('only 1 line (1) reads "<?php"; give occurrence from 1 to 1.');
    expect(anchorLine({ after: "<?php", occurrence: 1 }, lines)).toBe(1);
  });

  test("Python: two `return [` lists, the same anchor", () => {
    const py = ["def bars():", "    return [", "    ]", "", "def totals():", "    return [", "    ]", ""];
    expect(anchorLine({ after: "return [", occurrence: 2 }, py)).toBe(6);
  });

  test("the description names occurrence for lists that open with the same line", () => {
    expect(placeRowsDescription(targets)).toContain("when two lists open with the same line (such as `return [`), add occurrence, 2 for the second from the top");
  });
});

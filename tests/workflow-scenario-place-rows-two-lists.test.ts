import { describe, expect, test } from "bun:test";
import {
  anchorLine,
  placedWhere,
  placeRows,
  placeRowsDescription,
  placeRowTargets,
} from "../src/core/tools/place-rows.js";

// Bench round 102 (#2956). tailcut `filters` T002 placed the rows of topk_test.cpp, a file with two
// lists (`rows` and `totals`), in two calls with absolute lines: place_rows(line 3, rows 1 to 12),
// then place_rows(line 7, rows 13 to 18). Line 7 was computed before the first insert moved the
// file, so rows 13 to 18 went into `rows`. Each result named only the first placed line, the task
// ended `implemented`, and the review's F1 correction could not move the rows (#2955).

const PATH = "tests/topk_test.cpp";
const ROWS = ['{"topk 2", "5 1 4", "5 4"}', '{"topk 1", "3 9", "9"}', '{"sum", "1 2", "3"}', '{"sum", "4", "4"}'];
const request = ["The rows:", "", "```text", `TopkTest in ${PATH} (4 rows)`, ...ROWS, "```", ""].join("\n");
const task = { writes: [{ path: PATH, action: "create" as const }] };
const targets = placeRowTargets(request, task);
const ROWS_LIST = "static const std::vector<Row> rows = {";
const TOTALS_LIST = "static const std::vector<Row> totals = {";
const frame = ['#include "topk.h"', ROWS_LIST, "};", TOTALS_LIST, "};", "int main() { return run(rows, totals); }", ""].join("\n");

/** The rows of each list in the file, by the list's opening line. */
function lists(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.endsWith("= {")) out[line] = current = [];
    else if (line.startsWith("}")) current = null;
    else if (current) current.push(line.trim().replace(/,$/, ""));
  }
  return out;
}

function place(text: string, input: Parameters<typeof placeRows>[0]) {
  const placed = placeRows(input, targets, text);
  if ("refusal" in placed) throw new Error(placed.refusal);
  return placed;
}

describe("scenario: tailcut 898cd4af filters T002, a two-list row file placed in two calls (#2956)", () => {
  test("with lines computed before the first insert, the second block lands in the first list, and the result says so", () => {
    const first = place(frame, { path: PATH, line: 2, rows: [1, 2] });
    const second = place(first.content, { path: PATH, line: 4, rows: [3, 4] });
    expect(lists(second.content)).toEqual({ [ROWS_LIST]: [ROWS[0], ROWS[1], ROWS[2], ROWS[3]], [TOTALS_LIST]: [] });
    // The result names the list that holds the rows, so the wrong placement shows at once.
    expect(placedWhere(second)).toBe(` They follow line 4, ${JSON.stringify(`${ROWS[1]},`)}, in the list opened at line 2, ${JSON.stringify(ROWS_LIST)}.`);
  });

  test("with after, each block lands in its own list whatever the order of the calls", () => {
    const first = place(frame, { path: PATH, after: ROWS_LIST, rows: [1, 2] });
    expect(placedWhere(first)).toBe(` They follow line 2, ${JSON.stringify(ROWS_LIST)}, which opens their list.`);
    const second = place(first.content, { path: PATH, after: `  ${TOTALS_LIST}  `, rows: [3, 4] });
    const want = { [ROWS_LIST]: [ROWS[0], ROWS[1]], [TOTALS_LIST]: [ROWS[2], ROWS[3]] };
    expect(lists(second.content)).toEqual(want);
    const reversed = place(place(frame, { path: PATH, after: TOTALS_LIST, rows: [3, 4] }).content, { path: PATH, after: ROWS_LIST, rows: [1, 2] });
    expect(lists(reversed.content)).toEqual(want);
  });

  test("after continues a list from its last placed row", () => {
    const first = place(frame, { path: PATH, after: TOTALS_LIST, rows: [3] });
    const second = place(first.content, { path: PATH, after: `${ROWS[2]},`, rows: [4] });
    expect(lists(second.content)[TOTALS_LIST]).toEqual([ROWS[2], ROWS[3]]);
    expect(placedWhere(second)).toBe(` They follow line 5, ${JSON.stringify(`${ROWS[2]},`)}, in the list opened at line 4, ${JSON.stringify(TOTALS_LIST)}.`);
  });

  test("rows after a list's close are in no list, and the result says so", () => {
    const placed = place(frame, { path: PATH, line: 3, rows: [1] });
    expect(placedWhere(placed)).toBe(' They follow line 3, "};", under no line that opens a list.');
  });
});

describe("place_rows anchors (#2956)", () => {
  const lines = frame.split("\n").slice(0, -1);
  test("after names one line; a missing or repeated text is refused with the change to make", () => {
    expect(anchorLine({ after: TOTALS_LIST }, lines)).toBe(4);
    expect(anchorLine({ after: "static int nope = {" }, lines)).toStartWith('no line reads "static int nope = {"');
    expect(anchorLine({ after: "};" }, lines)).toStartWith("lines 3, 5 all read");
    expect(anchorLine({ after: "};", line: 6 }, lines)).toBe(5);
    expect(anchorLine({ line: 2 }, lines)).toBe(2);
    expect(anchorLine({}, lines)).toStartWith("give the line the rows go after");
  });

  test("a refused anchor writes nothing and names the file", () => {
    expect(placeRows({ path: PATH, after: "nowhere", rows: [1] }, targets, frame)).toEqual({
      refusal: `${PATH}: no line reads "nowhere". Give after as the whole text of one line of the file (such as the list's opening line), or line with its number.`,
    });
  });

  test("the description tells a session to anchor on the list or place the last list first", () => {
    const text = placeRowsDescription(targets);
    expect(text).toContain("give after (the opening line of the list the rows belong in");
    expect(text).toContain("or place the rows of the last list first");
    expect(text).toContain("The result names the line the rows follow and the list that holds them");
  });
});

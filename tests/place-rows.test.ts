import { describe, expect, test } from "bun:test";
import {
  placeRowIndents,
  placeRows,
  placeRowTargets,
  placeRowsDescription,
} from "../src/core/tools/place-rows.js";

// #2618: place_rows took a placed row's indentation from the file's smallest indentation and fell
// back to four spaces, so a frame with no indented line (`let rows = [`, `]`, the harness call)
// got four-space rows whatever the request wrote. Bench round 85 csp (ReScript) `cli` T004: eight
// rows with four spaces against a request that wrote them with two; T006 spent 574k tokens on
// re-indenting them, because place_rows refused rows the file already held.

const PATH = "tests/CliTest.res";
const ROWS = ['Harness.row(["--help"], 0, "usage: csp\\n")', 'Harness.row(["--version"], 0, "csp 1.0\\n")'];
const frame = "let rows = [\n]\n\nHarness.run(rows)\n";
const file = (indent: string) => `let rows = [\n${ROWS.map((r) => `${indent}${r},`).join("\n")}\n]\n\nHarness.run(rows)\n`;
const request = (indent: string) =>
  ["The rows, one per line, two spaces of indentation:", "", "```text", `CliTest in ${PATH} (2 rows)`, ...ROWS.map((r) => `${indent}${r}`), "```", ""].join("\n");
const task = { writes: [{ path: PATH, action: "create" as const }] };

describe("place_rows indentation (#2618)", () => {
  test("a frame without indented lines takes the request's two-space rows", () => {
    const text = request("  ");
    const targets = placeRowTargets(text, task);
    const indents = placeRowIndents(text, task);
    expect([...indents]).toEqual([[PATH, "  "]]);
    // A TypeScript file (two spaces by convention) would get the same; a Kotlin path shows the
    // request's layout wins over the language's four spaces.
    const placed = placeRows({ path: PATH, line: 1, rows: [1, 2] }, targets, frame, indents);
    expect(placed).toMatchObject({ content: file("  "), lines: [2, 3], first: `  ${ROWS[0]},` });
    const kt = "tests/CliTest.kt";
    const ktText = request("  ").replace(PATH, kt);
    const ktTask = { writes: [{ path: kt, action: "create" as const }] };
    expect(
      placeRows({ path: kt, line: 1, rows: [1] }, placeRowTargets(ktText, ktTask), frame, placeRowIndents(ktText, ktTask)),
    ).toMatchObject({ first: `  ${ROWS[0]},` });
  });

  test("with no indentation in the request or the file, the language's ROW_INDENT; four spaces only where it states none", () => {
    const text = request("");
    expect(placeRowIndents(text, task).size).toBe(0);
    const targets = placeRowTargets(text, task);
    expect(placeRows({ path: PATH, line: 1, rows: [1] }, targets, frame)).toMatchObject({ first: `  ${ROWS[0]},` });
    const go = new Map([["rows_test.go", ['{"x"}']]]);
    expect(placeRows({ path: "rows_test.go", line: 1, rows: [1] }, go, "var rows = []row{\n}\n")).toMatchObject({ first: '\t{"x"},' });
    const c = new Map([["tests/rows.c", ['{"x"}']]]);
    expect(placeRows({ path: "tests/rows.c", line: 1, rows: [1] }, c, "Row rows[] = {\n};\n")).toMatchObject({ first: '    {"x"},' });
    // The file's own indentation still wins over the language's.
    expect(placeRows({ path: PATH, line: 1, rows: [1] }, targets, `${frame}let f = () => {\n    ()\n}\n`)).toMatchObject({
      first: `    ${ROWS[0]},`,
    });
  });

  test("reindent: rows a four-space file holds take the request's layout in one call", () => {
    const text = request("  ");
    const targets = placeRowTargets(text, task);
    const indents = placeRowIndents(text, task);
    const held = file("    ");
    // Placing them again is refused, naming the re-indent call.
    const refused = placeRows({ path: PATH, line: 1, rows: [1, 2] }, targets, held, indents);
    expect("refusal" in refused ? refused.refusal : null).toContain("reindent: true");
    const fixed = placeRows({ path: PATH, line: 1, rows: [1, 2], reindent: true }, targets, held, indents);
    expect(fixed).toMatchObject({ content: file("  "), placed: [1, 2], lines: [2, 3], first: `  ${ROWS[0]},`, reindented: true });
    // One change: only the two row lines differ from the four-space file.
    const before = held.split("\n");
    const after = "content" in fixed ? fixed.content.split("\n") : [];
    expect(before.flatMap((line, i) => (line === after[i] ? [] : [i + 1]))).toEqual([2, 3]);
    // An explicit indent wins; a row the file does not hold yet is refused.
    expect(placeRows({ path: PATH, line: 0, rows: [1, 2], reindent: true, indent: "\t" }, targets, held, indents)).toMatchObject({
      content: file("\t"),
    });
    const one = placeRows({ path: PATH, line: 0, rows: [1, 2], reindent: true }, targets, frame, indents);
    expect("refusal" in one ? one.refusal : null).toContain("does not hold rows 1, 2 yet");
  });

  test("the description states the default indentation and the re-indent call", () => {
    const description = placeRowsDescription(new Map([[PATH, ROWS]]));
    expect(description).toContain("the indentation of the request's own row lines, else the file's smallest indentation, else the language's convention");
    expect(description).toContain("reindent: true");
  });
});

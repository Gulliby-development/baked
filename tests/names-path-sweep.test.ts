import { describe, expect, test } from "bun:test";
import { rowClaimConflicts } from "../src/core/workflows/row-claims.js";
import { markStaleIndexResult } from "../src/core/workflows/stale-index.js";

// #2672 sweep: two more host decisions asked whether a text names a planned file with a bare
// `text.includes(path)`, so a longer file name that ends with the path, or a longer extension,
// named it. Both now go through `namesPath`.

const row = (input: string, out: string) => `run "deflate" "--hex" stdin="${input}" => 0 "${out}\\n" ""`;
const block = (path: string, input: string, out: string) => ["```text", `match rows in ${path} (1 row)`, row(input, out), "```"];
const SHORT = "match_test.c";
const LONG = "long_match_test.c";
const REQUEST = ["Create ready value.", "", ...block(SHORT, "78".repeat(300), "ab1805440300"), "", ...block(LONG, "78".repeat(306), "ab1805240200"), ""].join("\n");

describe("a row claim is checked against the files it names by whole name (#2672)", () => {
  test("a claim about long_match_test.c is not checked against match_test.c's rows", () => {
    // long_match_test.c prescribes 306 x bytes; the claim of 300 miscounts it. With a substring,
    // the text also "named" match_test.c, whose 300-byte row then matched and hid the conflict.
    const text = `The request supplies 300 repeated x bytes in ${LONG}.`;
    expect(rowClaimConflicts(REQUEST, [SHORT, LONG], text)).toEqual([
      { path: LONG, row: 1, kind: "run", byte: 0x78, claimed: 300, prescribed: 306 },
    ]);
  });

  test("a claim naming the shorter file is still checked against it alone", () => {
    const text = `The request supplies 306 repeated x bytes in ${SHORT}.`;
    expect(rowClaimConflicts(REQUEST, [SHORT, LONG], text)).toEqual([
      { path: SHORT, row: 1, kind: "run", byte: 0x78, claimed: 306, prescribed: 300 },
    ]);
  });
});

describe("a stale-index note names only the changed files the answer cites (#2672)", () => {
  test("an answer citing src/app.tsx or test_store.py gets no note for src/app.ts or store.py", () => {
    const found = { success: true, output: "src/app.tsx:3 function render()\ntests/test_store.py:9 def test_save" };
    expect(markStaleIndexResult(found, ["src/app.ts", "store.py"])).toBe(found);
  });

  test("the changed file itself, after a directory or in a Windows path, still gets the note", () => {
    const found = { success: true, output: "src\\app.ts:3 function render()\n/w/store.py:9 def save" };
    expect(markStaleIndexResult(found, ["src/app.ts", "store.py"]).output).toContain("out of date: src/app.ts, store.py.");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseCheck, quotedSpans, testsHold } from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// Bench round 63, eolscope (#1979, #1980): 5 of the 6 case-walk refusals were tests that spelled a
// multi-line literal right, because the walk trimmed and split its lines with JavaScript's `trim()`
// and `\s`, which also take a BOM, NBSP, U+2028, U+2029, U+3000 and a bare CR. In breaks the model
// pasted the literal into two test comments to get through, a raw U+FEFF in a Rust source file. In
// front an empty quoted literal (`gives "";`) paired its second quote with the next span's opening
// one, and the walk demanded the prose between spans.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const hex = (char: string) => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");

/** A string literal of each language, with the escape it writes a code point in. */
const SPELLINGS: [string, (body: string) => string, (char: string) => string][] = [
  ["rust", (body) => `assert_eq!(out, "${body}");`, (c) => `\\u{${hex(c)}}`],
  ["python", (body) => `assert out == "${body}"`, (c) => `\\u${hex(c)}`],
  ["java", (body) => `assertEquals("${body}", out);`, (c) => `\\u${hex(c)}`],
  ["csharp", (body) => `Assert.Equal("${body}", output);`, (c) => `\\u${hex(c)}`],
  ["go", (body) => `if out != "${body}" { t.Fatal(out) }`, (c) => `\\u${hex(c).toLowerCase()}`],
  ["typescript", (body) => `expect(out).toBe("${body}");`, (c) => `\\u${hex(c)}`],
];

const CHARS: [string, string][] = [
  ["LS", " "],
  ["PS", " "],
  ["BOM", "﻿"],
  ["NBSP", " "],
  ["U+3000", "　"],
  ["NEL", "\u0085"],
  ["space", " "],
];

describe("a multi-line literal with an invisible character is held as the test spells it (#1979)", () => {
  for (const [name, char] of CHARS) {
    // The criterion writes the literal with escapes, as eolscope's did.
    const literal = `a\\r\\n${char === " " ? " " : `\\u${hex(char)}`}x`;
    for (const [language, statement, escape] of SPELLINGS)
      test(`${name}, ${language}`, () => {
        expect(testsHold(statement(`a\\r\\n${escape(char)}x`), literal)).toBe(true);
        // The character itself in the source file, as a raw string holds it.
        expect(testsHold(statement(`a\\r\\n${char}x`), literal)).toBe(true);
        // Without the character the test spells another text.
        if (char !== " ") expect(testsHold(statement("a\\r\\nx"), literal)).toBe(false);
      });
  }

  test("a bare CR inside a line is part of the line, in every spelling", () => {
    for (const [, statement] of SPELLINGS) {
      expect(testsHold(statement("a\\rb\\nc"), "a\\rb\\nc")).toBe(true);
      expect(testsHold(statement("a b\\nc"), "a\\rb\\nc")).toBe(false);
    }
  });

  test("a quoted literal keeps an invisible character at its ends", () => {
    expect(quotedSpans('it prints " x" and "﻿y "').map((s) => s.literal)).toEqual([" x", "﻿y "]);
    expect(quotedSpans("it prints `　z`").map((s) => s.literal)).toEqual(["　z"]);
    // ASCII spaces and tabs around a literal are still not part of it.
    expect(quotedSpans('it prints " x\t"').map((s) => s.literal)).toEqual(["x"]);
  });
});

describe("an empty quoted literal does not flip the quote pairing (#1980)", () => {
  test("the R63 issue's text", () => {
    expect(quotedSpans('x gives ""; y gives "ok"; z gives "b".').map((s) => s.literal)).toEqual(["", "ok", "b"]);
    expect(quotedSpans("x gives “”; y gives “ok”.").map((s) => s.literal)).toEqual(["", "ok"]);
    // An escaped quote stays inside its span.
    expect(quotedSpans('x gives "a\\"b"; y gives "".').map((s) => s.literal)).toEqual(['a\\"b', ""]);
  });
});

describe("scenario: the R63 eolscope task-end walk (#1979, #1980)", () => {
  const spec: Pick<Spec, "criteria"> = {
    criteria: [
      // front T002 AC-002: an empty expected output among the rows.
      { id: "AC-002", requirementIds: ["FR-001"], given: "the converter", when: "`convert` runs on each input", then: '[] gives ""; then ["x1"] gives "y1"; then ["x2"] gives "y2".', method: "automated" },
      // breaks T005 AC-006: a line that starts with a BOM after a CRLF.
      { id: "AC-006", requirementIds: ["FR-001"], given: "the input `a\\r\\n\\uFEFFx1`", when: "`split` runs", then: "it yields two lines", method: "automated" },
    ],
  };
  const task = { id: "T005", criterionIds: ["AC-002", "AC-006"], writes: [{ path: "tests/splitter_tests.rs", action: "create" as const }] };
  const walk = async (text: string) => {
    const root = mkdtempSync(join(tmpdir(), "baked-case-invisible-"));
    roots.push(root);
    mkdirSync(dirname(join(root, task.writes[0].path)), { recursive: true });
    writeFileSync(join(root, task.writes[0].path), text);
    const check = caseCheck(spec, task, {});
    if (!check) throw new Error("no case walk");
    return check(root);
  };
  const TEST = [
    "#[test]",
    'fn converts() { assert_eq!(convert(&[]), ""); assert_eq!(convert(&["x1"]), "y1"); assert_eq!(convert(&["x2"]), "y2"); }',
    "#[test]",
    'fn splits_bom() { assert_eq!(split("a\\r\\n\\u{feff}x1").len(), 2); }',
  ].join("\n");

  test("a test that spells every case passes, with no literal pasted into a comment", async () => {
    expect(await walk(TEST)).toEqual([]);
  });

  test("a test that leaves out the BOM or a row is still refused", async () => {
    const refused = await walk(TEST.replace("\\u{feff}", "").replace('"y2"', '"y3"'));
    expect(refused.some((line) => line.startsWith("AC-006 names"))).toBe(true);
    expect(refused.some((line) => line.startsWith('AC-002 names "y2"'))).toBe(true);
    expect(refused.some((line) => /AC-002 names "[^"]*(?:gives|then)/.test(line))).toBe(false);
  });
});

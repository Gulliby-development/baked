import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseCheck, testsHold } from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// Bench round 65 (#2021): 4 of the 13 case-walk refusals were multi-line literals with a blank
// line in the middle (lint T004 AC-001 `a\n\n{b\n`, md-site T004 AC-004
// `Intro\n\n# First\n\n# Second`) that the models' tests spelled exactly. `linesHeld` dropped the
// blank lines from the literal and demanded the remaining lines next to each other, so no test
// could hold them: not an escaped string, not a raw one.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A string literal with escapes, as each language's test writes it. */
const SPELLINGS: [string, (body: string) => string][] = [
  ["python", (body) => `assert out == "${body}"`],
  ["typescript", (body) => `expect(out).toBe("${body}");`],
  ["go", (body) => `if out != "${body}" { t.Fatal(out) }`],
  ["java", (body) => `assertEquals("${body}", out);`],
  ["csharp", (body) => `Assert.Equal("${body}", output);`],
  ["rust", (body) => `assert_eq!(out, "${body}");`],
];

describe("a multi-line literal with a blank middle line is held as the test spells it (#2021)", () => {
  for (const [language, statement] of SPELLINGS)
    test(language, () => {
      // Two lines around one blank line, as lint T004 AC-001 wrote it.
      expect(testsHold(statement("a\\n\\n{b\\n"), "a\\n\\n{b\\n")).toBe(true);
      // Three lines with blank lines between, as md-site T004 AC-004.
      const md = "Intro\\n\\n# First\\n\\n# Second";
      expect(testsHold(statement(md), md)).toBe(true);
      // CRLF line breaks in the test's string.
      expect(testsHold(statement("Intro\\r\\n\\r\\n# First\\r\\n\\r\\n# Second"), md)).toBe(true);
      // A missing line, or a missing blank line, is another text.
      expect(testsHold(statement("Intro\\n\\n# Second"), md)).toBe(false);
      expect(testsHold(statement("a\\n{b\\n"), "a\\n\\n{b\\n")).toBe(false);
    });

  test("raw text, a list of lines and JSON text with doubled escapes hold", () => {
    const literal = "one\\n\\nthree";
    expect(testsHold("want := `one\n\nthree`", literal)).toBe(true);
    expect(testsHold('assert lines == "\\n".join(["one", "", "three"])', literal)).toBe(true);
    expect(testsHold('assert out.splitlines() == ["one", "", "three"]', literal)).toBe(true);
    expect(testsHold('const rows = JSON.parse("[\\"one\\\\n\\\\nthree\\"]");', literal)).toBe(true);
    // A data file the host or the model wrote, with the escape doubled.
    expect(testsHold('{"expected": "one\\\\n\\\\nthree"}', literal)).toBe(true);
    // Blank lines before the first and after the last line do not count.
    expect(testsHold('x = "one\\nthree"', "\\none\\nthree\\n\\n")).toBe(true);
  });
});

describe("scenario: the R65 lint task-end walk (#2021)", () => {
  const spec: Pick<Spec, "criteria"> = {
    criteria: [
      {
        id: "AC-001",
        requirementIds: ["FR-001"],
        given: "a file with an unclosed brace",
        when: "`lint` formats it",
        then: 'the output is "a\\n\\n{b\\n"',
        method: "automated",
      },
      {
        id: "AC-004",
        requirementIds: ["FR-002"],
        given: "two headings",
        when: "`render` runs",
        then: 'the page text is "Intro\\n\\n# First\\n\\n# Second"',
        method: "automated",
      },
    ],
  };
  const task = {
    id: "T004",
    criterionIds: ["AC-001", "AC-004"],
    writes: [{ path: "tests/test_lint.py", action: "create" as const }],
  };
  const walk = async (text: string) => {
    const root = mkdtempSync(join(tmpdir(), "baked-case-blank-"));
    roots.push(root);
    mkdirSync(dirname(join(root, task.writes[0].path)), { recursive: true });
    writeFileSync(join(root, task.writes[0].path), text);
    const check = caseCheck(spec, task, { checks: [] });
    if (!check) throw new Error("no case walk");
    return check(root);
  };
  const TEST = [
    "def test_unclosed():",
    '    assert lint("a{b") == "a\\n\\n{b\\n"',
    "",
    "def test_headings():",
    '    assert render(doc) == "Intro\\n\\n# First\\n\\n# Second"',
  ].join("\n");

  test("a test that spells both outputs passes", async () => {
    expect(await walk(TEST)).toEqual([]);
  });

  test("a test that leaves out a heading is still refused", async () => {
    const refused = await walk(TEST.replace("\\n\\n# First", ""));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.startsWith("AC-004 names")).toBe(true);
  });
});

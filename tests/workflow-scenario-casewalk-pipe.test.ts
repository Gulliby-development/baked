import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseCheck, criterionCases } from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// Bench round 66 (#2044): nodepluck lint AC-007 was a table whose Input cells were JSONPath
// queries in code spans, one with `||`. The case walk split the row at every `|`, demanded the
// half query with its opening backtick, and refused the task three times (1.29M tokens). A `|`
// inside a code span, inside a double-quoted string or escaped as `\|` is not a cell separator.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const REGEX = "^(?:get|set)_[0-9]+$";
const PIPELINE = "cat in.txt | wc -l";

/** Each language's own pipe in a code span, and a test that spells all three inputs. */
const LANGUAGES: { language: string; path: string; code: string; test: (code: string) => string }[] = [
  {
    language: "typescript",
    path: "tests/query.test.ts",
    code: "$[?@[0,0]==2 || @.b[?-1<0]]",
    test: (code) =>
      `test("q", () => {\n  expect(query("${code}")).toEqual([]);\n  expect(match("${REGEX}")).toBe(true);\n  expect(run("${PIPELINE}")).toBe("1");\n});\n`,
  },
  {
    language: "python",
    path: "tests/test_sets.py",
    code: "flags | 0b100",
    test: (code) =>
      `def test_union():\n    assert (${code}) == 5\n    assert matches("${REGEX}")\n    assert run("${PIPELINE}") == "1"\n`,
  },
  {
    language: "go",
    path: "flags_test.go",
    code: "n > 10 || n < -10",
    test: (code) =>
      `func TestFlags(t *testing.T) {\n  if !(${code}) { t.Fatal(n) }\n  if !match("${REGEX}") { t.Fatal() }\n  if run("${PIPELINE}") != "1" { t.Fatal() }\n}\n`,
  },
  {
    language: "java",
    path: "src/test/java/FlagsTest.java",
    code: "flags | 0x4",
    test: (code) =>
      `class FlagsTest {\n  @Test void bits() {\n    assertEquals(5, ${code});\n    assertTrue(match("${REGEX}"));\n    assertEquals("1", run("${PIPELINE}"));\n  }\n}\n`,
  },
  {
    language: "csharp",
    path: "tests/FlagsTests.cs",
    code: "mask | 8",
    test: (code) =>
      `public class FlagsTests {\n  [Fact] public void Bits() {\n    Assert.Equal(9, ${code});\n    Assert.True(Match("${REGEX}"));\n    Assert.Equal("1", Run("${PIPELINE}"));\n  }\n}\n`,
  },
];

const specFor = (code: string): Pick<Spec, "criteria"> => ({
  criteria: [
    {
      id: "AC-007",
      requirementIds: ["FR-001"],
      given: "the inputs below",
      when: "each one is evaluated",
      then: [
        "| Input | Expected |",
        "| --- | --- |",
        `| \`${code}\` | accepted |`,
        `| "${REGEX}" | matched |`,
        `| \`cat in.txt \\| wc -l\` | 1 |`,
        // A row that splits to no header width is skipped, never demanded.
        '| `broken | "never | demanded" | 3 |',
      ].join("\n"),
      method: "automated",
    },
  ],
});

describe("scenario: a table cell with a pipe in each language's spelling (#2044)", () => {
  for (const { language, path, code, test: write } of LANGUAGES) {
    const spec = specFor(code);
    const task = { id: "T005", criterionIds: ["AC-007"], writes: [{ path, action: "create" as const }] };
    const walk = async (text: string) => {
      const root = mkdtempSync(join(tmpdir(), "baked-case-pipe-"));
      roots.push(root);
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
      const check = caseCheck(spec, task, { checks: [] });
      if (!check) throw new Error("no case walk");
      return check(root);
    };

    test(`${language}: the cases are the whole cells`, () => {
      expect(criterionCases(spec, task, { checks: [] }).map((c) => c.literal)).toEqual([
        code,
        REGEX,
        PIPELINE,
      ]);
    });

    test(`${language}: a test that spells every input passes`, async () => {
      expect(await walk(write(code))).toEqual([]);
    });

    test(`${language}: a test that leaves out the piped input is refused with the whole literal`, async () => {
      const refused = await walk(write(code).replace(code, "other"));
      expect(refused).toEqual([
        `AC-007 names ${JSON.stringify(code)}, and no test file this task writes (${path}) contains it.`,
      ]);
    });
  }
});

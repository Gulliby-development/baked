import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseCheck, criterionCases } from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// Bench round 67, skillcomb (#2096): AC-007 read "name boundaries `1`/`64` ... description
// boundaries `20`/`400`". The walk demanded the token `64` from tests/test_fields.py, which spelled
// the 64-character name out as the brief asked (`NAME_64 = "aaaa..."`); T010 was refused four
// times. A bare number of a length sentence is a boundary: a string literal of that many
// characters holds it. cayleykit-update (C#) was refused once for `UnitTest1.cs`, the file the task
// edits: the task's own file is never a literal.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const THEN =
  "Also verify name boundaries `1`/`64` are accepted and description boundaries `20`/`400` are accepted, with handwritten fixtures.";

const name64 = "a".repeat(64);
const desc20 = "d".repeat(20);
const desc400 = "e".repeat(400);

/** A test file of each language that spells each boundary string out and no bare number. */
const LANGUAGES: [string, string, (name: string) => string][] = [
  [
    "csharp",
    "tests/App.Tests/FieldTests.cs",
    (name) =>
      `public class FieldTests { [Fact] public void Bounds() { Assert.True(Fields.Ok("${name}", "${desc20}")); Assert.True(Fields.Ok("a", "${desc400}")); } }`,
  ],
  [
    "go",
    "fields_test.go",
    (name) =>
      `func TestBounds(t *testing.T) { if !Ok("${name}", "${desc20}") || !Ok("a", \`${desc400}\`) { t.Fatal() } }`,
  ],
  [
    "java",
    "src/test/java/app/FieldsTest.java",
    (name) =>
      `class FieldsTest { @Test void bounds() { assertTrue(Fields.ok("${name}", "${desc20}")); assertTrue(Fields.ok("a", "${desc400}")); } }`,
  ],
  [
    "python",
    "tests/test_fields.py",
    (name) =>
      `NAME_LONG = "${name}"\n\ndef test_bounds():\n    assert ok(NAME_LONG, '${desc20}')\n    assert ok("a", "${desc400}")\n`,
  ],
  [
    "typescript",
    "tests/fields.test.ts",
    (name) =>
      `test("bounds", () => { expect(ok("${name}", "${desc20}")).toBe(true); expect(ok("a", "${desc400}")).toBe(true); });`,
  ],
];

const criterion = (then: string) => ({
  id: "AC-007",
  requirementIds: ["FR-001"],
  given: "a SKILL.md with front matter",
  when: "the linter checks its fields",
  then,
  method: "automated" as const,
});

const walk = async (then: string, path: string, text: string, writes = [path]) => {
  const task = {
    id: "T010",
    criterionIds: ["AC-007"],
    writes: writes.map((p) => ({ path: p, action: "create" as const })),
  };
  const root = mkdtempSync(join(tmpdir(), "baked-case-boundaries-"));
  roots.push(root);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  const check = caseCheck({ criteria: [criterion(then)] } satisfies Pick<Spec, "criteria">, task, {
    checks: [],
  });
  if (!check) throw new Error("no case walk");
  return check(root);
};

describe("a bare number of a length sentence is a boundary (#2096)", () => {
  test("the numbers are still cases, marked as lengths", () => {
    const cases = criterionCases({ criteria: [criterion(THEN)] }, { criterionIds: ["AC-007"] }, { checks: [] });
    expect(cases.map((c) => [c.literal, c.length ?? false])).toEqual([
      ["64", true],
      ["20", true],
      ["400", true],
    ]);
  });

  test("a number outside a length sentence is not a length", () => {
    const cases = criterionCases(
      { criteria: [criterion("the exit code is `64`")] },
      { criterionIds: ["AC-007"] },
      { checks: [] },
    );
    expect(cases.map((c) => c.length ?? false)).toEqual([false]);
  });

  for (const [language, path, text] of LANGUAGES) {
    test(`${language}: a spelled-out boundary string holds the number`, async () => {
      expect(await walk(THEN, path, text(name64))).toEqual([]);
    });
    test(`${language}: no string of that length and no number is refused`, async () => {
      const refused = await walk(THEN, path, text("a".repeat(63)));
      expect(refused).toEqual([expect.stringContaining('AC-007 names "64"')]);
    });
  }

  test("the number itself still holds the case", async () => {
    const text = `def test_bounds():\n    assert ok("a" * 64, "${desc20}")\n    assert ok("a", "${desc400}")\n`;
    expect(await walk(THEN, "tests/test_fields.py", text)).toEqual([]);
  });
});

describe("the task's own file is not a literal (#2096)", () => {
  const then = "the tests in `UnitTest1.cs` assert `Group.Order(6)` returns `cyclic 6`";
  test("a file the task writes is not demanded", async () => {
    const path = "tests/App.Tests/UnitTest1.cs";
    const text = `public class UnitTest1 { [Fact] public void Order() { Assert.Equal("cyclic 6", Group.Order(6)); } }`;
    expect(await walk(then, path, text)).toEqual([]);
  });
  test("a file another task writes is still a case", () => {
    const cases = criterionCases(
      { criteria: [criterion(then)] },
      { criterionIds: ["AC-007"], writes: [{ path: "tests/App.Tests/OtherTests.cs", action: "create" }] },
      { checks: [] },
    );
    expect(cases.map((c) => c.literal)).toContain("UnitTest1.cs");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  caseCheck,
  missingCases,
  repairCaseTask,
  testsHold,
} from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

// R54 (#1807): the case walk refused 15 times with 42 items in 4 of 7 runs for a JUnit
// `Class.method` name, usage metavariables (`FILE`), an anchored regex, a base URL and the values a
// property test draws from its strategies. A test held each of them in its own spelling.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-case-references-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type Criterion = Spec["criteria"][number];
const criterion = (id: string, then: string, extra: Partial<Criterion> = {}): Criterion => ({
  id,
  requirementIds: ["FR-001"],
  given: "the tool",
  when: "it runs",
  then,
  method: "automated",
  ...extra,
});

async function refusals(c: Criterion, path: string, text: string): Promise<string[]> {
  const check = caseCheck({ criteria: [c] }, { criterionIds: [c.id], writes: [{ path, action: "create" }] }, {});
  // No check means the walk demands nothing (a Go `TestX/sub` reads as a path).
  return check ? check(workspace({ [path]: text })) : [];
}

// A qualified test name in each toolchain's spelling: the test declares the class and the member apart.
const NAMES: { tool: string; name: string; path: string; text: string }[] = [
  {
    tool: "maven (R54 propdrift)",
    name: "PropdriftTest.validatesArgumentsInTheSpecifiedOrder",
    path: "src/test/java/app/PropdriftTest.java",
    text: "class PropdriftTest {\n  @Test\n  void validatesArgumentsInTheSpecifiedOrder() {}\n}\n",
  },
  {
    tool: "gradle",
    name: "ParserTest.rejectsEmptyInput",
    path: "src/test/kotlin/app/ParserTest.kt",
    text: "class ParserTest {\n  @Test fun rejectsEmptyInput() {}\n}\n",
  },
  {
    tool: "dotnet test",
    name: "ParserTests.Rejects_empty_input",
    path: "tests/App.Tests/ParserTests.cs",
    text: "public class ParserTests {\n  [Fact] public void Rejects_empty_input() {}\n}\n",
  },
  {
    tool: "pytest",
    name: "TestParser.test_rejects_empty_input",
    path: "tests/test_parser.py",
    text: "class TestParser:\n    def test_rejects_empty_input(self):\n        pass\n",
  },
  {
    tool: "cargo test",
    name: "parser::rejects_empty_input",
    path: "tests/parser.rs",
    text: "mod parser {\n    #[test]\n    fn rejects_empty_input() {}\n}\n",
  },
  {
    tool: "go test",
    name: "TestParse/empty_input",
    path: "parse_test.go",
    text: 'func TestParse(t *testing.T) {\n\tt.Run("empty_input", func(t *testing.T) {})\n}\n',
  },
  {
    tool: "bun test",
    name: "Parser.rejectsEmptyInput",
    path: "tests/parser.test.ts",
    text: 'describe("Parser", () => {\n  test("rejectsEmptyInput", () => {});\n});\n',
  },
];

describe("a qualified test name is held by its class and member (#1807)", () => {
  for (const { tool, name, path, text } of NAMES)
    test(tool, async () => {
      expect(await refusals(criterion("AC-001", `the test \`${name}\` passes`), path, text)).toEqual([]);
    });

  test("a missing member is still missing", () => {
    expect(testsHold("class PropdriftTest {\n  void validatesOrder() {}\n}", "PropdriftTest.validatesArgumentsInTheSpecifiedOrder")).toBe(false);
  });

  test("file names stay paths", () => {
    expect(testsHold("readme = read('README')", "README.md")).toBe(false);
    expect(testsHold("load('config')", "config.yaml")).toBe(false);
  });
});

describe("usage metavariables are placeholders (#1807)", () => {
  test("R54 propdrift: an argument array and a temporary path", async () => {
    const c = criterion("AC-002", 'the usage reads `--rule PR004 --write-baseline FILE <dir>` and it prints "wrote 1 finding to FILE"');
    const text = [
      'String[] args = {"--rule", "PR004", "--write-baseline", baseline.toString(), dir.toString()};',
      'assertEquals("wrote 1 finding to " + baseline, out.trim());',
    ].join("\n");
    expect(await refusals(c, "src/test/java/app/BaselineTest.java", text)).toEqual([]);
  });

  test("a metavariable that is the whole literal, or not after a flag or preposition, stays a value", () => {
    expect(testsHold('run(["--path", "lib"])', "--path SRC")).toBe(false);
    expect(testsHold('assert out == "FILE"', "FILE")).toBe(true);
    expect(testsHold('assert out == "file"', "FILE")).toBe(false);
  });
});

describe("a regex or a base URL is held as the test writes it (#1807)", () => {
  test("bun: an anchored regex as a regex literal", async () => {
    const c = criterion("AC-003", "each code matches `^[A-Za-z0-9_-]{7}$`");
    expect(await refusals(c, "tests/code.test.ts", "expect(shorten(url)).toMatch(/^[A-Za-z0-9_-]{7}$/);\n")).toEqual([]);
  });

  test("pytest: a regex in a raw string", async () => {
    const c = criterion("AC-003", "each code matches `^[A-Za-z0-9_-]{7}$`");
    expect(await refusals(c, "tests/test_code.py", 'assert re.fullmatch(r"[A-Za-z0-9_-]{7}", code)\n')).toEqual([]);
  });

  test("a different pattern is still missing", () => {
    expect(testsHold("expect(code).toMatch(/^[a-z]{7}$/);", "^[A-Za-z0-9_-]{7}$")).toBe(false);
  });

  test("a base URL inside the URL a test requests", async () => {
    const c = criterion("AC-004", "short links start with `https://sho.rt/`");
    expect(await refusals(c, "tests/handler.test.ts", 'const res = await handler(new Request("https://sho.rt/abc"));\n')).toEqual([]);
    expect(testsHold('new Request("https://other.rt/abc")', "https://sho.rt/")).toBe(false);
  });
});

// R54 expenses-py: one hypothesis test drew the dates and the category's letter case.
const PROPERTY = criterion(
  "AC-005",
  'filtering with `--from 2024-01-02` keeps "2024-01-02" and `--category fOoD` matches any letter case',
);
const HYPOTHESIS = [
  "from hypothesis import given, strategies as st",
  "",
  "@given(st.dates(), st.sampled_from(['food', 'FOOD', 'Food']))",
  "def test_filters(day, category):",
  '    out = run(["--from", day.isoformat(), "--category", category])',
  "    assert all(row.day >= day for row in out)",
].join("\n");

describe("a property test holds the values its strategies draw (#1807)", () => {
  test("pytest + hypothesis", async () => {
    expect(await refusals(PROPERTY, "tests/test_filter.py", HYPOTHESIS)).toEqual([]);
  });

  test("bun + fast-check", async () => {
    const text = [
      'import fc from "fast-check";',
      "fc.assert(fc.property(fc.date(), fc.constantFrom('food', 'FOOD'), (day, category) => {",
      '  run(["--from", iso(day), "--category", category]);',
      "}));",
    ].join("\n");
    expect(await refusals(PROPERTY, "tests/filter.test.ts", text)).toEqual([]);
  });

  test("a criterion marked as a property is held by any test that names its words", async () => {
    const c = { ...PROPERTY, property: "invariant" as const };
    const text = 'for day in days(seed):\n    run(["--from", day, "--category", "Food"])\n';
    expect(await refusals(c, "tests/test_filter.py", text)).toEqual([]);
  });

  test("an example test still owes the literal values", async () => {
    const text = 'def test_filters():\n    run(["--from", "2024-01-03", "--category", "food"])\n';
    expect(await refusals(PROPERTY, "tests/test_filter.py", text)).not.toEqual([]);
  });

  test("a property test still owes its flags", async () => {
    expect(await refusals(PROPERTY, "tests/test_filter.py", HYPOTHESIS.replace(/--category/g, "--kind"))).toHaveLength(1);
  });
});

describe("adversarial review of the #1790 fix (#1807)", () => {
  const BYTES = criterion("AC-006", "the bytes `7B FF 0A` are rejected");

  test("a byte string mixing a printable character with escapes", async () => {
    expect(await refusals(BYTES, "tests/test_decode.py", 'decode(b"{\\xff\\n")\n')).toEqual([]);
  });

  test("two bytes as one quoted hex string", () => {
    expect(missingCases([{ criterionId: "AC-006", literal: "FF FE" }], ['decode(Buffer.from("fffe", "hex"))'])).toEqual([]);
    expect(missingCases([{ criterionId: "AC-006", literal: "FF FE" }], ['decode(Buffer.from("feff", "hex"))'])).toHaveLength(1);
  });

  test("a finding on a shared file that names its criteria owes only those", () => {
    type PlanTask = Pick<Task, "origin" | "writes" | "criterionIds">;
    const shared = "src/cli.ts";
    const tasks: PlanTask[] = [
      { origin: "planned", criterionIds: ["AC-001"], writes: [{ path: shared, action: "create" }] },
      { origin: "planned", criterionIds: ["AC-002"], writes: [{ path: shared, action: "modify" }] },
    ];
    const spec = { criteria: [criterion("AC-001", "`a` runs"), criterion("AC-002", "`b` runs")] };
    expect(repairCaseTask({ criterionIds: ["AC-001", "AC-002"] }, [{ file: shared, criterionIds: ["AC-002"] }], spec, tasks).criterionIds).toEqual(["AC-002"]);
  });
});

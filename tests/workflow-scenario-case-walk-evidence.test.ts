import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseCheck, testsHold } from "../src/core/verification/criteria-cases.js";
import { caseEvidence } from "../src/core/verification/criteria-evidence.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// Bench round 57 (#1846): the task-end case walk ran in 6 of 7 runs with 8 refusals on 18 items,
// about 1.9M tokens. A comment pasting the criterion's row held it, a table line did not, a JSON
// object of keys and empty strings fell back to a token match, a doubly escaped line break was
// never decoded, and a multi-line text missing its middle line passed.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ROW = '(6,d,1777,0777,"/tmp")';
// modeplan `tests/Modeplan.Tests/Tree/TreeCmdTests.cs`: the rows as table text, the tuple only in a comment.
const TABLE = [
  "public class TreeCmdTests {",
  "  [Fact] public void Rows() {",
  '    var expected = "IDX  KIND  MODE  NEW   PATH\\n" +',
  '      "6    d     1777  0777  \\"/tmp\\"\\n" +',
  '      "11   d     0644  0744  \\"odd dir/\\"\\n";',
  "    Assert.Equal(expected, Tree.Render(Input));",
  "  }",
  "}",
].join("\n");
const COMMENT_ONLY = [
  "public class TreeCmdTests {",
  "  [Fact] public void Rows() {",
  '    Assert.Equal("11 d", Tree.Render(Input));',
  `    // Expected rows include ${ROW} and (11,d,0644,0744,"odd dir/").`,
  "  }",
  "}",
].join("\n");

describe("comments are not evidence, in every comment syntax (#1846)", () => {
  test("the R57 modeplan comment no longer holds the row; the table line does", () => {
    const path = "tests/Modeplan.Tests/Tree/TreeCmdTests.cs";
    expect(testsHold(caseEvidence(path, COMMENT_ONLY), ROW)).toBe(false);
    expect(testsHold(caseEvidence(path, TABLE), ROW)).toBe(true);
  });

  const forms: [string, string][] = [
    ["tests/test_a.py", `# AC-004 input: [["x","B"]]\ndef test_a():\n    assert run() == 1\n`],
    ["src/a.test.ts", `// AC-004 input: [["x","B"]]\ntest("a", () => expect(run()).toBe(1));\n`],
    ["src/test/java/ATest.java", `/* AC-004 input: [["x","B"]] */\nclass ATest { @Test void a() { assertEquals(1, run()); } }\n`],
    ["a_test.go", `// AC-004 input: [["x","B"]]\nfunc TestA(t *testing.T) { if run() != 1 { t.Fatal() } }\n`],
    ["tests/a.rs", `// AC-004 input: [["x","B"]]\n#[test]\nfn a() { assert_eq!(run(), 1); }\n`],
    ["test/a_test.exs", `# AC-004 input: [["x","B"]]\nassert run() == 1\n`],
    ["test/a.bats", `# AC-004 input: [["x","B"]]\n@test "a" { run; }\n`],
    ["test/a_test.ml", `(* AC-004 input: [["x","B"]] *)\nlet () = assert (run () = 1)\n`],
  ];
  for (const [path, text] of forms)
    test(path, () => {
      expect(testsHold(text, '[["x","B"]]')).toBe(true);
      expect(testsHold(caseEvidence(path, text), '[["x","B"]]')).toBe(false);
      // The same text in a string stays evidence.
      expect(testsHold(caseEvidence(path, `${text}\nrun("x", "B")\n`), '[["x","B"]]')).toBe(true);
    });
});

describe("row notation, JSON keys, escaped line breaks and multi-line texts (#1846)", () => {
  test("a row in tuple notation is held by its cells in order within one statement", () => {
    expect(testsHold('[InlineData(6, "d", 1777, "0777", "/tmp")]', ROW)).toBe(true);
    expect(testsHold('cases = [(6, "d", 1777, "0777", "/tmp")]', ROW)).toBe(true);
    expect(testsHold('[InlineData(6, "d", 1777, "0777", "/var")]', ROW)).toBe(false);
    // The cells spread over unrelated statements are not the row.
    expect(testsHold('var a = 6; var b = "d";\nvar c = 1777; var d = "0777"; var p = "/tmp";', ROW)).toBe(false);
  });

  test("a JSON object with no non-empty string is held by its keys and the empty string", () => {
    const literal = '{"flags":[],"values":{"--umask":""},"args":[]}';
    const cs = 'var o = Options.Parse(["--umask", ""]);\nAssert.Empty(o.Flags);\nAssert.Equal("", o.Values["--umask"]);\nAssert.Empty(o.Args);';
    expect(testsHold(cs, literal)).toBe(true);
    expect(testsHold(cs.replaceAll('""', "null").replaceAll("Assert.Equal(null", "Assert.Null(null"), literal)).toBe(false);
    expect(testsHold(cs.replaceAll("--umask", "--mask"), literal)).toBe(false);
  });

  test("a doubly escaped line break is held by a real one", () => {
    const literal = String.raw`STEP  ACTION\\n0     start`;
    expect(testsHold('Assert.Equal("STEP  ACTION\\n0     start\\n", Render(plan));', literal)).toBe(true);
    // The spelling with the backslash stays held too.
    expect(testsHold(String.raw`Assert.Equal("STEP  ACTION\\n0     start", Render(plan));`, literal)).toBe(true);
  });

  const MULTI = "f 0644 a\n# c\nf 0600 a";
  const forms: [string, string, boolean][] = [
    ["Go raw string, the middle line missing (R57 foundation T013)", "want := `f 0644 a\nf 0600 a`", false],
    ["Go raw string", "want := `f 0644 a\n# c\nf 0600 a`", true],
    ["C# escaped string", 'Assert.Equal("f 0644 a\\n# c\\nf 0600 a", Run());', true],
    ["TypeScript concatenation", 'expect(run()).toBe("f 0644 a\\n" +\n  "# c\\n" +\n  "f 0600 a");', true],
    ["Python list of lines", 'assert lines == ["f 0644 a", "# c", "f 0600 a"]', true],
    ["Java text block", 'assertEquals("""\n    f 0644 a\n    # c\n    f 0600 a""", run());', true],
    ["lines in another order", 'assertEquals("# c\\nf 0644 a\\nf 0600 a", run());', false],
  ];
  for (const [name, text, held] of forms)
    test(`a multi-line text is held whole: ${name}`, () => {
      expect(testsHold(text, MULTI)).toBe(held);
    });
});

describe("scenario: the R57 task-end walk on the stored shapes (#1846)", () => {
  const spec: Pick<Spec, "criteria"> = {
    criteria: [
      { id: "AC-003", requirementIds: ["FR-001"], given: "the tree of `/tmp`", when: "`tree` runs", then: `it lists the row \`${ROW}\``, method: "automated" },
      { id: "AC-016", requirementIds: ["FR-001"], given: "the manifest `f 0644 a\\n# c\\nf 0600 a`", when: "it is parsed", then: "it reports `3:8`", method: "automated" },
    ],
  };
  const task = { id: "T002", criterionIds: ["AC-003", "AC-016"], writes: [{ path: "tests/TreeTests.cs", action: "create" as const }] };
  const walk = async (text: string) => {
    const root = mkdtempSync(join(tmpdir(), "baked-case-evidence-"));
    roots.push(root);
    mkdirSync(dirname(join(root, task.writes[0].path)), { recursive: true });
    writeFileSync(join(root, task.writes[0].path), text);
    const check = caseCheck(spec, task, {});
    if (!check) throw new Error("no case walk");
    return check(root);
  };

  test("a comment and a test missing a line are refused; the rows and the whole text pass", async () => {
    const refused = await walk(`${COMMENT_ONLY}\n// f 0644 a\nclass M { string m = "f 0644 a\\nf 0600 a"; string e = "3:8"; }\n`);
    expect(refused.some((line) => line.startsWith(`AC-003 names ${JSON.stringify(ROW)}, found only in a comment`))).toBe(true);
    expect(refused.some((line) => line.startsWith(`AC-016 names ${JSON.stringify("f 0644 a\\n# c\\nf 0600 a")}, and no test file`))).toBe(true);
    expect(await walk(`${TABLE}\nclass M { string m = "f 0644 a\\n# c\\nf 0600 a"; string e = "3:8"; }\n`)).toEqual([]);
  });
});

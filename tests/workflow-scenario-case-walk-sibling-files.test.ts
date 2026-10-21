import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseCheck } from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

// R57 (#1886): expenses-py T009 was refused for six CLI argument strings that T007's
// tests/test_cli.py already tested (about 435k tokens after the refusal); md-site T009 and
// url-shortener T004 the same way. A case a sibling task's test file tests is held.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-case-siblings-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type PlanTask = Pick<Task, "id" | "description" | "criterionIds" | "writes" | "dependsOn">;
const task = (id: string, description: string, path: string, dependsOn: string[] = []): PlanTask => ({
  id,
  description,
  criterionIds: ["AC-004"],
  writes: [{ path, action: "create" }],
  dependsOn,
});

interface Language {
  name: string;
  /** The test file the sibling writes, the one the walked task writes, and how each spells a string. */
  sibling: string;
  own: string;
  holds: (literal: string) => string;
  comment: (literal: string) => string;
  empty: string;
}

const LANGUAGES: Language[] = [
  {
    name: "python",
    sibling: "tests/test_cli.py",
    own: "tests/test_report.py",
    holds: (l) => `def test_filter():\n    assert run(${JSON.stringify(l)}.split()) == 0\n`,
    comment: (l) => `# ${l}\ndef test_filter():\n    pass\n`,
    empty: "def test_report():\n    assert report() == []\n",
  },
  {
    name: "typescript",
    sibling: "tests/cli.test.ts",
    own: "tests/report.test.ts",
    holds: (l) => `import { test, expect } from "bun:test";\ntest("filter", () => {\n  expect(run(${JSON.stringify(l)})).toBe(0);\n});\n`,
    comment: (l) => `// ${l}\ntest("filter", () => {});\n`,
    empty: 'test("report", () => {\n  expect(report()).toEqual([]);\n});\n',
  },
  {
    name: "go",
    sibling: "cli_test.go",
    own: "report_test.go",
    holds: (l) => `package main\n\nimport "testing"\n\nfunc TestFilter(t *testing.T) {\n\tif run(${JSON.stringify(l)}) != 0 {\n\t\tt.Fatal("filter")\n\t}\n}\n`,
    comment: (l) => `package main\n\n// ${l}\nfunc TestFilter(t *testing.T) {}\n`,
    empty: 'package main\n\nimport "testing"\n\nfunc TestReport(t *testing.T) {}\n',
  },
  {
    name: "rust",
    sibling: "tests/cli_tests.rs",
    own: "tests/report_tests.rs",
    holds: (l) => `#[test]\nfn filter() {\n    assert_eq!(run(${JSON.stringify(l)}), 0);\n}\n`,
    comment: (l) => `// ${l}\n#[test]\nfn filter() {}\n`,
    empty: "#[test]\nfn report() {}\n",
  },
];

const LITERAL = "--from 2024-01-02 --to 2024-01-03";
const spec: Spec["criteria"] = [
  {
    id: "AC-004",
    requirementIds: ["FR-001"],
    given: "an expenses file with rows on 2024-01-01 to 2024-01-04",
    when: `the user runs the report with "${LITERAL}"`,
    then: "only the rows of the 2nd and 3rd are listed",
    method: "automated",
  },
];

describe("the case walk counts a sibling task's test file (#1886)", () => {
  for (const lang of LANGUAGES) {
    const T007 = task("T007", "Write the CLI tests.", lang.sibling);
    const T009 = task("T009", "Write the report tests.", lang.own, ["T007"]);
    const tasks = [T007, T009];
    const walk = async (files: Record<string, string>) => {
      const check = caseCheck({ criteria: spec }, T009, { checks: [], tasks });
      if (!check) throw new Error("no case check");
      return check(workspace(files));
    };

    test(`${lang.name}: a case the sibling's test file tests is not demanded again`, async () => {
      expect(await walk({ [lang.own]: lang.empty, [lang.sibling]: lang.holds(LITERAL) })).toEqual([]);
    });

    test(`${lang.name}: a sibling file not written yet, or holding the case only in a comment, holds nothing`, async () => {
      const refused = [`AC-004 names ${JSON.stringify(LITERAL)}, and no test file this task writes (${lang.own}) contains it.`];
      expect(await walk({ [lang.own]: lang.empty })).toEqual(refused);
      expect(await walk({ [lang.own]: lang.empty, [lang.sibling]: lang.comment(LITERAL) })).toEqual(refused);
    });
  }

  test("a corrective without a plan identity is not refused for its sibling's case either", async () => {
    const T007 = task("T007", "Write the CLI tests.", "tests/test_cli.py");
    const corrective: PlanTask = { ...task("T012", "Fix the report filter.", "tests/test_report.py"), id: "T012" };
    const check = caseCheck({ criteria: spec }, corrective, { checks: [], tasks: [T007] });
    const root = workspace({ "tests/test_report.py": "def test_report():\n    pass\n", "tests/test_cli.py": `def test_cli():\n    run("${LITERAL}")\n` });
    expect(check ? await check(root) : []).toEqual([]);
  });

  test("a sibling's host-written row data holds its cases; missing row data holds nothing", async () => {
    const T008: Pick<Task, "id" | "description" | "criterionIds" | "writes" | "rows" | "rowTest"> = {
      ...task("T008", "Write the rows of AC-004.", "tests/rows.test.ts"),
      rows: ["AC-004"],
      rowTest: { framework: "bun", harness: "tests/harness.ts", test: "tests/rows.test.ts", data: "tests/rows.json" },
    };
    const corrective = task("T012", "Fix the report filter.", "tests/report.test.ts");
    const check = caseCheck({ criteria: spec }, corrective, { checks: [], tasks: [T008] });
    if (!check) throw new Error("no case check");
    const own = { "tests/report.test.ts": 'test("report", () => {});\n' };
    expect(await check(workspace({ ...own, "tests/rows.json": JSON.stringify([{ input: LITERAL, expected: "2" }]) }))).toEqual([]);
    expect(await check(workspace(own))).toHaveLength(1);
  });

  test("the task's own file is not read twice as a sibling's", async () => {
    const T007 = task("T007", "Write the CLI tests.", "tests/test_cli.py");
    const T009 = task("T009", "Extend the CLI tests.", "tests/test_cli.py", ["T007"]);
    const check = caseCheck({ criteria: spec }, T009, { checks: [], tasks: [T007, T009] });
    expect(check ? await check(workspace({ "tests/test_cli.py": "def test_cli():\n    pass\n" })) : []).toHaveLength(1);
  });
});

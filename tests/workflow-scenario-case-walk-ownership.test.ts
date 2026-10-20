import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { caseCheck, criterionCases } from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

// R52 (#1771): grundykit T006 ("change exactly three lines and nothing else" in two existing test
// files) was refused for README fragments that T003 writes and for test names that T004 and T005
// write. It added them, the review flagged the extra lines, and corrective T007 reverted them
// (258k tokens, 21 percent of the run).

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-case-ownership-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type Criterion = Spec["criteria"][number];
const criterion = (id: string, given: string, when: string, then: string): Criterion => ({
  id,
  requirementIds: ["FR-001"],
  given,
  when,
  then,
  method: "automated",
});

type PlanTask = Pick<Task, "id" | "description" | "criterionIds" | "writes" | "dependsOn">;
const task = (id: string, description: string, criterionIds: string[], paths: string[], dependsOn: string[] = []): PlanTask => ({
  id,
  description,
  criterionIds,
  writes: paths.map((path) => ({ path, action: "modify" as const })),
  dependsOn,
});

const README = criterion(
  "AC-008",
  "README.md after the change",
  "a reader looks up the period command",
  'it contains ", default 3). For example" and "reports the period 5. Any reported period is a pattern detected in the finite sequence"',
);
const NAMES = criterion(
  "AC-009",
  "the test suite after the change",
  "cargo test runs",
  "the tests `two_cycles_are_enough_when_requested` and `cycles_below_two_are_rejected` pass",
);
const USAGE = criterion("AC-007", "the CLI", "it runs `period --cycles 4`", 'the usage line reads "period [--cycles <n>]"');
const spec: Spec["criteria"] = [USAGE, README, NAMES];

const T003 = task("T003", "Document --cycles in README.md.", ["AC-008"], ["README.md"]);
const T004 = task(
  "T004",
  "Write `two_cycles_are_enough_when_requested` in tests/period_tests.rs.",
  ["AC-009"],
  ["tests/period_tests.rs"],
);
const T005 = task(
  "T005",
  "Write `cycles_below_two_are_rejected` in tests/command_tests.rs.",
  ["AC-009"],
  ["tests/command_tests.rs"],
);
const T006 = task(
  "T006",
  'Update the three usage and README lines in the existing tests. Change exactly three lines and nothing else: the usage line becomes "period [--cycles <n>]".',
  ["AC-007", "AC-008", "AC-009"],
  ["tests/cli_tests.rs", "tests/docs_tests.rs"],
  ["T003", "T004", "T005"],
);
const tasks = [T003, T004, T005, T006];

describe("the case walk demands only what a task owns (#1771)", () => {
  test("grundykit T006 passes with its three changed lines", async () => {
    const root = workspace({
      "tests/cli_tests.rs": '#[test]\nfn usage() {\n    assert!(usage_text().contains("period [--cycles <n>]"));\n}\n',
      "tests/docs_tests.rs": '#[test]\nfn readme_has_the_required_sections() {\n    assert!(readme().contains("## period"));\n}\n',
    });
    const check = caseCheck({ criteria: spec }, T006, { checks: [], tasks });
    expect(check ? await check(root) : []).toEqual([]);
  });

  test("the README text belongs to the task that writes the README", () => {
    expect(criterionCases({ criteria: spec }, T003, { checks: [], tasks }).map((c) => c.literal)).toEqual([
      ", default 3). For example",
      "reports the period 5. Any reported period is a pattern detected in the finite sequence",
    ]);
  });

  test("a test name belongs to the sibling task whose description names it", () => {
    expect(criterionCases({ criteria: spec }, T004, { checks: [], tasks }).map((c) => c.literal)).toEqual([
      "two_cycles_are_enough_when_requested",
    ]);
  });

  test("an unrestricted test task still owes the README text it is not given elsewhere", () => {
    const docs = task("T006", "Test the README sections.", ["AC-008"], ["tests/docs_tests.rs"]);
    const alone = [docs];
    expect(criterionCases({ criteria: [README] }, docs, { checks: [], tasks: alone }).map((c) => c.literal)).toHaveLength(2);
  });

  test("a restricted task still owes the case its description names", async () => {
    const root = workspace({ "tests/cli_tests.rs": "#[test]\nfn usage() {}\n" });
    const check = caseCheck({ criteria: spec }, T006, { checks: [], tasks });
    expect(check ? await check(root) : []).toEqual([
      'AC-007 names "period [--cycles <n>]", and no test file this task writes (tests/cli_tests.rs, tests/docs_tests.rs) contains it.',
    ]);
  });

  test('"prints only one line" is not an edit limit', () => {
    const one = criterion("AC-001", "the CLI", "it runs `sum --strict 1 2`", "it prints only one line");
    const t = task("T001", "Test that sum prints only one line.", ["AC-001"], ["tests/sum_test.py"]);
    expect(criterionCases({ criteria: [one] }, t, { checks: [], tasks: [t] }).map((c) => c.literal)).toEqual(["sum --strict 1 2"]);
  });
});

// The walk has no language branch; each language's test-name shape and docs test must behave the same.
const LANGUAGES: { language: string; name: string; sibling: string; own: string; docs: string }[] = [
  { language: "rust", name: "two_cycles_are_enough", sibling: "tests/period_tests.rs", own: "tests/docs_tests.rs", docs: "README.md" },
  { language: "typescript", name: "rejectsCyclesBelowTwo", sibling: "tests/period.test.ts", own: "tests/docs.test.ts", docs: "README.md" },
  { language: "python", name: "test_cycles_below_two", sibling: "tests/test_period.py", own: "tests/test_docs.py", docs: "docs/usage.md" },
  { language: "go", name: "TestCyclesBelowTwo", sibling: "period_test.go", own: "docs_test.go", docs: "README.md" },
  { language: "java", name: "rejectsCyclesBelowTwo", sibling: "src/test/java/app/PeriodTest.java", own: "src/test/java/app/DocsTest.java", docs: "README.md" },
  { language: "csharp", name: "Rejects_cycles_below_two", sibling: "tests/App.Tests/PeriodTests.cs", own: "tests/App.Tests/DocsTests.cs", docs: "README.md" },
];

describe("case ownership in every language (#1771)", () => {
  for (const { language, name, sibling, own, docs } of LANGUAGES)
    test(language, async () => {
      const criteria = [
        criterion("AC-002", "the test suite", "the tests run", `\`${name}\` passes`),
        criterion("AC-003", `${docs} after the change`, "a reader opens it", 'it contains "--cycles <n> (default 3)"'),
      ];
      const writer = task("T001", `Document --cycles in ${docs}.`, ["AC-003"], [docs]);
      const owner = task("T002", `Write \`${name}\` in ${sibling}.`, ["AC-002"], [sibling]);
      const update = task("T003", "Update the docs test.", ["AC-002", "AC-003"], [own], ["T001", "T002"]);
      // A code task keeps AC-002 off most of the plan, so the broad-criterion exemption does not apply.
      const code = task("T000", "Add --cycles.", ["AC-001"], ["src/period.txt"]);
      const plan = [code, writer, owner, update];
      const check = caseCheck({ criteria }, update, { checks: [], tasks: plan });
      expect(check ? await check(workspace({ [own]: "// docs test\n" })) : []).toEqual([]);
      expect(criterionCases({ criteria }, owner, { checks: [], tasks: plan }).map((c) => c.literal)).toEqual([name]);
    });
});

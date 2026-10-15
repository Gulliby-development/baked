import { describe, expect, test } from "bun:test";
import { failedCheckFindings, pathsInOutput } from "../src/core/verification/convergence.js";
import type { Task } from "../src/core/workflows/types.js";

const task = (id: string, paths: string[], criteria: string[]): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: criteria,
  dependsOn: [],
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" as const })),
  readHints: [],
  checkIds: ["lint"],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const tasks = [
  task("T001", ["src/expenses/parser.py"], ["AC-001"]),
  task("T005", ["tests/test_parser.py"], ["AC-001"]),
  task("T006", ["tests/test_cli.py"], ["AC-003"]),
  task("T007", ["tests/test_report.py"], ["AC-002"]),
];
let counter = 0;
const newId = () => `F${++counter}`;

describe("failed check findings", () => {
  // Run 6931efd6: ruff named files of three test tasks; the single finding without a file went to
  // the first task and its correction could not edit the other two.
  test("each task whose file the check output names gets its own finding", () => {
    const output = [
      "C:\\Project\\baked-bench\\expenses-py\\tests\\test_cli.py:3:1: FURB157 Verbose expression",
      "tests/test_report.py:12:5: FURB157 Verbose expression",
      "tests/test_report.py:20:5: FURB157 Verbose expression",
      "Found 3 errors.",
    ].join("\n");
    const findings = failedCheckFindings({ id: "lint" }, "E1", output, tasks, tasks[0] as Task, "fix", newId);
    expect(findings.map((f) => [f.file, f.criterionIds])).toEqual([
      ["tests/test_cli.py", ["AC-003"]],
      ["tests/test_report.py", ["AC-002"]],
    ]);
  });

  test("output that names no planned file keeps one finding without a file", () => {
    const findings = failedCheckFindings({ id: "lint" }, "E1", "error: config invalid", tasks, tasks[0] as Task, "fix", newId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBeNull();
    expect(findings[0]?.criterionIds).toEqual(["AC-001"]);
  });

  test("a path is matched whole, not as a prefix of a longer one", () => {
    expect(pathsInOutput("tests/test_cli.pyc is stale", tasks)).toEqual([]);
    expect(pathsInOutput("old/tests/test_cli.py:1", tasks)).toEqual(["tests/test_cli.py"]);
  });

  test("a path written in Markdown is matched (#1207)", () => {
    for (const text of ["between `tests/test_cli.py::test_x` (requires", "**tests/test_cli.py**", "[tests/test_cli.py](x)", "a,tests/test_cli.py", "path=tests/test_cli.py", "<tests/test_cli.py>"])
      expect(pathsInOutput(text, tasks)).toEqual(["tests/test_cli.py"]);
    expect(pathsInOutput("`tests/test_cli.pyc`", tasks)).toEqual([]);
  });
});

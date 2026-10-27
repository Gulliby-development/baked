import { describe, expect, test } from "bun:test";
import { missingPlannedPaths } from "../src/core/verification/convergence.js";
import { withinBaseline } from "../src/core/verification/output-counts.js";
import type { Task, TaskGraph } from "../src/core/workflows/schemas.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { failureOwner, failureOwnerNote } from "../src/core/workflows/task-graph.js";

// A required gate that names a folder a later task creates fails with only "path does not exist"
// until that task runs (rpn 09a1c786, #1913). Every shape in MISSING_PATH_LINES has a case here.

const task = (id: string, paths: string[], dependsOn: string[] = []): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Fixture" });
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
const row = (t: Task, status: string): TaskRow => ({ id: t.id, status }) as TaskRow;

describe("missingPlannedPaths: the planned files under a path a gate says does not exist (#1913)", () => {
  const tasks = [task("T001", ["src/rpn/core.py"]), task("T002", ["tests/test_core.py", "tests/unit/test_ops.py"])];
  const tests = ["tests/test_core.py", "tests/unit/test_ops.py"];
  for (const [tool, output] of [
    ["ruff", "E902 No such file or directory (os error 2)\n --> tests:1:1\n\nFound 1 error."],
    ["ruff (older) and flake8", "tests:0:1: E902 FileNotFoundError: [Errno 2] No such file or directory: 'tests'"],
    ["mypy", "mypy: can't read file 'tests': No such file or directory"],
    ["black", "Usage: black [OPTIONS] SRC ...\nError: Invalid value for 'SRC ...': Path 'tests' does not exist."],
    ["pytest", "ERROR: file or directory not found: tests/\n\n===== no tests ran in 0.01s ====="],
    ["eslint", 'Oops! Something went wrong! :(\n\nESLint: 9.12.0\n\nNo files matching the pattern "tests" were found.'],
    ["phpstan", "Path /work/app/tests does not exist"],
    ["go test", "stat /work/app/tests: directory not found"],
    ["go vet", 'go: warning: "./tests/..." matched no packages\nno packages to vet'],
    ["luacheck", "Checking tests                                    I/O error\n\nTotal: 0 warnings / 0 errors in 0 files, couldn't check 1 file"],
    // Pasted from sqlfluff 4.4.0 (#1499).
    ["sqlfluff", "\nUser Error: Specified path does not exist. Check it/they exist(s): tests."],
    // Pasted from PowerShell 7.5, PSScriptAnalyzer 1.24 and Pester 5.9 (#1498).
    ["Invoke-ScriptAnalyzer", "Invoke-ScriptAnalyzer: Cannot find path '/work/app/tests' because it does not exist."],
    // Pasted from R 4.3 and testthat 3.2 (#1500).
    ["Rscript", "Error in `testthat::test_dir()`:\n! No test files found\nWarning message:\nIn normalizePath(path) : path[1]=\"tests\": No such file or directory\nExecution halted"],
    ["Invoke-Pester", "Get-ChildItem: Cannot find path 'C:\\work\\app\\tests\\' because it does not exist.\nSystem.Management.Automation.RuntimeException: No test files were found and no scriptblocks were provided."],
  ] as const)
    test(tool, () => expect(missingPlannedPaths(output, tasks)).toEqual(tests));

  test("a planned file itself, and a folder above several", () => {
    expect(missingPlannedPaths("ERROR: file or directory not found: tests/unit/test_ops.py", tasks)).toEqual(["tests/unit/test_ops.py"]);
    expect(missingPlannedPaths("ERROR: file or directory not found: tests/unit", tasks)).toEqual(["tests/unit/test_ops.py"]);
  });

  test("no missing path: a lint error's location, another folder, a relative suffix", () => {
    expect(missingPlannedPaths("F401 [*] `os` imported but unused\n --> tests/test_core.py:1:8\n\nFound 1 error.", tasks)).toEqual([]);
    expect(missingPlannedPaths("E902 No such file or directory (os error 2)\n --> docs:1:1", tasks)).toEqual([]);
    expect(missingPlannedPaths("ERROR: file or directory not found: other/tests", tasks)).toEqual([]);
    expect(missingPlannedPaths("tests/test_core.py:3:1: F401 'os' imported but unused", tasks)).toEqual([]);
  });
});

describe("failureOwner: a missing path a later task creates is that task's (#1913)", () => {
  const output = "E902 No such file or directory (os error 2)\n --> tests:1:1\n\nFound 1 error.";
  const source = task("T001", ["src/rpn/core.py"]);
  test("a dependent creator takes the failure over; an independent one defers the check", () => {
    const dependent = task("T002", ["tests/test_core.py"], ["T001"]);
    const owner = failureOwner(graph(source, dependent), [row(source, "implemented"), row(dependent, "pending")], {}, source, output);
    expect(owner).toMatchObject({ kind: "creates", owners: ["T002"] });
    expect(failureOwnerNote(owner)).toContain("do not exist yet");
    const independent = task("T002", ["tests/test_core.py"]);
    expect(failureOwner(graph(source, independent), [row(independent, "pending")], {}, source, output)).toMatchObject({ kind: "pending", owners: ["T002"] });
  });
  test("the task's own folder, a finished creator or an error in the task's file stay with the task", () => {
    const creator = task("T002", ["tests/test_core.py"], ["T001"]);
    const own = task("T001", ["src/rpn/core.py", "tests/conftest.py"]);
    expect(failureOwner(graph(own, creator), [row(creator, "pending")], {}, own, output).kind).not.toBe("creates");
    expect(failureOwner(graph(source, creator), [row(creator, "verified")], {}, source, output).kind).toBe("unowned");
    const mixed = `${output}\nsrc/rpn/core.py:1:1: F401 'os' imported but unused`;
    expect(failureOwner(graph(source, creator), [row(creator, "pending")], {}, source, mixed).kind).toBe("self");
  });
});

describe("withinBaseline: a failure that reports only what the baseline did (#1913)", () => {
  const both = "E902 No such file or directory (os error 2)\n --> src\nE902 No such file or directory (os error 2)\n --> tests\nFound <n> error.";
  test("a subset of the baseline's lines is the baseline's; a new line or no line is not", () => {
    expect(withinBaseline(both, "E902 No such file or directory (os error 2)\n --> tests\nFound <n> error.")).toBe(true);
    expect(withinBaseline(both, both)).toBe(true);
    expect(withinBaseline(both, "F401 `os` imported but unused\n --> src/rpn/core.py\nFound <n> error.")).toBe(false);
    expect(withinBaseline(both, "")).toBe(false);
  });
});

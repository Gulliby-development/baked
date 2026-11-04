import { describe, expect, test } from "bun:test";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { missingArtifactOwners, namesPath } from "../src/core/workflows/task-graph.js";
import type { Task } from "../src/core/workflows/types.js";

// #2672: namesPath matched a planned path anywhere inside the text, so `test_wordcount.py` named
// `wordcount.py` and `src/app.tsx` named `src/app.ts`. A task's own unresolved test failure was
// then dropped as "another task's file", and a blocked task waited for an unrelated task.

const task = (id: string, path: string, dependsOn: string[] = []): Task => ({
  id,
  title: `Write ${path}`,
  description: `Write ${path}.`,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn,
  profileId: "implementer",
  writes: [{ path, action: "create" }],
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: "fixture",
});

describe("namesPath matches whole file names (#2672)", () => {
  test("a longer file name that ends with the path does not name it", () => {
    expect(namesPath("FAILED test_wordcount.py::test_empty - AssertionError", "wordcount.py")).toBe(false);
    expect(namesPath("tests/test_cli.py:12: assert 1 == 2", "cli.py")).toBe(false);
    expect(namesPath("see my-cli.py", "cli.py")).toBe(false);
  });

  test("a longer extension does not name the path", () => {
    expect(namesPath("src/app.tsx(3,1): error TS2304", "src/app.ts")).toBe(false);
    expect(namesPath("wrote src/app.ts.map", "src/app.ts")).toBe(false);
  });

  test("the path itself, after a directory or punctuation, still names it", () => {
    expect(namesPath("FAILED wordcount.py::test_empty", "wordcount.py")).toBe(true);
    expect(namesPath('File "/tmp/w/wordcount.py", line 3', "wordcount.py")).toBe(true);
    expect(namesPath("C:\\work\\src\\app.ts(3,1): error", "src/app.ts")).toBe(true);
    expect(namesPath("`src/app.ts` is missing.", "src/app.ts")).toBe(true);
    expect(namesPath("Missing wordcount.py.", "wordcount.py")).toBe(true);
    expect(namesPath("src/app.ts:3:1 error", "src/app.ts")).toBe(true);
  });

  test("a blocked task does not wait for a task whose file name ends its own", () => {
    const graph: TaskGraph = {
      schemaVersion: 1,
      featureId: "fixture",
      revision: 1,
      specHash: "a".repeat(64),
      planHash: "b".repeat(64),
      tasks: [task("T001", "wordcount.py"), task("T002", "count.py")],
    };
    const rows = [
      { id: "T001", status: "running" },
      { id: "T002", status: "pending" },
    ] as TaskRow[];
    const account = { summary: "Blocked: wordcount.py raises TypeError on empty input", unresolved: [] };
    expect(missingArtifactOwners(graph, rows, graph.tasks[0] as Task, account)).toEqual([]);
  });
});

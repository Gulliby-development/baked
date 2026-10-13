import { describe, expect, test } from "bun:test";
import { withReadHintDependencies } from "../src/core/workflows/plan-consistency.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

type Write = Task["writes"][number];
const task = (id: string, writes: Write[], readHints: string[] = [], dependsOn: string[] = []): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn,
  profileId: "implementer",
  writes,
  readHints,
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const graphOf = (...tasks: Task[]): TaskGraph =>
  ({ schemaVersion: 1, featureId: "f", revision: 1, specHash: "a", planHash: "b", tasks }) as TaskGraph;
const deps = (graph: TaskGraph) => graph.tasks.map((t) => t.dependsOn);
const modify = (path: string): Write => ({ path, action: "modify" });
const create = (path: string): Write => ({ path, action: "create" });

// zoneslot-update c941a83a: T002 read src/overlap.ts, which T001 changed, and ran beside it.
describe("a task waits for the tasks that write its read hints", () => {
  test("the reader of a modified file depends on its writer", () => {
    const out = withReadHintDependencies(
      graphOf(task("T001", [modify("src/overlap.ts")]), task("T002", [modify("src/App.tsx")], ["src/overlap.ts"])),
    );
    expect(deps(out)).toEqual([[], ["T001"]]);
  });

  test("a created file counts, a deleted one and an unwritten hint do not", () => {
    const out = withReadHintDependencies(
      graphOf(
        task("T001", [create("src/a.ts")]),
        task("T002", [{ path: "src/old.ts", action: "delete" }]),
        task("T003", [create("src/b.ts")], ["src/a.ts", "src/old.ts", "README.md"]),
      ),
    );
    expect(deps(out)).toEqual([[], [], ["T001"]]);
  });

  test("an existing edge in either direction and a hint the task writes itself add nothing", () => {
    const out = withReadHintDependencies(
      graphOf(
        task("T001", [modify("src/a.ts")], ["src/b.ts"]),
        task("T002", [modify("src/b.ts")], ["src/a.ts"], ["T001"]),
        task("T003", [modify("src/c.ts")], ["src/c.ts"], ["T001"]),
      ),
    );
    // T001 reads T002's file, but T002 already depends on T001: no cycle is added.
    expect(deps(out)).toEqual([[], ["T001"], ["T001"]]);
  });
});

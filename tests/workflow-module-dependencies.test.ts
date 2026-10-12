import { describe, expect, test } from "bun:test";
import { withModuleDependencies } from "../src/core/workflows/plan-consistency.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

const task = (id: string, paths: string[], dependsOn: string[] = []): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn,
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" as const })),
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const graphOf = (...tasks: Task[]): TaskGraph =>
  ({ schemaVersion: 1, featureId: "f", revision: 1, specHash: "a", planHash: "b", tasks }) as TaskGraph;
const deps = (graph: TaskGraph) => graph.tasks.map((t) => t.dependsOn);

// Bench round 08, commitbump: T001 wrote lib.rs (`pub mod parse; pub mod render;`) while T002, in
// parallel, wrote parse.rs and render.rs; every check of T001 failed on the missing files.
describe("module index tasks wait for the tasks that create their modules", () => {
  test("a crate's lib.rs and main.rs wait for the task that writes parse.rs and render.rs", () => {
    const out = withModuleDependencies(
      graphOf(
        task("T001", ["src/lib.rs", "src/main.rs", "src/version.rs"]),
        task("T002", ["src/parse.rs", "src/render.rs"]),
        task("T003", ["tests/docs.rs"]),
      ),
    );
    expect(deps(out)).toEqual([["T002"], [], []]);
  });

  test("Python packages and TypeScript barrels follow the same rule", () => {
    const out = withModuleDependencies(
      graphOf(
        task("T001", ["app/__init__.py"]),
        task("T002", ["app/store.py"]),
        task("T003", ["src/index.ts"]),
        task("T004", ["src/util/index.ts"]),
        task("T005", ["src/other/deep/x.ts"]),
      ),
    );
    expect(deps(out)).toEqual([["T002"], [], ["T004"], [], []]);
  });

  test("a dependency that would close a cycle, or one that exists, is not added", () => {
    const cyclic = withModuleDependencies(
      graphOf(task("T001", ["src/lib.rs"]), task("T002", ["src/parse.rs"], ["T001"])),
    );
    expect(deps(cyclic)).toEqual([[], ["T001"]]);
    const known = withModuleDependencies(
      graphOf(task("T001", ["src/lib.rs"], ["T002"]), task("T002", ["src/parse.rs"])),
    );
    expect(deps(known)).toEqual([["T002"], []]);
  });

  test("tasks without a module index, or in another directory, stay independent", () => {
    const out = withModuleDependencies(
      graphOf(task("T001", ["crates/a/src/lib.rs"]), task("T002", ["crates/b/src/parse.rs"]), task("T003", ["README.md"])),
    );
    expect(deps(out)).toEqual([[], [], []]);
  });
});

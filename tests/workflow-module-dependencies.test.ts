import { describe, expect, test } from "bun:test";
import {
  withCommandDependencies,
  withImplementationProfiles,
  withModuleDependencies,
  withReadDependencies,
} from "../src/core/workflows/plan-consistency.js";
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

// zoneslot-update c941a83a: T002 (App.tsx) read overlap.ts, which T001 wrote, with no dependency;
// both ran in one wave and T002's typecheck failed before overlap.ts had its new export.
describe("a task waits for the tasks that write the files it reads", () => {
  const reading = (id: string, paths: string[], readHints: string[], dependsOn: string[] = []): Task => ({
    ...task(id, paths, dependsOn),
    readHints,
  });
  test("a read hint another task writes becomes a dependency", () => {
    const out = withReadDependencies(
      graphOf(task("T001", ["src/overlap.ts"]), reading("T002", ["src/App.tsx"], ["src/overlap.ts", "src/other.ts"])),
    );
    expect(deps(out)).toEqual([[], ["T001"]]);
  });
  test("its own files, deletions, existing edges and cycles add nothing", () => {
    const deleting: Task = { ...task("T001", []), writes: [{ path: "src/old.ts", action: "delete" }] };
    const out = withReadDependencies(
      graphOf(
        deleting,
        reading("T002", ["src/a.ts"], ["src/a.ts", "src/old.ts"]),
        reading("T003", ["src/b.ts"], ["src/c.ts"]),
        reading("T004", ["src/c.ts"], ["src/b.ts"]),
        reading("T005", ["src/d.ts"], ["src/c.ts"], ["T004"]),
      ),
    );
    // T003 and T004 read each other's files: the first waits, the second does not close a cycle.
    expect(deps(out)).toEqual([[], [], ["T004"], [], ["T004"]]);
  });
});

// Bench round 12, cfgtrace 4018a791: T011 (README with worked-example output) had no dependency
// and ran in the first wave beside T001 while the CLI was T005; it found no `cfgtrace.__main__`
// in its worktree and blocked the run.
describe("a docs task that runs the program waits for its entry points", () => {
  const described = (id: string, paths: string[], description: string, dependsOn: string[] = []): Task => ({
    ...task(id, paths, dependsOn),
    description,
  });
  test("a README that captures CLI output depends on the tasks writing the entry points", () => {
    const out = withCommandDependencies(
      graphOf(
        task("T001", ["cfgtrace/model.py"]),
        task("T005", ["cfgtrace/cli.py", "cfgtrace/__main__.py"], ["T001"]),
        task("T006", ["bin/cfgtrace"]),
        described("T011", ["README.md"], "Document usage with a worked example: run the CLI on the sample config and paste its output."),
      ),
    );
    expect(deps(out)).toEqual([[], ["T001"], [], ["T005", "T006"]]);
  });
  test("docs that run nothing, code tasks, test entry points and cycles add nothing", () => {
    const out = withCommandDependencies(
      graphOf(
        task("T001", ["src/main.ts"]),
        described("T002", ["docs/design.md"], "Describe the module layout and the data model."),
        described("T003", ["src/util.ts"], "Run the CLI and capture its output in a fixture."),
        task("T004", ["tests/main.test.ts"]),
        described("T005", ["README.md"], "Show sample output of the command.", ["T004"]),
        described("T006", ["src/server.ts"], "Serve the notes", ["T007"]),
        described("T007", ["docs/notes.md"], "Notes", ["T005"]),
      ),
    );
    // T005 waits for T001 but not for T006, which reaches it through the notes task already.
    expect(deps(out)).toEqual([[], [], [], [], ["T004", "T001"], ["T007"], ["T005"]]);
  });
});

// Bench round 09, commitbump dde8747e: the planner wrote "planner" as profileId on all 7 tasks and
// the host rejected the whole plan.
describe("tasks get an implementation profile", () => {
  const profiles = [
    { id: "planner", output: "plan" },
    { id: "implementer", output: "implementation" },
    { id: "writer", output: "implementation" },
  ] as const;
  const named = (id: string, profileId: string): Task => ({ ...task(id, [`src/${id}.ts`]), profileId });
  test("a task naming a non-implementation or unknown profile gets the default implementer", () => {
    const out = withImplementationProfiles(graphOf(named("T001", "planner"), named("T002", "writer"), named("T003", "coder")), profiles);
    expect(out.tasks.map((t) => t.profileId)).toEqual(["implementer", "writer", "implementer"]);
  });
  test("without an implementer profile the first implementation profile is used; without any the graph is kept", () => {
    const writerOnly = [{ id: "planner", output: "plan" }, { id: "writer", output: "implementation" }] as const;
    expect(withImplementationProfiles(graphOf(named("T001", "planner")), writerOnly).tasks[0]?.profileId).toBe("writer");
    const graph = graphOf(named("T001", "planner"));
    expect(withImplementationProfiles(graph, [{ id: "planner", output: "plan" }])).toBe(graph);
  });
});

import { describe, expect, test } from "bun:test";
import { unwiredEntryPoints, withModuleDependencies } from "../src/core/workflows/plan-consistency.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

const task = (id: string, writes: Array<string | [string, "create" | "modify"]>, dependsOn: string[] = []): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn,
  profileId: "implementer",
  writes: writes.map((w) => (typeof w === "string" ? { path: w, action: "create" as const } : { path: w[0], action: w[1] })),
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const graphOf = (...tasks: Task[]): TaskGraph =>
  ({ schemaVersion: 1, featureId: "f", revision: 1, specHash: "a", planHash: "b", tasks }) as TaskGraph;

// linehunk f0b66451: T001 created Cli.java delegating to a CommandHandler that no later task installed.
describe("code created after the entry point is wired into it", () => {
  const foundation = task("T001", ["src/main/java/linehunk/Cli.java", "src/main/java/linehunk/CommandHandler.java"]);
  const diff = task("T002", ["src/main/java/linehunk/Diff.java"], ["T001"]);
  const patch = task("T003", ["src/main/java/linehunk/Patch.java"], ["T002"]);
  const tests = task("T004", ["src/test/java/linehunk/CliTest.java"], ["T003"]);

  test("a foundation entry point that no later task writes is reported", () => {
    const [problem, ...rest] = unwiredEntryPoints(graphOf(foundation, diff, patch, tests));
    expect(rest).toEqual([]);
    expect(problem).toContain("T001 creates the entry point src/main/java/linehunk/Cli.java");
    expect(problem).toContain("T002, T003 create code after it");
  });

  test("a later task that writes the entry point or a file the entry task created wires them", () => {
    const wire = task("T005", [["src/main/java/linehunk/Cli.java", "modify"]], ["T003"]);
    expect(unwiredEntryPoints(graphOf(foundation, diff, patch, tests, wire))).toEqual([]);
    const registry = task("T003", ["src/main/java/linehunk/Patch.java", ["src/main/java/linehunk/CommandHandler.java", "modify"]], ["T002"]);
    expect(unwiredEntryPoints(graphOf(foundation, diff, registry, tests))).toEqual([]);
  });

  test("an entry point written last, tests, other languages and Rust module indexes are not reported", () => {
    const last = task("T003", ["src/cli.ts"], ["T001", "T002"]);
    expect(unwiredEntryPoints(graphOf(task("T001", ["src/parse.ts"]), task("T002", ["src/render.ts"]), last))).toEqual([]);
    expect(unwiredEntryPoints(graphOf(task("T001", ["src/cli.py"]), task("T002", ["tests/test_cli.py", "docs/cli.md"], ["T001"])))).toEqual([]);
    // The host orders main.rs after the modules beside it, so it runs last.
    const crate = withModuleDependencies(graphOf(task("T001", ["src/main.rs"]), task("T002", ["src/parse.rs"])));
    expect(unwiredEntryPoints(crate)).toEqual([]);
  });
});

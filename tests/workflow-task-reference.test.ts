import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import {
  fileReferences,
  planConsistencyProblems,
  withReadDependencies,
} from "../src/core/workflows/plan-consistency.js";
import { type Spec, TaskGraphSchema, type TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const task = (id: string, writes: string[], extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: writes.map((path) => ({ path, action: "create" as const })),
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: id,
  ...extra,
});
const graphOf = (...tasks: Task[]): TaskGraph => ({
  schemaVersion: 1,
  featureId: "f",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks,
});
const spec = {
  requirements: [{ id: "FR-001" }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"] }],
} as unknown as Spec;

// #645: agents copy the nearest pattern; the plan names the one to follow.
describe("a task's reference file", () => {
  test("the task graph schema accepts a reference and keeps it optional", () => {
    const graph = graphOf(task("T001", ["src/b.ts"], { reference: "src/a.ts" }), task("T002", ["src/c.ts"]));
    const parsed = TaskGraphSchema.parse(graph);
    expect(parsed.tasks[0]?.reference).toBe("src/a.ts");
    expect(parsed.tasks[1]?.reference).toBeUndefined();
    expect(TaskGraphSchema.safeParse(graphOf(task("T001", ["src/b.ts"], { reference: "../x.ts" }))).success).toBe(false);
  });

  test("a reference that does not exist and that no earlier task creates is a plan problem", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-ref-"));
    dirs.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/existing.ts"), "export const a = 1;\n");
    const graph = graphOf(
      task("T001", ["src/first.ts"]),
      task("T002", ["src/b.ts"], { reference: "src/existing.ts" }),
      task("T003", ["src/c.ts"], { reference: "src/first.ts", dependsOn: ["T001"] }),
      task("T004", ["src/d.ts"], { reference: "src/missing.ts" }),
      task("T005", ["src/e.ts"], { reference: "src/e.ts" }),
    );
    const problems = planConsistencyProblems(root, spec, "", graph);
    expect(problems.filter((p) => p.includes("reference"))).toEqual([
      "T004 reference src/missing.ts does not exist and no earlier task creates it; name an existing file that shows the pattern, or leave reference out",
      "T005 reference src/e.ts does not exist and no earlier task creates it; name an existing file that shows the pattern, or leave reference out",
    ]);
  });

  test("a task waits for the task that writes its reference", () => {
    const out = withReadDependencies(
      graphOf(task("T001", ["src/handler.ts"]), task("T002", ["src/other.ts"], { reference: "src/handler.ts" })),
    );
    expect(out.tasks.map((t) => t.dependsOn)).toEqual([[], ["T001"]]);
  });

  test("the correctness review gets each written file mapped to its task's reference", () => {
    const graph = graphOf(
      task("T001", ["src/b.ts", "tests/b.test.ts"], { reference: "src/a.ts" }),
      task("T002", ["src/c.ts"]),
      { ...task("T003", [], { reference: "src/a.ts" }), writes: [{ path: "src/old.ts", action: "delete" }] },
    );
    expect(fileReferences(graph)).toEqual({ "src/b.ts": "src/a.ts", "tests/b.test.ts": "src/a.ts" });
  });

  test("the planner, implementer and correctness reviewer are told about it", () => {
    const instructions = (id: string) => builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    expect(instructions("planner")).toContain("reference");
    expect(instructions("implementer")).toContain("names a reference");
    expect(instructions("reviewer")).toContain("extra.references");
  });
});

// #778: a modify of a file that neither exists nor is created earlier fails in the tool policy.
describe("a task's modify targets", () => {
  test("a modify target must exist or be created by an earlier task", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-modify-"));
    dirs.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/existing.rs"), "fn main() {}\n");
    const modify = (id: string, path: string, extra: Partial<Task> = {}): Task => ({
      ...task(id, [], extra),
      writes: [{ path, action: "modify" }],
    });
    const graph = graphOf(
      task("T001", ["src/scan.rs"]),
      modify("T002", "src/existing.rs"),
      modify("T003", "src/scan.rs", { dependsOn: ["T001"] }),
      modify("T004", "src/missing.rs"),
    );
    const problems = planConsistencyProblems(root, spec, "", graph, () => false, true);
    expect(problems).toEqual([
      "T004 modifies src/missing.rs, which does not exist and no earlier task creates it; depend on the task that creates it, or use create",
    ]);
  });
});

// #1932: a planned-ahead run plans on a provisional base without its unfinished upstream files.
describe("files an unfinished upstream feature writes", () => {
  test("a read hint or reference may name them; a modify of them and a file nobody writes are still refused", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-later-"));
    dirs.push(root);
    const later = (path: string) => path.startsWith("pkg/upstream/");
    const graph = graphOf(
      task("T001", ["pkg/own.py"], { readHints: ["pkg/upstream/target.py"], reference: "pkg/upstream/tags.py" }),
      task("T002", ["pkg/other.py"], { readHints: ["pkg/nobody.py"], reference: "pkg/missing.py" }),
      { ...task("T003", []), writes: [{ path: "pkg/upstream/target.py", action: "modify" }] },
    );
    const problems = planConsistencyProblems(root, spec, "", graph, () => false, true, undefined, later);
    expect(problems).toEqual([
      "T002 read hint pkg/nobody.py does not exist and no earlier task creates it",
      "T002 reference pkg/missing.py does not exist and no earlier task creates it; name an existing file that shows the pattern, or leave reference out",
      "T003 modifies pkg/upstream/target.py, which does not exist and no earlier task creates it; depend on the task that creates it, or use create",
    ]);
    // Without the planned-ahead paths, the upstream files are refused as before.
    expect(planConsistencyProblems(root, spec, "", graph, () => false, true).filter((p) => p.startsWith("T001"))).toHaveLength(2);
  });
});

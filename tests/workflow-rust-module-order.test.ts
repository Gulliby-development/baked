import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planConsistencyProblems,
  withModuleDependencies,
} from "../src/core/workflows/plan-consistency.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

// Plan of bench round 31 (#1299). idpeek a270ff5a: T001 wrote a skeleton src/lib.rs, T002 to T007
// created the module files with per-task clippy, and T008 "registered all modules" in lib.rs.
// Cargo compiled none of those modules until T008, so clippy found 11 errors at once there.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const task = (
  id: string,
  writes: Array<[string, "create" | "modify"]>,
  extra: Partial<Task> = {},
): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: writes.map(([path, action]) => ({ path, action })),
  readHints: [],
  checkIds: ["clippy"],
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
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "baked-rust-modules-"));
  dirs.push(root);
  return root;
};
const moduleProblems = (graph: TaskGraph, root: string) =>
  planConsistencyProblems(root, spec, "", withModuleDependencies(graph)).filter((p) =>
    p.includes("Rust module"),
  );

describe("plan: Rust modules registered by a later task (#1299)", () => {
  test("a task that creates a module without declaring it goes back to the planner", () => {
    const graph = graphOf(
      task("T001", [["Cargo.toml", "create"], ["src/lib.rs", "create"], ["src/main.rs", "create"]]),
      task("T002", [["src/text.rs", "create"]], { dependsOn: ["T001"] }),
      task("T003", [["src/scan/mod.rs", "create"], ["src/scan/walk.rs", "create"]], { dependsOn: ["T001"] }),
      task("T008", [["src/lib.rs", "modify"]], { dependsOn: ["T002", "T003"] }),
    );
    expect(moduleProblems(graph, workspace())).toEqual([
      "T002 creates the Rust module src/text.rs but does not write src/lib.rs or src/main.rs, which declares it, so T002's checks (clippy) never compile it and its errors surface only after the task that adds the mod line. Add src/lib.rs to T002's writes and declare the module there; the host orders tasks that write the same index.",
      "T003 creates the Rust module src/scan/mod.rs but does not write src/lib.rs or src/main.rs, which declares it, so T003's checks (clippy) never compile it and its errors surface only after the task that adds the mod line. Add src/lib.rs to T003's writes and declare the module there; the host orders tasks that write the same index.",
    ]);
  });

  test("each task declaring its own module passes, ordered by the host", () => {
    const graph = graphOf(
      task("T001", [["Cargo.toml", "create"], ["src/lib.rs", "create"]]),
      task("T002", [["src/text.rs", "create"], ["src/lib.rs", "modify"]], { dependsOn: ["T001"] }),
      task("T003", [["src/scan/mod.rs", "create"], ["src/scan/walk.rs", "create"], ["src/lib.rs", "modify"]], { dependsOn: ["T001"] }),
    );
    expect(planConsistencyProblems(workspace(), spec, "", withModuleDependencies(graph))).toEqual([]);
  });

  test("tests, binaries, tasks without checks and other languages are not flagged", () => {
    const graph = graphOf(
      task("T001", [["Cargo.toml", "create"], ["src/lib.rs", "create"]]),
      task("T002", [["tests/common/mod.rs", "create"], ["tests/cli.rs", "create"]], { dependsOn: ["T001"] }),
      task("T003", [["src/bin/tool.rs", "create"]], { dependsOn: ["T001"] }),
      task("T004", [["src/later.rs", "create"]], { dependsOn: ["T001"], checkIds: [] }),
      task("T005", [["pkg/__init__.py", "create"]]),
      task("T006", [["pkg/util.py", "create"]], { dependsOn: ["T005"] }),
      task("T009", [["src/lib.rs", "modify"]], { dependsOn: ["T004"] }),
    );
    expect(moduleProblems(graph, workspace())).toEqual([]);
  });
});

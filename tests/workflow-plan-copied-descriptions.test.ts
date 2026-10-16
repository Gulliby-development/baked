import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copiedTaskTexts, planConsistencyProblems } from "../src/core/workflows/plan-consistency.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { SPLIT_PART } from "../src/core/workflows/sizing.js";
import type { Task } from "../src/core/workflows/types.js";

// Plan of bench round 37 (#1377). vtsnap-update b436e161: T003, T004 and T005 had the same title
// and description, "Create DiffIgnoreStyleTests.cs following CliTests layout ...", while T004 and
// T005 only modify CliTests.cs and DocsTests.cs, so two tasks worked from another task's text.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COPIED = "Create DiffIgnoreStyleTests.cs following CliTests layout, cover --ignore-style for text and JSON output. Define its own private in-memory IIo.";
const task = (id: string, path: string, action: "create" | "modify", description: string): Task => ({
  id,
  title: "Add in-memory feature tests and update usage expectations",
  description,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: [{ path, action }],
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const graphOf = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "f", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
const spec = { requirements: [{ id: "FR-001" }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"] }] } as unknown as Spec;

describe("plan: task descriptions copied from another task (#1377)", () => {
  test("identical descriptions and a description that creates another task's file go back to the planner", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-copied-tasks-"));
    dirs.push(root);
    const graph = graphOf(
      task("T003", "tests/VtSnap.Tests/DiffIgnoreStyleTests.cs", "create", COPIED),
      task("T004", "tests/VtSnap.Tests/CliTests.cs", "create", COPIED),
      task("T005", "tests/VtSnap.Tests/DocsTests.cs", "create", COPIED),
    );
    expect(copiedTaskTexts(graph)).toEqual([
      "T003, T004, T005 have the same description; give each task the description of its own writes",
      "T004's description says to create DiffIgnoreStyleTests.cs, which T003 writes and T004 does not; describe the files T004 writes",
      "T005's description says to create DiffIgnoreStyleTests.cs, which T003 writes and T005 does not; describe the files T005 writes",
    ]);
    expect(planConsistencyProblems(root, spec, "", graph)).toEqual(copiedTaskTexts(graph));
  });

  test("tasks with their own descriptions pass, also when a description names a file it reads", () => {
    const graph = graphOf(
      task("T003", "tests/DiffIgnoreStyleTests.cs", "create", COPIED),
      task("T004", "tests/CliTests.cs", "modify", "Update the usage expectation in CliTests.cs for the new --ignore-style flag, reading DiffIgnoreStyleTests.cs for the names."),
      task("T005", "tests/DocsTests.cs", "modify", "Add --ignore-style to the documented options checked by DocsTests.cs; write a short README line."),
      task("T006", "src/a.ts", "create", "Write a.ts"),
      task("T007", "src/b.ts", "create", "Write b.ts"),
    );
    expect(copiedTaskTexts(graph)).toEqual([]);
  });

  test("the parts of a sizing split keep their task's description without a problem", () => {
    const original = "Write tests/test_schema.py and tests/test_sources.py";
    const graph = graphOf(
      task("T003", "tests/test_schema.py", "create", `${original}\n${SPLIT_PART} write only tests/test_schema.py; tests/test_sources.py belong to the other parts of T003.`),
      task("T004", "tests/test_sources.py", "create", `${original}\n${SPLIT_PART} write only tests/test_sources.py; tests/test_schema.py belong to the other parts of T003.`),
    );
    expect(copiedTaskTexts(graph)).toEqual([]);
  });
});

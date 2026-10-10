import { describe, expect, test } from "bun:test";
import { correctionAuthorized, correctionWrites } from "../src/core/verification/convergence.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

const task = (id: string, paths: string[], criteria: string[], extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: criteria,
  dependsOn: [],
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "modify" as const })),
  readHints: [],
  checkIds: ["tests"],
  origin: "planned",
  findingIds: [],
  rationale: id,
  ...extra,
});
const code = task("T001", ["src/parse.ts", "src/usage.ts"], ["AC-001", "AC-002"]);
const tests = task("T002", ["tests/usage.test.ts"], ["AC-001"], { dependsOn: ["T001"] });
const other = task("T003", ["src/other.ts"], ["AC-009"]);
const root: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [code, tests, other],
};

describe("correction scope", () => {
  // Run 7c8bb5af: a review finding on the parser also needed the test that pinned the old default,
  // which belonged to the separate test task, so the correction could not finish.
  test("a correction of the code task may also write the tests of tasks with the same criteria", () => {
    const writes = correctionWrites(code, root, {}).map((w) => w.path);
    expect(writes).toEqual(["src/parse.ts", "src/usage.ts", "tests/usage.test.ts"]);
    expect(writes).not.toContain("src/other.ts");
    const correction = task("T004", writes, code.criterionIds, { origin: "repair", findingIds: ["F1"] });
    expect(correctionAuthorized(correction, root)).toBe(true);
  });

  test("files of unrelated tasks stay out of scope", () => {
    const widened = task("T004", ["src/parse.ts", "src/other.ts"], ["AC-001"], { origin: "repair" });
    expect(correctionAuthorized(widened, root)).toBe(false);
    const planned = task("T004", ["src/parse.ts"], ["AC-001"]);
    expect(correctionAuthorized(planned, root)).toBe(false);
  });

  test("a file the plan created is modified by the correction", () => {
    const created = task("T001", ["src/new.ts"], ["AC-001"], {
      writes: [{ path: "src/new.ts", action: "create" }],
    });
    const graph = { ...root, tasks: [created] };
    expect(correctionWrites(created, graph, { "src/new.ts": "hash" })[0]?.action).toBe("modify");
  });
});

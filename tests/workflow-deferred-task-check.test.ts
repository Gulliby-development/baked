import { describe, expect, test } from "bun:test";
import { hashJson } from "../src/core/specs/hash.js";
import { pendingOwners } from "../src/core/workflows/task-graph.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import type { Task } from "../src/core/workflows/types.js";

const task = (id: string, path: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: [{ path, action: "create" }],
  readHints: [],
  checkIds: ["typecheck"],
  origin: "planned",
  findingIds: [],
  rationale: id,
  ...extra,
});
const main = task("T003", "src/main.tsx");
const app = task("T004", "src/App.tsx");
const graph: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [main, app],
};
const row = (t: Task, status: string): TaskRow =>
  ({ id: t.id, status, generation: 0, snapshot_id: "s", definition_json: JSON.stringify(t) }) as unknown as TaskRow;
const output = "src/App.tsx(1,1): error TS2307: Cannot find module './Board'.";

// contrastgrid d372ea22: main.tsx imports App.tsx of T004, which had not run, and a repair agent
// started for a failure the owner resolves.
describe("a task check failing on a file a pending task owns", () => {
  test("names the pending owner", () => {
    expect(pendingOwners(graph, [row(main, "implemented"), row(app, "pending")], {}, main, output)).toEqual(["T004"]);
  });
  test("is the task's own failure when the owner is done", () => {
    const gates = {
      T004: { generation: 0, snapshotId: "s", definitionHash: hashJson(app), evidenceIds: [] },
    };
    expect(pendingOwners(graph, [row(main, "implemented"), row(app, "implemented")], gates, main, output)).toEqual([]);
  });
  test("is the task's own failure when the output names its own file or no planned file", () => {
    const rows = [row(main, "implemented"), row(app, "pending")];
    expect(pendingOwners(graph, rows, {}, main, `${output}\nsrc/main.tsx: bad`)).toEqual([]);
    expect(pendingOwners(graph, rows, {}, main, "1 test failed")).toEqual([]);
  });
  test("does not wait for an owner that depends on the task", () => {
    const later: TaskGraph = { ...graph, tasks: [main, { ...app, dependsOn: ["T003"] }] };
    expect(pendingOwners(later, [row(main, "implemented"), row(app, "pending")], {}, main, output)).toEqual([]);
  });
});

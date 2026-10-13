import { describe, expect, test } from "bun:test";
import { hashJson } from "../src/core/specs/hash.js";
import { missingArtifactOwners, pendingOwners, readyTasks } from "../src/core/workflows/task-graph.js";
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
  test("waits for a pending task that writes a file it reads, though the error names its own file", () => {
    // zoneslot-update c941a83a: App.tsx (T002) imports overlap.ts of T001; tsc names App.tsx.
    const overlap = task("T001", "src/overlap.ts");
    const reader = task("T002", "src/App.tsx", { readHints: ["src/overlap.ts"] });
    const g: TaskGraph = { ...graph, tasks: [overlap, reader] };
    const own = "src/App.tsx(4,10): error TS2305: Module './overlap' has no exported member 'localRanges'.";
    expect(pendingOwners(g, [row(overlap, "pending"), row(reader, "implemented")], {}, reader, own)).toEqual(["T001"]);
    expect(pendingOwners(g, [row(overlap, "pending"), row(reader, "implemented")], {}, reader, "1 test failed")).toEqual(["T001"]);
    expect(pendingOwners(g, [row(overlap, "verified"), row(reader, "implemented")], {}, reader, own)).toEqual([]);
    const later: TaskGraph = { ...g, tasks: [{ ...overlap, dependsOn: ["T002"] }, reader] };
    expect(pendingOwners(later, [row(overlap, "pending"), row(reader, "implemented")], {}, reader, own)).toEqual([]);
  });
  test("does not wait for an owner that depends on the task", () => {
    const later: TaskGraph = { ...graph, tasks: [main, { ...app, dependsOn: ["T003"] }] };
    expect(pendingOwners(later, [row(main, "implemented"), row(app, "pending")], {}, main, output)).toEqual([]);
  });
});

// cfgtrace 4018a791 (bench round 12): the README task ran before the CLI task and reported the
// missing `cfgtrace.__main__` as blocked (#807).
describe("a blocked task waits for the unfinished task that writes the file it names", () => {
  const readme = task("T011", "README.md");
  const cli = task("T005", "cfgtrace/__main__.py");
  const other = task("T006", "cfgtrace/model.py");
  const tasks: TaskGraph = { ...graph, tasks: [readme, cli, other] };
  const account = (summary: string) => ({ summary, unresolved: [] });
  test("a dotted module name or a path names the file", () => {
    const rows = [row(readme, "running"), row(cli, "pending"), row(other, "running")];
    expect(missingArtifactOwners(tasks, rows, readme, account("No module named cfgtrace.__main__"))).toEqual(["T005"]);
    expect(missingArtifactOwners(tasks, rows, readme, account("cfgtrace/model.py is missing"))).toEqual(["T006"]);
    expect(missingArtifactOwners(tasks, rows, readme, account("The spec is ambiguous"))).toEqual([]);
  });
  test("finished, blocked and dependent tasks are not waited for", () => {
    const text = account("cfgtrace.__main__ and cfgtrace.model are missing");
    expect(missingArtifactOwners(tasks, [row(readme, "running"), row(cli, "verified"), row(other, "blocked")], readme, text)).toEqual([]);
    const dependent: TaskGraph = { ...graph, tasks: [readme, { ...cli, dependsOn: ["T011"] }, other] };
    expect(missingArtifactOwners(dependent, [row(readme, "running"), row(cli, "pending"), row(other, "pending")], readme, text, { T006: ["T011"] })).toEqual([]);
  });
  test("a waiting task is ready once the tasks it waits for are done", () => {
    const waits = { T011: ["T005"] };
    const ready = (status: string) => readyTasks(tasks, [row(readme, "interrupted"), row(cli, status), row(other, "verified")], {}, waits).map((t) => t.id);
    expect(ready("running")).toEqual([]);
    expect(ready("verified")).toEqual(["T011"]);
  });
});

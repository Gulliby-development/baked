import { describe, expect, test } from "bun:test";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { documentsOnly, readyTasks } from "../src/core/workflows/task-graph.js";
import type { Task } from "../src/core/workflows/types.js";

const task = (id: string, paths: string[], extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" as const })),
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: id,
  ...extra,
});
const cli = task("T001", ["src/cfgtrace/cli.py"]);
const readme = task("T011", ["README.md", "LICENSE"], { dependsOn: ["T001"] });
const fix1 = task("T013", ["src/cfgtrace/cli.py"], { origin: "repair", findingIds: ["F-001"] });
const fix2 = task("T014", ["src/cfgtrace/cli.py"], { origin: "convergence", findingIds: ["F-002"], dependsOn: ["T013"] });
const graph = (tasks: Task[]): TaskGraph => ({
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks,
});
const row = (t: Task, status: string, generation = 0): TaskRow =>
  ({ id: t.id, status, generation, snapshot_id: "s", definition_json: JSON.stringify(t) }) as unknown as TaskRow;
const ids = (tasks: Task[]) => tasks.map((t) => t.id);

// cfgtrace 14b1da41: T011 (README and LICENSE) was invalidated by each of the correctives T013 to
// T018 and re-ran three times in full before the last one (#1211).
describe("a documentation task invalidated by a corrective", () => {
  const all = graph([cli, readme, fix1, fix2]);

  test("waits while a corrective is ready", () => {
    const rows = [row(cli, "verified"), row(readme, "invalidated", 1), row(fix1, "pending"), row(fix2, "pending")];
    expect(ids(readyTasks(all, rows))).toEqual(["T013"]);
  });

  test("waits while a corrective is running", () => {
    const rows = [row(cli, "verified"), row(readme, "invalidated", 1), row(fix1, "running"), row(fix2, "pending")];
    expect(ids(readyTasks(all, rows))).toEqual([]);
  });

  test("reruns once the correctives of the pass are done", () => {
    const rows = [row(cli, "verified"), row(readme, "invalidated", 2), row(fix1, "verified"), row(fix2, "verified")];
    expect(ids(readyTasks(all, rows))).toEqual(["T011"]);
  });

  test("does not wait for a corrective that cannot start", () => {
    const rows = [row(cli, "verified"), row(readme, "invalidated", 1), row(fix1, "failed"), row(fix2, "pending")];
    expect(ids(readyTasks(all, rows))).toEqual(["T011"]);
  });

  test("a first run and a source task are not held back", () => {
    const lib = task("T002", ["src/cfgtrace/lib.py"], { dependsOn: ["T001"] });
    const rows = [row(cli, "verified"), row(readme, "pending"), row(lib, "invalidated", 1), row(fix1, "pending")];
    expect(ids(readyTasks(graph([cli, readme, lib, fix1]), rows))).toEqual(["T011", "T002", "T013"]);
  });
});

describe("documentsOnly", () => {
  test("covers Markdown, README, licence and changelog writes", () => {
    expect(documentsOnly(readme)).toBe(true);
    expect(documentsOnly(task("T1", ["docs/usage.md", "CHANGELOG", "COPYING.txt"]))).toBe(true);
    expect(documentsOnly(task("T2", ["README.md", "src/cli.py"]))).toBe(false);
    expect(documentsOnly(task("T3", []))).toBe(false);
    expect(documentsOnly(task("T4", ["README.md"], { origin: "repair" }))).toBe(false);
  });
});

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Task, TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R47 md-site 3fabebb1 (#1580): the third plan replaces 32 tasks with 14 after test
// splitting. Deleting T015 fails on its old T003 dependency and T016's edge to it.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const markdown = "# Plan\n## Context\nCreate a value and test it.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nValue and sequential test slices\n## Data\nText\n## Verification\nCheck ready\n## Risks\nStale task dependencies";
const id = (n: number) => `T${String(n).padStart(3, "0")}`;
const pathOf = (n: number) => n === 1 ? "value.txt" : n <= 4 ? `source-${n}.txt` : `tests/slice-${n}.test.ts`;
// The second plan's edges, including the sequential slices, from the bench database.
const dependencies = [[], [], [1, 2], [3], [1], [1, 5], [1, 6], [2], [2, 8], [2, 9], [2, 10], [2, 11], [2, 12], [3], [3, 14], [3, 15], [2], [2, 17], [4], [4, 19], [3], [3, 21], [3], [3, 23], [4], [4, 25], [4, 26], [4, 27], [4], [4, 29], [4, 30], []];
const task = (n: number): Task => ({
  id: id(n), title: `Write ${pathOf(n)}`, description: `Write ${pathOf(n)}`,
  requirementIds: ["FR-001"], criterionIds: ["AC-001"],
  dependsOn: dependencies[n - 1]!.map(id), profileId: "implementer",
  writes: [{ path: pathOf(n), action: "create" }], readHints: [], checkIds: [],
  origin: "planned", findingIds: [], rationale: "Required behavior",
});

class ScriptedExecutor extends FixtureExecutor {
  plans = 0;
  analyses = 0;
  owners: unknown[] = [];
  implemented: string[] = [];
  constructor(private workspace: string) { super(workspace); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const count = [13, 32, 14][this.plans++]!;
      const taskGraph: TaskGraph = {
        schemaVersion: 1, featureId: "fixture", revision: 1,
        specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
        tasks: Array.from({ length: count }, (_, i) => task(i + 1)),
      };
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "analysis") {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
      const findings = ++this.analyses < 3 ? [{ id: "F001", kind: "inconsistency", refs: ["tasks.json"], description: "Revise the test slices to fit the plan", blocking: true }] : [];
      return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: findings.length ? "needs_revision" : "pass", findings }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation") {
      const own = request.task!;
      this.implemented.push(own.id);
      // Ownership must use the replacement graph, which still has this unfinished test writer.
      if (own.id === "T001") this.owners.push(request.failureOwner?.("tests/slice-14.test.ts:\n(fail) value is ready"));
      for (const write of own.writes) {
        const target = join(request.root ?? this.workspace, write.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, write.path.endsWith(".test.ts") ? 'import { expect, test } from "bun:test";\ntest("value is ready", () => expect(true).toBe(true));\n' : "ready");
      }
      return { output: { schemaVersion: 1, taskId: own.id, outcome: "implemented", summary: "Wrote required value or test slice", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

test("scenario: re-planning split tests removes old edges before dropped tasks (#1580)", async () => {
  const fixture = workflowFixture({
    policy: { ...fixturePolicy, clarification: "assume" },
    executor: (root) => new ScriptedExecutor(root),
  });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const run = await fixture.start();
  expect(await service.drive(run.runId, new AbortController().signal)).toMatchObject({ status: "waiting", reason: "approval" });
  expect(executor.plans).toBe(3);
  expect(executor.analyses).toBe(3);
  expect(service.store.tasks(run.runId).map((row) => row.id)).toEqual(Array.from({ length: 14 }, (_, i) => id(i + 1)));

  const db = new Database(service.store.path, { readonly: true });
  try {
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT task_id,dependency_id FROM task_dependencies WHERE run_id=? ORDER BY task_id,dependency_id").all(run.runId)).toEqual(
      service.store.state(run.runId).graph!.tasks.flatMap((t) => [...t.dependsOn].sort().map((dep) => ({ task_id: t.id, dependency_id: dep }))),
    );
  } finally { db.close(); }

  await fixture.approve(run.runId);
  expect(await service.drive(run.runId, new AbortController().signal)).toMatchObject({ status: "completed" });
  expect(executor.implemented).toHaveLength(14);
  expect(executor.owners).toEqual([expect.objectContaining({ kind: "test-update", owners: ["T014"] })]);
  expect(service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"))).toEqual([]);
}, 60000);

test("a package revision preserves task history and clears corrective findings before invalidation", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  const other = await fixture.start("other");
  const graph: TaskGraph = {
    schemaVersion: 1, featureId: "fixture", revision: 1,
    specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
    tasks: [task(1), task(2), { ...task(3), origin: "repair", findingIds: ["F001"] }],
  };
  store.transaction(() => {
    store.syncTasks(run.runId, graph);
    store.syncTasks(other.runId, { ...graph, featureId: "other" });
    const snapshot = store.putSnapshot(run.runId, {}).id;
    store.taskStatus(run.runId, "T001", "implemented", snapshot);
    const artifact = store.artifact(run.runId, "finding", "findings/F001.json", '{"id":"F001"}');
    const finding = store.addFinding(run.runId, { id: "F001" }, "f".repeat(64), artifact.id);
    store.findingStatus(run.runId, finding, "confirmed", "T003");
  });
  const before = store.tasks(run.runId).find((row) => row.id === "T001")!;
  store.transaction(() => store.syncTasks(run.runId, { ...graph, tasks: graph.tasks.slice(0, 2) }, true, new Set(["T001"])));
  expect(store.tasks(run.runId).map((row) => [row.id, row.status])).toEqual([["T001", "implemented"], ["T002", "invalidated"], ["T003", "cancelled"]]);
  expect(store.tasks(run.runId)[0]?.snapshot_id).toBe(before.snapshot_id);
  expect(store.findings(run.runId)).toEqual([]);
  expect(store.artifacts(run.runId).filter((a) => a.kind === "revision-history")).toHaveLength(1);
  const db = new Database(store.path, { readonly: true });
  try {
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT * FROM task_dependencies WHERE run_id=?").all(run.runId)).toEqual([]);
    expect(db.query("SELECT task_id,dependency_id FROM task_dependencies WHERE run_id=? ORDER BY dependency_id").all(other.runId)).toEqual([
      { task_id: "T003", dependency_id: "T001" }, { task_id: "T003", dependency_id: "T002" },
    ]);
  } finally { db.close(); }
});

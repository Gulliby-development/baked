import { afterEach, describe, expect, test } from "bun:test";
import { canonical, hashJson } from "../src/core/specs/hash.js";
import { earlierReads, repeatCorrections } from "../src/core/workflows/scheduler.js";
import type { Task, TaskGraph } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const task = (extra: Partial<Task>): Task => ({
  id: "T074",
  title: "Correct F-002",
  description: "Correct F-002",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: [{ path: "src/render.ts", action: "modify" }],
  readHints: [],
  checkIds: [],
  origin: "convergence",
  findingIds: [],
  rationale: "Finding",
  ...extra,
});

// #1774: md-site T075 (bench round 52) ended at its token cap without a submission; the next
// session read the project again for 1.24M tokens.
describe("earlier reads of a task", () => {
  test("names what the task's earlier attempts read, most repeated first, and nothing of other tasks", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    const read = (attemptId: string, input: Record<string, unknown>, result: string) =>
      store.artifact(run.runId, "read", `reads/${attemptId}/${crypto.randomUUID()}.json`, canonical({ tool: "read", input, result }));
    const first = store.transaction(() => store.beginExternalAttempt(run.runId, "task-T075"));
    const other = store.transaction(() => store.beginExternalAttempt(run.runId, "task-T001"));
    store.transaction(() => {
      read(first.attemptId, { path: "src/render.ts" }, "a".repeat(100));
      read(first.attemptId, { path: "src/parse.ts" }, "b");
      read(first.attemptId, { path: "src/render.ts" }, "a".repeat(100));
      read(other.attemptId, { path: "README.md" }, "c");
    });
    expect(earlierReads(store, run.runId, "T075")).toMatchObject([
      { tool: "read", targets: ["src/render.ts"], times: 2 },
      { tool: "read", targets: ["src/parse.ts"], times: 1 },
    ]);
    expect(earlierReads(store, run.runId, "T076")).toEqual([]);
  });
});

describe("repeat corrections", () => {
  test("hands a repeat finding's correction the patch of the correction of the finding it repeats", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    const finding = (id: string, body: Record<string, unknown>) => {
      const artifact = store.artifact(run.runId, "review", `reviews/${id}.json`, JSON.stringify(body));
      return store.addFinding(run.runId, { id, ...body }, hashJson({ id, ...body }), artifact.id);
    };
    const [earlier, repeat, fresh] = store.transaction(() => [
      finding("F-002", { claim: "A tab before javascript: is kept" }),
      finding("F-003", { claim: "A U+0001 before javascript: is kept", repeatOf: "F-002" }),
      finding("F-004", { claim: "Another defect", repeatOf: null }),
    ]) as [string, string, string];
    const fixed = task({ findingIds: [earlier] });
    const graph = { ...store.state(run.runId).graph, tasks: [fixed] } as TaskGraph;
    const patch = "--- a/src/render.ts\n+++ b/src/render.ts\n@@ -1 +1 @@\n-if (url.startsWith('javascript:'))\n+if (url.trimStart().startsWith('javascript:'))";
    store.transaction(() => {
      store.syncTasks(run.runId, graph);
      store.artifact(run.runId, "diff", "tasks/T074/diff.json", canonical({ changed: ["src/render.ts"], patch }));
    });
    expect(repeatCorrections(store, run.runId, task({ id: "T075", findingIds: [repeat] })).size).toBe(0);
    store.transaction(() => store.taskStatus(run.runId, "T074", "implemented", null));
    expect([...repeatCorrections(store, run.runId, task({ id: "T075", findingIds: [repeat] }))]).toEqual([
      [earlier, { taskId: "T074", patch }],
    ]);
    // A finding that repeats nothing, and a planned task, get no earlier patch.
    expect(repeatCorrections(store, run.runId, task({ id: "T076", findingIds: [fresh] })).size).toBe(0);
    expect(repeatCorrections(store, run.runId, task({ id: "T077", origin: "planned", findingIds: [repeat] })).size).toBe(0);
  });
});

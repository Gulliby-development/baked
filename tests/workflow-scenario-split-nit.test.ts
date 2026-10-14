import { afterEach, expect, test } from "bun:test";
import { hostSplitParts, isHostSplitNit } from "../src/core/workflows/analysis-notes.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 23, mdtoc-update 20f81464 (#1142). The host had split the planner's test task: T005
// (tests/cli.test.ts) was a part of T003. Analysis raised F-001, blocking: AC-007 whitelists four
// changed files, but FR-005 and T005 require edits in tests/cli.test.ts, so implementing the
// request fails AC-007. Because the finding named only T005, the host demoted it as a note about
// the split, the run implemented the contradictory spec and blocked at converge after 1.19M tokens.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const contradiction = "AC-001 whitelists value.txt as the only changed file, but task T003 requires edits in tests/b.test.ts, so implementing the request fails AC-001";
const parts = { T002: ["T002", "T003"] };

test("a finding about the split is a note; one that says a part fails a criterion is not", () => {
  expect(isHostSplitNit({ refs: ["tasks.json"], description: "T003 is not listed in plan.md" }, parts)).toBe(true);
  expect(isHostSplitNit({ refs: ["T002", "T003"], description: "T002 and T003 check the same thing" }, parts)).toBe(true);
  expect(isHostSplitNit({ refs: ["spec.json", "AC-001", "T003"], description: contradiction }, parts)).toBe(false);
  // Naming a part without saying anything about the split is not enough either.
  expect(isHostSplitNit({ refs: ["T003"], description: "T003 writes tests/b.test.ts with a wrong fixture path" }, parts)).toBe(false);
});

test("the contradiction stays blocking and the run does not go on to approval", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const original = executor.execute.bind(executor);
  let analyses = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "plan") {
      const result = await original(request);
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const base = graph.tasks[0] as Task;
      // The stored graph after the host split the planner's test task T002 by file.
      const testPart = (id: string, path: string, sibling: string): Task => ({
        ...base, id, title: "Test value", dependsOn: ["T001"], writes: [{ path, action: "create" }],
        description: `Test value\nSizing split this task by file: write only ${path}; ${sibling} belong to the other parts of T002.`,
      });
      graph.tasks.push(testPart("T002", "tests/a.test.ts", "tests/b.test.ts"), testPart("T003", "tests/b.test.ts", "tests/a.test.ts"));
      return result;
    }
    if (request.profile.output === "analysis") {
      analyses += 1;
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
      const findings = analyses === 1 ? [{ id: "F-001", kind: "inconsistency", refs: ["spec.json", "AC-001", "T003"], description: contradiction, blocking: true }] : [];
      return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: findings.length ? "needs_revision" : "pass", findings }, inputTokens: 25, outputTokens: 25 };
    }
    return original(request);
  };
  const run = await fixture.start();
  const first = await service.drive(run.runId, new AbortController().signal);
  expect(Object.keys(hostSplitParts(service.store.state(run.runId).graph as TaskGraph))).toEqual(["T002"]);
  const analysis = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("analysis")).map((a) => service.store.readArtifact(run.runId, a.id)).join("\n");
  expect(analysis).not.toContain("About tasks the host split");
  // The finding reached a person (or a return) instead of passing analysis after one pass.
  expect(first.reason === "approval" && analyses === 1).toBe(false);
});

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
const TEST = "tests/test_value.py";

/**
 * cfgtrace 49dbf63b (bench round 16): a test task wrote an assertion that contradicts the spec, and
 * the task that writes the code could only report spec_conflict, which asked a person each time.
 */
test("under assume, a test that contradicts the spec is decided for the spec and corrected by its test task (#967)", async () => {
  // The value check passes until value.txt exists, so the test task's own check passes before
  // the code task runs.
  const check = { ...fixturePolicy.checks[0]!, args: ["-e", "const f = Bun.file('value.txt'); if ((await f.exists()) && (await f.text()) !== 'ready') process.exit(1)"] };
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume", checks: [check] } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const corrections: NonNullable<ExecutionRequest["task"]>[] = [];
  let conflicts = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown>;
      graph.tasks = [
        { ...code, id: "T001", title: "Test value", description: "Test that value is ready", writes: [{ path: TEST, action: "create" }] },
        { ...code, id: "T002", dependsOn: ["T001"] },
      ];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    const task = request.task;
    if (task?.id === "T001") {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, TEST), "assert value == 'not ready'\n");
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote the test", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    if (task?.writes.some((w) => w.path === TEST)) {
      // The correction of the test task: the assertion follows the spec.
      corrections.push(task);
      writeFileSync(join(root, TEST), "assert value == 'ready'\n");
      return { output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "The test follows the spec", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    // The code task meets the contradicting test until it is corrected.
    if (readFileSync(join(root, TEST), "utf8").includes("not ready")) {
      conflicts++;
      return {
        output: { schemaVersion: 1, taskId: task?.id, outcome: "spec_conflict", summary: `${TEST} expects the value to be not ready, while FR-001 of the approved spec says the value is ready.`, evidenceIds: [], unresolved: [] },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    return original(request);
  };
  const run = await fixture.start();
  for (let i = 0; i < 8; i++) {
    const current = await service.get(run.runId);
    if (current.status === "completed" || current.status === "blocked" || current.status === "failed") break;
    if (current.status === "waiting" && !service.store.requests(run.runId).some((r) => r.kind === "approval" && r.status === "pending")) break;
    if (current.pendingRequestIds.length) await fixture.approve(run.runId);
    else if (current.status === "paused" || current.status === "created") await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  const finished = await service.get(run.runId);
  // No person is asked: the spec wins over the test once, and the task fixes the test.
  expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification")).toEqual([]);
  expect(conflicts).toBe(1);
  // One correction of the test task, which may write only the test file.
  expect(corrections.map((t) => [t.origin, t.writes.map((w) => w.path)])).toEqual([["repair", [TEST]]]);
  expect(readFileSync(join(root, TEST), "utf8")).toBe("assert value == 'ready'\n");
  expect(existsSync(join(root, "value.txt"))).toBe(true);
  const assumption = service.store.latestArtifact(run.runId, "assumptions/conflicts/T002.json");
  expect(assumption && JSON.parse(service.store.readArtifact(run.runId, assumption.id))).toMatchObject({
    assumed: `The approved spec wins over ${TEST} (written by T001)`,
    tests: [TEST],
  });
  expect(finished.status).toBe("completed");
});

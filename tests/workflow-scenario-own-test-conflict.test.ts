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
 * md-site a652d8fc (bench round 22, #1114): a test this run generated contradicted the spec, and
 * the task that met it could write that test but stopped with spec_conflict, which asked a person.
 */
/** Runs the #1114 scenario with the conflict report the implementer submits. */
async function settledForSpec(report: string): Promise<void> {
  const check = { ...fixturePolicy.checks[0]!, args: ["-e", "const f = Bun.file('value.txt'); if ((await f.exists()) && (await f.text()) !== 'ready') process.exit(1)"] };
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume", checks: [check] } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  let conflicts = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      graph.tasks = [
        { ...code, id: "T001", title: "Test value", description: "Test that value is ready", writes: [{ path: TEST, action: "create" }] },
        // The code task may also change the test, as a correction of a failed test check may.
        { ...code, id: "T002", dependsOn: ["T001"], writes: [...code.writes, { path: TEST, action: "modify" }] },
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
    prompts.push(JSON.stringify(request));
    if (!JSON.stringify(request).includes("which this run wrote")) {
      conflicts++;
      return {
        output: { schemaVersion: 1, taskId: task?.id, outcome: "spec_conflict", summary: report, evidenceIds: [], unresolved: [] },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    writeFileSync(join(root, TEST), "assert value == 'ready'\n");
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
  // No person is asked: the task corrects the test it may write and runs again.
  expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification")).toEqual([]);
  expect(conflicts).toBe(1);
  expect(readFileSync(join(root, TEST), "utf8")).toBe("assert value == 'ready'\n");
  expect(existsSync(join(root, "value.txt"))).toBe(true);
  const assumption = service.store.latestArtifact(run.runId, "assumptions/conflicts/T002.json");
  expect(assumption && JSON.parse(service.store.readArtifact(run.runId, assumption.id))).toMatchObject({
    assumed: `The approved spec and the request win over ${TEST}, which this run wrote`,
    tests: [TEST],
  });
  expect(finished.status).toBe("completed");
}

test("under assume, a spec conflict over a test the run wrote and the task may write is settled for the spec (#1114)", () =>
  settledForSpec(`${TEST} expects the value to be not ready, while FR-001 of the approved spec says the value is ready. Which one is right? It may not weaken the tests.`));

test("a conflict report that names the test in a Markdown code span is settled for the spec too (#1207)", () =>
  // cfgtrace T005 (bench round 26): models write paths in backticks, often with a `::test` suffix;
  // the path after the backtick went unmatched and the run waited for a person.
  settledForSpec(`Resolve the conflict between \`${TEST}::test_value_is_ready\` (requires the value to be not ready) and FR-001 (the value is ready).`));

test("a spec conflict over a test that existed before the run still asks a person (#1114)", async () => {
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, TEST), "assert value == 'not ready'\n");
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      graph.tasks = [{ ...code, id: "T001", writes: [...code.writes, { path: TEST, action: "modify", reason: "FR-001 changes the value" }] }];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "spec_conflict", summary: `${TEST} expects the value to be not ready, while FR-001 of the approved spec says the value is ready.`, evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  for (let i = 0; i < 8; i++) {
    const current = await service.get(run.runId);
    if (current.status !== "paused" && current.status !== "created" && !service.store.requests(run.runId).some((r) => r.kind === "approval" && r.status === "pending")) break;
    if (current.pendingRequestIds.length) await fixture.approve(run.runId);
    else await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  const asked = service.store.requests(run.runId).filter((r) => r.kind === "clarification");
  expect(asked.map((r) => JSON.stringify(r)).join("")).toContain("SPEC-CONFLICT-T001");
  expect(service.store.latestArtifact(run.runId, "assumptions/conflicts/T001.json")).toBeNull();
});

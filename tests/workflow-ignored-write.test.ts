import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileHash } from "../src/core/workflows/effects.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const signal = () => new AbortController().signal;

test("a task that edits a git-ignored file counts as having changed it, through the effect journal", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  // value.txt is invisible to the source manifest, like a docs directory listed in .gitignore.
  writeFileSync(join(root, ".gitignore"), "value.txt\n");
  const original = executor.execute.bind(executor);
  // The agent's edit tool journals every write; the stand-in does the same after writing the file.
  executor.execute = async (request: ExecutionRequest) => {
    const out = await original(request);
    if (request.profile.output === "implementation") {
      const effect = service.store.prepareEffect(request.runId, request.attemptId, "file_patch", { path: "value.txt", tool: "edit_file" }, null, null);
      service.store.finishFileEffect(request.runId, effect, fileHash(join(root, "value.txt")));
    }
    return out;
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
    await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  expect((await service.get(run.runId)).status).toBe("completed");
  expect(service.store.tasks(run.runId).every((t) => ["implemented", "verified"].includes(t.status))).toBe(true);
});

test("without a journaled write the same task is still rejected as having changed nothing", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, root } = fixture;
  writeFileSync(join(root, ".gitignore"), "value.txt\n");
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  const state = await service.drive(run.runId, signal());
  expect(state).toMatchObject({ status: "blocked", reason: "invalid_output" });
});

test("a task without writes is a verification task and needs no changed file to pass", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const original = executor.execute.bind(executor);
  // The planner adds a last task that only confirms the result; it declares no file to write.
  executor.execute = async (request: ExecutionRequest) => {
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as { taskGraph: { tasks: Record<string, unknown>[] } };
      const first = plan.taskGraph.tasks[0] as Record<string, unknown>;
      plan.taskGraph.tasks.push({ ...first, id: "T002", title: "Confirm the result", dependsOn: ["T001"], writes: [], rationale: "Verification only" });
    }
    return out;
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
    await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  expect((await service.get(run.runId)).status).toBe("completed");
  expect(service.store.tasks(run.runId).map((t) => t.id).sort()).toEqual(["T001", "T002"]);
});

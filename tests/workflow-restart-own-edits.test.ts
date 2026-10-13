import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;

test("a restarted task edits the file its own earlier attempt edited", async () => {
  // Under clarification assume a blocked implementer restarts once in a fresh session (#745).
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "usage.txt");
  writeFileSync(file, "original usage\n");
  const errors: string[] = [];
  let attempts = 0;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "usage.txt", action: "modify" });
      }
      return out;
    }
    attempts++;
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    try {
      await guard.execute("edit_file", { path: "usage.txt" }, async () => writeFileSync(file, attempts === 1 ? "draft" : "ready"));
      await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
    } catch (error) {
      errors.push((error as Error).message);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: attempts === 1 ? "blocked" : "implemented", summary: attempts === 1 ? "Ran out of steps" : "Wrote value", evidenceIds: [], unresolved: attempts === 1 ? ["value is a draft"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("ready");
});

test("a restarted task creates again the file its earlier attempt created when the file is gone", async () => {
  // A task restarted after `invalidated` can get a rebuilt worktree without the earlier attempt's
  // file while the journal still carries its write; every write was refused as changed (#927).
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "fresh.txt");
  const errors: string[] = [];
  let attempts = 0;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "fresh.txt", action: "create" });
      }
      return out;
    }
    attempts++;
    // The rebuilt worktree of the restart no longer holds the first attempt's file.
    if (attempts === 2) rmSync(file, { force: true });
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    try {
      await guard.execute("edit_file", { path: "fresh.txt" }, async () => writeFileSync(file, attempts === 1 ? "draft" : "ready"));
      if (attempts === 2) await guard.execute("edit_file", { path: "fresh.txt" }, async () => writeFileSync(file, "ready, edited"));
      await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
    } catch (error) {
      errors.push((error as Error).message);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: attempts === 1 ? "blocked" : "implemented", summary: attempts === 1 ? "Ran out of steps" : "Wrote value", evidenceIds: [], unresolved: attempts === 1 ? ["value is a draft"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("ready, edited");
});

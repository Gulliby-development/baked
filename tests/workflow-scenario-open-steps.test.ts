import { afterEach, describe, expect, test } from "bun:test";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

/** The fixture flow with a worker that dies in its next implementation call, as in #1745. */
class CrashingExecutor extends FixtureExecutor {
  crashNext = false;
  override async execute(request: ExecutionRequest) {
    if (this.crashNext && request.profile.output === "implementation") {
      this.crashNext = false;
      throw new Error("worker process exited");
    }
    return super.execute(request);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function crashedRun() {
  const fixture = workflowFixture({ executor: (root) => new CrashingExecutor(root) });
  cleanups.push(fixture.dispose);
  const { runId } = await fixture.start();
  await fixture.service.drive(runId, new AbortController().signal);
  fixture.executor.crashNext = true;
  await fixture.approve(runId);
  await fixture.service.drive(runId, new AbortController().signal);
  return { fixture, runId, store: fixture.service.store };
}

const open = (store: ReturnType<typeof workflowFixture>["service"]["store"], runId: string) => ({
  steps: store
    .steps(runId)
    .filter((s) => s.status === "running" || s.status === "waiting")
    .map((s) => `${s.stage_id}#${s.generation}:${s.status}`),
  tasks: store
    .tasks(runId)
    .filter((t) => t.status === "running")
    .map((t) => t.id),
});

describe("scenario: steps and tasks a crash or a decision leaves open are settled (#1745, #1746)", () => {
  test("the crash closes the task step under the failed stage step", async () => {
    const { store, runId } = await crashedRun();
    expect(store.run(runId).status).toBe("blocked");
    const task = store.steps(runId).find((s) => s.stage_id === "task-T001");
    expect(task?.status).toBe("failed");
  });

  test("crash, then resume: the completed run has no running or waiting step", async () => {
    const { fixture, store, runId } = await crashedRun();
    await fixture.resume(runId);
    await fixture.service.drive(runId, new AbortController().signal);
    expect(store.run(runId).status).toBe("completed");
    expect(open(store, runId)).toEqual({ steps: [], tasks: [] });
  });

  test("crash, then cancel: no step and no task stays running on the cancelled run", async () => {
    const { fixture, store, runId } = await crashedRun();
    const run = await fixture.service.get(runId);
    await fixture.service.cancel(runId, { commandId: newId(), expectedRevision: run.revision });
    expect(store.run(runId).status).toBe("cancelled");
    expect(open(store, runId)).toEqual({ steps: [], tasks: [] });
    expect(store.tasks(runId).find((t) => t.id === "T001")?.status).toBe("cancelled");
  });

  test("a run that only crashed keeps its task for the resume", async () => {
    const { store, runId } = await crashedRun();
    // The task row is not settled while the run can still resume: recovery invalidates it.
    expect(store.tasks(runId).find((t) => t.id === "T001")?.status).toBe("running");
  });

  test("approve and complete: the approve stage is not left waiting (#1746)", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { runId } = await fixture.start();
    await fixture.service.drive(runId, new AbortController().signal);
    const store = fixture.service.store;
    expect(store.steps(runId).find((s) => s.stage_id === "approve")?.status).toBe("waiting");
    await fixture.approve(runId);
    await fixture.service.drive(runId, new AbortController().signal);
    expect(store.run(runId).status).toBe("completed");
    expect(open(store, runId)).toEqual({ steps: [], tasks: [] });
    const view = await fixture.service.get(runId);
    expect(JSON.stringify(view)).not.toContain('"waiting"');
  });

  test("cancel while waiting for approval: the approve step ends with the run", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { runId } = await fixture.start();
    await fixture.service.drive(runId, new AbortController().signal);
    const run = await fixture.service.get(runId);
    await fixture.service.cancel(runId, { commandId: newId(), expectedRevision: run.revision });
    expect(open(fixture.service.store, runId)).toEqual({ steps: [], tasks: [] });
  });

  test("a stage step ends every open descendant, not its siblings or finished children", async () => {
    // The parallel, candidate, host-first, dimension and skeptic steps all hang under the stage
    // step the drive's catch finishes; nested ones (a skeptic under a review) end too.
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { runId } = await fixture.start();
    const store = fixture.service.store;
    const ids = store.transaction(() => {
      const stage = store.beginStep(runId, "review");
      const dimension = store.beginStep(runId, "dimension-security", stage);
      const skeptic = store.beginStep(runId, "skeptic-abc", dimension);
      const done = store.beginStep(runId, "critic", stage);
      store.finishStep(runId, done, "completed");
      const other = store.beginStep(runId, "transition-review-done");
      store.endOpenSteps(runId, stage, "running", "failed");
      return { stage, dimension, skeptic, done, other };
    });
    const status = (id: string) => store.steps(runId).find((s) => s.id === id)?.status;
    expect(status(ids.dimension)).toBe("failed");
    expect(status(ids.skeptic)).toBe("failed");
    expect(status(ids.done)).toBe("completed");
    // The caller finishes the root itself; a step outside the tree is left for recovery.
    expect(status(ids.stage)).toBe("running");
    expect(status(ids.other)).toBe("running");
  });
});

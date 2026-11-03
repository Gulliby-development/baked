import { afterEach, expect, test } from "bun:test";
import { startApiServer } from "../src/core/api/server.js";
import type { QueuedResume } from "../src/core/workflows/queued-resume.js";
import { newId } from "../src/core/workflows/store.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// #2421: a resume through the local API while the workspace already executes
// `workflows.maxParallelRuns` runs answered 200 with a bare `paused` run; the drive's
// WORKSPACE_BUSY refusal went only to the serve log, so the desktop showed no reason.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = workflowFixture();
  (fixture.config.workflows as Record<string, unknown>).maxParallelRuns = 1;
  const logs: string[] = [];
  const server = await startApiServer({ service: fixture.service, pollMs: 20, log: (line) => logs.push(line) });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${server.token}`, ...(init.headers as Record<string, string>) },
    });
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { fixture, call, post, logs };
}

type Queued = { status: string; queued?: QueuedResume };

test("a resume at the parallel-run cap answers that the run waits for a slot, and the run view keeps saying so", async () => {
  const { fixture, call, post, logs } = await setup();
  const store = fixture.service.store;
  const run = await fixture.start();
  store.transition(run.runId, "paused", "user_pause");
  // Another run executes in its own worktree and holds the only slot.
  const other = await fixture.start("other");
  store.putLease({ resource: `execution:${other.runId}`, owner_id: "other-owner", owner_epoch: 1, run_id: other.runId, expires_at: Date.now() + 60_000, process_identity_json: JSON.stringify({ pid: process.pid }) });

  const response = await post(`/v1/workflow/runs/${run.runId}/resume`, {
    commandId: newId(),
    expectedRevision: (await fixture.service.get(run.runId)).revision,
  });
  expect(response.status).toBe(200);
  const resumed = (await response.json()) as Queued;
  expect(resumed.status).toBe("paused");
  expect(resumed.queued).toMatchObject({ reason: "parallel_cap", maxParallelRuns: 1, executing: [other.runId], initiativeId: null });
  expect(resumed.queued?.message).toContain("continues when a slot is free");
  expect(resumed.queued?.next).toContain(`baked workflow resume ${run.runId}`);

  const view = (await (await call(`/v1/workflow/runs/${run.runId}`)).json()) as Queued;
  expect(view.queued).toMatchObject({ reason: "parallel_cap", executing: [other.runId] });
  expect(logs.some((line) => line.includes('"drive-error"'))).toBe(false);

  // The slot frees and the run is cancelled: the view stops saying it waits.
  store.releaseLease(`execution:${other.runId}`, "other-owner", 1);
  await post(`/v1/workflow/runs/${run.runId}/cancel`, { commandId: newId(), expectedRevision: (await fixture.service.get(run.runId)).revision });
  const after = (await (await call(`/v1/workflow/runs/${run.runId}`)).json()) as Queued;
  expect(after.queued).toBeUndefined();
});

test("a resume with a free slot carries no queued answer", async () => {
  const { fixture, post } = await setup();
  const run = await fixture.start();
  fixture.service.store.transition(run.runId, "paused", "user_pause");
  const response = await post(`/v1/workflow/runs/${run.runId}/resume`, {
    commandId: newId(),
    expectedRevision: (await fixture.service.get(run.runId)).revision,
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as Queued).queued).toBeUndefined();
});

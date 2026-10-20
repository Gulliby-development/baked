import { afterEach, expect, spyOn, test } from "bun:test";
import { headline } from "../src/components/workflow/format.js";
import { HOST_ERROR_PREFIX } from "../src/core/workflows/host-error.js";
import { reasonText } from "../src/core/workflows/reasons.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Broad review of rounds 39 to 50 (#1653): an exception of BAKED's own code (a TypeError, a bad
// JSON.parse) blocked the run as invalid_output. The model was blamed, the next attempt was told
// the host's error message as a correction note, and the second resume was refused with advice
// (revise, replan, cancel) that cannot fix a host defect.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function blockedOnHost() {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const started = await fixture.start();
  await service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  // A stage handler of the host reads a field of something missing.
  const implement = spyOn(
    service.scheduler as unknown as { implement: () => Promise<void> },
    "implement",
  ).mockImplementation(async () => {
    throw new TypeError("Cannot read properties of undefined (reading 'tasks')");
  });
  await service.drive(started.runId, new AbortController().signal);
  return { ...fixture, runId: started.runId, implement };
}

test("a host exception blocks host_error, keeps its stack and is not told to the agents", async () => {
  const { service, runId } = await blockedOnHost();
  const run = await service.get(runId);
  expect([run.status, run.reason]).toEqual(["blocked", "host_error"]);
  const stack = service.store.artifacts(runId).find((a) => a.logical_path.startsWith(HOST_ERROR_PREFIX));
  expect(stack).toBeDefined();
  expect(service.store.readArtifact(runId, stack?.id ?? "")).toContain("TypeError: Cannot read properties");
  expect(reasonText("host_error")).toContain("not a model problem");
  const advice = stopRecovery(service.store, runId);
  expect(advice?.message).toContain(`baked workflow export ${runId}`);
  expect(advice?.remedies.map((r) => r.action)).toEqual(["resume", "cancel"]);
  expect(headline(run, [], false).now).toContain("BAKED failed internally");
});

test("resuming a host_error is accepted every time and leaves the agents' prompt as it was", async () => {
  const { service, runId, implement } = await blockedOnHost();
  const prompt = service.store.state(runId).prompt;
  for (let round = 0; round < 2; round++) {
    const run = await service.get(runId);
    await service.resume(runId, { commandId: newId(), expectedRevision: run.revision });
    await service.drive(runId, new AbortController().signal);
    expect((await service.get(runId)).reason).toBe("host_error");
    expect(service.store.state(runId).prompt).toBe(prompt);
  }
  // Once the defect is gone, the same run finishes.
  implement.mockRestore();
  const run = await service.get(runId);
  await service.resume(runId, { commandId: newId(), expectedRevision: run.revision });
  await service.drive(runId, new AbortController().signal);
  expect((await service.get(runId)).status).toBe("completed");
});

class InvalidSpecExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: { schemaVersion: 1 }, inputTokens: 25, outputTokens: 25 };
    return super.execute(request);
  }
}

test("a model result that fails its schema still blocks invalid_output", async () => {
  const fixture = workflowFixture({ executor: (root) => new InvalidSpecExecutor(root) });
  cleanups.push(fixture.dispose);
  const started = await fixture.start();
  await fixture.service.drive(started.runId, new AbortController().signal);
  const run = await fixture.service.get(started.runId);
  expect([run.status, run.reason]).toEqual(["blocked", "invalid_output"]);
});

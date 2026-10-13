import { afterEach, describe, expect, test } from "bun:test";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Fails the first `outages` model calls the way a provider that cannot be reached does. */
class OutageExecutor extends FixtureExecutor {
  outages = 0;
  override async execute(request: ExecutionRequest) {
    if (this.outages > 0) {
      this.outages -= 1;
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    }
    return super.execute(request);
  }
}

async function outageRun(outages: number, backoff: number[]) {
  const fx = workflowFixture({ executor: (root) => new OutageExecutor(root) });
  cleanups.push(fx.dispose);
  fx.executor.outages = outages;
  fx.service.providerOutageBackoffMs = backoff;
  const run = await fx.start();
  await fx.resume(run.runId);
  const snapshot = await fx.service.drive(run.runId, new AbortController().signal);
  return { fx, run, snapshot };
}

describe("provider outage", () => {
  test("a run blocked by a provider outage waits and resumes by itself", async () => {
    const { fx, run } = await outageRun(1, [0, 0]);
    const status = fx.service.store.run(run.runId);
    expect(status.reason).not.toBe("provider_unavailable");
    expect(fx.service.store.state(run.runId).providerResumes).toBe(1);
    const resume = fx.service.store
      .artifacts(run.runId)
      .find((a) => a.logical_path === "provider-outage/resume-1.json");
    expect(resume?.kind).toBe("recovery");
    const body = JSON.parse(fx.service.store.readArtifact(run.runId, resume?.id ?? "")) as Record<string, unknown>;
    expect(body).toMatchObject({ attempt: 1, of: 2, waitMs: 0 });
    expect(typeof body.retryAt).toBe("string");
  });

  test("the run stays blocked once its automatic resumes are spent", async () => {
    const { fx, run, snapshot } = await outageRun(10, [0]);
    expect(snapshot.status).toBe("blocked");
    expect(fx.service.store.run(run.runId).reason).toBe("provider_unavailable");
    expect(fx.service.store.state(run.runId).providerResumes).toBe(1);
  });
});

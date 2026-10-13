import { afterEach, describe, expect, test } from "bun:test";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An implementer that takes longer than the run's original active-time cap. */
class SlowImplementer extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") await Bun.sleep(2_500);
    return super.execute(request);
  }
}

async function drive(fixture: ReturnType<typeof workflowFixture<SlowImplementer>>, runId: string) {
  for (let i = 0; i < 12; i++) {
    const run = await fixture.service.get(runId);
    if (run.status === "blocked" || run.status === "completed") return run;
    if (run.pendingRequestIds.length) await fixture.approve(runId);
    else if (run.status === "paused" || run.status === "created") await fixture.resume(runId);
    await fixture.service.drive(runId, new AbortController().signal);
  }
  return fixture.service.get(runId);
}

describe("scenario: sizing raises the active-time cap with the budget (#933)", () => {
  // cfgtrace 2ad7c3e4: sizing raised the budget but kept maxActiveMs at one hour, so the run
  // stopped on time with 39% of its sized tokens unused.
  test("a run the sizer priced above its time cap finishes instead of stopping on time", async () => {
    const policy = { ...fixturePolicy, maxActiveMs: 2_000, sizing: { maxRunTokens: 10_000_000 } };
    const fixture = workflowFixture({ policy, executor: (root) => new SlowImplementer(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const store = fixture.service.store;
    const last = await drive(fixture, run.runId);
    expect(last.status).toBe("completed");
    const stored = JSON.parse(store.run(run.runId).policy_json);
    expect(stored.maxActiveMs).toBeGreaterThan(2_000);
    const revision = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/sizing-"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)))[0];
    expect(revision).toMatchObject({ kind: "sizing", previous: { maxActiveMs: 2_000 } });
    expect(revision.next.maxActiveMs).toBe(stored.maxActiveMs);
    const approval = store.requests(run.runId).find((r) => r.kind === "approval");
    const body = JSON.parse(approval?.body_json ?? "{}");
    expect(body.activeTime).toMatchObject({ basis: "default", before: 2_000, after: stored.maxActiveMs });
    expect(body.activeTime.estimatedMs).toBeGreaterThan(2_000);
  });

  test("without a maxRunTokens ceiling the time cap stays and the run stops on time", async () => {
    const policy = { ...fixturePolicy, maxActiveMs: 2_000, sizing: {} };
    const fixture = workflowFixture({ policy, executor: (root) => new SlowImplementer(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const last = await drive(fixture, run.runId);
    expect(last).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    expect(JSON.parse(fixture.service.store.run(run.runId).policy_json).maxActiveMs).toBe(2_000);
  });
});

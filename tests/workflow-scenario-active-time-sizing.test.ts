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

async function drive(
  fixture: ReturnType<typeof workflowFixture<FixtureExecutor>>,
  runId: string,
  beforeApproval: () => void = () => {},
) {
  for (let i = 0; i < 12; i++) {
    const run = await fixture.service.get(runId);
    if (run.status === "blocked" || run.status === "completed") return run;
    if (run.pendingRequestIds.length) {
      beforeApproval();
      await fixture.approve(runId);
    }
    else if (run.status === "paused" || run.status === "created") await fixture.resume(runId);
    await fixture.service.drive(runId, new AbortController().signal);
  }
  return fixture.service.get(runId);
}

describe("scenario: sizing raises the active-time cap with the budget (#933)", () => {
  // cfgtrace 2ad7c3e4: sizing raised the budget but kept maxActiveMs at one hour, so the run
  // stopped on time with 39% of its sized tokens unused.
  test("a run the sizer priced above its time cap finishes instead of stopping on time", async () => {
    // The cap leaves the planning stages room on a slow runner (a 2 s cap stopped them before
    // sizing on Windows CI). Instead of real time, the run is given more active time than the
    // original cap before its tasks start, so only the cap sizing raised lets them run.
    const cap = 60_000;
    const policy = { ...fixturePolicy, maxActiveMs: cap, sizing: { maxRunTokens: 10_000_000 } };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const store = fixture.service.store;
    const last = await drive(fixture, run.runId, () => store.addActiveTime(run.runId, cap + 1_000));
    expect(last.status).toBe("completed");
    expect(store.run(run.runId).active_ms).toBeGreaterThan(cap);
    const stored = JSON.parse(store.run(run.runId).policy_json);
    expect(stored.maxActiveMs).toBeGreaterThan(store.run(run.runId).active_ms);
    const revision = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/sizing-"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)))[0];
    expect(revision).toMatchObject({ kind: "sizing", previous: { maxActiveMs: cap } });
    expect(revision.next.maxActiveMs).toBe(stored.maxActiveMs);
    const approval = store.requests(run.runId).find((r) => r.kind === "approval");
    const body = JSON.parse(approval?.body_json ?? "{}");
    expect(body.activeTime).toMatchObject({ basis: "default", before: cap, after: stored.maxActiveMs });
    expect(body.activeTime.estimatedMs).toBeGreaterThan(cap);
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

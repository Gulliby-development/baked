import { afterEach, describe, expect, test } from "bun:test";
import { guardStep } from "../src/core/workflows/initiatives/growth.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 70, namesound soundex (#2216): the drive held a 1,482,098 ms share. initiative-9
// raised the stored limit to 1,852,623 ms while the drive ran, and a reservation adopted it into
// the drive's copy. The deadline timer, armed at the old share, fired; the initiative's guard
// refused a further step (1,477,761 / 1,852,623 = 0.7977, under 80 percent), the copy already
// held the stored limit, so "did this callback raise it" was false and the run stopped
// "Active deadline exhausted" at the old limit. It waited 30 minutes for an owner's plain resume.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * The implementation step raises the stored limit while the drive runs (an initiative refresh
 * between model calls); the review step then outlasts the limit the drive was armed with.
 */
class RaisingExecutor extends FixtureExecutor {
  raise: () => void = () => {};
  reviewMs = 0;
  private raised = false;
  private reviewed = false;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation" && !this.raised) {
      this.raised = true;
      this.raise();
      await Bun.sleep(200);
    }
    if (request.profile.output === "review" && !this.reviewed) {
      this.reviewed = true;
      await Bun.sleep(this.reviewMs);
    }
    return super.execute(request);
  }
}

async function scenario(options: {
  armedMs: number;
  raisedMs: (activeBefore: number) => number;
  reviewMs: number;
  guard: boolean;
}) {
  const made = workflowFixture({
    policy: { ...fixturePolicy, maxActiveMs: 60_000 },
    executor: (root) => new RaisingExecutor(root),
  });
  cleanups.push(made.dispose);
  const { service, executor } = made;
  const { runId } = await made.start();
  await service.drive(runId, new AbortController().signal);
  await made.approve(runId);
  const store = service.store;
  const activeBefore = store.run(runId).active_ms;
  const stored = () => JSON.parse(store.run(runId).policy_json) as RunPolicy;
  // The drive starts armed at the held share.
  store.setPolicy(runId, { ...stored(), maxActiveMs: activeBefore + options.armedMs });
  const raised = options.raisedMs(activeBefore);
  executor.raise = () => store.setPolicy(runId, { ...stored(), maxActiveMs: raised });
  executor.reviewMs = options.reviewMs;
  // The initiative's guard at the deadline: a run under 80 percent of its limit does not rise.
  const steps: { used: number; limit: number; next: number }[] = [];
  service.growLimits = options.guard
    ? (id) => {
        const limit = stored().maxActiveMs;
        const used = store.run(id).active_ms;
        const next = guardStep(used, limit, limit * 2);
        steps.push({ used, limit, next });
        if (next > limit) store.setPolicy(id, { ...stored(), maxActiveMs: next });
      }
    : undefined;
  const snapshot = await service.drive(runId, new AbortController().signal);
  const diagnostics = store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("errors/"))
    .map((a) => store.readArtifact(runId, a.id));
  return { snapshot, steps, raised, limit: stored().maxActiveMs, diagnostics };
}

describe("scenario: soundex R70, a stored limit raised mid-drive re-arms the deadline (#2216)", () => {
  test("a limit raised and adopted between model calls does not stop the run at the old value", async () => {
    const { snapshot, raised, limit } = await scenario({
      armedMs: 1000,
      raisedMs: (before) => before + 60_000,
      reviewMs: 1600,
      guard: false,
    });
    expect(limit).toBe(raised);
    expect([snapshot.status, snapshot.reason]).toEqual(["completed", "none"]);
  });

  test("usage just under 80 percent of the raised limit at the old expiry continues", async () => {
    // At the old expiry the run used about 0.7977 of the raised limit, as soundex did.
    const { snapshot, steps, raised, limit } = await scenario({
      armedMs: 3000,
      raisedMs: (before) => Math.ceil((before + 3000) / 0.7977),
      reviewMs: 2900,
      guard: true,
    });
    // The guard was asked at the old expiry and refused a step: the stored raise alone carries it.
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.used / step.limit).toBeLessThan(0.8);
      expect(step.next).toBe(step.limit);
    }
    expect(limit).toBe(raised);
    expect([snapshot.status, snapshot.reason]).toEqual(["completed", "none"]);
  });

  test("a deadline that does run out names the usage and the stored limit", async () => {
    const { snapshot, diagnostics, raised } = await scenario({
      armedMs: 1000,
      raisedMs: (before) => before + 1200,
      reviewMs: 1600,
      guard: false,
    });
    expect([snapshot.status, snapshot.reason]).toEqual(["blocked", "budget_exhausted"]);
    const stop = diagnostics.find((text) => text.startsWith("Active deadline exhausted"));
    expect(stop).toMatch(new RegExp(`^Active deadline exhausted: \\d+ ms active of the stored ${String(raised)} ms limit$`));
  });
});

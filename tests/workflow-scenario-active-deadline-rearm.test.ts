import { afterEach, describe, expect, test } from "bun:test";
import { guardStep } from "../src/core/workflows/initiatives/growth.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { noteStoredLimitResume } from "../src/core/workflows/stop-reasons.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
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
  /** Runs when the drive aborts the review call: after the deadline's stop, before the block. */
  onAbort: (() => void) | undefined;
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
      const onAbort = this.onAbort;
      if (onAbort) request.signal.addEventListener("abort", onAbort, { once: true });
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
  /** Raises the stored limit to this many ms past the usage once the deadline aborts the call. */
  raiseOnStopMs?: number;
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
  const raiseOnStop = options.raiseOnStopMs;
  if (raiseOnStop !== undefined)
    executor.onAbort = () => store.setPolicy(runId, { ...stored(), maxActiveMs: store.run(runId).active_ms + raiseOnStop });
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
  return { snapshot, steps, raised, limit: stored().maxActiveMs, diagnostics, runId, store };
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

// #2226: the same soundex block, a growth that lands after the deadline stopped the attempt (6 s
// after, 2,315,779 ms stored against 1,477,761 ms used) left the run blocked until an owner's
// plain resume. The host would resume it once; in shadow it records `decision.would_resume`
// and the run stays blocked.

const wouldResumes = (store: WorkflowStore, runId: string) =>
  store
    .eventsOfType(runId, "decision.would_resume")
    .flatMap((e) => (e.type === "decision.would_resume" ? [e.payload] : []));

describe("scenario: a blocked run whose stored limit grew past its usage would resume (#2226)", () => {
  test("a limit raised between the deadline's stop and the block record records one would-resume", async () => {
    const { snapshot, runId, store } = await scenario({
      armedMs: 1000,
      raisedMs: (before) => before + 1200,
      reviewMs: 1600,
      guard: false,
      raiseOnStopMs: 60_000,
    });
    // Shadow: the run blocks as before.
    expect([snapshot.status, snapshot.reason]).toEqual(["blocked", "budget_exhausted"]);
    const records = wouldResumes(store, runId);
    expect(records).toHaveLength(1);
    const inputs = records[0]!.inputs as { held: string[]; at: string; stored: { maxActiveMs: number }; usage: { activeMs: number }; atBlock: { maxActiveMs: number }; blockedAt: string };
    expect(records[0]).toMatchObject({ reason: "host-resume-on-stored-limit", mode: "shadow" });
    expect(inputs).toMatchObject({ held: ["active"], at: "drive" });
    expect(inputs.stored.maxActiveMs).toBeGreaterThan(inputs.usage.activeMs);
    expect(inputs.atBlock.maxActiveMs).toBeLessThanOrEqual(inputs.usage.activeMs);
    expect(Date.parse(inputs.blockedAt)).not.toBeNaN();
    // Once per block: the initiative's round sees it recorded.
    expect(noteStoredLimitResume(store, runId, "initiative-round")).toBe(false);
    expect(wouldResumes(store, runId)).toHaveLength(1);
  });

  test("a limit that stays at its usage records none; raised after the block, the round records one", async () => {
    const { snapshot, runId, store } = await scenario({
      armedMs: 1000,
      raisedMs: (before) => before + 1200,
      reviewMs: 1600,
      guard: false,
    });
    expect([snapshot.status, snapshot.reason]).toEqual(["blocked", "budget_exhausted"]);
    expect(wouldResumes(store, runId)).toEqual([]);
    const stored = () => JSON.parse(store.run(runId).policy_json) as RunPolicy;
    // The stored limit at the run's usage holds it.
    store.setPolicy(runId, { ...stored(), maxActiveMs: store.run(runId).active_ms });
    expect(noteStoredLimitResume(store, runId, "initiative-round")).toBe(false);
    expect(wouldResumes(store, runId)).toEqual([]);
    // A growth after the block: the initiative's round records one would-resume, once.
    store.setPolicy(runId, { ...stored(), maxActiveMs: store.run(runId).active_ms + 60_000 });
    expect(noteStoredLimitResume(store, runId, "initiative-round")).toBe(true);
    expect(noteStoredLimitResume(store, runId, "initiative-round")).toBe(false);
    const records = wouldResumes(store, runId);
    expect(records).toHaveLength(1);
    expect(records[0]!.inputs).toMatchObject({ held: ["active"], at: "initiative-round" });
    expect(store.run(runId).status).toBe("blocked");
  });

  test("a block on the run's own calls records a would-resume only once its stored calls exceed its usage", async () => {
    const made = workflowFixture({ policy: { ...fixturePolicy, maxActiveMs: 60_000 } });
    cleanups.push(made.dispose);
    const { service } = made;
    const { runId } = await made.start();
    await service.drive(runId, new AbortController().signal);
    await made.approve(runId);
    const store = service.store;
    const stored = () => JSON.parse(store.run(runId).policy_json) as RunPolicy;
    store.setPolicy(runId, { ...stored(), maxAgentCalls: store.run(runId).agent_calls + 1 });
    const snapshot = await service.drive(runId, new AbortController().signal);
    expect([snapshot.status, snapshot.reason]).toEqual(["blocked", "budget_exhausted"]);
    expect(wouldResumes(store, runId)).toEqual([]);
    expect(noteStoredLimitResume(store, runId, "initiative-round")).toBe(false);
    store.setPolicy(runId, { ...stored(), maxAgentCalls: store.run(runId).agent_calls + 10 });
    expect(noteStoredLimitResume(store, runId, "initiative-round")).toBe(true);
    expect(wouldResumes(store, runId)[0]!.inputs).toMatchObject({ held: ["calls"] });
  });

  test("the initiative's driver round records the would-resume of a blocked feature run, and none while its limit holds", async () => {
    const plan: InitiativePlan = {
      schemaVersion: 1, title: "Sound", goals: ["Create soundex"], completionCriteria: ["Soundex is ready"],
      features: ["soundex", "metaphone", "cli"].map((id, i) => ({
        id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
        contract: `${id}.txt contains ready`, dependsOn: i === 0 ? [] : ["soundex"], mandatory: true,
      })),
    };
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const initiatives = new InitiativeService(fixture.service);
    const policy: RunPolicy = { ...fixture.policy, maxTotalTokens: 10_000_000, maxAgentCalls: 1000, costForecast: "off" };
    const view = await initiatives.start({ commandId: newId(), initiativeId: "namesound", prompt: "Create soundex", plan, policy, model: "fixture/model", ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 } });
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("namesound", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
    const starter = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean> };
    expect(await starter.startFeature("namesound", "soundex")).toBe(true);
    const runId = initiatives.view("namesound").features[0]!.runId!;
    const store = fixture.service.store;
    const stored = () => JSON.parse(store.run(runId).policy_json) as RunPolicy;
    // The run used its whole active share; without the deadline's growth it blocks at once.
    store.transaction(() => store.addActiveTime(runId, stored().maxActiveMs));
    fixture.service.growLimits = undefined;
    await fixture.service.drive(runId, new AbortController().signal);
    expect([store.run(runId).status, store.run(runId).reason]).toEqual(["blocked", "budget_exhausted"]);
    await initiatives.drive("namesound", new AbortController().signal);
    expect(wouldResumes(store, runId)).toEqual([]);
    // The stored limit grows after the block: the next round records one, and the run stays blocked.
    store.setPolicy(runId, { ...stored(), maxActiveMs: store.run(runId).active_ms + 60_000 });
    await initiatives.drive("namesound", new AbortController().signal);
    await initiatives.drive("namesound", new AbortController().signal);
    const records = wouldResumes(store, runId);
    expect(records).toHaveLength(1);
    expect(records[0]!.inputs).toMatchObject({ held: ["active"], at: "initiative-round" });
    expect(store.run(runId).status).toBe("blocked");
  }, 60_000);
});

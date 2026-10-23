import { afterEach, describe, expect, test } from "bun:test";
import { guardStep, openGuardRoom, refreshedGrowth } from "../src/core/workflows/initiatives/growth.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 62, stepvet (#1958): 12 features, 3 parallel runs, an initiative pool of 6 hours of
// active time. lines started with a share of 1,362,376 ms; 24 initiative-growth revisions moved it
// by 3 ms to 7.5 s each, because the room counted every open run at its whole limit and was 0 to
// 7 ms, and it stopped "Active deadline exhausted" at 1,423,830 ms, 0.65 percent short. tagexpr
// stopped at 2,100,000 ms while it was the only live run, so no driver round looked at it again.
// The initiative ended with 33 percent of its time unused.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const POOL = { calls: 1000, activeMs: 21_600_000 };

describe("scenario: stepvet R62 lines grows into the time its siblings do not use (#1958)", () => {
  // At 15:52: three features finished (7.4M ms), two siblings open at half of their 1.5M and 1.8M
  // ms shares, five features waiting with 1.4M ms floors.
  const others = { calls: 3 * 20 + 2 * 12, activeMs: 7_400_000 + 750_000 + 900_000 };
  const waiting = { calls: 5 * 30, activeMs: 5 * 1_400_000 };
  const lines = { calls: 25, activeMs: 1_423_830 };

  test("an open sibling reserves what it used, not its limit, and the room is positive", () => {
    const room = openGuardRoom(POOL, lines, others, waiting);
    expect(room.activeMs).toBe(21_600_000 - 9_050_000 - 7_000_000 - 1_423_830);
  });

  test("lines rises once by a quarter, enough for the 1,433,043 ms it needed", () => {
    const policy: RunPolicy = { ...fixturePolicy, maxAgentCalls: 25, maxActiveMs: 1_423_830 };
    const room = openGuardRoom(POOL, lines, others, waiting);
    const after = refreshedGrowth(policy, policy, { usd: 0, tokens: 0, ...lines }, { calls: 17, activeMs: 1_423_830 }, { usd: null, tokens: null, ...room });
    expect(after?.maxActiveMs).toBe(Math.ceil(1_423_830 * 1.25));
    expect(after!.maxActiveMs).toBeGreaterThan(1_433_043);
    // 17 of 25 calls is below 80 percent: the calls limit stays.
    expect(after?.maxAgentCalls).toBe(25);
  });

  test("a raise under 1 percent writes no revision, and a run below 80 percent does not rise", () => {
    expect(guardStep(1_423_000, 1_423_830, 1_423_830 + 7)).toBe(1_423_830);
    expect(guardStep(1_000_000, 1_423_830, 9_000_000)).toBe(1_423_830);
    expect(guardStep(1_200_000, 1_423_830, 1_500_000)).toBe(1_500_000);
    expect(guardStep(24, 25, 1000)).toBe(32);
  });

  test("an empty pool still leaves the limit where it is", () => {
    const room = openGuardRoom({ calls: 50, activeMs: 2_000_000 }, lines, others, waiting);
    expect(room).toEqual({ calls: 0, activeMs: 0 });
  });
});

/** An implementation step that takes longer than the run's active-time limit. */
class SlowExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") await Bun.sleep(1600);
    return super.execute(request);
  }
}

describe("scenario: tagexpr R62, the only live run grows at its deadline with no driver round (#1958)", () => {
  async function drive(grow: boolean) {
    const made = workflowFixture({ policy: { ...fixturePolicy, maxActiveMs: 60_000 }, executor: (root) => new SlowExecutor(root) });
    cleanups.push(made.dispose);
    const { service } = made;
    const { runId } = await made.start();
    await service.drive(runId, new AbortController().signal);
    await made.approve(runId);
    // The implementation step outlasts what is left of its share.
    const policy = JSON.parse(service.store.run(runId).policy_json) as RunPolicy;
    service.store.setPolicy(runId, { ...policy, maxActiveMs: service.store.run(runId).active_ms + 1000 });
    const asked: string[] = [];
    if (grow)
      service.growLimits = (id) => {
        asked.push(id);
        const stored = JSON.parse(service.store.run(id).policy_json) as RunPolicy;
        service.store.setPolicy(id, { ...stored, maxActiveMs: stored.maxActiveMs + 60_000 });
      };
    return { snapshot: await service.drive(runId, new AbortController().signal), asked, runId };
  }

  test("without growth the share-derived deadline stops the run", async () => {
    const { snapshot } = await drive(false);
    expect([snapshot.status, snapshot.reason]).toEqual(["blocked", "budget_exhausted"]);
  }, 60000);

  test("with an initiative's growth the deadline is re-armed and the run finishes", async () => {
    const { snapshot, asked, runId } = await drive(true);
    expect(asked).toEqual([runId]);
    expect(snapshot.status).toBe("completed");
  }, 60000);
});

const plan: InitiativePlan = {
  schemaVersion: 1, title: "Steps", goals: ["Create steps"], completionCriteria: ["Steps are ready"],
  features: ["lines", "parser", "cli", "docs"].map((id) => ({
    id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`, dependsOn: [], mandatory: true,
  })),
};

describe("scenario: the initiative answers a feature run's deadline with its share's growth (#1958)", () => {
  test("a run at its limit is raised by a quarter and the raise is a host revision", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const initiatives = new InitiativeService(fixture.service);
    const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 10_000_000, maxAgentCalls: 1000, costForecast: "off" };
    const view = await initiatives.start({ commandId: newId(), initiativeId: "stepvet", prompt: "Create steps", plan, policy, model: "fixture/model", ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 } });
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("stepvet", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
    const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean> };
    expect(await service.startFeature("stepvet", "lines")).toBe(true);
    expect(await service.startFeature("stepvet", "parser")).toBe(true);
    const runOf = (featureId: string) => initiatives.view("stepvet").features.find((f) => f.id === featureId)!.runId!;
    const store = fixture.service.store;
    const lines = runOf("lines");
    const share = (JSON.parse(store.run(lines).policy_json) as RunPolicy).maxActiveMs;
    // lines used its whole share; parser, open beside it, used little of its own.
    store.transaction(() => {
      store.addActiveTime(lines, share);
      store.addActiveTime(runOf("parser"), 60_000);
    });
    fixture.service.growLimits?.(lines);
    const after = JSON.parse(store.run(lines).policy_json) as RunPolicy;
    expect(after.maxActiveMs).toBe(Math.ceil(share * 1.25));
    const revisions = store.artifacts(lines).filter((a) => a.logical_path.startsWith("policy-revisions/initiative-"));
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(store.readArtifact(lines, revisions[0]!.id))).toMatchObject({ kind: "initiative-growth", previous: { maxActiveMs: share }, next: { maxActiveMs: after.maxActiveMs } });
    // A run nowhere near its limit is left alone.
    fixture.service.growLimits?.(runOf("parser"));
    expect(store.artifacts(runOf("parser")).filter((a) => a.logical_path.startsWith("policy-revisions/initiative-"))).toHaveLength(0);
  }, 60000);
});

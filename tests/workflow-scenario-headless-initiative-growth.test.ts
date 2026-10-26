import { afterEach, describe, expect, test } from "bun:test";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 68, ewvet scanner d467eb7e (#2134): a feature run of an initiative with 37 percent
// of its 6 hours used stopped "Active deadline exhausted" 33 s after `baked workflow reroute
// --resume`, and later over its cost cap with $12 of the initiative's $30 spare. The headless
// command drove the run with `service.drive` before any `InitiativeService` existed in its
// process, and only that constructor installed the growth hook (#1958), so the deadline asked
// nobody. The loop raised both limits by hand. The workflow service now holds the hook.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const plan: InitiativePlan = {
  schemaVersion: 1, title: "Scan", goals: ["Create scan"], completionCriteria: ["Scan is ready"],
  features: ["scanner", "reader", "codec"].map((id) => ({
    id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`, dependsOn: [], mandatory: true,
  })),
};

/** An initiative whose scanner run used its whole active share, reader beside it barely any. */
async function exhaustedShare() {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const initiatives = new InitiativeService(fixture.service);
  const policy: RunPolicy = { ...fixture.policy, maxTotalTokens: 10_000_000, maxAgentCalls: 1000, costForecast: "off" };
  const view = await initiatives.start({ commandId: newId(), initiativeId: "ewvet", prompt: "Create scan", plan, policy, model: "fixture/model", ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 } });
  const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
  await initiatives.approve("ewvet", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
  const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean> };
  expect(await service.startFeature("ewvet", "scanner")).toBe(true);
  expect(await service.startFeature("ewvet", "reader")).toBe(true);
  const runOf = (featureId: string) => initiatives.view("ewvet").features.find((f) => f.id === featureId)!.runId!;
  const store = fixture.service.store;
  const scanner = runOf("scanner");
  const share = (JSON.parse(store.run(scanner).policy_json) as RunPolicy).maxActiveMs;
  store.transaction(() => {
    store.addActiveTime(scanner, share);
    store.addActiveTime(runOf("reader"), 60_000);
  });
  // The headless process: a workflow service of its own, and no initiative service in it.
  const headless = new NativeWorkflowService(fixture.root, fixture.config, fixture.executor);
  cleanups.push(async () => { await headless.shutdown(); headless.close(); });
  const growth = () => headless.store.artifacts(scanner).filter((a) => a.logical_path.startsWith("policy-revisions/initiative-"));
  return { headless, scanner, share, growth, before: growth().length };
}

describe("scenario: ewvet R68, a headless resume drives a feature run with the initiative's growth (#2134)", () => {
  test("a workflow service no initiative service was made for still grows the run's share at its deadline", async () => {
    const { headless, scanner, share, growth, before } = await exhaustedShare();
    expect(headless.growLimits).toBeDefined();
    headless.growLimits?.(scanner);
    expect(growth()).toHaveLength(before + 1);
    expect((JSON.parse(headless.store.run(scanner).policy_json) as RunPolicy).maxActiveMs).toBeGreaterThan(share);
  }, 60000);

  test("driving the run grows its share first, so it is not stopped on the old deadline", async () => {
    const { headless, scanner, share, growth, before } = await exhaustedShare();
    await headless.drive(scanner, new AbortController().signal);
    expect(growth().length).toBeGreaterThan(before);
    const run = headless.store.run(scanner);
    expect((JSON.parse(run.policy_json) as RunPolicy).maxActiveMs).toBeGreaterThan(share);
    expect(run.reason).not.toBe("budget_exhausted");
  }, 60000);

  test("its store asks the initiative before a cost stop, too (#2241)", async () => {
    const { headless, scanner } = await exhaustedShare();
    // Installed by the workflow service itself; the stop path's case is in
    // tests/workflow-scenario-started-run-stage-reserve.test.ts.
    expect(headless.store.reserveStages).toBeDefined();
    const policy = headless.store.run(scanner).policy_json;
    // scanner has not finished its tasks: nothing to reserve.
    headless.store.reserveStages?.(scanner, 0.02);
    expect(headless.store.run(scanner).policy_json).toBe(policy);
  }, 60000);

  test("a run of no initiative is left alone", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const policy = fixture.service.store.run(run.runId).policy_json;
    fixture.service.growLimits?.(run.runId);
    expect(fixture.service.store.run(run.runId).policy_json).toBe(policy);
  }, 60000);
});

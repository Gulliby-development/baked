import { afterEach, describe, expect, test } from "bun:test";
import { growBudgetOnProgress, raiseToStartEstimate } from "../src/core/workflows/budget.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const heavy = (output: string): number =>
  ["implementation", "review", "convergence"].includes(output) ? 600000 : 50;

async function drive(fixture: ReturnType<typeof workflowFixture>, runId: string) {
  for (let i = 0; i < 12; i++) {
    const run = await fixture.service.get(runId);
    if (run.status === "blocked" || run.status === "completed") return run;
    if (run.pendingRequestIds.length) await fixture.approve(runId);
    else if (run.status === "paused" || run.status === "created") await fixture.resume(runId);
    await fixture.service.drive(runId, new AbortController().signal);
  }
  return fixture.service.get(runId);
}

describe("automatic budget growth", () => {
  // md-site 2707d602 stopped at 2,140,388 of 2,149,014 tokens with work finishing; the only way on
  // was a user extension to the 4M ceiling the policy already declared.
  test("a run with a ceiling grows its budget while tasks finish instead of blocking", async () => {
    const policy = { ...fixturePolicy, maxTotalTokens: 300000, sizing: { maxRunTokens: 10_000_000 } };
    // Heavier than the start estimate's high end, which sets the budget before the plan.
    const heavier = (output: string): number => heavy(output) * 3;
    const fixture = workflowFixture({ policy, tokensPerCall: heavier });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const last = await drive(fixture, run.runId);
    expect(last.status).toBe("completed");
    const store = fixture.service.store;
    const stored = JSON.parse(store.run(run.runId).policy_json);
    expect(stored.maxTotalTokens).toBeGreaterThan(300000);
    expect(stored.maxTotalTokens).toBeLessThanOrEqual(10_000_000);
    const revisions = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"));
    expect(revisions.length).toBeGreaterThan(0);
    const growth = revisions.map((a) => JSON.parse(store.readArtifact(run.runId, a.id)));
    const body = growth.find((b) => b.kind === "auto-growth");
    expect(body).toMatchObject({ kind: "auto-growth", approvedBy: "sizing" });
    expect(body.next.maxTotalTokens).toBeGreaterThan(body.previous.maxTotalTokens);
  });

  test("without a ceiling the run still stops on its budget", async () => {
    const policy = { ...fixturePolicy, maxTotalTokens: 300000 };
    const fixture = workflowFixture({ policy, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const last = await drive(fixture, run.runId);
    expect(last).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
  });

  test("growth stops at the ceiling", async () => {
    const policy = { ...fixturePolicy, maxTotalTokens: 300000, sizing: { maxRunTokens: 1_000_000 } };
    const fixture = workflowFixture({ policy, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const last = await drive(fixture, run.runId);
    expect(last).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    expect(JSON.parse(fixture.service.store.run(run.runId).policy_json).maxTotalTokens).toBeLessThanOrEqual(1_000_000);
  });

  // junitdigest 3e5be74b stopped twice at its ceiling and was cleared by mechanical extends (#747).
  test("under assume a run grows past its ceiling up to extendToTokens while it makes progress", async () => {
    const policy = {
      ...fixturePolicy,
      clarification: "assume" as const,
      maxTotalTokens: 300000,
      sizing: { maxRunTokens: 1_000_000, extendToTokens: 10_000_000 },
    };
    const fixture = workflowFixture({ policy, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const last = await drive(fixture, run.runId);
    expect(last.status).toBe("completed");
    const store = fixture.service.store;
    const stored = JSON.parse(store.run(run.runId).policy_json);
    expect(stored.maxTotalTokens).toBeGreaterThan(1_000_000);
    expect(stored.maxTotalTokens).toBeLessThanOrEqual(10_000_000);
    const extensions = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)))
      .filter((b) => b.kind === "auto-extend");
    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions[0]).toMatchObject({ approvedBy: "sizing", hardCeiling: 10_000_000 });
    expect(extensions[0].next.maxTotalTokens).toBeGreaterThan(extensions[0].previous.maxTotalTokens);
  });

  test("without assume the ceiling still stops the run", async () => {
    const policy = {
      ...fixturePolicy,
      maxTotalTokens: 300000,
      sizing: { maxRunTokens: 1_000_000, extendToTokens: 10_000_000 },
    };
    const fixture = workflowFixture({ policy, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const last = await drive(fixture, run.runId);
    expect(last).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    expect(JSON.parse(fixture.service.store.run(run.runId).policy_json).maxTotalTokens).toBeLessThanOrEqual(1_000_000);
  });

  test("a run at its ceiling with nothing finished or resolved is not extended", async () => {
    const policy = {
      ...fixturePolicy,
      clarification: "assume" as const,
      maxTotalTokens: 1_000_000,
      sizing: { maxRunTokens: 1_000_000, extendToTokens: 10_000_000 },
    };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const store = fixture.service.store;
    const current = JSON.parse(store.run(run.runId).policy_json);
    expect(growBudgetOnProgress(store, run.runId, current, 1_200_000)).toBe(false);
    expect(JSON.parse(store.run(run.runId).policy_json).maxTotalTokens).toBe(1_000_000);
  });

  // md-site eaeb51d6 (bench round 25, #1187): growth reached the 6M ceiling from 5,773,892 for an
  // attempt that needed 6,039,774, and the run stopped budget_exhausted with 1 of 8 tasks left and
  // the 9M hard limit unused, because only a call that started at the ceiling tried an extension.
  test("a call that reaches the ceiling from below and still falls short extends past it", async () => {
    const policy = { ...fixturePolicy, clarification: "assume" as const, sizing: { maxRunTokens: 6_000_000 } };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    expect((await drive(fixture, run.runId)).status).toBe("completed");
    const store = fixture.service.store;
    const current = { ...JSON.parse(store.run(run.runId).policy_json), maxTotalTokens: 5_773_892 };
    store.setPolicy(run.runId, current);
    expect(growBudgetOnProgress(store, run.runId, current, 6_039_774)).toBe(true);
    expect(current.maxTotalTokens).toBeGreaterThanOrEqual(6_039_774);
    expect(current.maxTotalTokens).toBeLessThanOrEqual(9_000_000);
    const kinds = store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)))
      .map((b) => [b.kind, b.next.maxTotalTokens]);
    expect(kinds.slice(-2)).toEqual([
      ["auto-growth", 6_000_000],
      ["auto-extend", current.maxTotalTokens],
    ]);
    expect(JSON.parse(store.run(run.runId).policy_json).maxTotalTokens).toBe(current.maxTotalTokens);
  });

  test("without assume a call that reaches the ceiling from below stops there", async () => {
    const policy = { ...fixturePolicy, sizing: { maxRunTokens: 6_000_000 } };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    expect((await drive(fixture, run.runId)).status).toBe("completed");
    const store = fixture.service.store;
    const current = { ...JSON.parse(store.run(run.runId).policy_json), maxTotalTokens: 5_773_892 };
    store.setPolicy(run.runId, current);
    expect(growBudgetOnProgress(store, run.runId, current, 6_039_774)).toBe(false);
    expect(current.maxTotalTokens).toBe(6_000_000);
  });

  test("the planning budget starts at the start estimate's high end, up to the ceiling", async () => {
    const policy = { ...fixturePolicy, maxTotalTokens: 300000, sizing: { maxRunTokens: 900000 } };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const store = fixture.service.store;
    store.artifact(
      run.runId,
      "estimate",
      "estimates/start.json",
      JSON.stringify({ tokens: { low: 400000, high: 950000 } }),
    );
    const current = JSON.parse(store.run(run.runId).policy_json);
    expect(raiseToStartEstimate(store, run.runId, current)).toBe(true);
    expect(current.maxTotalTokens).toBe(900000);
    expect(JSON.parse(store.run(run.runId).policy_json).maxTotalTokens).toBe(900000);
    // Already there: nothing more to record.
    expect(raiseToStartEstimate(store, run.runId, current)).toBe(false);
  });
});

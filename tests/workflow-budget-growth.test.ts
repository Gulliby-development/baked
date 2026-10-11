import { afterEach, describe, expect, test } from "bun:test";
import { raiseToStartEstimate } from "../src/core/workflows/budget.js";
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
    const policy = { ...fixturePolicy, maxTotalTokens: 300000, sizing: { maxRunTokens: 2_000_000 } };
    const fixture = workflowFixture({ policy, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const last = await drive(fixture, run.runId);
    expect(last.status).toBe("completed");
    const store = fixture.service.store;
    const stored = JSON.parse(store.run(run.runId).policy_json);
    expect(stored.maxTotalTokens).toBeGreaterThan(300000);
    expect(stored.maxTotalTokens).toBeLessThanOrEqual(2_000_000);
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

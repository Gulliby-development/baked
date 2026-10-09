import { afterEach, describe, expect, test } from "bun:test";
import { extensionFor, extensionText, headline, runActions } from "../src/components/workflow/format.js";
import { type BudgetLimits, proposeExtension } from "../src/core/workflows/budget.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { newId } from "../src/core/workflows/store.js";
import { type BudgetView, readWorkflowView } from "../src/core/workflows/view.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const usage = { tokens: 0, heldTokens: 0, inFlightTokens: 0, calls: 0, activeMs: 0 };
const limits: BudgetLimits = { maxTotalTokens: 400000, maxAgentCalls: 80, maxActiveMs: 3600000 };

describe("budget extension proposal", () => {
  test("raises the limit that stopped the run and anything close to its limit", () => {
    expect(proposeExtension(limits, { ...usage, tokens: 390000 })).toEqual({ maxTotalTokens: 800000, maxAgentCalls: 80, maxActiveMs: 3600000 });
    expect(proposeExtension(limits, { ...usage, calls: 80, tokens: 1000 })).toEqual({ maxTotalTokens: 400000, maxAgentCalls: 160, maxActiveMs: 3600000 });
    expect(proposeExtension(limits, { ...usage, activeMs: 3600000, tokens: 1000 })).toEqual({ maxTotalTokens: 400000, maxAgentCalls: 80, maxActiveMs: 7200000 });
    // Held reservations from interrupted attempts count toward the tokens used.
    expect(proposeExtension(limits, { ...usage, tokens: 100000, heldTokens: 230000 })?.maxTotalTokens).toBe(800000);
    // Nothing is close to its limit but the run stopped: the next step did not fit, so tokens grow.
    expect(proposeExtension(limits, { ...usage, tokens: 100000 })?.maxTotalTokens).toBe(800000);
  });
  test("ceilings stop growth and report when nothing can be raised", () => {
    const high = { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 24 * 3600 * 1000 };
    expect(proposeExtension(high, { ...usage, tokens: 50_000_000 })).toBeNull();
    expect(proposeExtension({ ...high, maxTotalTokens: 30_000_000 }, { ...usage, tokens: 29_000_000 })?.maxTotalTokens).toBe(50_000_000);
  });
  test("panel text names only the limits that change", () => {
    const budget: BudgetView = { tokens: 390000, heldTokens: 0, inFlightTokens: 0, maxTokens: 400000, calls: 10, maxCalls: 80, activeMs: 60000, maxActiveMs: 3600000, repairRounds: 0, maxRepairRounds: 2 };
    expect(extensionText(budget)).toBe("tokens 400k → 800k");
    expect(extensionFor({ ...budget, maxTokens: 50_000_000, tokens: 50_000_000, maxCalls: 1000, calls: 1000, maxActiveMs: 24 * 3600 * 1000, activeMs: 1 })).toBeNull();
    const snapshot = { runId: "r", featureId: "f", status: "blocked" as const, reason: "budget_exhausted" as const, revision: 1, eventSeq: 1, stageId: "plan", approvalDigest: null, inputHash: "a".repeat(64), workspaceHash: null, tokenUsage: 0, activeMs: 0, estimatedCostUsd: null, verificationState: "not_verified" as const, pendingRequestIds: [] };
    expect(runActions(snapshot, budget).map((a) => a.key)).toEqual(["B", "F", "C"]);
    expect(runActions(snapshot, { ...budget, maxTokens: 50_000_000, tokens: 50_000_000, maxCalls: 1000, calls: 1000, maxActiveMs: 24 * 3600 * 1000, activeMs: 1 }).map((a) => a.key)).toEqual(["F", "C"]);
    expect(headline(snapshot, [{ id: "plan", kind: "plan", status: "failed", generation: 0 }], false, budget).next).toContain("Press B to raise the limits (tokens 400k → 800k)");
  });
});

describe("extending the budget of a blocked run", () => {
  // The fixture reports heavy usage once code is written, so the run stops after approval and
  // implementation. Each extension doubles the token limit.
  const tight = { ...fixturePolicy, maxTotalTokens: 300000 };
  const heavy = (output: string): number => (["implementation", "review", "convergence"].includes(output) ? 150000 : 50);
  async function runUntilBlocked(fixture: ReturnType<typeof workflowFixture>, runId: string) {
    for (let i = 0; i < 12; i++) {
      const run = await fixture.service.get(runId);
      if (run.status === "blocked") return run;
      if (run.status === "completed") return run;
      if (run.pendingRequestIds.length) await fixture.approve(runId);
      else if (run.status === "paused" || run.status === "created") await fixture.resume(runId);
      await fixture.service.drive(runId, new AbortController().signal);
    }
    return fixture.service.get(runId);
  }

  test("raises the stored limits, records the revision, keeps the approval and continues from the stage that stopped", async () => {
    const fixture = workflowFixture({ policy: tight, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    const blocked = await runUntilBlocked(fixture, run.runId);
    expect(blocked).toMatchObject({ status: "blocked", reason: "budget_exhausted", approvalDigest: expect.any(String) });
    expect(fixture.executor.calls).toContain("implementation");
    const stageBefore = blocked.stageId;
    const stateBefore = service.store.state(run.runId);
    const rowBefore = service.store.run(run.runId);
    const callsBefore = fixture.executor.calls.length;

    const extended = await service.extendBudget(run.runId, { commandId: newId(), expectedRevision: blocked.revision });
    expect(extended).toMatchObject({ status: "paused", reason: "none" });
    const row = service.store.run(run.runId);
    const policy = JSON.parse(row.policy_json);
    expect(policy.maxTotalTokens).toBe(600000);
    // Nothing but the limits changed: checks, tools and scope are the approved ones.
    expect({ ...policy, maxTotalTokens: 300000 }).toEqual(JSON.parse(rowBefore.policy_json));
    expect(row.input_hash).toBe(rowBefore.input_hash);
    expect(row.approval_digest).toBe(rowBefore.approval_digest);
    expect(service.store.state(run.runId).stageIndex).toBe(stateBefore.stageIndex);
    expect(service.store.state(run.runId).approvalRoot).toBe(stateBefore.approvalRoot);

    const revision = service.store.artifacts(run.runId).find((a) => a.kind === "policy-revision");
    expect(revision?.logical_path).toMatch(/^policy-revisions\/.+\.json$/);
    const body = JSON.parse(service.store.readArtifact(run.runId, revision!.id));
    expect(body).toMatchObject({ kind: "budget-extension", approvedBy: "user", stageId: stageBefore, previous: { maxTotalTokens: 300000 }, next: { maxTotalTokens: 600000 } });
    expect(body.policyHash).not.toBe(body.previousPolicyHash);

    // Continue: the run picks up at the stopped stage and does not redo earlier stages.
    await fixture.resume(run.runId);
    const after = await runUntilBlocked(fixture, run.runId);
    expect(after.status).toBe("completed");
    // Only the stopped stage and the ones after it ran; nothing before the stop was redone.
    const rerun = fixture.executor.calls.slice(callsBefore);
    for (const earlier of ["research", "spec", "plan", "analysis", "implementation"]) expect(rerun).not.toContain(earlier);
    expect(rerun.length).toBeGreaterThan(0);
    expect(service.store.run(run.runId).approval_digest).toBe(rowBefore.approval_digest);
    const view = readWorkflowView(service, run.runId);
    expect(view.budget.maxTokens).toBe(600000);
  });

  test("a run keeps going through repeated extensions until it completes", async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, maxTotalTokens: 9000 } });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    let extensions = 0;
    for (let i = 0; i < 12; i++) {
      const state = await runUntilBlocked(fixture, run.runId);
      if (state.status === "completed") break;
      expect(state).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
      await service.extendBudget(run.runId, { commandId: newId(), expectedRevision: state.revision });
      extensions++;
    }
    expect((await service.get(run.runId)).status).toBe("completed");
    expect(extensions).toBeGreaterThan(0);
    expect(service.store.artifacts(run.runId).filter((a) => a.kind === "policy-revision")).toHaveLength(extensions);
    // The approval digest is the one the user gave, from the first approval to completion.
    expect(service.store.run(run.runId).approval_digest).toBe(service.store.state(run.runId).approvalRoot);
  });

  test("only a run stopped on its budget can be extended, limits only go up, and a repeat is idempotent", async () => {
    const fixture = workflowFixture({ policy: tight, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await expect(service.extendBudget(run.runId, { commandId: newId(), expectedRevision: run.revision })).rejects.toThrow("stopped on its budget");
    const blocked = await runUntilBlocked(fixture, run.runId);
    const command = { commandId: newId(), expectedRevision: blocked.revision };
    await expect(service.extendBudget(run.runId, { ...command, commandId: newId() }, { maxTotalTokens: 1000 })).rejects.toThrow("only be raised");
    await expect(service.extendBudget(run.runId, { ...command, commandId: newId() }, { maxActiveMs: 100 * 24 * 3600 * 1000 })).rejects.toThrow("ceiling");
    await expect(service.extendBudget(run.runId, { commandId: newId(), expectedRevision: blocked.revision + 5 })).rejects.toThrow("revision");
    const first = await service.extendBudget(run.runId, command, { maxTotalTokens: 450000 });
    const again = await service.extendBudget(run.runId, command, { maxTotalTokens: 450000 });
    expect(again).toEqual(first);
    expect(JSON.parse(service.store.run(run.runId).policy_json).maxTotalTokens).toBe(450000);
    expect(service.store.artifacts(run.runId).filter((a) => a.kind === "policy-revision")).toHaveLength(1);
    await expect(service.extendBudget(run.runId, { ...command, commandId: command.commandId }, { maxTotalTokens: 500000 })).rejects.toThrow("different input");
    // A terminal run cannot be extended.
    await service.cancel(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision });
    await expect(service.extendBudget(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision })).rejects.toThrow();
  });

  test("the CLI raises the limits with explicit values and the run resumes afterwards", async () => {
    const fixture = workflowFixture({ policy: tight, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    const blocked = await runUntilBlocked(fixture, run.runId);
    const signal = new AbortController().signal;
    const result = await executeWorkflowCommand(service, parseWorkflowArgs(["extend", run.runId, "--expected-revision", String(blocked.revision), "--tokens", "700000", "--calls", "120"]), signal) as { status: string };
    expect(result.status).toBe("paused");
    expect(JSON.parse(service.store.run(run.runId).policy_json)).toMatchObject({ maxTotalTokens: 700000, maxAgentCalls: 120 });
    expect(() => parseWorkflowArgs(["extend", run.runId, "--tokens", "abc", "--expected-revision", "1"])).toThrow("integer");
    expect(() => parseWorkflowArgs(["extend", run.runId, "--tokens", "0", "--expected-revision", "1"])).toThrow("integer");
    expect(() => parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--tokens", "5"])).toThrow("not valid");
  });
});

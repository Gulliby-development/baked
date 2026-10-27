import { afterEach, describe, expect, test } from "bun:test";
import { extensionFor, extensionText, headline, runActions } from "../src/components/workflow/format.js";
import { type BudgetLimits, proposeExtension, reserveTokens } from "../src/core/workflows/budget.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { type AgentProfile, PolicySchema } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { type BudgetView, readWorkflowView } from "../src/core/workflows/view.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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
    const snapshot = { runId: "r", featureId: "f", status: "blocked" as const, reason: "budget_exhausted" as const, revision: 1, eventSeq: 1, stageId: "plan", approvalDigest: null, inputHash: "a".repeat(64), workspaceHash: null, tokenUsage: 0, activeMs: 0, estimatedCostUsd: null, verificationState: "not_verified" as const, limitations: { count: 0, ids: [] }, reviewNotes: { count: 0, ids: [] }, pendingRequestIds: [] };
    expect(runActions(snapshot, budget).map((a) => a.key)).toEqual(["B", "F", "U", "C"]);
    expect(runActions(snapshot, { ...budget, maxTokens: 50_000_000, tokens: 50_000_000, maxCalls: 1000, calls: 1000, maxActiveMs: 24 * 3600 * 1000, activeMs: 1 }).map((a) => a.key)).toEqual(["F", "U", "C"]);
    expect(headline(snapshot, [{ id: "plan", kind: "plan", status: "failed", generation: 0 }], false, budget).next).toContain("Press B to raise the limits (tokens 400k → 800k)");
  });
});

// Hot module cap-growth (#2258): a call reserves a token for every three bytes of its prompt (code
// and non-Latin text tokenize denser than four) plus its output, capped by the run limit.
describe("token reservation of a call", () => {
  test("is a third of the prompt's bytes, rounded up, plus the output limit", () => {
    const profile = { maxOutputTokens: 8000 } as AgentProfile;
    const policy = { ...fixturePolicy, maxTotalTokens: 400000 };
    expect(reserveTokens("x".repeat(1200), profile, policy)).toBe(400 + 8000);
    expect(reserveTokens("x".repeat(1201), profile, policy)).toBe(401 + 8000);
    // Cyrillic letters take two bytes each.
    expect(reserveTokens("я".repeat(300), profile, policy)).toBe(200 + 8000);
    expect(reserveTokens("", profile, { ...policy, maxTotalTokens: 5000 })).toBe(5000);
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

  test("an auto-approval token bound that covered the old budget follows the extension", async () => {
    const limits = { maxTasks: 5, maxFiles: 5, allowedPaths: ["**"], allowDelete: false, allowNewDependencies: false as const, maxTotalTokens: 300000 };
    const fixture = workflowFixture({ policy: { ...tight, autoApproval: { renewal: false, limits } }, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    const blocked = await runUntilBlocked(fixture, run.runId);
    expect(blocked).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    await service.extendBudget(run.runId, { commandId: newId(), expectedRevision: blocked.revision }, { maxTotalTokens: 2_000_000 });
    const policy = PolicySchema.parse(JSON.parse(service.store.run(run.runId).policy_json));
    expect(policy.maxTotalTokens).toBe(2_000_000);
    expect(policy.autoApproval?.limits?.maxTotalTokens).toBe(2_000_000);
    // A bound set below the budget on purpose is the operator's choice and stays.
    const strict = workflowFixture({ policy: { ...tight, autoApproval: { renewal: false, limits: { ...limits, maxTotalTokens: 100000 } } }, tokensPerCall: heavy });
    cleanups.push(strict.dispose);
    const strictRun = await strict.start();
    const strictBlocked = await runUntilBlocked(strict, strictRun.runId);
    expect(strictBlocked).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    await strict.service.extendBudget(strictRun.runId, { commandId: newId(), expectedRevision: strictBlocked.revision }, { maxTotalTokens: 2_000_000 });
    const kept = PolicySchema.parse(JSON.parse(strict.service.store.run(strictRun.runId).policy_json));
    expect(kept.autoApproval?.limits?.maxTotalTokens).toBe(100000);
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
    await expect(service.extendBudget(run.runId, { ...command, commandId: newId() }, { maxTotalTokens: 1000 })).rejects.toThrow("Limits can only be raised: tokens 300,000 now, you asked 1,000");
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

  test("extend --resume raises the limits and drives the run on in one command", async () => {
    const fixture = workflowFixture({ policy: tight, tokensPerCall: heavy });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    const blocked = await runUntilBlocked(fixture, run.runId);
    const signal = new AbortController().signal;
    const result = await executeWorkflowCommand(service, parseWorkflowArgs(["extend", run.runId, "--expected-revision", String(blocked.revision), "--tokens", "2000000", "--resume"]), signal) as { status: string; revision: number };
    expect(result.status).not.toBe("paused");
    expect(result.revision).toBeGreaterThan(blocked.revision + 1);
    expect(() => parseWorkflowArgs(["extend", run.runId, "--expected-revision", "1", "--events"])).toThrow("--events and --after need --resume");
  });
});

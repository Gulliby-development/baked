import { afterEach, describe, expect, test } from "bun:test";
import { headline, runActions } from "../src/components/workflow/format.js";
import { canonical } from "../src/core/specs/hash.js";
import { growBudgetOnProgress } from "../src/core/workflows/budget.js";
import { canExtendRun } from "../src/core/workflows/extendable.js";
import {
  costGrowthLimit,
  featurePolicy,
  type InitiativeSettings,
  type InitiativeView,
} from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy, RunSnapshot, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 35, narrowfit sum (#1353): the feature run started with a $1.46 cap (its dollar
// share) and 1,527,292 tokens. Auto-growth raised the tokens to 2,290,938 while the cap stayed
// $1.46, so the run stopped on the cap with 62% of its tokens used and $14 of the initiative
// unspent. It first blocked `invalid_output` at $1.45 of $1.46, where extend was refused, and only
// a resume to the budget stop let the same extend through.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `src/${id}.ts`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });

function usage(input: number): AttemptUsageRecord {
  return {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 20_000_000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: input,
    steps: [{ step: 1, inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
  };
}

/** A sum-like feature run: its share as policy, one task implemented, `tokens` spent on a priced model. */
async function featureRun(policy: RunPolicy, tokens: number) {
  // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
  const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
  cleanups.push(made.dispose);
  const { store } = made.service;
  const { runId } = await made.start();
  store.transaction(() => store.transition(runId, "running"));
  store.setPolicy(runId, policy);
  store.transaction(() =>
    store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task("T001"), task("T002")] }),
  );
  store.transaction(() => store.taskStatus(runId, "T001", "implemented"));
  const stepId = store.beginStep(runId, "implement");
  const attempt = store.reserve(runId, stepId, MODEL, 1000, policy);
  store.transaction(() => {
    store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(tokens)));
    store.finishAttempt(runId, attempt, "completed", tokens);
  });
  return { made, store, runId };
}

const share: RunPolicy = {
  ...fixturePolicy,
  maxAgentCalls: 1000,
  maxTotalTokens: 1_527_292,
  maxCostUsd: 1.46,
};

describe("scenario: a feature's dollar cap grows with its tokens (#1353)", () => {
  test("auto-growth raises the cap by the same factor, up to sizing.maxRunCostUsd, and records it", async () => {
    const policy = { ...share, sizing: { maxRunTokens: 5_000_000, maxRunCostUsd: 9.5 } };
    const { store, runId } = await featureRun(policy, 1_400_000);
    const live = { ...policy };
    expect(growBudgetOnProgress(store, runId, live, 1_600_000)).toBe(true);
    expect(live.maxTotalTokens).toBe(2_290_938);
    // $1.46 times 1.5, rounded up to the cent.
    expect(live.maxCostUsd).toBe(2.19);
    const stored = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    expect([stored.maxTotalTokens, stored.maxCostUsd]).toEqual([2_290_938, 2.19]);
    const revision = store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
      .map((a) => JSON.parse(store.readArtifact(runId, a.id)))
      .at(-1);
    expect(revision).toMatchObject({
      kind: "auto-growth",
      previous: { maxTotalTokens: 1_527_292, maxCostUsd: 1.46 },
      next: { maxTotalTokens: 2_290_938, maxCostUsd: 2.19 },
    });
  });

  test("the grown cap stops at sizing.maxRunCostUsd", async () => {
    const policy = { ...share, sizing: { maxRunTokens: 5_000_000, maxRunCostUsd: 1.8 } };
    const { store, runId } = await featureRun(policy, 1_400_000);
    const live = { ...policy };
    growBudgetOnProgress(store, runId, live, 1_600_000);
    expect(live.maxCostUsd).toBe(1.8);
  });

  test("without sizing.maxRunCostUsd a cap someone set stays where it is", async () => {
    const policy = { ...share, sizing: { maxRunTokens: 5_000_000 } };
    const { store, runId } = await featureRun(policy, 1_400_000);
    const live = { ...policy };
    growBudgetOnProgress(store, runId, live, 1_600_000);
    expect(live.maxTotalTokens).toBe(2_290_938);
    expect(live.maxCostUsd).toBe(1.46);
  });

  test("an initiative lets a feature's cap grow into the dollars the other waiting features do not need", () => {
    const settings = {
      basePolicy: { ...fixturePolicy, maxCostUsd: 8, sizing: { maxRunTokens: 50_000_000 } },
      costBudget: { maxCostUsd: 30, costTolerance: "auto" },
      featureAutoApproval: null,
    } as unknown as InitiativeSettings;
    const waiting = (id: string, shareUsd: number, tokens: number, needLow: number | null) => ({
      id,
      share: { tokens, calls: 100, activeMs: 3_600_000 },
      shareUsd,
      need: needLow === null ? null : { low: needLow, high: needLow * 2 },
    });
    // sum and two others wait; the others need half their token shares at the low end.
    const view = {
      budget: { cost: { remainingUsd: 14 } },
      features: [waiting("sum", 1.46, 1_527_292, 700_000), waiting("language", 7.58, 8_000_000, 4_000_000), waiting("docs", 4.96, 5_000_000, null)],
    } as unknown as InitiativeView;
    // 14 less language's 3.79 (half its share) and docs' whole 4.96: it has no estimate.
    expect(costGrowthLimit(view, "sum")).toBeCloseTo(5.25, 6);
    const feature = { id: "sum", title: "sum", boundary: { scope: "sum", paths: ["src/sum.ts"] }, contract: "sum", dependsOn: [], mandatory: true };
    const policy = featurePolicy(settings, view.features[0]?.share ?? { tokens: 0, calls: 0, activeMs: 0 }, feature, true, 3_000_000, 1.46, costGrowthLimit(view, "sum"));
    expect(policy.maxCostUsd).toBe(1.46);
    expect(policy.sizing?.maxRunCostUsd).toBe(5.25);
    // The base policy's own per-run cap does not bound it under a dollar budget (#1503).
    expect(featurePolicy(settings, view.features[0]?.share ?? { tokens: 0, calls: 0, activeMs: 0 }, feature, true, 3_000_000, 1.46, 20).sizing?.maxRunCostUsd).toBe(20);
    // Without a dollar budget nothing grows.
    expect(costGrowthLimit({ ...view, budget: { cost: { remainingUsd: null } } } as unknown as InitiativeView, "sum")).toBeNull();
  });
});

describe("scenario: extend a run blocked with its dollar cap nearly spent (#1353)", () => {
  test("a run blocked invalid_output at $1.45 of $1.46 can be extended at once", async () => {
    const { made, store, runId } = await featureRun(share, 1_400_000);
    const { spentUsd } = store.costUsage(runId);
    // Price the cap so the spending sits at 99% of it, as sum's $1.45 of $1.46 did.
    const cap = Math.round((spentUsd / 0.99) * 100) / 100;
    store.setPolicy(runId, { ...share, maxCostUsd: cap });
    store.transaction(() => store.transition(runId, "blocked", "invalid_output"));
    const snapshot = await made.service.get(runId);
    expect(canExtendRun(snapshot)).toBe(true);
    expect(runActions(snapshot).map((a) => a.action)).toContain("extend");
    await made.service.extendBudget(runId, { commandId: "extend-1", expectedRevision: snapshot.revision }, { maxCostUsd: cap * 2 });
    const after = await made.service.get(runId);
    expect(after.status).toBe("paused");
    expect(JSON.parse(store.run(runId).policy_json).maxCostUsd).toBe(cap * 2);
  });

  test("a run blocked for another reason with dollars to spare is still refused", async () => {
    const { made, store, runId } = await featureRun({ ...share, maxCostUsd: 100 }, 1_400_000);
    store.transaction(() => store.transition(runId, "blocked", "invalid_output"));
    const snapshot = await made.service.get(runId);
    expect(canExtendRun(snapshot)).toBe(false);
    expect(runActions(snapshot).map((a) => a.action)).not.toContain("extend");
    await expect(
      made.service.extendBudget(runId, { commandId: "extend-2", expectedRevision: snapshot.revision }, { maxCostUsd: 200 }),
    ).rejects.toThrow("Only a run that stopped on its budget");
  });

  test("a run blocked at 90% spent with a 6% reservation is offered extend on every surface (#1435)", async () => {
    const { made, store, runId } = await featureRun(share, 1_400_000);
    const { spentUsd } = store.costUsage(runId);
    // An attempt with unknown usage still holds its reservation: about 6% of the cap below.
    const stepId = store.beginStep(runId, "implement");
    store.reserve(runId, stepId, MODEL, 95_000, { ...share, maxCostUsd: null });
    const cap = Math.round((spentUsd / 0.9) * 100) / 100;
    store.setPolicy(runId, { ...share, maxCostUsd: cap });
    store.transaction(() => store.transition(runId, "blocked", "invalid_output"));
    const { reservedUsd } = store.costUsage(runId);
    expect(spentUsd / cap).toBeLessThan(0.95);
    expect((spentUsd + reservedUsd) / cap).toBeGreaterThanOrEqual(0.95);
    const view = readWorkflowView(made.service, runId);
    const snapshot = view.snapshot;
    expect(canExtendRun(snapshot)).toBe(true);
    expect(runActions(snapshot, view.budget).map((a) => a.action)).toContain("extend");
    expect(headline(snapshot, view.stages, false, view.budget).next).toContain("press B to raise the limits");
    expect(snapshot.reservedCostUsd).toBeCloseTo(reservedUsd, 6);
    await made.service.extendBudget(runId, { commandId: "extend-3", expectedRevision: snapshot.revision }, { maxCostUsd: cap * 2 });
    expect(JSON.parse(store.run(runId).policy_json).maxCostUsd).toBe(cap * 2);
  });

  test("an attempt-cap stop resumes instead, whatever the dollars", () => {
    const blocked = (reason: string, cost: number): Pick<RunSnapshot, "status" | "reason" | "estimatedCostUsd" | "maxCostUsd"> =>
      ({ status: "blocked", reason, estimatedCostUsd: cost, maxCostUsd: 1 }) as Pick<RunSnapshot, "status" | "reason" | "estimatedCostUsd" | "maxCostUsd">;
    expect(canExtendRun(blocked("attempt_cap", 0.99))).toBe(false);
    expect(canExtendRun(blocked("budget_exhausted", 0.1))).toBe(true);
    expect(canExtendRun(blocked("invalid_output", 0.95))).toBe(true);
    expect(canExtendRun(blocked("invalid_output", 0.94))).toBe(false);
    expect(canExtendRun({ ...blocked("invalid_output", 0.9), reservedCostUsd: 0.05 })).toBe(true);
    expect(canExtendRun({ ...blocked("invalid_output", 0.9), reservedCostUsd: 0.04 })).toBe(false);
  });
});

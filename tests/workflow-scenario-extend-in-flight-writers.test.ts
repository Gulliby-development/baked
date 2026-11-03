import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 84, md-site 2361845b (#2590). A run under `clarification: assume` with a
// 6M sizing ceiling and three parallel writers extended at its 12th task finish from 6.0M to 7.5M
// while the writers were already in flight. They kept working, none finished, and when the next
// step of one of them passed 7.5M the extension was refused for want of progress: two attempts
// failed BUDGET_EXHAUSTED with the dollar cap and the hard ceiling far from reached.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;
const FINISHED = 5_290_000;
const HARD = 17_000_000;

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

const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `${id}.txt`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });
const taskId = (i: number) => `T${String(i + 1).padStart(3, "0")}`;

const extensions = (store: WorkflowStore, runId: string) =>
  store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
    .map((a) => JSON.parse(store.readArtifact(runId, a.id)))
    .filter((r) => r.kind === "auto-extend");

/**
 * md-site at the moment the third writer asks for its next step: 5.29M finished, an auto-extend to
 * 7.5M made at the 12th finish with the three writers open at 0.1M each, and the writers since
 * then at 0.6M each. `costTokens` sets the dollar cap to what that many tokens cost at the model's
 * price (null: no cap); `extendTo` the token hard ceiling.
 */
async function writersInFlight(costTokens: number | null, extendTo = HARD) {
  const cap = costTokens === null ? null : Math.round(costTokens * INPUT * 100) / 100;
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", maxAgentCalls: 1000, maxTotalTokens: 6_000_000, maxCostUsd: cap, costTolerance: "off", sizing: { maxRunTokens: 6_000_000, extendToTokens: extendTo } };
  // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
  const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
  cleanups.push(made.dispose);
  const { store } = made.service;
  const { runId } = await made.start();
  store.transaction(() => store.transition(runId, "running"));
  store.setPolicy(runId, policy);
  const tasks = Array.from({ length: 15 }, (_, i) => task(taskId(i)));
  store.transaction(() => {
    store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
    for (const t of tasks.slice(0, 11)) store.taskStatus(runId, t.id, "implemented");
  });
  const stepId = store.beginStep(runId, "fixture");
  const done = store.reserve(runId, stepId, MODEL, 1000, policy);
  store.transaction(() => {
    store.artifact(runId, "usage", `attempts/${done}/usage.json`, canonical(usage(FINISHED)));
    store.finishAttempt(runId, done, "completed", FINISHED);
  });
  // Three writers (T013 to T015) start and take their first steps.
  const writers = [0, 1, 2].map(() => store.reserve(runId, stepId, MODEL, 1000, policy));
  for (const id of writers) {
    store.recordAttemptUsage(runId, id, 100_000);
    store.expandReservation(runId, id, 200_000, policy);
  }
  // T012 finishes; the first writer's next step passes 6.0M and the run extends to 7.5M.
  store.transaction(() => store.taskStatus(runId, "T012", "implemented"));
  store.expandReservation(runId, writers[0] as string, 800_000, policy);
  expect(policy.maxTotalTokens).toBe(7_500_000);
  expect(extensions(store, runId)).toHaveLength(1);
  // The writers keep working; nothing finishes.
  for (const id of writers) store.recordAttemptUsage(runId, id, 600_000);
  store.expandReservation(runId, writers[1] as string, 620_000, policy);
  store.expandReservation(runId, writers[2] as string, 620_000, policy);
  return { store, runId, policy, writers };
}

/** The third writer's next step: 5.29M + 0.8M + 0.62M + 0.9M = 7.61M, past the 7.5M limit. */
const NEXT_STEP = 900_000;

describe("scenario: R84 md-site 2361845b, writers in flight count as progress for an auto-extend (#2590)", () => {
  test("with the hard ceiling and the dollar cap far away the run extends instead of failing the writer", async () => {
    const { store, runId, policy, writers } = await writersInFlight(20_000_000);
    expect(() => store.expandReservation(runId, writers[2] as string, NEXT_STEP, policy)).not.toThrow();
    expect(policy.maxTotalTokens).toBe(9_000_000);
    const all = extensions(store, runId);
    expect(all).toHaveLength(2);
    expect(all[1].taskCompletions).toBe(all[0].taskCompletions);
    expect(all[1].continuedAttempts).toBe(all[0].continuedAttempts);
    expect(all[1].inFlightTokens).toBe(1_500_000);
    expect(Object.values(all[1].openAttemptTokens)).toEqual([600_000, 600_000, 600_000]);
    expect(all[1].hardCeiling).toBeGreaterThanOrEqual(HARD);
    expect(all[1].affordableTokens).toBeGreaterThan(9_000_000);
    // The second writer's next step fits the grown limit: no attempt fails BUDGET_EXHAUSTED.
    expect(() => store.expandReservation(runId, writers[1] as string, 900_000, policy)).not.toThrow();
    expect(store.run(runId).status).toBe("running");
  });

  test("without a dollar cap the run extends the same way, up to the token hard ceiling", async () => {
    const { store, runId, policy, writers } = await writersInFlight(null);
    expect(() => store.expandReservation(runId, writers[2] as string, NEXT_STEP, policy)).not.toThrow();
    expect(extensions(store, runId)).toHaveLength(2);
  });

  test("the same in-flight tokens do not extend twice", async () => {
    const { store, runId, policy, writers } = await writersInFlight(20_000_000);
    store.expandReservation(runId, writers[2] as string, NEXT_STEP, policy);
    // Nothing used since the second extension: the next overrun has no progress.
    expect(() => store.expandReservation(runId, writers[2] as string, policy.maxTotalTokens, policy)).toThrow("Next model step exceeds remaining token budget");
    expect(extensions(store, runId)).toHaveLength(2);
  });

  test("at the token hard ceiling the writer still stops BUDGET_EXHAUSTED", async () => {
    const { store, runId, policy, writers } = await writersInFlight(null, 7_500_000);
    let code: string | undefined;
    try {
      store.expandReservation(runId, writers[2] as string, NEXT_STEP, policy);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("BUDGET_EXHAUSTED");
    expect(policy.maxTotalTokens).toBe(7_500_000);
    expect(extensions(store, runId)).toHaveLength(1);
  });

  test("when the dollar cap pays for no more than the run holds, the writer still stops BUDGET_EXHAUSTED", async () => {
    // The cap pays for 7.4M tokens, short of the 7.61M the step needs; the token ceiling is 17M.
    const { store, runId, policy, writers } = await writersInFlight(7_400_000);
    let code: string | undefined;
    try {
      store.expandReservation(runId, writers[2] as string, NEXT_STEP, policy);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("BUDGET_EXHAUSTED");
    expect(policy.maxTotalTokens).toBe(7_500_000);
    expect(extensions(store, runId)).toHaveLength(1);
  });
});

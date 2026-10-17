import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertAttemptFits } from "../src/core/workflows/budget.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 38, md-site 095b7b11 (#1383). The run had a $13.2 cost ceiling and a
// 6M sizing ceiling under `clarification: assume`. 8 of 9 tasks were done and it had extended
// past the ceiling at the last finish. Its last corrective T009 then ran two attempts: one
// without an edit (interrupted `widened_correction`) and one that edited and stopped at its cap
// (interrupted `continue_at_cap`). Nothing finished and no finding was resolved, so the third
// attempt was refused an extension and the run blocked `budget_exhausted` with $5 of the cap left.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;
const FIRST = 5_900_000;
const SPENT_TOKENS = 8_270_388;
// The run's spend priced at the test model; the cap keeps md-site's ratio of $13.2 to $8.09.
const CAP = Math.round(SPENT_TOKENS * INPUT * (13.2 / 8.09) * 100) / 100;

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

function spend(store: WorkflowStore, runId: string, stepId: string, policy: RunPolicy, tokens: number) {
  const attempt = store.reserve(runId, stepId, MODEL, 1000, policy);
  store.transaction(() => {
    store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(tokens)));
    store.finishAttempt(runId, attempt, "completed", tokens);
  });
}

const extensions = (store: WorkflowStore, runId: string) =>
  store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
    .map((a) => JSON.parse(store.readArtifact(runId, a.id)))
    .filter((b) => b.kind === "auto-extend");

/** md-site after its extension at the last finish and two attempts of corrective T009. */
async function afterTwoAttempts(edited: boolean | "restart") {
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", maxAgentCalls: 1000, maxTotalTokens: 6_000_000, maxCostUsd: CAP, sizing: { maxRunTokens: 6_000_000 } };
  // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
  const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
  cleanups.push(made.dispose);
  const { store } = made.service;
  const run = await made.start();
  const { runId } = run;
  store.transaction(() => store.transition(runId, "running"));
  store.setPolicy(runId, policy);
  const tasks = Array.from({ length: 9 }, (_, i) => task(`T${String(i + 1).padStart(3, "0")}`));
  store.transaction(() => {
    store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
    for (const t of tasks.slice(0, 8)) store.taskStatus(runId, t.id, "implemented");
  });
  const stepId = store.beginStep(runId, "fixture");
  spend(store, runId, stepId, policy, FIRST);
  // The extension past the 6M ceiling, at 8 finished tasks.
  assertAttemptFits(store, runId, "next", policy, 900_000);
  expect(extensions(store, runId)).toHaveLength(1);
  // T009's first attempt edits nothing; its second edits and stops at its cap.
  store.transaction(() => {
    store.taskStatus(runId, "T009", "running");
    store.taskStatus(runId, "T009", "interrupted", null, { cause: "widened_correction" });
    store.taskStatus(runId, "T009", "running");
    if (edited === "restart") store.taskStatus(runId, "T009", "interrupted", null, { cause: "restart", detail: "prose end", carried: true });
    else if (edited) store.taskStatus(runId, "T009", "interrupted", null, { cause: "continue_at_cap" });
    else store.taskStatus(runId, "T009", "interrupted", null, { cause: "restart", detail: "no edit" });
  });
  spend(store, runId, stepId, policy, SPENT_TOKENS - FIRST);
  return { store, runId, policy };
}

describe("scenario: md-site 095b7b11, a corrective continued at its cap counts as progress (#1383)", () => {
  test("the run extends again for the corrective's continued attempt while the cap has room", async () => {
    const { store, runId, policy } = await afterTwoAttempts(true);
    const budget = policy.maxTotalTokens;
    expect(budget).toBeLessThan(SPENT_TOKENS + 1_200_000);
    // The third attempt needs 1.2M, more than the extended budget has left.
    expect(() => assertAttemptFits(store, runId, "next", policy, 1_200_000)).not.toThrow();
    expect(policy.maxTotalTokens).toBeGreaterThan(budget);
    const all = extensions(store, runId);
    expect(all).toHaveLength(2);
    expect(all[1].continuedAttempts).toBe(1);
    expect(all[1].taskCompletions).toBe(all[0].taskCompletions);
  });

  // Sibling of #1388 (#1432): a restart that carries the attempt's edits keeps work the same way.
  test("a restart that carried its edits counts as progress too", async () => {
    const { store, runId, policy } = await afterTwoAttempts("restart");
    expect(() => assertAttemptFits(store, runId, "next", policy, 1_200_000)).not.toThrow();
    const all = extensions(store, runId);
    expect(all).toHaveLength(2);
    expect(all[1].continuedAttempts).toBe(1);
  });

  test("attempts that kept no edits are still no progress", async () => {
    const { store, runId, policy } = await afterTwoAttempts(false);
    expect(() => assertAttemptFits(store, runId, "next", policy, 1_200_000)).toThrow();
    expect(extensions(store, runId)).toHaveLength(1);
  });

  test("the same continued attempt does not extend twice", async () => {
    const { store, runId, policy } = await afterTwoAttempts(true);
    assertAttemptFits(store, runId, "next", policy, 1_200_000);
    expect(() => assertAttemptFits(store, runId, "next", policy, policy.maxTotalTokens)).toThrow();
    expect(extensions(store, runId)).toHaveLength(2);
  });
});

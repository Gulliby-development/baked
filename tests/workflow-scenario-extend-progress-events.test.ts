import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertAttemptFits } from "../src/core/workflows/budget.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 27, cfgtrace eff0ebe7 (#1224). The run had a $12 cost cap and an 8M
// sizing ceiling under `clarification: assume`. At 13 finished tasks it extended past the ceiling
// to 10M. Corrective T014 then finished and invalidated T005 and T011 in the same transaction, so
// 13 tasks were still `implemented`; the next extension saw no progress, and the run stopped
// `budget_exhausted` at 9,814,993 tokens with $3.20 of the cap left and T015 unstarted.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;
const FIRST = 7_900_000;
const SPENT_TOKENS = 9_814_993;
// The run's spend priced at the test model; the cap keeps cfgtrace's ratio of $12 to $8.80.
const CAP = Math.round(SPENT_TOKENS * INPUT * (12 / 8.8) * 100) / 100;

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

/** cfgtrace after its first extension and corrective T014: 9.81M spent, 13 tasks implemented. */
async function afterCorrective(maxCostUsd: number | null) {
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", maxAgentCalls: 1000, maxTotalTokens: 8_000_000, maxCostUsd, sizing: { maxRunTokens: 8_000_000 } };
  // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
  const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
  cleanups.push(made.dispose);
  const { store } = made.service;
  const run = await made.start();
  const { runId } = run;
  store.transaction(() => store.transition(runId, "running"));
  store.setPolicy(runId, policy);
  const tasks = Array.from({ length: 15 }, (_, i) => task(`T${String(i + 1).padStart(3, "0")}`));
  store.transaction(() => {
    store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
    for (const t of tasks.slice(0, 13)) store.taskStatus(runId, t.id, "implemented");
  });
  const stepId = store.beginStep(runId, "fixture");
  spend(store, runId, stepId, policy, FIRST);
  // The first extension past the 8M ceiling, at 13 finished tasks.
  assertAttemptFits(store, runId, "next", policy, 600_000);
  expect(extensions(store, runId)).toHaveLength(1);
  expect(policy.maxTotalTokens).toBe(10_000_000);
  // Corrective T014 finishes and invalidates T005 and T011 in the same transaction.
  store.transaction(() => {
    store.taskStatus(runId, "T014", "implemented");
    store.taskStatus(runId, "T005", "invalidated");
    store.taskStatus(runId, "T011", "invalidated");
  });
  spend(store, runId, stepId, policy, SPENT_TOKENS - FIRST);
  expect(store.tasks(runId).filter((t) => t.status === "implemented")).toHaveLength(12);
  return { store, runId, policy };
}

describe("scenario: cfgtrace eff0ebe7, a corrective that invalidates tasks still counts as progress (#1224)", () => {
  test("the run extends again for its last corrective task while the cap has room", async () => {
    const { store, runId, policy } = await afterCorrective(CAP);
    // T015 needs 600k; 185k tokens are left under the 10M budget.
    expect(() => assertAttemptFits(store, runId, "next", policy, 600_000)).not.toThrow();
    expect(policy.maxTotalTokens).toBeGreaterThan(10_000_000);
    const last = extensions(store, runId).at(-1);
    expect(extensions(store, runId)).toHaveLength(2);
    expect(last.taskCompletions).toBeGreaterThan(extensions(store, runId)[0].taskCompletions);
  });

  test("a finished task invalidated and finished again counts each time", async () => {
    const { store, runId } = await afterCorrective(CAP);
    const before = store.taskCompletions(runId);
    store.transaction(() => store.taskStatus(runId, "T005", "implemented"));
    expect(store.taskCompletions(runId)).toBe(before + 1);
    // Keeping a snapshot on an implemented task is not a new finish.
    store.transaction(() => store.taskStatus(runId, "T005", "implemented"));
    expect(store.taskCompletions(runId)).toBe(before + 1);
  });

  test("with no finish since the last extension the run still stops", async () => {
    const { store, runId, policy } = await afterCorrective(CAP);
    assertAttemptFits(store, runId, "next", policy, 600_000);
    const budget = policy.maxTotalTokens;
    // Nothing finished since the second extension: a call past it is refused.
    expect(() => assertAttemptFits(store, runId, "next", policy, budget)).toThrow();
    expect(extensions(store, runId)).toHaveLength(2);
  });
});

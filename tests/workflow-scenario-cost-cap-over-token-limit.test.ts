import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertAttemptFits } from "../src/core/workflows/budget.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 26, cfgtrace 14b1da41 (#1206). The run had a $12 cost cap and a sizing
// ceiling of 8M tokens; under `clarification: assume` it extended to the 12M token hard limit
// (1.5 times the ceiling). At 11,686,061 tokens and $10.55 the last corrective task needed more
// than the 314k tokens left, and the run stopped `budget_exhausted` with $1.45 of the cap unspent
// and 1 of 20 tasks unfinished. With a cost cap the dollars govern: the run extends past the token
// hard limit while the cap pays for it, and the cap stops it, as a cost stop.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;
const SPENT_TOKENS = 11_686_061;
// The run's spend priced at the test model; the cap keeps cfgtrace's ratio of $12 to $10.55.
const CAP = Math.round(SPENT_TOKENS * INPUT * (12 / 10.55) * 100) / 100;

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

/** cfgtrace at its stop: the budget at the 12M hard limit, 11.69M tokens spent, 19 of 20 tasks done. */
async function atHardLimit(maxCostUsd: number | null) {
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", maxAgentCalls: 1000, maxTotalTokens: 12_000_000, maxCostUsd, sizing: { maxRunTokens: 8_000_000 } };
  // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
  const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
  cleanups.push(made.dispose);
  const { store } = made.service;
  const run = await made.start();
  store.transaction(() => store.transition(run.runId, "running"));
  store.setPolicy(run.runId, policy);
  const tasks = Array.from({ length: 20 }, (_, i) => task(`T${String(i + 1).padStart(3, "0")}`));
  store.transaction(() => {
    store.syncTasks(run.runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
    for (const t of tasks.slice(0, 19)) store.taskStatus(run.runId, t.id, "implemented");
  });
  const stepId = store.beginStep(run.runId, "fixture");
  const spent = store.reserve(run.runId, stepId, MODEL, 1000, policy);
  store.transaction(() => {
    store.artifact(run.runId, "usage", `attempts/${spent}/usage.json`, canonical(usage(SPENT_TOKENS)));
    store.finishAttempt(run.runId, spent, "completed", SPENT_TOKENS);
  });
  return { store, runId: run.runId, stepId, policy };
}

describe("scenario: cfgtrace 14b1da41, a cost cap over the token hard limit (#1206)", () => {
  test("with a cost cap the last corrective task starts past the token hard limit", async () => {
    const { store, runId, stepId, policy } = await atHardLimit(CAP);
    // T020's attempt needs 600k; 314k tokens are left under the 12M hard limit.
    expect(() => assertAttemptFits(store, runId, "next", policy, 600_000)).not.toThrow();
    expect(policy.maxTotalTokens).toBeGreaterThan(12_000_000);
    const extension = store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
      .map((a) => JSON.parse(store.readArtifact(runId, a.id)))
      .at(-1);
    expect(extension).toMatchObject({ kind: "auto-extend", approvedBy: "sizing" });
    expect(extension.hardCeiling).toBeGreaterThan(12_000_000);
    // The attempt itself fits the dollar cap.
    expect(() => store.reserve(runId, stepId, MODEL, 600_000, policy)).not.toThrow();
  });

  test("the cost cap is what stops the run, as a cost stop", async () => {
    const { store, runId, stepId, policy } = await atHardLimit(CAP);
    // An attempt the cap cannot pay for: the token budget may grow, the cost cap refuses it.
    const unaffordable = Math.ceil((CAP - SPENT_TOKENS * INPUT) / INPUT) + 1_000_000;
    let fault: unknown;
    try {
      assertAttemptFits(store, runId, "next", policy, unaffordable);
      store.reserve(runId, stepId, MODEL, unaffordable, policy);
    } catch (error) {
      fault = error;
    }
    expect(fault).toBeInstanceOf(WorkflowFault);
    expect((fault as WorkflowFault).details).toMatchObject({ reason: "cost", maxCostUsd: CAP });
  });

  test("without a cost cap the token hard limit still stops the run", async () => {
    const { store, runId, policy } = await atHardLimit(null);
    expect(() => assertAttemptFits(store, runId, "next", policy, 600_000)).toThrow(
      "The next attempt needs more tokens than the run budget has left",
    );
    expect(policy.maxTotalTokens).toBe(12_000_000);
  });
});

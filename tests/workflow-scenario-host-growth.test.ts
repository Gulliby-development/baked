import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { growBudgetOnProgress } from "../src/core/workflows/budget.js";
import { PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { canonical } from "../src/core/specs/hash.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Siblings of #1318 and #1363 from the 2026-10-17 audit: since the host grows budgets and caps on
// its own, checks that compare a policy with one a person approved or answered read that growth
// as a change a person must decide again.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: renewal after the host grew the budget (#1430)", () => {
  test("a revise the host then grows is renewed without a person", async () => {
    const auto: RunPolicy = { ...fixturePolicy, autoApproval: { renewal: true, limits: null }, sizing: { maxRunTokens: 10_000_000 } };
    const made = workflowFixture({ policy: auto });
    cleanups.push(made.dispose);
    const { service, root } = made;
    const run = await made.start();
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    await made.approve(run.runId);
    writeFileSync(join(root, "AGENTS.md"), "Use fixture conventions.\r\n");
    const candidate = await new WorkflowArtifacts(service).stageRevision(run.runId, { commandId: "stage-1", expectedInputHash: (await service.get(run.runId)).inputHash });
    await service.revise(run.runId, { commandId: "revise-1", expectedRevision: (await service.get(run.runId)).revision }, candidate.candidateHash);
    // The host grows the budget after the operator's revise, as auto-growth does mid-run.
    const { store } = service;
    const live = PolicySchema.parse(JSON.parse(store.run(run.runId).policy_json));
    const stepId = store.beginStep(run.runId, "plan");
    const attempt = store.reserve(run.runId, stepId, "fixture/model", 1000, live);
    store.transaction(() => store.finishAttempt(run.runId, attempt, "completed", 1000));
    expect(growBudgetOnProgress(store, run.runId, live, live.maxTotalTokens + 1)).toBe(true);
    const done = await service.drive(run.runId, new AbortController().signal);
    const approvals = store.requests(run.runId).filter((r) => r.kind === "approval");
    expect(JSON.parse(approvals.at(-1)?.body_json ?? "{}").autoApproval?.declined ?? []).toEqual([]);
    expect(done.status).toBe("completed");
    expect(approvals.map((r) => r.actor)).toEqual(["user", "auto-approval"]);
  });
});

const MODEL = "anthropic/claude-sonnet-4-6";

function usage(input: number): AttemptUsageRecord {
  return { schemaVersion: 1, profileId: "implementer", taskId: null, maxSteps: 10, maxTokens: 20_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: input, steps: [{ step: 1, inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }] };
}

describe("scenario: a cost check after another attempt grew the cap (#1434)", () => {
  test("a reservation against a stale policy object is checked against the stored, grown cap", async () => {
    const policy: RunPolicy = { ...fixturePolicy, maxAgentCalls: 1000, maxTotalTokens: 10_000_000, maxCostUsd: 10 };
    // The fixture model has no price, so the run starts uncapped and takes the capped policy after.
    const made = workflowFixture({ policy: { ...policy, maxCostUsd: null } });
    cleanups.push(made.dispose);
    const { store } = made.service;
    const { runId } = await made.start();
    store.transaction(() => store.transition(runId, "running"));
    store.setPolicy(runId, policy);
    const stepId = store.beginStep(runId, "implement");
    const first = store.reserve(runId, stepId, MODEL, 1000, policy);
    store.transaction(() => {
      store.artifact(runId, "usage", `attempts/${first}/usage.json`, canonical(usage(2_000_000)));
      store.finishAttempt(runId, first, "completed", 2_000_000);
    });
    const { spentUsd } = store.costUsage(runId);
    // The cap this drive holds is nearly spent; another attempt has grown the stored cap since.
    const stale: RunPolicy = { ...policy, maxCostUsd: Math.ceil(spentUsd * 1.01 * 100) / 100 };
    store.setPolicy(runId, { ...stale, maxCostUsd: spentUsd * 3 });
    const next = store.beginStep(runId, "implement");
    expect(() => store.reserve(runId, next, MODEL, 1_000_000, stale)).not.toThrow();
    // Past the stored cap it still stops on cost.
    const fault = (() => {
      try {
        store.reserve(runId, store.beginStep(runId, "implement"), MODEL, 5_000_000, stale);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(fault).toBeInstanceOf(WorkflowFault);
    expect((fault as WorkflowFault).details).toMatchObject({ reason: "cost", maxCostUsd: spentUsd * 3 });
  });
});

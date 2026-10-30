import { afterEach, describe, expect, test } from "bun:test";
import { canonical } from "../src/core/specs/hash.js";
import { growBudgetOnProgress } from "../src/core/workflows/budget.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 79, deltaglue (#2468). Four features shared a 12.0M token pool. chunks ran under
// `clarification: assume` past its 8M sizing ceiling: its auto-extends `auto-4` and `auto-5` set
// its limit to 10M and then 12M, bounded only by what its $25.51 dollar bound paid for (hard
// ceilings 28.9M and 35.8M), while the other features had used 1,859,601 tokens. chunks stopped
// at 10,821,649 and the initiative at 12,681,250 of its 12.0M pool: 681,250 over a limit the
// person set. The `initiative-pool-growth` shadow had recorded the would-stop three times.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const POOL = 12_000_000;
const CEILING = 8_000_000;
/** frames 0.77M, commands 1.05M and the decompose run's 0.03M, as two features here. */
const OTHERS = { frames: 800_000, commands: 1_059_601 };
const OTHERS_USED = OTHERS.frames + OTHERS.commands;

const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `${id}.txt`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });
const usage = (tokens: number): AttemptUsageRecord => ({
  schemaVersion: 1, profileId: "implementer", taskId: null, maxSteps: 10, maxTokens: 20_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: tokens,
  steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
});

function spend(store: WorkflowStore, runId: string, tokens: number) {
  const stepId = store.beginStep(runId, "implement");
  const attempt = store.reserve(runId, stepId, MODEL, 1000, { ...fixturePolicy, maxTotalTokens: 1_000_000_000, maxCostUsd: null });
  store.transaction(() => {
    store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(tokens)));
    store.finishAttempt(runId, attempt, "completed", tokens);
  });
}

const plan: InitiativePlan = {
  schemaVersion: 1, title: "Deltaglue", goals: ["Create the CLI"], completionCriteria: ["The CLI is ready"],
  features: ["frames", "commands", "chunks"].map((id) => ({
    id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`, dependsOn: [], mandatory: true,
  })),
};

/**
 * deltaglue with chunks at its sizing ceiling: the other features used `othersUsed`, chunks has
 * used just under its 8M limit, and every call past it finishes a task first. Returns the limits
 * the run's auto-extends reach.
 */
async function deltaglue(othersUsed: typeof OTHERS) {
  const fixture = workflowFixture();
  fixture.config.defaultModel = MODEL;
  cleanups.push(async () => fixture.dispose());
  const initiatives = new InitiativeService(fixture.service);
  const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 4_000_000, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: CEILING } };
  const view = await initiatives.start({ commandId: newId(), initiativeId: "deltaglue", prompt: "Create the CLI", plan, policy, model: MODEL, ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: POOL, maxAgentCalls: 1000, maxActiveMs: 21_600_000 } });
  const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
  await initiatives.approve("deltaglue", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
  const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean> };
  for (const id of ["frames", "commands", "chunks"]) expect(await service.startFeature("deltaglue", id)).toBe(true);
  const runOf = (id: string) => initiatives.view("deltaglue").features.find((f) => f.id === id)!.runId!;
  const store = fixture.service.store;
  for (const [id, tokens] of Object.entries(othersUsed)) {
    const runId = runOf(id);
    store.transaction(() => store.transition(runId, "running"));
    if (tokens > 0) spend(store, runId, tokens);
  }
  const runId = runOf("chunks");
  store.transaction(() => store.transition(runId, "running"));
  // chunks at its ceiling, with an extend-to (the stand-in for what its dollar bound paid for,
  // 35.8M in R79) far above the pool.
  const chunks: RunPolicy = { ...JSON.parse(store.run(runId).policy_json), clarification: "assume", maxTotalTokens: CEILING, maxCostUsd: null, sizing: { maxRunTokens: CEILING, extendToTokens: 40_000_000 } };
  store.setPolicy(runId, chunks);
  const tasks = Array.from({ length: 8 }, (_, i) => task(`T${String(i + 1).padStart(3, "0")}`));
  store.transaction(() => store.syncTasks(runId, { schemaVersion: 1, featureId: "chunks", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks }));
  spend(store, runId, CEILING - 100_000);
  const limits: number[] = [];
  for (const t of tasks) {
    // A task finishes, then the next call passes the limit by one token.
    store.transaction(() => store.taskStatus(runId, t.id, "implemented"));
    growBudgetOnProgress(store, runId, chunks, chunks.maxTotalTokens + 1);
    if (chunks.maxTotalTokens !== limits.at(-1)) limits.push(chunks.maxTotalTokens);
  }
  const revisions = store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("policy-revisions/auto-"))
    .map((a) => JSON.parse(store.readArtifact(runId, a.id)))
    .filter((b) => b.kind === "auto-extend");
  return { limits, revisions, stored: (JSON.parse(store.run(runId).policy_json) as RunPolicy).maxTotalTokens, initiatives };
}

describe("scenario: R79 deltaglue's chunks auto-extends no further than its pool leaves (#2468)", () => {
  test("with 1.86M of the 12.0M pool used by the others, the auto-extend stops at 10.14M", async () => {
    const { limits, revisions, stored, initiatives } = await deltaglue(OTHERS);
    // Before #2468: 10M, 12M, 14M, ... up to the 40M extend-to, the dollar bound's 35.8M in R79.
    expect(limits).toEqual([10_000_000, POOL - OTHERS_USED]);
    expect(stored).toBe(10_140_399);
    expect(revisions.at(-1)).toMatchObject({ next: { maxTotalTokens: POOL - OTHERS_USED }, hardCeiling: POOL - OTHERS_USED, poolHoldTokens: POOL - OTHERS_USED });
    // The run's limit and the others' use stay inside the pool the person set.
    expect(stored + OTHERS_USED).toBeLessThanOrEqual(initiatives.view("deltaglue").budget.limits.maxTotalTokens);
  });

  test("with the run alone in the pool, it still reaches the whole 12.0M", async () => {
    const { limits, stored } = await deltaglue({ frames: 0, commands: 0 });
    expect(limits).toEqual([10_000_000, POOL]);
    expect(stored).toBe(POOL);
  });

  test("a run of no initiative still extends to its extend-to", async () => {
    const fixture = workflowFixture();
    cleanups.push(async () => fixture.dispose());
    const store = fixture.service.store;
    const { runId } = await fixture.start();
    store.transaction(() => store.transition(runId, "running"));
    const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", maxAgentCalls: 1000, maxTotalTokens: CEILING, maxCostUsd: null, sizing: { maxRunTokens: CEILING, extendToTokens: 14_000_000 } };
    store.setPolicy(runId, policy);
    const tasks = Array.from({ length: 4 }, (_, i) => task(`T${String(i + 1).padStart(3, "0")}`));
    store.transaction(() => store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks }));
    expect(store.tokenHold?.(runId) ?? null).toBeNull();
    for (const t of tasks) {
      store.transaction(() => store.taskStatus(runId, t.id, "implemented"));
      growBudgetOnProgress(store, runId, policy, policy.maxTotalTokens + 1);
    }
    expect(policy.maxTotalTokens).toBe(14_000_000);
  });
});

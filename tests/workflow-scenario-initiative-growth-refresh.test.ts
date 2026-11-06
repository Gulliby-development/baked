import { afterEach, describe, expect, test } from "bun:test";
import { canonical } from "../src/core/specs/hash.js";
import { growBudgetOnProgress } from "../src/core/workflows/budget.js";
import { hostGrowth, withoutHostGrowth } from "../src/core/workflows/host-growth.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { costGrowthLimit, InitiativeService, refreshedGrowth } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy, Task } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 60, wheeltags explain (#1931). A planned-ahead feature got its room to grow when it
// started planning at 19:00: share $2.17, bound $3.41. It was released to implement 98 minutes
// later with the same bound. At 20:43 its first T002 attempt took the run to $3.10 spent plus 937k
// tokens reserved, the next call would pass $3.41 and its 10 percent tolerance, and the run blocked
// budget_exhausted while the initiative had $24.91 of $30 committed and its two waiting features
// needed $1.63 at their priced lows. An owner approved $40 the next morning; none of it was used.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `src/${id}.ts`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });
const usage = (tokens: number): AttemptUsageRecord => ({
  schemaVersion: 1, profileId: "implementer", taskId: null, maxSteps: 10, maxTokens: 20_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: tokens,
  steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
});

/** explain as it was released: its share as cap, its start-time bound, the base policy's ceilings. */
const explain: RunPolicy = {
  ...fixturePolicy,
  maxAgentCalls: 200,
  maxTotalTokens: 5_000_000,
  maxActiveMs: 1_986_252,
  maxCostUsd: 3.41,
  costTolerance: 0.1,
  sizing: { maxRunTokens: 5_000_000, maxRunCostUsd: 3.41 },
};
const base: RunPolicy = { ...fixturePolicy, sizing: { maxRunTokens: 40_000_000 } };

describe("scenario: wheeltags R60 explain grows into the dollars other features freed (#1931)", () => {
  // At 20:43: committed $24.91 of $30 with explain at its $3.41 cap, waiting lows front $1.09 and
  // docs $0.54.
  const spareUsd = 30 - 24.91 - 1.09 - 0.54;
  const held = { usd: 3.41, tokens: 5_000_000, calls: 200, activeMs: 1_986_252 };

  test("the refreshed bound is what the run holds plus what the initiative can spare now", () => {
    const after = refreshedGrowth(explain, base, held, { calls: 40, activeMs: 1_859_458 }, { usd: spareUsd, tokens: 10_000_000, calls: 300, activeMs: 3_600_000 });
    expect(after?.sizing?.maxRunCostUsd).toBe(6.87);
    expect(after?.sizing?.maxRunTokens).toBe(15_000_000);
    // explain had used 94 percent of its active time; its calls were far from their limit. It
    // rises by a quarter at most and asks again when it needs more (#1958).
    expect(after?.maxActiveMs).toBe(Math.ceil(1_986_252 * 1.25));
    expect(after?.maxAgentCalls).toBe(200);
    // The cap itself does not move: the run grows it when a call needs it.
    expect(after?.maxCostUsd).toBe(3.41);
  });

  test("bounds only rise, and the base policy's ceilings still hold", () => {
    expect(refreshedGrowth(explain, base, held, { calls: 0, activeMs: 0 }, { usd: 0, tokens: 0, calls: 0, activeMs: 0 })).toBeNull();
    const capped = refreshedGrowth(explain, { ...base, sizing: { maxRunTokens: 6_000_000 } }, held, { calls: 0, activeMs: 0 }, { usd: 0, tokens: 30_000_000, calls: 0, activeMs: 0 });
    expect(capped?.sizing?.maxRunTokens).toBe(6_000_000);
    // A run without a dollar budget gets no dollar bound.
    expect(refreshedGrowth({ ...explain, sizing: { maxRunTokens: 5_000_000 } }, base, held, { calls: 0, activeMs: 0 }, { usd: 20, tokens: 0, calls: 0, activeMs: 0 })?.sizing?.maxRunCostUsd).toBeUndefined();
  });

  test("the call that stopped explain grows instead once the stored bound is refreshed, with the drive's own copy stale", async () => {
    const made = workflowFixture({ policy: { ...explain, maxCostUsd: null } });
    cleanups.push(made.dispose);
    const { store } = made.service;
    const { runId } = await made.start();
    store.transaction(() => store.transition(runId, "running"));
    store.setPolicy(runId, explain);
    store.transaction(() => store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task("T001"), task("T002")] }));
    const stepId = store.beginStep(runId, "implement");
    // Spend about $3.10 at the model's price, as T002's first attempt left the run.
    const perToken = (() => {
      const attempt = store.reserve(runId, stepId, MODEL, 1000, { ...explain, maxCostUsd: null });
      store.transaction(() => {
        store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(1_000_000)));
        store.finishAttempt(runId, attempt, "completed", 1_000_000);
      });
      return store.costUsage(runId).spentUsd / 1_000_000;
    })();
    const more = Math.round(3.1 / perToken) - 1_000_000;
    const second = store.reserve(runId, stepId, MODEL, 1000, { ...explain, maxCostUsd: null });
    store.transaction(() => {
      store.artifact(runId, "usage", `attempts/${second}/usage.json`, canonical(usage(more)));
      store.finishAttempt(runId, second, "completed", more);
    });
    // The next call: $3.10 spent and $0.75 requested pass $3.41 and its tolerance ($3.75).
    const request = Math.round(0.75 / perToken);
    const drive = structuredClone(explain);
    expect(store.costCapDecision(runId, stepId, structuredClone(explain), MODEL, request)?.decision).toBe("stop");
    // The initiative refreshes the stored policy while the drive holds its copy.
    const after = refreshedGrowth(explain, base, held, { calls: 0, activeMs: 0 }, { usd: spareUsd, tokens: 0, calls: 0, activeMs: 0 });
    store.setPolicy(runId, after!);
    expect(store.costCapDecision(runId, stepId, drive, MODEL, request)?.decision).toBe("grow");
    expect(drive.sizing?.maxRunCostUsd).toBe(6.87);
    expect(drive.maxCostUsd!).toBeGreaterThan(3.41);
  });
});

const plan: InitiativePlan = {
  schemaVersion: 1, title: "Values", goals: ["Create values"], completionCriteria: ["Values are ready"],
  features: ["base", "explain", "docs"].map((id) => ({
    id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`, dependsOn: [], mandatory: true,
  })),
};

describe("scenario: the initiative refreshes an open feature run's bound and records it (#1931)", () => {
  test("a run started on a stale bound is raised to its cap plus the spare, as a host revision a renewal undoes", async () => {
    const fixture = workflowFixture();
    fixture.config.defaultModel = MODEL;
    cleanups.push(fixture.dispose);
    const initiatives = new InitiativeService(fixture.service);
    const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 10_000_000, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: 50_000_000, maxRunCostUsd: 100 } };
    const view = await initiatives.start({ commandId: newId(), initiativeId: "wheeltags", prompt: "Create values", plan, policy, model: MODEL, ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 }, costBudget: { maxCostUsd: 30, costTolerance: "off" } });
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("wheeltags", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
    const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean>; refreshGrowth(id: string, featureId: string, runId: string): void };
    expect(await service.startFeature("wheeltags", "explain")).toBe(true);
    const runId = initiatives.view("wheeltags").features.find((f) => f.id === "explain")!.runId!;
    const store = fixture.service.store;
    const started = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    // Plant the bound explain had: its cap, as if the others had held the rest when it started.
    const stale = { ...started, sizing: { ...started.sizing, maxRunCostUsd: started.maxCostUsd! } };
    store.setPolicy(runId, stale);
    service.refreshGrowth("wheeltags", "explain", runId);
    const refreshed = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    const spare = costGrowthLimit(initiatives.view("wheeltags"), "explain")!;
    expect(spare).toBeGreaterThan(0);
    expect(refreshed.sizing!.maxRunCostUsd!).toBeCloseTo(Math.floor((started.maxCostUsd! + spare) * 100) / 100, 2);
    expect(refreshed.maxCostUsd).toBe(started.maxCostUsd);
    const revisions = store.artifacts(runId).filter((a) => a.logical_path.startsWith("policy-revisions/initiative-"));
    expect(revisions).toHaveLength(1);
    const body = JSON.parse(store.readArtifact(runId, revisions[0]!.id));
    expect(body).toMatchObject({ kind: "initiative-growth", approvedBy: "sizing", previous: { sizing: { maxRunCostUsd: started.maxCostUsd } }, next: { sizing: { maxRunCostUsd: refreshed.sizing!.maxRunCostUsd } } });
    expect(body.inputs.spareUsd).toBeCloseTo(spare, 6);
    // A renewal compares against the policy before the host's growth.
    const read = (a: { id: string }) => store.readArtifact(runId, a.id);
    const { hashJson } = await import("../src/core/specs/hash.js");
    expect(withoutHostGrowth(refreshed, hostGrowth(store.artifacts(runId), read, hashJson(refreshed))).sizing).toEqual(stale.sizing);
    // Nothing changed since: a second refresh writes nothing.
    service.refreshGrowth("wheeltags", "explain", runId);
    expect(store.artifacts(runId).filter((a) => a.logical_path.startsWith("policy-revisions/initiative-"))).toHaveLength(1);
  });
});

// Every path that raises a feature run's token limit reads what the initiative holds for the run
// (AGENTS.md): the initiative-growth bounds through `chargeHold` and `growthLimit`, the run's own
// auto-growth and auto-extend through `WorkflowStore.tokenHold` (#2468, R79 deltaglue).
describe("scenario: an open feature run grows into its refreshed bound no further than the pool holds (#2468)", () => {
  test("auto-growth and auto-extend toward a 20M bound stop at the pool less the others' use", async () => {
    const fixture = workflowFixture();
    fixture.config.defaultModel = MODEL;
    cleanups.push(fixture.dispose);
    const initiatives = new InitiativeService(fixture.service);
    const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 4_000_000, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: 8_000_000 } };
    const view = await initiatives.start({ commandId: newId(), initiativeId: "wheeltags", prompt: "Create values", plan, policy, model: MODEL, ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: 12_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 } });
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("wheeltags", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
    const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean> };
    expect(await service.startFeature("wheeltags", "base")).toBe(true);
    expect(await service.startFeature("wheeltags", "explain")).toBe(true);
    const runOf = (id: string) => initiatives.view("wheeltags").features.find((f) => f.id === id)!.runId!;
    const store = fixture.service.store;
    // base used 6.5M of the 12M pool: 5.5M is what the pool holds for explain.
    const baseRun = runOf("base");
    store.transaction(() => store.transition(baseRun, "running"));
    const stepId = store.beginStep(baseRun, "implement");
    const attempt = store.reserve(baseRun, stepId, MODEL, 1000, { ...fixturePolicy, maxTotalTokens: 1_000_000_000, maxCostUsd: null });
    store.transaction(() => {
      store.artifact(baseRun, "usage", `attempts/${attempt}/usage.json`, canonical(usage(6_500_000)));
      store.finishAttempt(baseRun, attempt, "completed", 6_500_000);
    });
    const runId = runOf("explain");
    store.transaction(() => store.transition(runId, "running"));
    // explain's bounds as a refresh left them, above the pool: 20M to grow to, 30M to extend to.
    const explainPolicy: RunPolicy = { ...JSON.parse(store.run(runId).policy_json), clarification: "assume", maxTotalTokens: 3_000_000, maxCostUsd: null, sizing: { maxRunTokens: 20_000_000, extendToTokens: 30_000_000 } };
    store.setPolicy(runId, explainPolicy);
    store.transaction(() => {
      store.syncTasks(runId, { schemaVersion: 1, featureId: "explain", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task("T001"), task("T002")] });
      store.taskStatus(runId, "T001", "implemented");
    });
    // A call that needs 9M: auto-growth would take the run to 9M on its 20M bound.
    expect(growBudgetOnProgress(store, runId, explainPolicy, 9_000_000)).toBe(false);
    expect(explainPolicy.maxTotalTokens).toBe(5_500_000);
    expect(store.tokenHold?.(runId)).toBe(5_500_000);
    const growth = store.artifacts(runId).filter((a) => a.logical_path.startsWith("policy-revisions/auto-")).map((a) => JSON.parse(store.readArtifact(runId, a.id)));
    expect(growth.map((g) => [g.kind, g.next.maxTotalTokens, g.poolHoldTokens])).toEqual([["auto-growth", 5_500_000, 5_500_000]]);
    // Another task finishes: still no growth past the hold.
    store.transaction(() => store.taskStatus(runId, "T002", "implemented"));
    expect(growBudgetOnProgress(store, runId, explainPolicy, 5_600_000)).toBe(false);
    expect(explainPolicy.maxTotalTokens).toBe(5_500_000);
  });
});

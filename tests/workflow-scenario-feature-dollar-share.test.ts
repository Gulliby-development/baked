import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { startApiServer } from "../src/core/api/server.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { assertAttemptFits, grownCostCap } from "../src/core/workflows/budget.js";
import { costForecast } from "../src/core/workflows/cost-forecast.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { costGrowthLimit, featurePolicy, InitiativeService, type InitiativeView, rebaseView } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #1625, shexpand R49: a skeleton's small weighted dollar share stopped model work
// while tokens and the initiative's dollars remained. Host writes must still cost zero.
const MODEL = "anthropic/claude-sonnet-4-6";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const skeleton = Array.from({ length: 25 }, (_, i) => ({ path: `stub${i}.txt`, content: "placeholder\n" }));
const plan: InitiativePlan = {
  schemaVersion: 1, title: "Skeleton and values", goals: ["Create values"], completionCriteria: ["Values are ready"],
  features: ["base", "next", "last"].map((id, i) => ({
    id, title: id, size: i ? "large" : "small", workflow: "sdd",
    boundary: { scope: id, paths: [`${id}.txt`, ...(i ? [] : skeleton.map((s) => s.path))] },
    ...(i ? {} : { skeleton }), contract: `${id}.txt contains ready`, dependsOn: i ? ["base"] : [], mandatory: true,
  })),
};

class ScriptedExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  implemented: string[] = [];
  failLint = false;
  beforeCorrection: { cap: number; tokens: number } | null = null;
  correction: { task: Task; forecast: ReturnType<typeof costForecast>; priced: boolean } | null = null;
  override async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { spec: Spec | null; extra: { featureId: string } };
    const spec = data.spec ?? { ...fixtureSpec, featureId: this.store.run(request.runId).feature_id };
    const id = spec.featureId.split("_").at(-1)!;
    let output: unknown;
    switch (request.profile.output) {
      case "spec": output = spec; break;
      case "plan": {
        const markdown = `# Plan\n## Context\nCreate ${id}.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nValues\n## Data\nText\n## Verification\nCheck values\n## Risks\nNone for fixture`;
        const task = (taskId: string, writes: Task["writes"], dependsOn: string[]): Task => ({ id: taskId, title: taskId, description: "Write value", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
        const host = id === "base" && !this.failLint ? [task("T001", skeleton.map((s) => ({ ...s, action: "create" })), [])] : [];
        const value = task("T002", [{ path: `${id}.txt`, action: existsSync(join(request.root, `${id}.txt`)) ? "modify" : "create" }], host.map((t) => t.id));
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: spec.featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [...host, value] } };
        break;
      }
      case "implementation":
        this.implemented.push(request.task!.id);
        if (this.failLint && request.task!.origin !== "planned") {
          const policy = JSON.parse(this.store.run(request.runId).policy_json) as RunPolicy;
          const sizing = this.store.artifacts(request.runId).filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-")).at(-1);
          const priced = sizing ? JSON.parse(this.store.readArtifact(request.runId, sizing.id)).tasks : [];
          this.correction = { task: request.task!, forecast: costForecast(this.store, request.runId, policy), priced: priced.some((t: { taskId: string }) => t.taskId === request.task!.id) };
        }
        for (const write of request.task!.writes) writeFileSync(join(request.root, write.path), this.failLint && request.task!.origin === "planned" ? "invalid" : "ready");
        if (this.failLint && request.task!.origin === "planned") {
          const policy = JSON.parse(this.store.run(request.runId).policy_json) as RunPolicy;
          this.beforeCorrection = { cap: policy.maxCostUsd!, tokens: policy.maxTotalTokens };
        }
        output = { schemaVersion: 1, taskId: request.task!.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
        break;
      default: output = (await super.execute(request)).output;
    }
    const tokens = 36_000;
    this.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
      schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null,
      maxSteps: 10, maxTokens: 1_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: tokens,
      steps: [{ step: 1, inputTokens: tokens / 2, outputTokens: tokens / 2, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
    }));
    return { output, inputTokens: tokens / 2, outputTokens: tokens / 2 };
  }
}

async function scenario(dollars = 10, failLint = false) {
  const fixture = workflowFixture({ executor: (root) => new ScriptedExecutor(root) });
  fixture.executor.failLint = failLint;
  fixture.executor.store = fixture.service.store;
  fixture.config.defaultModel = MODEL;
  cleanups.push(fixture.dispose);
  const initiatives = new InitiativeService(fixture.service);
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", maxTotalTokens: 10_000_000, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: 50_000_000, maxRunCostUsd: 100 }, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }] };
  if (failLint) {
    policy.costForecast = "ask";
    policy.checks.push({ ...fixturePolicy.checks[0]!, id: "linting-type", args: ["-e", "if (await Bun.file('base.txt').text() !== 'ready') { console.log('base.txt:1:1: error TS2322: Value must be ready'); process.exit(1) }"] });
  }
  const scenarioPlan = failLint ? { ...plan, features: plan.features.map((f) => ({ ...f, skeleton: undefined, boundary: { ...f.boundary, paths: [`${f.id}.txt`] } })) } : plan;
  const view = await initiatives.start({ commandId: newId(), initiativeId: "skeleton", prompt: "Create three values", plan: scenarioPlan, policy, model: MODEL, ownerLabel: "test", keepFeatures: true, featureAutoApproval: { maxFiles: 30, maxTasks: 5 }, budget: { maxTotalTokens: 50_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 }, costBudget: { maxCostUsd: dollars, costTolerance: "off" } });
  const identity = () => ({ commandId: newId(), expectedRevision: initiatives.view("skeleton").revision });
  const driveOne = async () => {
    const controller = new AbortController();
    const unwatch = fixture.service.store.observe((e) => { if (e.type === "run.state_changed" && e.payload.to === "completed") controller.abort(); });
    try { return await initiatives.drive("skeleton", controller.signal); } finally { unwatch(); }
  };
  return { fixture, initiatives, view, identity, driveOne };
}

describe("scenario: feature dollars grow independently of tokens (#1625)", () => {
  test("R49 linting-type correctives finish past the cap without a priced corrective or cost forecast", async () => {
    const { fixture, initiatives, view, identity, driveOne } = await scenario(10, true);
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    const approved = await initiatives.approve("skeleton", identity(), { requestId: request.requestId, digest: request.digest });
    const bound = costGrowthLimit(approved, "base")!;
    const done = await driveOne();
    const base = done.features[0]!;
    expect(base.blockers).toEqual([]);
    expect(base.state).toBe("accepted");
    const { beforeCorrection, correction } = fixture.executor;
    expect(beforeCorrection).not.toBeNull();
    expect(correction).not.toBeNull();
    expect(correction!.task.origin).not.toBe("planned");
    expect(fixture.executor.implemented).toEqual(["T002", correction!.task.id]);
    expect(correction!.task.findingIds.length).toBeGreaterThan(0);
    expect(correction!.priced).toBe(false);
    expect(correction!.forecast).toBeNull();
    expect(base.spentUsd).toBeGreaterThan(beforeCorrection!.cap);
    const store = fixture.service.store;
    const policy = JSON.parse(store.run(base.runId!).policy_json) as RunPolicy;
    expect(policy.maxCostUsd!).toBeGreaterThan(beforeCorrection!.cap);
    expect(policy.maxCostUsd!).toBeLessThanOrEqual(bound);
    expect(policy.maxTotalTokens).toBe(beforeCorrection!.tokens);
    expect(done.budget.cost.remainingUsd!).toBeGreaterThan(0);
    const revisions = store.artifacts(base.runId!).filter((a) => a.logical_path.startsWith("policy-revisions/auto-")).map((a) => JSON.parse(store.readArtifact(base.runId!, a.id)));
    expect(revisions.some((r) => r.kind === "call-growth" && r.previous.maxCostUsd >= beforeCorrection!.cap && r.next.maxCostUsd > beforeCorrection!.cap)).toBe(true);
    expect(readFileSync(join(fixture.root, "base.txt"), "utf8")).toBe("ready");
  }, 60000);

  test("the host writes 25 stubs and the feature completes past its weighted cap with tokens unchanged", async () => {
    const { fixture, initiatives, view, identity, driveOne } = await scenario();
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    const approved = await initiatives.approve("skeleton", identity(), { requestId: request.requestId, digest: request.digest });
    const initial = approved.features[0]!.shareUsd!;
    const bound = costGrowthLimit(approved, "base")!;
    const done = await driveOne();
    const base = done.features[0]!;
    expect(base.blockers).toEqual([]);
    expect(base.state).toBe("accepted");
    expect(base.spentUsd).toBeGreaterThan(initial);
    const store = fixture.service.store;
    const policy = JSON.parse(store.run(base.runId!).policy_json) as RunPolicy;
    expect(policy.maxCostUsd!).toBeLessThanOrEqual(bound);
    expect(policy.maxTotalTokens).toBe(approved.features[0]!.share!.tokens);
    const revisions = store.artifacts(base.runId!).filter((a) => a.logical_path.startsWith("policy-revisions/auto-")).map((a) => JSON.parse(store.readArtifact(base.runId!, a.id)));
    expect(revisions.some((r) => r.kind === "call-growth" && r.approvedBy === "sizing")).toBe(true);
    expect(fixture.executor.implemented).toEqual(["T002"]);
    for (const s of skeleton) expect(readFileSync(join(fixture.root, s.path), "utf8")).toBe(s.content);
    expect(store.attempts(base.runId!).filter((a) => a.model_id && store.steps(base.runId!).find((s) => s.id === a.step_id)?.stage_id === "task-T001")).toHaveLength(0);
    await initiatives.pause("skeleton", identity());
    const resumed = await initiatives.resume("skeleton", identity());
    expect(resumed.features[1]!.needUsd!.low).toBeGreaterThan(0);
    const replanned = await initiatives.replan("skeleton", identity(), "base");
    expect(replanned.features[0]!.needUsd!.low).toBeGreaterThan(0);
    expect(costGrowthLimit(replanned, "base")).toBeLessThanOrEqual(replanned.budget.cost.remainingUsd!);
  }, 60000);

  test("split approval warns about a dollar share below the priced low on every client", async () => {
    const { fixture, initiatives, view } = await scenario(0.1);
    expect(view.next.message).toContain("dollar share");
    expect(view.next.message).toContain("below its low estimate");
    expect(view.next.message).not.toContain("high end");
    expect(tuiRecoveryText(view.next.message, view.next.recovery)).toContain("Press B to extend budget");
    expect(desktopRecoveryText(view.next.message, view.next.recovery)).toContain("Choose Extend budget");
    expect(await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "skeleton"]), new AbortController().signal)).toEqual(view);
    const server = await startApiServer({ service: fixture.service, log: () => {} });
    cleanups.push(async () => { await server.stop(); });
    const response = await fetch(`${server.url}/v1/initiatives/skeleton`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(response.status).toBe(200);
    expect((await response.json() as InitiativeView).next).toEqual(view.next);
    expect(initiatives.estimate("skeleton")!.features[0]!.costUsd!.low).toBeGreaterThan(0.1);
  });

  test("reserves priced dollar lows after rebase even when token shares and dollar weights differ", () => {
    const view = { budget: { remaining: { tokens: 1_000_000, calls: 100, activeMs: 1_000_000 }, cost: { remainingUsd: 10 } }, features: [
      { id: "base", size: "small", share: null, need: null },
      { id: "next", size: "large", share: { tokens: 1_000_000, calls: 100, activeMs: 1_000_000 }, shareUsd: 10, need: { low: 200_000, high: 1_000_000 }, needUsd: { low: 4, high: 8 } },
    ] } as unknown as InitiativeView;
    const rebased = rebaseView(view, "base", { low: 700_000, high: 800_000 }, { low: 2, high: 3 });
    expect(costGrowthLimit(rebased, "base")).toBe(6);
    expect(costGrowthLimit(rebased, "next")).toBe(8);
    const settings = { basePolicy: { ...fixturePolicy, sizing: { maxRunCostUsd: 100 } }, costBudget: { maxCostUsd: 10, costTolerance: "off" }, featureAutoApproval: null } as Parameters<typeof featurePolicy>[0];
    const feature = plan.features[0]!;
    // A base growth setting must not leak beyond the initiative's available pool.
    expect(featurePolicy(settings, { tokens: 1_000_000, calls: 100, activeMs: 1_000_000 }, feature, true, null, 6, 5).sizing?.maxRunCostUsd).toBe(6);
    const unpriced = { ...rebased, features: rebased.features.map((f) => f.id === "next" ? { ...f, needUsd: null } : f) };
    expect(costGrowthLimit(unpriced, "base")).toBeCloseTo(10 - unpriced.features[1]!.shareUsd!, 6);
  });

  test("model reservations grow only to the approved dollar bound, including repeated calls and stale policies", async () => {
    const fixture = workflowFixture(); cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const store = fixture.service.store;
    store.transaction(() => store.transition(run.runId, "running"));
    const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 1_000_000, maxCostUsd: 0.1, costTolerance: 0.1, sizing: { maxRunCostUsd: 1 } };
    store.setPolicy(run.runId, policy);
    const stale = structuredClone(policy);
    const step = store.beginStep(run.runId, "implement");
    const first = store.reserve(run.runId, step, MODEL, 50_000, policy);
    expect(policy.maxCostUsd!).toBeGreaterThan(0.1);
    const second = store.reserve(run.runId, step, MODEL, 50_000, stale);
    store.expandReservation(run.runId, first, 200_000, policy);
    const stored = JSON.parse(store.run(run.runId).policy_json) as RunPolicy;
    expect(stored.maxCostUsd!).toBeLessThanOrEqual(1);
    expect(stored.maxTotalTokens).toBe(1_000_000);
    expect(() => store.expandReservation(run.runId, second, 500_000, stale)).toThrow("cost ceiling");
    expect(() => store.reserve(run.runId, step, "unknown/model", 1, policy)).toThrow("No price is known");
    const fixed = { ...policy, maxCostUsd: 0.1, sizing: undefined };
    store.setPolicy(run.runId, fixed);
    expect(() => store.reserve(run.runId, step, MODEL, 50_000, fixed)).toThrow("cost ceiling");
    expect(grownCostCap(fixed, 1_000_000, 10)).toBe(0.1);
    expect(grownCostCap(policy, 1_000_000, 10)).toBe(1);
    expect(grownCostCap({ ...policy, maxCostUsd: 0.07 }, policy.maxTotalTokens)).toBe(0.07);
  });

  test("an unpriced corrective at its token ceiling can use approved dollar growth before the affordability check", async () => {
    const fixture = workflowFixture(); cleanups.push(fixture.dispose);
    const { runId } = await fixture.start();
    const store = fixture.service.store;
    store.transaction(() => store.transition(runId, "running"));
    const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", maxTotalTokens: 100_000, maxCostUsd: 0.3, sizing: { maxRunTokens: 100_000, extendToTokens: 100_000, maxRunCostUsd: 1 } };
    store.setPolicy(runId, policy);
    const task: Task = { id: "T001", title: "Value", description: "Write value", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };
    const corrective: Task = { ...task, id: "T002", origin: "repair", findingIds: ["F001"], writes: [{ path: "value.txt", action: "modify" }] };
    store.transaction(() => {
      store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task, corrective] });
      store.taskStatus(runId, task.id, "implemented");
    });
    const step = store.beginStep(runId, "task-T001");
    const attempt = store.reserve(runId, step, MODEL, 80_000, policy);
    store.transaction(() => {
      store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical({ schemaVersion: 1, profileId: "implementer", taskId: task.id, maxSteps: 10, maxTokens: 100_000, stopReason: "submitted", finalizedBy: null, totalTokens: 80_000, steps: [{ step: 1, inputTokens: 80_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }] }));
      store.finishAttempt(runId, attempt, "completed", 80_000);
    });
    const correctionStep = store.beginStep(runId, `task-${corrective.id}`);
    const correctionAttempt = store.reserve(runId, correctionStep, MODEL, 1000, policy);
    expect(costForecast(store, runId, policy)).toBeNull();
    expect(() => assertAttemptFits(store, runId, correctionAttempt, policy, 50_000)).not.toThrow();
    expect(policy.maxTotalTokens).toBeGreaterThanOrEqual(130_000);
    expect(policy.maxCostUsd!).toBeGreaterThan(0.3);
    expect(policy.maxCostUsd!).toBeLessThanOrEqual(1);
  });
});

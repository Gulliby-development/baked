import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPricing } from "../../src/core/llm/pricing.js";
import { canonical, hashBytes, hashJson } from "../../src/core/specs/hash.js";
import type { InitiativePlan } from "../../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../../src/core/workflows/initiatives/service.js";
import type { RunPolicy, Spec } from "../../src/core/workflows/schemas.js";
import { newId, type WorkflowStore } from "../../src/core/workflows/store.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./workflow-fixture.js";

export const MODEL = "anthropic/claude-sonnet-4-6";
const price = findPricing(MODEL)!.pricing;
// A scripted cached workload, not a reconstruction of the unavailable bench usage traces. A
// smaller cached share pays more per token, and `Mix` moves dollars between tasks and the other
// stages (#1890).
const rateAt = (cache: number) => ((0.95 - cache) * price.input + cache * price.cacheRead + 0.05 * price.output) / 1e6;
export const backtests = [
  { id: "shexpand", count: 11, actualUsd: 27.3 },
  { id: "recmill", count: 12, actualUsd: 31.1 },
  { id: "crossmill", count: 11, actualUsd: 23.1 },
] as const;

export interface Mix {
  /** The task stage's share of a feature's dollars; the six other stages split the rest. */
  taskShare?: number;
  /** The share of the task stage's tokens read from the cache. */
  cache?: number;
  /** The share of the other stages' tokens read from the cache. */
  planCache?: number;
}

class ScriptedExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  constructor(root: string, private featureUsd: number, private skeleton = false, private mix: Mix = {}) { super(root); }
  override async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      spec: Spec | null; extra: { featureId: string; hostFiles?: { files: { path: string; content: string }[] } };
    };
    const spec: Spec = data.spec ?? { ...fixtureSpec, featureId: data.extra.featureId };
    const path = `${spec.featureId?.split("_").at(-1) ?? "fixture"}.txt`;
    let result = request.profile.output === "implementation" ? {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] } as unknown,
      inputTokens: 0, outputTokens: 0,
    } : await super.execute(request);
    switch (request.profile.output) {
      case "spec": result.output = spec; break;
      case "plan": {
        const markdown = `# Plan\n## Context\nCreate ${path}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${path}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
        const writes = data.extra.hostFiles?.files.map((f) => ({ path: f.path, action: "create" })) ??
          [{ path, action: existsSync(join(request.root, path)) ? "modify" : "create" }];
        result.output = { schemaVersion: 1, markdown, taskGraph: {
          schemaVersion: 1, featureId: spec.featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", title: "Write the value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        } };
        break;
      }
      case "implementation":
        for (const write of request.task?.writes ?? []) writeFileSync(join(request.root, write.path), "ready");
        break;
    }
    // Six surrounding stages plus one task. The skeleton's entire $0.72 is planning usage;
    // its implementation is host-written, so it supplies no paid task-stage sample.
    const task = request.profile.output === "implementation";
    const taskShare = this.mix.taskShare ?? 0.4;
    const cache = (task ? this.mix.cache : this.mix.planCache) ?? 0.9;
    const usd = this.skeleton ? (request.profile.output === "research" ? this.featureUsd : 0) :
      this.featureUsd * (task ? taskShare : (1 - taskShare) / 6);
    const totalTokens = Math.round(usd / rateAt(cache));
    const outputTokens = Math.round(totalTokens * 0.05);
    const inputTokens = totalTokens - outputTokens;
    this.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
      schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null,
      maxSteps: 10, maxTokens: 5_000_000, stopReason: "submitted", finalizedBy: null, totalTokens,
      steps: [{ step: 1, inputTokens, outputTokens, cacheReadTokens: Math.round(totalTokens * cache), cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
    }));
    result = { ...result, inputTokens, outputTokens };
    return result;
  }
}

export async function historyFixture(featureUsd: number, mix: Mix = {}) {
  const policy = { ...fixturePolicy, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }], sizing: { maxRunTokens: 50_000_000 } };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, featureUsd, false, mix) });
  fixture.config.defaultModel = MODEL;
  fixture.executor.store = fixture.service.store;
  try {
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    if (done.status !== "completed") throw new Error(`Historical fixture stopped: ${done.status} ${done.reason}`);
    return fixture;
  } catch (error) { await fixture.dispose(); throw error; }
}

export async function plannedForecastScenario(
  count: number, firstUsd: number, histories: string[],
  options: { forecastStop?: boolean; stopModes?: RunPolicy["stopModes"]; mix?: Mix; skeleton?: boolean; capUsd?: number } = {},
) {
  const skeleton = options.skeleton ?? true;
  const fixture = workflowFixture({ executor: (root) => new ScriptedExecutor(root, firstUsd, skeleton, options.mix) });
  fixture.executor.store = fixture.service.store;
  const initiatives = new InitiativeService(fixture.service);
  const plan: InitiativePlan = {
    schemaVersion: 1, title: "Values", goals: ["Write values"], completionCriteria: ["Values exist"],
    features: Array.from({ length: count }, (_, i) => ({
      id: `f${i + 1}`, title: `Value ${i + 1}`, size: i ? "medium" : "small", workflow: "sdd",
      boundary: { scope: "Write the value", paths: [`f${i + 1}.txt`] },
      ...(!i && skeleton ? { skeleton: [{ path: "f1.txt", content: "ready" }] } : {}),
      contract: "The value is ready", dependsOn: i ? [`f${i}`] : [], mandatory: true,
    })),
  };
  try {
    let view = await initiatives.start({ commandId: newId(), initiativeId: "values", prompt: "Write values", ownerLabel: "test", model: MODEL,
      plan, keepFeatures: true, featureAutoApproval: { maxTasks: 5, maxFiles: 5 },
      ...(options.forecastStop ? { forecastStop: true } : {}),
      policy: { ...fixturePolicy, clarification: "assume", checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }], sizing: { maxRunTokens: 50_000_000, historyStores: histories },
        ...(options.stopModes ? { stopModes: options.stopModes } : {}) },
      budget: { maxTotalTokens: 100_000_000, maxAgentCalls: 1000, maxActiveMs: 21_600_000 },
      costBudget: { maxCostUsd: options.capUsd ?? 30, costTolerance: 0.25 },
    });
    const identity = () => ({ commandId: newId(), expectedRevision: initiatives.view("values").revision });
    const decision = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("values", identity(), { requestId: decision.requestId, digest: decision.digest });
    const controller = new AbortController();
    const unwatch = fixture.service.store.observe((event) => {
      if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
    });
    try { view = await initiatives.drive("values", controller.signal); } finally { unwatch(); }
    return { fixture, initiatives, view, identity };
  } catch (error) { await fixture.dispose(); throw error; }
}

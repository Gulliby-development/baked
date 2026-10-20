import { canonical } from "../../src/core/specs/hash.js";
import { findPricing } from "../../src/core/llm/pricing.js";
import type { RunPolicy } from "../../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../../src/core/workflows/store.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./workflow-fixture.js";

export const CALL_COST_MODELS = ["codex/gpt-5.4", "claude-code/claude-sonnet-4-6"] as const;
export const NEXT_CALL = 1_000_000;
const PLANNING = 634_442;
const TASK = 991_000;
const CACHED = 925_000;

export function pricedUsage(tokens: number, cached = 0) {
  return {
    schemaVersion: 1, profileId: "implementer", taskId: null,
    maxSteps: 10, maxTokens: 10_000_000, stopReason: "submitted", finalizedBy: null,
    totalTokens: tokens,
    steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: cached, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
  };
}

/** The next implementer expands its reservation like a cache-heavy native tool loop. */
class ScriptedExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  policy!: RunPolicy;
  expanded = false;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    this.store.expandReservation(request.runId, request.attemptId, NEXT_CALL, this.policy);
    this.expanded = true;
    const result = await super.execute(request);
    this.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical(pricedUsage(NEXT_CALL, Math.round(NEXT_CALL * CACHED / TASK))));
    return { ...result, inputTokens: NEXT_CALL, outputTokens: 0 };
  }
}

/** R49 state: expensive planning, one finished cached task, then another long task call. */
export async function perCallCostScenario(model: string, scripted = false) {
  const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 20_000_000, maxAgentCalls: 1000, costForecast: "off", maxCostUsd: null };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root) });
  fixture.config.defaultModel = model;
  fixture.executor.store = fixture.service.store;
  fixture.executor.policy = policy;
  try {
    const { runId } = await fixture.start();
    const store = fixture.service.store;
    if (scripted) await fixture.service.drive(runId, new AbortController().signal);
    else store.transaction(() => store.transition(runId, "running"));
    const spend = (stage: string, tokens: number, cached = 0) => {
      const step = store.beginStep(runId, stage);
      const attempt = store.reserve(runId, step, model, 1000, policy);
      store.transaction(() => {
        store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(pricedUsage(tokens, cached)));
        store.finishAttempt(runId, attempt, "completed", tokens);
      });
    };
    spend("plan", PLANNING);
    spend("task-T000", TASK, CACHED);
    const price = findPricing(model)!.pricing;
    const rate = ((TASK - CACHED) * price.input + CACHED * price.cacheRead) / TASK / 1e6;
    const { spentUsd } = store.costUsage(runId);
    // There is room for 1.5 calls at the task price. One call at the blended price does not fit.
    policy.maxCostUsd = Math.ceil((spentUsd + 1.5 * NEXT_CALL * rate) / 1.1 * 100) / 100;
    policy.costTolerance = 0.1;
    store.setPolicy(runId, policy);
    return { fixture, store, runId, policy, rate, spend };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

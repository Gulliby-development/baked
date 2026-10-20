import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertForecastFits, costForecast, forecastProgress } from "../src/core/workflows/cost-forecast.js";
import { DEFAULT_MIX } from "../src/core/workflows/estimate.js";
import { PolicySchema, type Task } from "../src/core/workflows/schemas.js";
import { DEFAULT_PER_FILE, type SizingReport, verificationTokens } from "../src/core/workflows/sizing.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R49 shexpand patterns (#1631): three code tasks overran their cold prices by 3.4x.
// Two open test tasks inherited that ratio and unnecessarily grew the initiative's held cap.
const MODEL = "anthropic/claude-sonnet-4-6";
const CODE_TOKENS = ((DEFAULT_PER_FILE.code.create.low + DEFAULT_PER_FILE.code.create.high) / 2) * 3.4;
const price = findPricing(MODEL)!.pricing;
const reviewRate = (DEFAULT_MIX.input * price.input + DEFAULT_MIX.cacheRead * price.cacheRead + DEFAULT_MIX.output * price.output) / 1e6;
// Cover code already spent, both tests at their high price, and verification, with some room.
const CAP = Math.ceil((3 * CODE_TOKENS * price.input / 1e6 + 2 * DEFAULT_PER_FILE.test.create.high * price.input / 1e6 + verificationTokens() * reviewRate) * 1.1 * 100) / 100;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class ScriptedExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  implemented: string[] = [];
  override async execute(request: ExecutionRequest) {
    const policy = PolicySchema.parse(JSON.parse(this.store.run(request.runId).policy_json));
    // The native executor checks this before each attempt. Script the same core check while
    // the scheduler drives actual task completion and records measured usage.
    assertForecastFits(this.store, request.runId, policy);
    if (request.profile.output === "implementation") {
      const task = request.task!;
      this.implemented.push(task.id);
      for (const write of task.writes) {
        const path = join(request.root, write.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "// ready\n");
      }
      const tokens = task.id <= "T003" ? CODE_TOKENS : 100_000;
      this.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
        schemaVersion: 1, profileId: request.profile.id, taskId: task.id,
        maxSteps: 10, maxTokens: 1_000_000, stopReason: "submitted", finalizedBy: null, totalTokens: tokens,
        steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
      }));
      return {
        output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote ready", evidenceIds: [], unresolved: [] },
        inputTokens: tokens, outputTokens: 0,
      };
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: Task[] } };
      const template = plan.taskGraph.tasks[0]!;
      plan.taskGraph.tasks = Array.from({ length: 5 }, (_, i) => ({
        ...template,
        id: `T00${i + 1}`,
        title: `Create ${i < 3 ? "code" : "test"} ${i + 1}`,
        dependsOn: i ? [`T00${i}`] : [],
        writes: [{ path: i < 3 ? `src/value${i}.ts` : `tests/value${i}.test.ts`, action: "create" }],
      }));
    }
    return result;
  }
}

describe("scenario: code overruns do not scale unmeasured test tasks (#1631)", () => {
  test("three code tasks at 3.4x leave two tests at their own price without growing the cap", async () => {
    const policy = {
      ...fixturePolicy, maxAgentCalls: 1000, maxTotalTokens: 10_000_000, maxCostUsd: CAP,
      sizing: { maxRunTokens: 20_000_000, maxRunCostUsd: CAP * 10 },
      checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }],
    };
    const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root) });
    cleanups.push(fixture.dispose);
    fixture.config.defaultModel = MODEL;
    const store = fixture.service.store;
    fixture.executor.store = store;
    const { runId } = await fixture.start();
    await fixture.service.drive(runId, new AbortController().signal);
    await fixture.approve(runId);
    const done = await fixture.service.drive(runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(fixture.executor.implemented).toEqual(["T001", "T002", "T003", "T004", "T005"]);
    const forecast = forecastProgress(store, runId).find((f) => f.measuredTasks === 3)!;
    expect(forecast).toBeDefined();
    expect(forecast.ratio).toBeCloseTo(3.4, 6);
    expect(forecast.openTasks).toBe(2);
    const sizingArtifact = store.artifacts(runId).filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-")).at(-1)!;
    const sizing = JSON.parse(store.readArtifact(runId, sizingArtifact.id)) as SizingReport;
    const tests = sizing.tasks.filter((t) => t.kind === "test");
    expect(tests).toHaveLength(2);
    const midpoint = tests.reduce((sum, t) => sum + (t.estimate.low + t.estimate.high) / 2, 0);
    const high = tests.reduce((sum, t) => sum + t.estimate.high, 0);
    expect(forecast.remainingTokens - verificationTokens()).toBe(midpoint);
    expect(forecast.remainingTokens - verificationTokens()).toBeLessThanOrEqual(high * 1.5);
    expect(forecast.projectedUsd).toBeLessThanOrEqual(CAP);
    const revisions = store.artifacts(runId).filter((a) => a.kind === "policy-revision").map((a) => JSON.parse(store.readArtifact(runId, a.id)) as { kind: string });
    expect(revisions.filter((r) => r.kind === "forecast-growth")).toEqual([]);
    expect(PolicySchema.parse(JSON.parse(store.run(runId).policy_json)).maxCostUsd).toBe(CAP);
    expect(costForecast(store, runId, policy)).toBeNull();
  });
});

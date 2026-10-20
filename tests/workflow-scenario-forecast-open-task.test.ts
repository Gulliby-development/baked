import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertForecastFits, type CostForecast, costForecast, forecastProgress } from "../src/core/workflows/cost-forecast.js";
import { DEFAULT_MIX } from "../src/core/workflows/estimate.js";
import { PolicySchema, type Task } from "../src/core/workflows/schemas.js";
import { DEFAULT_PER_FILE, type SizingReport, verificationTokens } from "../src/core/workflows/sizing.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #1648: the run's cost forecast priced an open task in full on top of what its earlier attempts
// had spent, and let one finished task set the price of every open task of its kind.
const MODEL = "anthropic/claude-sonnet-4-6";
const mid = (range: { low: number; high: number }) => (range.low + range.high) / 2;
const CODE = mid(DEFAULT_PER_FILE.code.create);
const TEST = mid(DEFAULT_PER_FILE.test.create);
const price = findPricing(MODEL)!.pricing;
const reviewRate = (DEFAULT_MIX.input * price.input + DEFAULT_MIX.cacheRead * price.cacheRead + DEFAULT_MIX.output * price.output) / 1e6;
/** A cap that covers `tokens` of task work, all input, and verification, with a little room. */
const capFor = (tokens: number) => Math.ceil((tokens * price.input / 1e6 + verificationTokens() * reviewRate * 1.1) * 100) / 100;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** What each implementation attempt of a task uses, in order, and whether it ends at its token cap. */
type Script = Record<string, { tokens: number; atCap?: boolean }[]>;

class ScriptedExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  attempts: string[] = [];
  /** The forecast before each implementation attempt, by task and attempt number. */
  forecasts = new Map<string, CostForecast | null>();
  constructor(root: string, private readonly tasks: number, private readonly script: Script) {
    super(root);
  }
  override async execute(request: ExecutionRequest) {
    const policy = PolicySchema.parse(JSON.parse(this.store.run(request.runId).policy_json));
    const task = request.task;
    const n = task ? this.attempts.filter((id) => id === task.id).length : 0;
    if (task && request.profile.output === "implementation")
      this.forecasts.set(`${task.id}/${n}`, costForecast(this.store, request.runId, policy));
    // The native executor checks this before each attempt.
    assertForecastFits(this.store, request.runId, policy);
    if (task && request.profile.output === "implementation") {
      this.attempts.push(task.id);
      const { tokens, atCap = false } = this.script[task.id]?.[n] ?? { tokens: task.id <= "T003" ? CODE : TEST };
      for (const write of task.writes) {
        const path = join(request.root, write.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, atCap ? "// draft\n" : "// ready\n");
      }
      this.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
        schemaVersion: 1, profileId: request.profile.id, taskId: task.id,
        maxSteps: 10, maxTokens: atCap ? tokens : 1_000_000,
        stopReason: atCap ? "tokens" : "submitted", finalizedBy: atCap ? "tokens" : null, totalTokens: tokens,
        steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
      }));
      return {
        output: atCap
          ? { schemaVersion: 1, taskId: task.id, outcome: "blocked", summary: "Reached the token cap", evidenceIds: [], unresolved: ["The token cap ended the attempt"] }
          : { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote ready", evidenceIds: [], unresolved: [] },
        inputTokens: tokens, outputTokens: 0,
      };
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: Task[] } };
      const template = plan.taskGraph.tasks[0]!;
      plan.taskGraph.tasks = Array.from({ length: this.tasks }, (_, i) => ({
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

async function runScenario(tasks: number, script: Script, cap: number) {
  const policy = {
    ...fixturePolicy, maxAgentCalls: 1000, maxTotalTokens: 10_000_000, maxCostUsd: cap,
    sizing: { maxRunTokens: 20_000_000, maxRunCostUsd: cap * 10 },
    checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, tasks, script) });
  cleanups.push(fixture.dispose);
  fixture.config.defaultModel = MODEL;
  const store = fixture.service.store;
  fixture.executor.store = store;
  const { runId } = await fixture.start();
  await fixture.service.drive(runId, new AbortController().signal);
  await fixture.approve(runId);
  const done = await fixture.service.drive(runId, new AbortController().signal);
  const sizingArtifact = store.artifacts(runId).filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-")).at(-1)!;
  const sizing = JSON.parse(store.readArtifact(runId, sizingArtifact.id)) as SizingReport;
  const midOf = (taskId: string) => {
    const estimate = sizing.tasks.find((t) => t.taskId === taskId)!.estimate;
    return (estimate.low + estimate.high) / 2;
  };
  const stageOf = new Map(store.steps(runId).map((s) => [s.id, s.stage_id]));
  /** What the attempts of a task reserved, in order. */
  const reserved = (taskId: string) => store.attempts(runId).filter((a) => stageOf.get(a.step_id) === `task-${taskId}`).map((a) => a.reserved_tokens);
  const revisions = store.artifacts(runId).filter((a) => a.kind === "policy-revision").map((a) => JSON.parse(store.readArtifact(runId, a.id)) as { kind: string });
  return {
    done, store, runId, midOf, reserved,
    executor: fixture.executor,
    progress: forecastProgress(store, runId),
    growth: revisions.filter((r) => r.kind === "forecast-growth"),
    capAfter: PolicySchema.parse(JSON.parse(store.run(runId).policy_json)).maxCostUsd,
    stops: store.artifacts(runId).filter((a) => a.kind === "cost-forecast"),
  };
}

const taskTokens = (forecast: CostForecast) => forecast.remainingTokens - verificationTokens();

describe("scenario: an open task's spent tokens count once in the forecast (#1648)", () => {
  test("a test task continuing after its token cap at 90% of its price neither stops the run nor grows its cap", async () => {
    const first = Math.round(TEST * 0.9);
    // Code at its price, T004 in full plus a little, T005 at its price: the forecast counting
    // T004's first attempt again (0.9 of a test task) does not fit.
    const cap = capFor(3 * CODE + 2.25 * TEST);
    const run = await runScenario(5, { T004: [{ tokens: first, atCap: true }, { tokens: Math.round(TEST * 0.2) }] }, cap);
    expect(run.done.status).toBe("completed");
    expect(run.executor.attempts).toEqual(["T001", "T002", "T003", "T004", "T004", "T005"]);
    // Before the continuation T004 needs only what its first attempt and the one in flight have
    // not covered: those tokens are already in the spent and reserved dollars.
    const before = run.executor.forecasts.get("T004/1")!;
    expect(before.openTasks).toBe(2);
    const [, held] = run.reserved("T004");
    expect(held).toBeGreaterThan(0);
    expect(taskTokens(before)).toBe(Math.max(0, run.midOf("T004") - first - (held ?? 0)) + run.midOf("T005"));
    expect(before.projectedUsd).toBeLessThanOrEqual(cap);
    expect(run.stops).toEqual([]);
    expect(run.growth).toEqual([]);
    expect(run.capAfter).toBe(cap);
  });
});

describe("scenario: one finished task does not price its kind (#1648)", () => {
  test("one test task at 3x leaves three open test tasks at their own price", async () => {
    // Code at its price, T004 at 3x, then T005-T007 at their price: about 7 test prices in all.
    const cap = capFor(3 * CODE + 7 * TEST);
    const run = await runScenario(7, { T004: [{ tokens: TEST * 3 }] }, cap);
    expect(run.done.status).toBe("completed");
    expect(run.executor.attempts).toEqual(["T001", "T002", "T003", "T004", "T005", "T006", "T007"]);
    const forecast = run.progress.find((f) => f.measuredTasks === 4)!;
    expect(forecast.openTasks).toBe(3);
    const [held] = run.reserved("T005");
    expect(taskTokens(forecast)).toBe(run.midOf("T005") - (held ?? 0) + run.midOf("T006") + run.midOf("T007"));
    expect(forecast.projectedUsd).toBeLessThanOrEqual(cap);
    expect(run.stops).toEqual([]);
    expect(run.growth).toEqual([]);
    expect(run.capAfter).toBe(cap);
  });
});

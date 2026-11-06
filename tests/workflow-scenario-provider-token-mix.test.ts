import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { assertForecastFits, type CostForecast, forecastProgress } from "../src/core/workflows/cost-forecast.js";
import { forecastStageCost } from "../src/core/workflows/forecast-price.js";
import { PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { DEFAULT_PER_FILE, verificationTokens } from "../src/core/workflows/sizing.js";
import { forecastRate, providerFamily, providerTaskMix, TASK_MIX } from "../src/core/workflows/stage-price.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import type { AttemptUsageRow } from "../src/core/workflows/usage.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2963: the dollar forecast priced a Claude stage without paid samples of its model at a mix with
// no cache writes, or at the mix another provider's attempts measured. R103's Claude track was
// forecast at $2.40 per Mtok (`TASK_MIX` at an Opus-tier card) against $3.40 to $3.90 paid. The
// per-provider forecast ships in shadow: it is recorded beside the shown one.
const CLAUDE = "claude-code/opus";
const CODEX = "codex/gpt-5.5";
const claudePrice = findPricing(CLAUDE)!.pricing;
const codexPrice = findPricing(CODEX)!.pricing;

const row = (model: string, stage: string, tokens: { input: number; read: number; write: number; output: number }, costUsd: number): AttemptUsageRow =>
  ({
    attemptId: `${model}-${stage}-${costUsd}`, stage, taskId: null, taskGeneration: null, model, status: "succeeded",
    usedTokens: tokens.input + tokens.output, steps: 1, peakInputTokens: tokens.input, prompt: null,
    inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.read, cacheWriteTokens: tokens.write, costUsd,
  }) as AttemptUsageRow;

/** A Codex task attempt as Codex reports one: 80% cache reads, no cache writes. */
const codexTask = row(CODEX, "implement", { input: 950_000, read: 800_000, write: 0, output: 50_000 }, 0.75 + 0.4 + 1.5);

describe("providerTaskMix: a Claude stage is not priced at another provider's mix (#2963)", () => {
  test("a Claude model with only Codex implement samples: per provider it takes the Claude task mix with its cache writes", () => {
    const mix = providerTaskMix(CLAUDE, "implement");
    expect(mix.cacheWrite).toBeGreaterThan(0);
    const claudeRate = (mix.input * claudePrice.input + mix.cacheRead * claudePrice.cacheRead + mix.cacheWrite * claudePrice.cacheWrite + mix.output * claudePrice.output) / 1e6;
    expect(forecastRate([codexTask], "implement", CLAUDE, true)).toBeCloseTo(claudeRate, 12);
    // The blended rate borrows the Codex attempts' mix: 15% uncached, 80% reads, 5% output.
    const borrowed = (0.15 * claudePrice.input + 0.8 * claudePrice.cacheRead + 0.05 * claudePrice.output) / 1e6;
    expect(forecastRate([codexTask], "implement", CLAUDE)).toBeCloseTo(borrowed, 12);
    expect(claudeRate).not.toBeCloseTo(borrowed, 12);
  });

  test("without any sample the Claude model's rate counts cache writes; the blended one is TASK_MIX's", () => {
    const blended = (TASK_MIX.input * claudePrice.input + TASK_MIX.cacheRead * claudePrice.cacheRead + TASK_MIX.output * claudePrice.output) / 1e6;
    expect(forecastRate([], "implement", CLAUDE)).toBeCloseTo(blended, 12);
    const perProvider = forecastRate([], "implement", CLAUDE, true)!;
    expect(perProvider).not.toBeCloseTo(blended, 12);
    expect(forecastStageCost([], [{ id: "implement", models: [CLAUDE], tokens: 1_000_000 }], true)).toBeCloseTo(perProvider * 1_000_000, 9);
  });

  test("a Claude model's measured mix comes from Claude attempts of the stage, cache writes priced", () => {
    const claudeTask = row("claude-code/sonnet", "implement", { input: 980_000, read: 680_000, write: 300_000, output: 20_000 }, 2);
    const rate = forecastRate([codexTask, claudeTask], "implement", CLAUDE, true)!;
    expect(rate).toBeCloseTo((680_000 * claudePrice.cacheRead + 300_000 * claudePrice.cacheWrite + 20_000 * claudePrice.output) / 1_000_000 / 1e6, 12);
  });

  test("a Codex model is priced as before (regression guard for the Codex track)", () => {
    expect(providerFamily(CODEX)).toBe("openai");
    expect(providerTaskMix(CODEX, "implement")).toEqual({ ...TASK_MIX, cacheWrite: 0 });
    for (const samples of [[], [codexTask]]) expect(forecastRate(samples, "implement", "codex/gpt-5.4", true)).toBe(forecastRate(samples, "implement", "codex/gpt-5.4"));
    expect(forecastRate([], "review", CODEX, true)).toBe(forecastRate([], "review", CODEX));
    expect(codexPrice.cacheWrite).toBe(codexPrice.input);
  });
});

const mid = (range: { low: number; high: number }) => (range.low + range.high) / 2;
const CODE = mid(DEFAULT_PER_FILE.code.create);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class TaskExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  override async execute(request: ExecutionRequest) {
    const policy = PolicySchema.parse(JSON.parse(this.store.run(request.runId).policy_json));
    assertForecastFits(this.store, request.runId, policy);
    const task = request.task;
    if (task && request.profile.output === "implementation") {
      for (const write of task.writes) {
        const path = join(request.root, write.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "// ready\n");
      }
      this.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({
        schemaVersion: 1, profileId: request.profile.id, taskId: task.id, maxSteps: 10, maxTokens: 1_000_000,
        stopReason: "submitted", finalizedBy: null, totalTokens: CODE,
        steps: [{ step: 1, inputTokens: CODE, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
      }));
      return { output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote ready", evidenceIds: [], unresolved: [] }, inputTokens: CODE, outputTokens: 0 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: { id: string; title: string; dependsOn: string[]; writes: { path: string; action: string }[] }[] } };
      const template = plan.taskGraph.tasks[0]!;
      plan.taskGraph.tasks = Array.from({ length: 5 }, (_, i) => ({
        ...template, id: `T00${i + 1}`, title: `Create code ${i + 1}`, dependsOn: i ? [`T00${i}`] : [],
        writes: [{ path: `src/value${i}.ts`, action: "create" }],
      }));
    }
    return result;
  }
}

/** A Claude-routed run of five code tasks with a dollar cap that holds; its forecasts as tasks finished. */
async function claudeRun(mode?: RunPolicy["providerTokenMix"]): Promise<CostForecast[]> {
  const cap = 1000;
  const policy = {
    ...fixturePolicy, maxAgentCalls: 1000, maxTotalTokens: 10_000_000, maxCostUsd: cap,
    sizing: { maxRunTokens: 20_000_000, maxRunCostUsd: cap * 10 },
    checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }],
    ...(mode ? { providerTokenMix: mode } : {}),
  };
  const fixture = workflowFixture({ policy, executor: (root) => new TaskExecutor(root) });
  cleanups.push(fixture.dispose);
  fixture.config.defaultModel = CLAUDE;
  const store = fixture.service.store;
  fixture.executor.store = store;
  const { runId } = await fixture.start();
  await fixture.service.drive(runId, new AbortController().signal);
  await fixture.approve(runId);
  const done = await fixture.service.drive(runId, new AbortController().signal);
  expect(done.status).toBe("completed");
  return forecastProgress(store, runId);
}

describe("scenario: a Claude-routed run records the per-provider forecast in shadow (#2963)", () => {
  test("shadow (the default) keeps the shown forecast and records the per-provider one with Claude's cache writes beside it", async () => {
    const [off, shadow, on] = [await claudeRun("off"), await claudeRun(), await claudeRun("on")];
    expect(shadow.length).toBeGreaterThan(0);
    expect(shadow.map((f) => f.measuredTasks)).toEqual(off.map((f) => f.measuredTasks));
    for (const [i, forecast] of shadow.entries()) {
      const before = off[i]!;
      // The shown forecast is the blended one, as with the setting off.
      expect(before.providerMix).toBeUndefined();
      expect(forecast.projectedUsd).toBe(before.projectedUsd);
      const shadowed = forecast.providerMix!;
      expect(shadowed.mode).toBe("shadow");
      expect(shadowed.blendedProjectedUsd).toBe(before.projectedUsd);
      // The final review and convergence have no samples on the model: per provider they are
      // priced at the Claude mix, which writes most of its input to the cache.
      const review = shadowed.rates.find((r) => r.stage !== "implement")!;
      expect(review).toMatchObject({ model: CLAUDE, provider: "claude" });
      const mix = providerTaskMix(CLAUDE, review.stage);
      expect(mix.cacheWrite).toBeGreaterThan(0);
      expect(review.rateUsd).toBeCloseTo((mix.input * claudePrice.input + mix.cacheRead * claudePrice.cacheRead + mix.cacheWrite * claudePrice.cacheWrite + mix.output * claudePrice.output) / 1e6, 12);
      expect(review.rateUsd).not.toBeCloseTo(review.blendedRateUsd, 12);
      expect(shadowed.projectedUsd).not.toBe(forecast.projectedUsd);
      expect(forecast.remainingTokens).toBeGreaterThanOrEqual(verificationTokens());
    }
    // `on` shows the per-provider forecast and keeps the blended one beside it.
    expect(on.map((f) => f.projectedUsd)).toEqual(shadow.map((f) => f.providerMix!.projectedUsd));
    expect(on.map((f) => f.providerMix!.blendedProjectedUsd)).toEqual(off.map((f) => f.projectedUsd));
  });
});

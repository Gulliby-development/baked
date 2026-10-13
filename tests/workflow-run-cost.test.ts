import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";

/** Usage of one attempt: one step with fresh input, cache reads, cache writes and output. */
function usage(fresh: number, cacheRead: number, cacheWrite: number, output: number): AttemptUsageRecord {
  const input = fresh + cacheRead + cacheWrite;
  return {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 1_000_000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: input + output,
    steps: [
      {
        step: 1,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        toolCalls: 0,
        compactedBytes: 0,
      },
    ],
  };
}

function priceOf(record: AttemptUsageRecord): number {
  const pricing = findPricing(MODEL)?.pricing;
  if (!pricing) throw new Error("No fixture price");
  const s = record.steps[0];
  if (!s) throw new Error("No step");
  const cacheRead = s.cacheReadTokens ?? 0;
  const cacheWrite = s.cacheWriteTokens ?? 0;
  const fresh = (s.inputTokens ?? 0) - cacheRead - cacheWrite;
  return (
    (fresh * pricing.input +
      cacheRead * pricing.cacheRead +
      cacheWrite * pricing.cacheWrite +
      (s.outputTokens ?? 0) * pricing.output) /
    1e6
  );
}

async function runningRun() {
  const fixture = workflowFixture({ policy: fixturePolicy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const stepId = store.beginStep(run.runId, "fixture");
  /** Runs one attempt on `model` that records `record` as its usage. */
  const attempt = (record: AttemptUsageRecord | null, model = MODEL) => {
    const id = store.reserve(run.runId, stepId, model, 2000, fixturePolicy);
    store.transaction(() => {
      if (record) store.artifact(run.runId, "usage", `attempts/${id}/usage.json`, canonical(record));
      store.finishAttempt(run.runId, id, "completed", record?.totalTokens ?? 10);
    });
    return id;
  };
  return { store, runId: run.runId, attempt };
}

describe("run cost", () => {
  test("adds each finished attempt's priced usage to the run, cache traffic at its own price", async () => {
    const { store, runId, attempt } = await runningRun();
    expect(store.snapshot(runId).estimatedCostUsd).toBeNull();
    const first = usage(10_000, 300_000, 50_000, 5_000);
    const second = usage(2_000, 100_000, 0, 1_000);
    attempt(first);
    expect(store.snapshot(runId).estimatedCostUsd).toBeCloseTo(priceOf(first), 5);
    attempt(second);
    // An unpriced model and an attempt without usage add nothing.
    attempt(usage(1_000, 0, 0, 100), "local/unknown-thing");
    attempt(null);
    const total = priceOf(first) + priceOf(second);
    expect(store.snapshot(runId).estimatedCostUsd).toBeCloseTo(total, 5);
    // The same tokens counted flat would overstate a cache-heavy run.
    const flat = (first.totalTokens + second.totalTokens) * (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;
    expect(total).toBeLessThan(flat);
  });

  test("a run recorded before the row kept costs sums its attempts, then keeps adding", async () => {
    const { store, runId, attempt } = await runningRun();
    const first = usage(10_000, 300_000, 50_000, 5_000);
    attempt(first);
    // As written by a version that never filled the run's cost.
    (store as unknown as { db: { run(sql: string, args: string[]): void } }).db.run(
      "UPDATE runs SET estimated_cost_microusd=NULL WHERE id=?",
      [runId],
    );
    expect(store.snapshot(runId).estimatedCostUsd).toBeCloseTo(priceOf(first), 5);
    const second = usage(2_000, 100_000, 0, 1_000);
    attempt(second);
    expect(store.run(runId).estimated_cost_microusd).toBe(
      Math.round((priceOf(first) + priceOf(second)) * 1e6),
    );
  });
});

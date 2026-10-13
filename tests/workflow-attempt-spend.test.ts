import { afterEach, expect, test } from "bun:test";
import { canonical } from "../src/core/specs/hash.js";
import { sentEffort } from "../src/core/workflows/agent-executor.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// #936, bench round 14 srtvet: 3.06M claude-code tokens were 93% cache traffic, the run's cost
// stayed null and nothing recorded the effort an attempt ran with.
test("a finished attempt journals its cache split, effort and cost, and the run sums the cost", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  const stepId = store.steps(run.runId)[0]?.id ?? "";
  const model = "claude-code/claude-opus-5-5";
  const attemptId = store.reserve(run.runId, stepId, model, 0, fixture.policy);
  const usage: AttemptUsageRecord = {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 100_000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: 21_000,
    effort: "medium",
    steps: [
      { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 9_000, toolCalls: 1, compactedBytes: 0 },
      { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 9_000, cacheWriteTokens: 500, toolCalls: 1, compactedBytes: 0 },
    ],
  };
  store.transaction(() => store.artifact(run.runId, "usage", `attempts/${attemptId}/usage.json`, canonical(usage)));
  store.transaction(() => store.finishAttempt(run.runId, attemptId, "completed", 21_000));

  // Opus 5.5: $5 input, $6.25 cache write, $0.50 cache read, $25 output per million tokens.
  const cost = (1_500 * 5 + 9_500 * 6.25 + 9_000 * 0.5 + 1_000 * 25) / 1e6;
  const finished = store
    .events(run.runId, 0, 10_000)
    .flatMap((e) => (e.type === "attempt.finished" && e.payload.attemptId === attemptId ? [e.payload] : []));
  expect(finished[0]?.spend).toEqual({
    inputTokens: 20_000,
    outputTokens: 1_000,
    cacheReadTokens: 9_000,
    cacheWriteTokens: 9_500,
    costUsd: cost,
    effort: "medium",
  });
  expect((await fixture.service.get(run.runId)).estimatedCostUsd).toBeCloseTo(cost, 6);
  expect(runUsage(store, run.runId).attempts.find((a) => a.attemptId === attemptId)?.effort).toBe("medium");
});

test("the effort an attempt sent is read from any provider's options", () => {
  expect(sentEffort({ anthropic: { effort: "high", thinking: { type: "adaptive" } } })).toBe("high");
  expect(sentEffort({ openai: { reasoningEffort: "medium" } })).toBe("medium");
  expect(sentEffort({ "claude-code": { reasoningEffort: "low" } })).toBe("low");
  expect(sentEffort({ openai: {} })).toBeUndefined();
  expect(sentEffort(undefined)).toBeUndefined();
});

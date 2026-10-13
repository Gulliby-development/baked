import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import { AttemptStepController, type AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { runUsage } from "../src/core/workflows/usage.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One provider step: a tool call (or plain text) with the usage the provider reports. */
function step(input: number, output: number, call?: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: call
      ? [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }]
      : [{ type: "text", text: "thinking" }],
    finishReason: { unified: call ? "tool-calls" : "stop", raw: undefined },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
    warnings: [],
  };
}

/** Route `openai/*` to a scripted model; every script entry is one step, a function throws. */
function scriptModel(script: Array<LanguageModelV3GenerateResult | (() => never)>): void {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
}

async function nativeAttempt(policy = fixturePolicy) {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === "research");
  if (!researcher) throw new Error("research profile missing");
  const profile: AgentProfile = { ...researcher, model: "openai/fixture-model" };
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
  const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
    ...fixture.config,
    repoMap: false,
  });
  cleanups.push(() => executor.dispose());
  const request: ExecutionRequest = {
    runId: run.runId,
    attemptId,
    profile,
    prompt: "Research the fixture",
    signal: new AbortController().signal,
    maxSteps: 10,
  };
  const usageRecord = (): AttemptUsageRecord | undefined => {
    const row = store.latestArtifact(run.runId, `attempts/${attemptId}/usage.json`);
    return row ? (JSON.parse(store.readArtifact(run.runId, row.id)) as AttemptUsageRecord) : undefined;
  };
  return { fixture, store, run, attemptId, executor, request, usageRecord };
}

describe("attempt usage of a failing native attempt", () => {
  test("a loop that throws after model steps keeps their tokens and writes usage.json", async () => {
    scriptModel([
      step(1000, 100, { name: "unknown_tool", input: {} }),
      step(1500, 200, { name: "unknown_tool", input: {} }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(2800);
    const usage = usageRecord();
    expect(usage?.stopReason).toBe("error");
    expect(usage?.totalTokens).toBe(2800);
    expect(usage?.steps.map((s) => [s.inputTokens, s.outputTokens])).toEqual([
      [1000, 100],
      [1500, 200],
    ]);
  });

  test("a budget refusal between steps keeps the spend of the steps that ran", async () => {
    // The first step fits; after it the cap (the 40,000 left of 50,000) is still above two such
    // steps, but the run limit refuses the next one once another attempt takes 25,000 more.
    const policy = { ...fixturePolicy, maxTotalTokens: 50_000 };
    scriptModel([
      step(12_000, 500, { name: "unknown_tool", input: {} }),
      step(12_000, 500, { name: "unknown_tool", input: {} }),
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    const otherAttempt = store.reserve(run.runId, other, "openai/fixture-model", 10_000, policy);
    const original = store.recordAttemptUsage.bind(store);
    store.recordAttemptUsage = (runId, id, used) => {
      original(runId, id, used);
      if (id === attemptId && used > 0) store.expandReservation(run.runId, otherAttempt, 25_000, policy);
    };
    cleanups.push(() => {
      store.recordAttemptUsage = original;
    });
    await expect(executor.execute(request)).rejects.toThrow("Next model step exceeds remaining token budget");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(12_500);
    expect(usageRecord()).toMatchObject({ stopReason: "error", totalTokens: 12_500 });
    store.transaction(() =>
      store.finishAttempt(run.runId, attemptId, "failed", store.recordedUsage(run.runId, attemptId)),
    );
    expect(store.attempts(run.runId).find((a) => a.id === attemptId)).toMatchObject({ used_tokens: 12_500, usage_complete: 1 });
  });

  test("an attempt that fails before any model step records zero tokens", async () => {
    scriptModel([
      () => {
        throw new Error("connection refused");
      },
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("connection refused");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(0);
    expect(usageRecord()?.steps).toEqual([]);
  });

  test("the attempt cap shrinks to the remaining run budget so the agent finalizes in time", async () => {
    // 30,000 of the 60,000-token run are held by another attempt, below the default attempt cap
    // of 250,000: the attempt starts with the remaining 30,000 instead of being refused.
    const policy = { ...fixturePolicy, maxTotalTokens: 60_000 };
    const result = {
      schemaVersion: 1,
      summary: "Fixture researched",
      facts: [],
      unknowns: [],
      constraints: [],
      suggestedScope: [],
    };
    scriptModel([
      step(10_000, 100, { name: "unknown_tool", input: {} }),
      step(10_200, 100, { name: "submit_result", input: result }),
    ]);
    const { store, run, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 30_000, policy);
    await expect(executor.execute(request)).resolves.toMatchObject({ output: result });
    const usage = usageRecord();
    expect(usage?.maxTokens).toBe(30_000);
    // After the first step two more would pass the cap, so the second was the submit-only step.
    expect(usage).toMatchObject({ finalizedBy: "tokens", stopReason: "submitted", totalTokens: 20_400 });
  });
});

describe("attempts whose provider reports no tokens", () => {
  const result = {
    schemaVersion: 1,
    summary: "Fixture researched",
    facts: [],
    unknowns: [],
    constraints: [],
    suggestedScope: [],
  };

  test("a submit step that reports zero tokens leaves the attempt's usage unknown", async () => {
    // Codex reports a response's usage only after its tool call is answered, so an attempt that
    // ends at its only call (the submit) sees zero input and zero output tokens.
    scriptModel([step(0, 0, { name: "submit_result", input: result })]);
    const { executor, request } = await nativeAttempt();
    await expect(executor.execute(request)).resolves.toMatchObject({
      output: result,
      usageComplete: false,
    });
  });

  test("an attempt with reported tokens stays complete", async () => {
    scriptModel([
      step(0, 0, { name: "unknown_tool", input: {} }),
      step(5_000, 100, { name: "submit_result", input: result }),
    ]);
    const { executor, request } = await nativeAttempt();
    const response = await executor.execute(request);
    expect(response).toMatchObject({ inputTokens: 5_000, outputTokens: 100 });
    expect(response.usageComplete).toBeUndefined();
  });
});

describe("scheduler accounting of failed attempts", () => {
  test("a failed attempt is charged the usage its executor recorded and releases its reservation", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const failing: AgentExecutor = {
      async execute(request) {
        service.store.recordAttemptUsage(request.runId, request.attemptId, 4321);
        throw new Error("model rejected the request");
      },
    };
    (service as unknown as { scheduler: { executor: AgentExecutor } }).scheduler.executor = failing;
    const run = await fixture.start();
    await fixture.resume(run.runId);
    await service.drive(run.runId, new AbortController().signal).catch(() => {});
    const attempts = service.store.attempts(run.runId).filter((a) => a.model_id !== null);
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts)
      expect(attempt).toMatchObject({ status: "failed", used_tokens: 4321, usage_complete: 1 });
    expect(service.store.run(run.runId).token_usage).toBe(4321 * attempts.length);
    expect(runUsage(service.store, run.runId).totalTokens).toBe(4321 * attempts.length);
  });
});

describe("next-step reservation", () => {
  const controller = () =>
    new AttemptStepController({
      maxSteps: 20,
      maxTokens: 250_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 1000,
      maxOutputTokens: 32_000,
    });
  const usage = (inputTokens: number, outputTokens: number) => ({
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    toolCalls: [{}],
  });

  test("grows from the reported input tokens instead of a fixed share of the bytes", () => {
    const budget = controller();
    const messages = [{ role: "user" as const, content: "x".repeat(300_000) }];
    budget.prepare({ stepNumber: 0, steps: [], messages });
    const done = [usage(90_000, 1000)];
    const longer = [...messages, { role: "user" as const, content: "y".repeat(3000) }];
    // Spend 91,000 + next input 90,000 + about 1,000 new + output estimate max(4096, 2*1000).
    const reserve = budget.reservation(done, longer);
    expect(reserve).toBeGreaterThan(91_000 + 90_000 + 4096);
    expect(reserve).toBeLessThan(91_000 + 90_000 + 1100 + 4096);
    // The former estimate charged half the bytes plus the whole output cap and a fixed slack.
    const former = 91_000 + Math.ceil(Buffer.byteLength(JSON.stringify(longer)) / 2) + 32_000 + 8192;
    expect(former - reserve).toBeGreaterThan(80_000);
  });

  test("before any usage it counts the messages at three bytes per token, and caps the output", () => {
    const budget = controller();
    const messages = [{ role: "user" as const, content: "x".repeat(30_000) }];
    const bytes = Buffer.byteLength(JSON.stringify(messages));
    expect(budget.reservation([], messages)).toBe(Math.ceil(bytes / 3) + 8192 + 4096);
    budget.prepare({ stepNumber: 0, steps: [], messages });
    expect(budget.reservation([usage(10_000, 30_000)], messages)).toBe(40_000 + 10_000 + 32_000);
  });

  test("records a failure as the stop reason", () => {
    const record = controller().record([usage(10, 1)], false, { profileId: "p", taskId: null }, "aborted");
    expect(record.stopReason).toBe("aborted");
    expect(record.totalTokens).toBe(11);
  });
});

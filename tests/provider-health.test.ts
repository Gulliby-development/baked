import { awakeClock } from "./helpers/awake-clock.js";
import { ExecutionBudgetClock } from "../src/core/workflows/execution-clock.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { generateText, type LanguageModel } from "ai";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { PROVIDER_FIRST_BYTE_MS, ProviderUnreachableError, probeProvider, providerBackoffMs, providerResponded, withProviderHealth } from "../src/core/llm/provider-health.js";
import { anthropic } from "../src/core/llm/providers/anthropic.js";
import { createClaudeCodeLanguageModel } from "../src/core/llm/providers/claude-code/index.js";
import { copilot } from "../src/core/llm/providers/copilot.js";
import { githubModels } from "../src/core/llm/providers/github-models.js";
import { openai } from "../src/core/llm/providers/openai.js";
import { CodexAppServerSessions, createCodexNativeLanguageModel } from "../src/core/llm/providers/codex/native.js";
import { createCodexLanguageModel } from "../src/core/llm/providers/codex/runner.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const finish: LanguageModelV4StreamPart = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 1, reasoning: 2 },
} };

function streaming(action: (controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>) => void): LanguageModelV4 {
  return {
    specificationVersion: "v4", provider: "fixture", modelId: "model", supportedUrls: {},
    doGenerate: async () => { throw new Error("must observe the provider stream"); },
    doStream: async () => ({ stream: new ReadableStream({ start: action }) }),
  };
}

describe("first-response deadline at each provider adapter", () => {
  test.each([anthropic, openai, copilot, githubModels])("$id aborts a request that never connects", async (provider) => {
    const previous = process.env[provider.envVar];
    process.env[provider.envVar] = "fixture-token";
    cleanups.push(() => { if (previous === undefined) delete process.env[provider.envVar]; else process.env[provider.envVar] = previous; });
    let sent: AbortSignal | null | undefined;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("copilot_internal/v2/token")) return Response.json({ token: "fixture-bearer", expires_at: Date.now() / 1000 + 3600 });
      sent = init?.signal;
      return new Promise(() => {});
    });
    cleanups.push(() => fetch.mockRestore());
    const base = provider.createModel(provider === anthropic ? "claude-sonnet-4-6" : "gpt-4o", { config: DEFAULT_CONFIG }) as LanguageModel;
    await expect(generateText({ model: withProviderHealth(base, `${provider.id}/model`, { firstByteMs: 40 }), prompt: "Hi", maxRetries: 0 })).rejects.toBeInstanceOf(ProviderUnreachableError);
    expect(sent).toBeDefined();
    expect(sent?.aborted).toBe(true);
  });

  test.each(["codex-native", "codex-exec", "claude-code"])("%s stops before an unanswered turn spends the silence floor", async (adapter) => {
    let sent: AbortSignal | undefined;
    const codex = createCodexLanguageModel("gpt-5.5", { run: async (call) => { sent = call.abortSignal; return new Promise(() => {}); } });
    const sessions = new CodexAppServerSessions();
    const open = spyOn(sessions, "openStep").mockImplementation(async (_, signal) => { sent = signal; return new Promise(() => {}); });
    cleanups.push(() => open.mockRestore());
    const claude = createClaudeCodeLanguageModel("opus", { run: async (call) => { sent = call.abortSignal; return new Promise(() => {}); } });
    const base = adapter === "codex-native" ? createCodexNativeLanguageModel("gpt-5.5", sessions, codex) : adapter === "codex-exec" ? codex : claude;
    await expect(generateText({ model: withProviderHealth(base, `${adapter}/model`, { firstByteMs: 20 }), prompt: "Hi", maxRetries: 0 })).rejects.toBeInstanceOf(ProviderUnreachableError);
    expect(sent?.aborted).toBe(true);
  });
});

test("local handshakes do not count as a first response", async () => {
  const settled: boolean[] = [];
  const base = streaming((controller) => {
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({ type: "response-metadata", id: "local-thread" });
  });
  await expect(generateText({ model: withProviderHealth(base, "fixture/model", { firstByteMs: 20, pending: () => (ok) => settled.push(ok) }), prompt: "Hi", maxRetries: 0 })).rejects.toBeInstanceOf(ProviderUnreachableError);
  expect(settled).toEqual([false]);
});

test("reasoning is a response, and its text and usage survive collection", async () => {
  const settled: boolean[] = [];
  const base = streaming((controller) => {
    controller.enqueue({ type: "reasoning-start", id: "r" });
    controller.enqueue({ type: "reasoning-delta", id: "r", delta: "Thinking" });
    setTimeout(() => {
      controller.enqueue({ type: "reasoning-end", id: "r" });
      controller.enqueue({ type: "text-start", id: "a" });
      controller.enqueue({ type: "text-delta", id: "a", delta: "OK" });
      controller.enqueue({ type: "text-end", id: "a" });
      controller.enqueue(finish); controller.close();
    }, 60);
  });
  const result = await generateText({ model: withProviderHealth(base, "fixture/model", { firstByteMs: 20, pending: () => (ok) => settled.push(ok) }), prompt: "Hi", maxRetries: 0 });
  expect(result.text).toBe("OK");
  expect(result.reasoningText).toBe("Thinking");
  expect(result.usage.inputTokens).toBe(2);
  expect(result.usage.outputTokens).toBe(3);
  expect(settled).toEqual([true]);
});

test.each(["codex", "claude-code"])("%s buffered CLI reports actual model traffic before its result", async (provider) => {
  const settled: boolean[] = [];
  const codex = createCodexLanguageModel("gpt-5.5", { run: async (call) => {
    call.onResponse?.(); await Bun.sleep(60);
    return { text: '{"text":"OK","toolCalls":[],"finishReason":"stop"}', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  } });
  const claude = createClaudeCodeLanguageModel("opus", { run: async (call) => {
    call.onResponse?.(); await Bun.sleep(60);
    return { structured: { text: "OK", toolCalls: [], finishReason: "stop" }, text: "OK", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };
  } });
  const result = await generateText({ model: withProviderHealth(provider === "codex" ? codex : claude, `${provider}/model`, { firstByteMs: 20, pending: () => (ok) => settled.push(ok) }), prompt: "Hi", maxRetries: 0 });
  expect(result.text).toBe("OK");
  expect(settled).toEqual([true]);
});

test("connection failures enter health recovery; account refusals keep their own error", async () => {
  for (const error of [new Error("fetch failed: ECONNREFUSED"), Object.assign(new Error("Invalid key"), { statusCode: 401 })]) {
    const settled: boolean[] = [];
    const base = streaming(() => { throw error; });
    const failure = await generateText({ model: withProviderHealth(base, "fixture/model", { pending: () => (ok) => settled.push(ok) }), prompt: "Hi", maxRetries: 0 }).catch((e: unknown) => e);
    if (error.message.startsWith("fetch failed")) { expect(failure).toBeInstanceOf(ProviderUnreachableError); expect(settled).toEqual([false]); }
    else { expect(failure).toBe(error); expect(settled).toEqual([true]); }
  }
});

test("probe backoff grows to five minutes without overflowing", () => {
  expect(PROVIDER_FIRST_BYTE_MS).toBe(60_000);
  expect([0, 1, 2, 10, 10000].map((n) => providerBackoffMs(n))).toEqual([1000, 2000, 4000, 300_000, 300_000]);
});

test("time accounting keeps healthy parallel work and successful first-response latency", () => {
  let time = 0;
  const clock = new ExecutionBudgetClock({ now: () => time });
  const a = clock.track();
  const wait = a.pending();
  time = 1000;
  expect(clock.now()).toBe(0);
  const b = clock.track();
  time = 2000;
  expect(clock.now()).toBe(1000);
  b.finish();
  time = 3000;
  wait(false); a.finish();
  expect(clock.now()).toBe(1000);
  const c = clock.track();
  const healthy = c.pending();
  time = 4000;
  healthy(true); c.finish();
  expect(clock.now()).toBe(2000);
});


test("a completed call keeps the Codex conversation alive until its attempt ends", async () => {
  const parent = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const base = streaming((controller) => { controller.enqueue(finish); controller.close(); });
  const stream = base.doStream;
  base.doStream = async (options) => { providerSignal = options.abortSignal; return stream(options); };
  await generateText({ model: withProviderHealth(base, "codex/model"), prompt: "Hi", abortSignal: parent.signal, maxRetries: 0 });
  expect(providerSignal?.aborted).toBe(false);
  parent.abort();
  expect(providerSignal?.aborted).toBe(true);
});


test("a probe with reasoning but no completed answer still reports a reachable provider", async () => {
  const clock = awakeClock();
  try {
    const base = streaming((controller) => {
      controller.enqueue({ type: "reasoning-start", id: "r" });
      controller.enqueue({ type: "reasoning-delta", id: "r", delta: "Working" });
    });
    const request = probeProvider(base, "fixture/model", new AbortController().signal);
    await Bun.sleep(1);
    clock.advance(61_000);
    expect(await request).toMatchObject({ usage: {} });
  } finally { clock.restore(); }
});

test.each([new Error("Not implemented"), new UnsupportedFunctionalityError({ functionality: "streaming" })])("generation-only adapters retain their result and account for a response: %s", async (error) => {
  const settled: boolean[] = [];
  let calls = 0;
  const base = streaming(() => { throw error; });
  base.doGenerate = async () => {
    calls++;
    return { content: [{ type: "text", text: "OK" }], finishReason: finish.finishReason, usage: finish.usage, warnings: [] };
  };
  const result = await generateText({ model: withProviderHealth(base, "fixture/model", { pending: () => (ok) => settled.push(ok) }), prompt: "Hi", maxRetries: 0 });
  expect(result.text).toBe("OK");
  expect(result.usage.inputTokens).toBe(2);
  expect(calls).toBe(1);
  expect(settled).toEqual([true]);
});

test("a generation-only adapter that hangs still times out and excludes its unanswered time", async () => {
  const settled: boolean[] = [];
  let sent: AbortSignal | undefined;
  const base = streaming(() => { throw new Error("Not implemented"); });
  base.doGenerate = async (options) => { sent = options.abortSignal; return new Promise(() => {}); };
  await expect(generateText({ model: withProviderHealth(base, "fixture/model", { firstByteMs: 20, pending: () => (ok) => settled.push(ok) }), prompt: "Hi", maxRetries: 0 })).rejects.toBeInstanceOf(ProviderUnreachableError);
  expect(sent?.aborted).toBe(true);
  expect(settled).toEqual([false]);
});

test("an incomplete stream fails without making a second generation request", async () => {
  let calls = 0;
  const base = streaming((controller) => { controller.close(); });
  base.doGenerate = async () => { calls++; throw new Error("must not retry"); };
  await expect(generateText({ model: withProviderHealth(base, "fixture/model"), prompt: "Hi", maxRetries: 0 })).rejects.toBeInstanceOf(ProviderUnreachableError);
  expect(calls).toBe(0);
});

test("an adapter that reports model traffic before failing cannot fall back to a second request", async () => {
  let calls = 0;
  const base = streaming(() => {});
  base.doStream = async (options) => { providerResponded(options.abortSignal); throw new Error("Not implemented"); };
  base.doGenerate = async () => { calls++; throw new Error("must not retry"); };
  await expect(generateText({ model: withProviderHealth(base, "fixture/model"), prompt: "Hi", maxRetries: 0 })).rejects.toThrow("Not implemented");
  expect(calls).toBe(0);
});

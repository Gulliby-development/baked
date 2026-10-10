import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/types/index.js";
import { openai, OPENAI_CHAT_MODEL } from "../src/core/llm/providers/openai.js";
import { buildProviderOptions } from "../src/core/llm/provider-options.js";

// IDs the OpenAI models endpoint returned for a real key on 2026-10-09 (a representative subset).
const CHAT = [
  "gpt-4o", "gpt-4.1", "gpt-5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
  "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-12-future", "chatgpt-4o-latest", "o1", "o3-mini", "o4-mini",
];
const NOT_CHAT = [
  "gpt-audio", "gpt-audio-mini", "gpt-image-2", "gpt-image-2.5-flare", "gpt-live-1", "gpt-realtime-2.1", "gpt-transcribe",
  "gpt-realtime-whisper", "omni-moderation-latest", "sora-2", "text-embedding-3-large", "tts-1-hd", "whisper-1", "davinci-002", "babbage-002", "chat-latest",
];

describe("OpenAI model list", () => {
  test("every chat generation is listed, including gpt-6 and gpt-6.1", () => {
    for (const id of CHAT) expect(OPENAI_CHAT_MODEL.test(id), id).toBe(true);
  });
  test("audio, image, realtime, embedding and moderation models stay out", () => {
    for (const id of NOT_CHAT) expect(OPENAI_CHAT_MODEL.test(id), id).toBe(false);
  });
  test("fetchModels keeps the chat models of the endpoint response and drops the rest", async () => {
    const original = globalThis.fetch;
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key-not-real";
    globalThis.fetch = (async () => Response.json({ data: [...CHAT, ...NOT_CHAT].map((id) => ({ id })) })) as unknown as typeof fetch;
    try {
      const models = (await openai.fetchModels()) ?? [];
      expect(models.map((m) => m.id).sort()).toEqual([...CHAT].sort());
    } finally {
      globalThis.fetch = original;
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

const effortConfig = (): AppConfig => ({ defaultModel: "", theme: { name: "default" }, performance: { openaiReasoningEffort: "high" } }) as unknown as AppConfig;

describe("reasoning options for later GPT generations", () => {
  for (const id of ["gpt-5", "gpt-5.6-luna", "gpt-6-astra", "gpt-6.1-sol"]) {
    test(`${id} receives the configured reasoning effort`, async () => {
      const { providerOptions } = await buildProviderOptions(`openai/${id}`, effortConfig());
      expect(providerOptions.openai).toMatchObject({ reasoningEffort: "high" });
    });
  }
  test("a non-reasoning model does not", async () => {
    const { providerOptions } = await buildProviderOptions("openai/gpt-4o", effortConfig());
    expect((providerOptions.openai as { reasoningEffort?: string } | undefined)?.reasoningEffort).toBeUndefined();
  });
});

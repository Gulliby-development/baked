import { describe, expect, test } from "bun:test";
import { addCopilotCacheControl } from "../src/core/llm/providers/copilot.js";

const EPHEMERAL = { type: "ephemeral" };

function marked(body: string): boolean[] {
  const parsed = JSON.parse(addCopilotCacheControl(body)) as {
    messages: Array<{ copilot_cache_control?: unknown }>;
  };
  return parsed.messages.map((m) => m.copilot_cache_control !== undefined);
}

describe("copilot prompt cache markers", () => {
  test("marks system messages and the last message for Claude models", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "system", content: "prompt" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "tool", tool_call_id: "1", content: "ok" },
      ],
    });
    expect(marked(body)).toEqual([true, false, false, true]);
    const last = JSON.parse(addCopilotCacheControl(body)).messages[3];
    expect(last.copilot_cache_control).toEqual(EPHEMERAL);
  });

  test("uses at most two system markers", () => {
    const body = JSON.stringify({
      model: "claude-opus-4.8",
      messages: [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "system", content: "c" },
        { role: "user", content: "hi" },
      ],
    });
    expect(marked(body)).toEqual([true, true, false, true]);
  });

  test("leaves non-Claude models and invalid bodies unchanged", () => {
    const gpt = JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] });
    expect(addCopilotCacheControl(gpt)).toBe(gpt);
    expect(addCopilotCacheControl("not json")).toBe("not json");
  });
});

describe("copilot prompt cache through the provider", () => {
  test("Claude steps carry markers and report Copilot's cached tokens as cache reads", async () => {
    const { generateText } = await import("ai");
    const { copilot } = await import("../src/core/llm/providers/copilot.js");
    const original = globalThis.fetch;
    const savedKey = process.env.COPILOT_API_KEY;
    process.env.COPILOT_API_KEY = "gho_test";
    const bodies: Array<{ messages: Array<{ role: string; copilot_cache_control?: unknown }> }> = [];
    // A fake Copilot backend: the token exchange, then a chat completion whose cached prompt
    // tokens grow with each step, as Copilot reports them once the markers hit the cache.
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("copilot_internal")) {
        return Response.json({ token: "bearer", expires_at: Date.now() / 1000 + 3600 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "claude-sonnet-4.6",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 2,
          total_tokens: 1002,
          prompt_tokens_details: { cached_tokens: bodies.length === 1 ? 0 : 900 },
        },
      });
    }) as unknown as typeof fetch;
    try {
      const model = copilot.createModel("claude-sonnet-4.6");
      const messages = [{ role: "user" as const, content: "first" }];
      const first = await generateText({ model, system: "prompt", messages });
      const second = await generateText({
        model,
        system: "prompt",
        messages: [...messages, { role: "assistant", content: "ok" }, { role: "user", content: "next" }],
      });
      for (const body of bodies) {
        expect(body.messages[0]?.copilot_cache_control).toEqual(EPHEMERAL);
        expect(body.messages.at(-1)?.copilot_cache_control).toEqual(EPHEMERAL);
      }
      expect(first.usage.inputTokenDetails?.cacheReadTokens ?? 0).toBe(0);
      expect(second.usage.inputTokenDetails?.cacheReadTokens).toBe(900);
    } finally {
      globalThis.fetch = original;
      if (savedKey === undefined) delete process.env.COPILOT_API_KEY;
      else process.env.COPILOT_API_KEY = savedKey;
    }
  });
});

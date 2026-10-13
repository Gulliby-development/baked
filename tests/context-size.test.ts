import { describe, expect, test } from "bun:test";
import {
  chatContextTokens,
  getModelContextSizes,
  parseContextSize,
  withContextSize,
} from "../src/core/llm/context-sizes.js";
import { claudeCodeContextSizes } from "../src/core/llm/providers/claude-code/index.js";
import { parseHeadlessArgs } from "../src/headless/parse.js";

describe("context size per chat", () => {
  test("Claude Code offers the 1M window for Opus 4.6+ and Sonnet 4+, not for Haiku", () => {
    expect(claudeCodeContextSizes("opus")).toEqual([
      { tokens: 200_000, modelId: "opus" },
      { tokens: 1_000_000, modelId: "opus[1m]" },
    ]);
    expect(claudeCodeContextSizes("sonnet[1m]").map((o) => o.modelId)).toEqual([
      "sonnet",
      "sonnet[1m]",
    ]);
    expect(claudeCodeContextSizes("claude-opus-5-5")).toHaveLength(2);
    expect(claudeCodeContextSizes("claude-opus-4-6")).toHaveLength(2);
    expect(claudeCodeContextSizes("claude-opus-4-5")).toEqual([]);
    expect(claudeCodeContextSizes("claude-sonnet-4-5")).toHaveLength(2);
    expect(claudeCodeContextSizes("haiku")).toEqual([]);
    expect(claudeCodeContextSizes("fable")).toEqual([]);
  });

  test("providers with one window per model offer no sizes", () => {
    expect(getModelContextSizes("claude-code/opus")).toEqual([200_000, 1_000_000]);
    expect(getModelContextSizes("anthropic/claude-opus-5-5")).toEqual([]);
    expect(getModelContextSizes("codex/gpt-5.5")).toEqual([]);
    expect(getModelContextSizes("no-slash")).toEqual([]);
  });

  test("default keeps the model, except for the coordinator, which takes the largest", () => {
    expect(withContextSize("claude-code/opus", "default")).toBe("claude-code/opus");
    expect(withContextSize("claude-code/opus[1m]", "default")).toBe("claude-code/opus[1m]");
    expect(withContextSize("claude-code/opus", "default", { coordinator: true })).toBe(
      "claude-code/opus[1m]",
    );
    expect(withContextSize("claude-code/opus", undefined, { coordinator: true })).toBe(
      "claude-code/opus[1m]",
    );
    expect(withContextSize("claude-code/opus[1m]", 200_000)).toBe("claude-code/opus");
    expect(withContextSize("claude-code/opus", "max")).toBe("claude-code/opus[1m]");
    // A size between two windows takes the larger one below it, one below all the smallest.
    expect(withContextSize("claude-code/opus", 500_000)).toBe("claude-code/opus");
    expect(withContextSize("claude-code/opus", 2_000_000)).toBe("claude-code/opus[1m]");
    expect(withContextSize("claude-code/opus", 1_000)).toBe("claude-code/opus");
    expect(withContextSize("anthropic/claude-opus-5-5", "max", { coordinator: true })).toBe(
      "anthropic/claude-opus-5-5",
    );
  });

  test("the window a chat runs with, for pickers", () => {
    expect(chatContextTokens("claude-code/sonnet", "default")).toBe(200_000);
    expect(chatContextTokens("claude-code/sonnet", "default", { coordinator: true })).toBe(1_000_000);
    expect(chatContextTokens("claude-code/sonnet[1m]", "default")).toBe(1_000_000);
    expect(chatContextTokens("openai/gpt-5", "max")).toBeNull();
  });

  test("parses keywords, token counts and short forms", () => {
    expect(parseContextSize("default")).toBe("default");
    expect(parseContextSize("MAX")).toBe("max");
    expect(parseContextSize("200k")).toBe(200_000);
    expect(parseContextSize("1m")).toBe(1_000_000);
    expect(parseContextSize("1.5M")).toBe(1_500_000);
    expect(parseContextSize("1_000_000")).toBe(1_000_000);
    expect(parseContextSize("huge")).toBeNull();
    expect(parseContextSize("0")).toBeNull();
  });

  test("headless takes --context for a run and for a chat", async () => {
    const action = await parseHeadlessArgs(["--headless", "--context", "1m", "hello"]);
    expect(action).toMatchObject({ type: "run", opts: { contextSize: 1_000_000, prompt: "hello" } });
    const chat = await parseHeadlessArgs(["--headless", "--chat", "--context=max"]);
    expect(chat).toMatchObject({ type: "chat", opts: { contextSize: "max" } });
  });
});

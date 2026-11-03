import { describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";

const found = (model: string) => {
  const hit = findPricing(model);
  return hit ? [hit.match, hit.pricing.input] : null;
};

describe("price table matching names the model, not a variant of it", () => {
  test("a pro, nano or other variant of a table entry is not priced as that entry", () => {
    // gpt-5.4-nano costs a fraction of gpt-5.4 and gpt-5.4-pro many times it: neither is exact.
    expect(findPricing("openai/gpt-5.4-nano")?.match).toBe("approximate");
    expect(findPricing("openai/gpt-5.4-pro")?.match).toBe("approximate");
    expect(findPricing("openai/gpt-5.5-pro")?.match).toBe("approximate");
    // Consistent with gpt-5.2-pro, whose base has no entry.
    expect(findPricing("openai/gpt-5.2-pro")?.match).toBe("approximate");
    expect(findPricing("openai/o3-pro")).toBeNull();
  });

  test("a later version after a key ending in a number is not that key", () => {
    // Opus 4.6 is $5, Opus 4 is $15: a dotted id must not take the Opus 4 entry.
    expect(found("anthropic/claude-opus-4.6")).toEqual(["approximate", 5]);
    expect(found("anthropic/claude-sonnet-4-7")).toEqual(["approximate", 3]);
    expect(findPricing("xai/grok-4-1-fast-reasoning")?.match).toBe("approximate");
  });

  test("dated, tagged and provider-prefixed releases keep their exact entry", () => {
    expect(found("claude-opus-4-20250514")).toEqual(["table", 15]);
    expect(found("claude-opus-4-1-20250805")).toEqual(["table", 15]);
    expect(found("anthropic/claude-opus-4-6")).toEqual(["table", 5]);
    expect(found("claude-sonnet-4-5@20250929")).toEqual(["table", 3]);
    expect(found("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual(["table", 3]);
    expect(found("claude-opus-4-8[1m]")).toEqual(["table", 5]);
    expect(found("openai/gpt-5.4-mini")).toEqual(["table", 0.75]);
    expect(found("openai/gpt-4o-2024-08-06")).toEqual(["table", 2.5]);
    expect(found("chatgpt-4o-latest")).toEqual(["table", 2.5]);
    expect(found("openai/o4-mini-2025-04-16")).toEqual(["table", 1.1]);
    expect(found("xai/grok-code-fast-1")).toEqual(["table", 0.2]);
    expect(found("xai/grok-4-0709")).toEqual(["table", 3]);
    expect(found("mistral/ministral-8b-latest")).toEqual(["table", 0.1]);
    expect(found("mistral/mistral-large-2411")).toEqual(["table", 0.5]);
    expect(found("groq/llama-3.3-70b-versatile")).toEqual(["table", 0.59]);
    expect(found("deepseek/deepseek-v3-0324")).toEqual(["table", 0.28]);
    expect(found("gemini-2.5-flash-preview-05-20")).toEqual(["table", 0.3]);
    expect(found("github-models/openai/gpt-4.1-nano")).toEqual(["table", 0.1]);
    expect(found("codex/gpt-5.5")).toEqual(["table", 5]);
  });
});

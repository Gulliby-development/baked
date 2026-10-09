import { describe, expect, test } from "bun:test";
import {
  applyProviderContextOverride,
  getModelContextInfoSync,
  matchesContextOverride,
} from "../src/core/llm/models.js";
import { codex } from "../src/core/llm/providers/codex/index.js";

const GPT_55_INPUT_CONTEXT = 272_000;

describe("provider model context normalization", () => {
  test("matches exact and provider-prefixed override IDs", () => {
    expect(matchesContextOverride("gpt-5.5", "gpt-5.5")).toBe(true);
    expect(matchesContextOverride("openai/gpt-5.5", "gpt-5.5")).toBe(true);
    expect(matchesContextOverride("gpt-5.5-pro", "gpt-5.5")).toBe(false);
  });

  test("resolves bare gpt-5.5 sync context as an override", () => {
    expect(getModelContextInfoSync("gpt-5.5")).toEqual({
      tokens: GPT_55_INPUT_CONTEXT,
      source: "override",
    });
  });

  test("normalizes codex gpt-5.5 when fetched model omits context", () => {
    expect(
      applyProviderContextOverride("codex", {
        id: "gpt-5.5",
        name: "gpt-5.5",
      }).contextWindow,
    ).toBe(GPT_55_INPUT_CONTEXT);

    expect(codex.fallbackModels.find((m) => m.id === "gpt-5.5")?.contextWindow).toBe(
      GPT_55_INPUT_CONTEXT,
    );
  });
});

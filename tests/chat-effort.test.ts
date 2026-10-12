import { describe, expect, test } from "bun:test";
import { getCompatReasoningBody } from "../src/core/llm/compat-reasoning.js";
import {
  buildProviderOptions,
  getModelEffortLevels,
  withChatEffort,
} from "../src/core/llm/provider-options.js";
import { parseHeadlessArgs } from "../src/headless/parse.js";
import type { AppConfig } from "../src/types/index.js";

const config = {
  defaultModel: "",
  performance: { effort: "medium", openaiReasoningEffort: "low" },
} as unknown as AppConfig;

describe("reasoning effort per chat", () => {
  test("lists the levels BAKED sends to each model", () => {
    expect(getModelEffortLevels("anthropic/claude-opus-4-8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getModelEffortLevels("anthropic/claude-haiku-4-5")).toEqual([]);
    expect(getModelEffortLevels("openai/gpt-5")).toEqual(["low", "medium", "high"]);
    expect(getModelEffortLevels("openai/gpt-4o")).toEqual([]);
    expect(getModelEffortLevels("codex/gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getModelEffortLevels("claude-code/opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getModelEffortLevels("claude-code/sonnet")).toEqual(["low", "medium", "high", "max"]);
    expect(getModelEffortLevels("claude-code/haiku")).toEqual([]);
  });

  test("default keeps the configuration; a level replaces every effort knob", () => {
    expect(withChatEffort("openai/gpt-5", config, "default")).toBe(config);
    expect(withChatEffort("openai/gpt-5", config, undefined)).toBe(config);
    expect(withChatEffort("openai/gpt-5", config, "high").performance).toMatchObject({
      effort: "high",
      openaiReasoningEffort: "high",
      compatReasoningEffort: "high",
    });
  });

  test("Codex and Claude Code get the effort as their own provider options, clamped", async () => {
    const codex = await buildProviderOptions("codex/gpt-5.5", withChatEffort("codex/gpt-5.5", config, "max"));
    expect(codex.providerOptions.codex).toEqual({ reasoningEffort: "xhigh" });
    const sonnet = await buildProviderOptions(
      "claude-code/sonnet",
      withChatEffort("claude-code/sonnet", config, "xhigh"),
    );
    expect(sonnet.providerOptions["claude-code"]).toEqual({ reasoningEffort: "high" });
    const haiku = await buildProviderOptions(
      "claude-code/haiku",
      withChatEffort("claude-code/haiku", config, "high"),
    );
    expect(haiku.providerOptions["claude-code"]).toBeUndefined();
    const off = await buildProviderOptions("codex/gpt-5.5", withChatEffort("codex/gpt-5.5", config, undefined));
    expect(off.providerOptions.codex).toEqual({ reasoningEffort: "medium" });
  });

  test("OpenAI-compatible providers read the chat's effort over their own setting", () => {
    const own = { ...config, performance: { compatReasoningEffort: "low" } } as AppConfig;
    const body = getCompatReasoningBody("copilot/gpt-5", withChatEffort("copilot/gpt-5", own, "high"));
    expect(body.reasoning_effort).toBe("high");
  });

  test("headless takes --effort for a run and for a chat", async () => {
    const action = await parseHeadlessArgs(["--headless", "--effort", "high", "hello"]);
    expect(action).toMatchObject({ type: "run", opts: { effort: "high", prompt: "hello" } });
    const chat = await parseHeadlessArgs(["--headless", "--chat", "--effort=low"]);
    expect(chat).toMatchObject({ type: "chat", opts: { effort: "low" } });
  });
});

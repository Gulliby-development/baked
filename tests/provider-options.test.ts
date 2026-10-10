import { describe, expect, test } from "bun:test";
import {
  buildProviderOptions,
  clampEffort,
  degradeProviderOptions,
  detectModelFamily,
  getSupportedClaudeEfforts,
  getSupportedEfforts,
  telemetryModelInfo,
} from "../src/core/llm/provider-options.js";
import type { AppConfig } from "../src/types/index.js";
import { getCompatReasoningBody } from "../src/core/llm/compat-reasoning.js";

function baseConfig(perf: Partial<AppConfig["performance"]> = {}): AppConfig {
  return {
    defaultModel: "",
    theme: { name: "default" },
    performance: perf,
  } as unknown as AppConfig;
}

    describe("OpenAI additional knobs", () => {
      test("reasoningSummary + verbosity propagate", async () => {
        const cfg = baseConfig({
          openaiReasoningEffort: "high",
          openaiReasoningSummary: "detailed",
          openaiVerbosity: "low",
        });
        const { providerOptions } = await buildProviderOptions("openai/gpt-5", cfg);
        expect(providerOptions.openai).toMatchObject({
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          verbosity: "low",
        });
      });
    });

    describe("degradeProviderOptions — multi-family", () => {
      test("anthropic still degrades to minimal thinking", () => {
        const { providerOptions } = degradeProviderOptions("anthropic/claude-opus-4-6", 1);
        expect(providerOptions.anthropic).toMatchObject({
          thinking: { type: "enabled", budgetTokens: 5000 },
        });
      });

      test("openai degrades to low effort", () => {
        const { providerOptions } = degradeProviderOptions("openai/gpt-5", 1);
        expect(providerOptions.openai).toEqual({ reasoningEffort: "low" });
      });

  test("level 2 wipes all options", () => {
    const { providerOptions } = degradeProviderOptions("anthropic/claude-opus-4-6", 2);
    expect(providerOptions).toEqual({});
  });
});

describe("buildProviderOptions — regression: existing behaviour preserved", () => {
  test("anthropic/claude-opus-4-6 still emits adaptive thinking", async () => {
    const cfg = baseConfig() as AppConfig;
    (cfg as { thinking?: unknown }).thinking = { mode: "adaptive" };
    const { providerOptions } = await buildProviderOptions("anthropic/claude-opus-4-6", cfg);
    expect(providerOptions.anthropic).toMatchObject({ thinking: { type: "adaptive" } });
  });

  test("openai/gpt-5 still emits reasoningEffort", async () => {
    const cfg = baseConfig({ openaiReasoningEffort: "high" });
    const { providerOptions } = await buildProviderOptions("openai/gpt-5", cfg);
    expect(providerOptions.openai).toMatchObject({ reasoningEffort: "high" });
  });
});

describe("getSupportedClaudeEfforts", () => {
  test("opus 4.7 supports full ladder incl. xhigh + max", () => {
    expect(getSupportedClaudeEfforts("anthropic/claude-opus-4-7")).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });

  test("opus 4.6 + sonnet 4.6 support max but NOT xhigh", () => {
    expect(getSupportedClaudeEfforts("anthropic/claude-opus-4-6")).toEqual([
      "max",
      "high",
      "medium",
      "low",
    ]);
    expect(getSupportedClaudeEfforts("anthropic/claude-sonnet-4-6")).toEqual([
      "max",
      "high",
      "medium",
      "low",
    ]);
  });

  test("opus 4.5 supports max (not xhigh)", () => {
    const e = getSupportedClaudeEfforts("anthropic/claude-opus-4-5");
    expect(e).toContain("max");
    expect(e).not.toContain("xhigh");
  });

  test("haiku has no effort support", () => {
    expect(getSupportedClaudeEfforts("anthropic/claude-haiku-4-5")).toBeNull();
  });

  test("clampEffort folds unsupported xhigh down to high on opus 4.6", () => {
    expect(clampEffort("anthropic/claude-opus-4-6", "xhigh")).toBe("high");
  });

  test("clampEffort keeps max on opus 4.6", () => {
    expect(clampEffort("anthropic/claude-opus-4-6", "max")).toBe("max");
  });
});

describe("getSupportedEfforts (route-agnostic, family-dispatched)", () => {

  test("openai reasoning has no xhigh; non-reasoning is null", () => {
    expect(getSupportedEfforts("openai/gpt-5")).toEqual([
      "off",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(getSupportedEfforts("openai/gpt-4o")).toBeNull();
  });

  test("non-effort families return null (keep static list)", () => {
    expect(getSupportedEfforts("anthropic/claude-haiku-4-5")).toBeNull();
  });
});

describe("telemetryModelInfo (privacy-safe provider/model)", () => {

  test("unknown bare provider → custom, unknown model → other", () => {
    const info = telemetryModelInfo("weirdprovider/some-private-thing");
    expect(info.provider).toBe("custom");
    expect(info.model).toBe("other");
  });

  test("model name is sanitized to safe charset + length", () => {
    const info = telemetryModelInfo("openai/gpt-5");
    expect(info.model).toMatch(/^[a-z0-9.\-]{1,40}$/);
  });
});

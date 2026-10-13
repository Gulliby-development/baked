import { describe, expect, test } from "bun:test";
import { resolveEmbeddingModel } from "../src/core/memory/embedder-resolver.js";
import type { AppConfig } from "../src/types/index.js";

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    defaultModel: "anthropic/claude-sonnet-4-6",
    ...overrides,
  }) as AppConfig;

describe("resolveEmbeddingModel — precedence", () => {

  test("explicit null disables — never falls back to heuristic", () => {
    const cfg = baseConfig({ memory: { embeddingModel: null } });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("explicit empty string falls through to next layer", () => {
    const cfg = baseConfig({ memory: { embeddingModel: "" } });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
    expect(r.source).toBe("heuristic");
  });

  test("heuristic from active model's provider", () => {
    const r = resolveEmbeddingModel(baseConfig(), "openai/gpt-5");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
    expect(r.source).toBe("heuristic");
  });
});

describe("resolveEmbeddingModel — provider heuristics", () => {
  test.each([
    ["openai/gpt-5", "openai/text-embedding-3-small"],
  ])("%s → %s", (active, expected) => {
    const r = resolveEmbeddingModel(baseConfig(), active);
    expect(r.modelId).toBe(expected);
    expect(r.source).toBe("heuristic");
  });

  test.each([
    "anthropic/claude-sonnet-4-6",
    "codex/gpt-5",
    "copilot/gpt-4",
  ])("%s → null (no embedding API)", (active) => {
    const r = resolveEmbeddingModel(baseConfig(), active);
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });
});

describe("resolveEmbeddingModel — degenerate inputs", () => {
  test("null config → safe fallback", () => {
    const r = resolveEmbeddingModel(null, "openai/gpt-5");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
    expect(r.source).toBe("heuristic");
  });

  test("undefined config → safe fallback", () => {
    const r = resolveEmbeddingModel(undefined, "openai/gpt-5");
    expect(r.source).toBe("heuristic");
  });

  test("empty active model → none", () => {
    const r = resolveEmbeddingModel(baseConfig(), "");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("'none' active model → none", () => {
    const r = resolveEmbeddingModel(baseConfig(), "none");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("null active model → none", () => {
    const r = resolveEmbeddingModel(baseConfig(), null);
    expect(r.modelId).toBeNull();
  });

  test("active model with no slash → unknown provider", () => {
    const r = resolveEmbeddingModel(baseConfig(), "gpt-5");
    expect(r.modelId).toBeNull();
  });

  test("unknown provider → null, advises explicit config", () => {
    const r = resolveEmbeddingModel(baseConfig(), "mycustom/my-model");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
    expect(r.reason).toContain("mycustom");
  });

  test("whitespace-only explicit override falls through", () => {
    const cfg = baseConfig({ memory: { embeddingModel: "   " } });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.source).toBe("heuristic");
  });

  test("whitespace-only taskRouter.semantic falls through", () => {
    const cfg = baseConfig({
      taskRouter: { semantic: "   " } as AppConfig["taskRouter"],
    });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.source).toBe("heuristic");
  });

  test("explicit override is trimmed", () => {
    const cfg = baseConfig({
      memory: { embeddingModel: "  openai/text-embedding-3-small  " },
    });
    const r = resolveEmbeddingModel(cfg, "anthropic/claude");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
  });
});

describe("resolveEmbeddingModel — taskRouter.semantic", () => {
  test("a chat model in the semantic slot is not used as an embedder", () => {
    const cfg = baseConfig({
      taskRouter: { semantic: "codex/gpt-6.1-sol" } as AppConfig["taskRouter"],
    });
    const r = resolveEmbeddingModel(cfg, "codex/gpt-6.1-sol");
    expect(r.modelId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("a chat model in the semantic slot falls through to the active provider", () => {
    const cfg = baseConfig({
      taskRouter: { semantic: "anthropic/claude-sonnet-4-6" } as AppConfig["taskRouter"],
    });
    const r = resolveEmbeddingModel(cfg, "openai/gpt-5");
    expect(r.modelId).toBe("openai/text-embedding-3-small");
    expect(r.source).toBe("heuristic");
  });

  test("an embedding model in the semantic slot is used", () => {
    const cfg = baseConfig({
      taskRouter: { semantic: " openai/text-embedding-3-large " } as AppConfig["taskRouter"],
    });
    const r = resolveEmbeddingModel(cfg, "codex/gpt-6.1-sol");
    expect(r.modelId).toBe("openai/text-embedding-3-large");
    expect(r.source).toBe("task-router");
  });
});

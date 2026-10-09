import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, getFamilyPrompt, getPromptForModel } from "../src/core/prompts/builder";
import { CLAUDE_PROMPT } from "../src/core/prompts/families/claude";
import { DEFAULT_PROMPT } from "../src/core/prompts/families/default";
import { GOOGLE_PROMPT } from "../src/core/prompts/families/google";
import { OPENAI_PROMPT } from "../src/core/prompts/families/openai";
import { getModeInstructions } from "../src/core/prompts/modes";
import { buildDirectoryTree, buildBakeMapAck, buildBakeMapUserMessage } from "../src/core/prompts/shared";
import type { PromptBuilderOptions } from "../src/core/prompts/builder";

// ── Family Selection ──

describe("family prompt selection", () => {
  test("getFamilyPrompt returns correct prompt per family", () => {
    expect(getFamilyPrompt("claude")).toBe(CLAUDE_PROMPT);
    expect(getFamilyPrompt("openai")).toBe(OPENAI_PROMPT);
    expect(getFamilyPrompt("google")).toBe(GOOGLE_PROMPT);
    expect(getFamilyPrompt("other")).toBe(DEFAULT_PROMPT);
  });

  test("getFamilyPrompt returns default for unknown family", () => {
    expect(getFamilyPrompt("llama")).toBe(DEFAULT_PROMPT);
    expect(getFamilyPrompt("nonexistent")).toBe(DEFAULT_PROMPT);
  });
});

// ── Builder Assembly ──

function baseOpts(overrides?: Partial<PromptBuilderOptions>): PromptBuilderOptions {
  return {
    modelId: "anthropic/claude-sonnet-4-6",
    hasRepoMap: false,
    hasSymbols: false,
    forgeMode: "default",
    contextPercent: 50,
    projectInstructions: null,
    ...overrides,
  };
}

describe("buildSystemPrompt assembly", () => {
  test("tool-guidance branch toggles with hasRepoMap", () => {
    const withMap = buildSystemPrompt(baseOpts({ hasRepoMap: true }));
    const withoutMap = buildSystemPrompt(baseOpts({ hasRepoMap: false }));
    expect(withMap).toContain("<workflow>");
    expect(withoutMap).not.toContain("<workflow>");
  });

  test("mode overlay is NEVER baked into the cached system prompt (cache stability)", () => {
    // Mode instructions moved to a cache-stable user-message inject in forge.ts
    // (discussion #85, source #1). The system prompt must be byte-identical
    // across modes so switching them never invalidates the cache breakpoint.
    const def = buildSystemPrompt(baseOpts({ forgeMode: "default" }));
    const arch = buildSystemPrompt(baseOpts({ forgeMode: "architect" }));
    const plan = buildSystemPrompt(baseOpts({ forgeMode: "plan" }));
    expect(arch).not.toContain("ARCHITECT MODE");
    expect(plan).not.toContain("PLAN MODE");
    expect(arch).toBe(def);
    expect(plan).toBe(def);
  });

  test("routes by model family — claude vs openai produce different prompts", () => {
    const claude = buildSystemPrompt(baseOpts({ modelId: "anthropic/claude-opus-4" }));
    const openai = buildSystemPrompt(baseOpts({ modelId: "openai/gpt-4o" }));
    expect(claude).not.toBe(openai);
    expect(claude).toContain(getFamilyPrompt("claude"));
    expect(openai).toContain(getFamilyPrompt("openai"));
  });
});

// ── Mode Instructions ──

describe("mode instructions", () => {
  test("default mode returns null", () => {
    expect(getModeInstructions("default")).toBeNull();
  });

  test("architect mode returns read-only instructions", () => {
    const instructions = getModeInstructions("architect");
    expect(instructions).toContain("ARCHITECT MODE");
    expect(instructions).toContain("Read-only");
  });

  test("plan mode returns full plan at high context", () => {
    const instructions = getModeInstructions("plan", { contextPercent: 80 });
    expect(instructions).toContain("full");
    expect(instructions).toContain("code_snippets");
  });

  test("plan mode returns light plan at low context", () => {
    const instructions = getModeInstructions("plan", { contextPercent: 30 });
    expect(instructions).toContain("light");
    expect(instructions).toContain("no code_snippets");
  });

  test("auto mode returns autonomous instructions", () => {
    const instructions = getModeInstructions("auto");
    expect(instructions).toContain("AUTO MODE");
    expect(instructions).toContain("Execute immediately");
  });
});

// ── Baked Map Messages ──

describe("Baked map messages", () => {
  test("buildBakeMapUserMessage wraps content in tags", () => {
    const msg = buildBakeMapUserMessage("file1.ts\n  +export foo", false);
    expect(msg).toContain("<bake_map>");
    expect(msg).toContain("</bake_map>");
    expect(msg).toContain("<data>");
    expect(msg).toContain("file1.ts");
    expect(msg).toContain("+export foo");
  });

  test("buildBakeMapUserMessage includes legend for non-minimal", () => {
    const msg = buildBakeMapUserMessage("data", false);
    expect(msg).toContain("+ = exported");
    expect(msg).toContain("blast radius");
  });

  test("buildBakeMapUserMessage omits legend for minimal", () => {
    const msg = buildBakeMapUserMessage("data", true);
    expect(msg).not.toContain("+ = exported");
  });

  test("buildBakeMapUserMessage includes directory tree when provided", () => {
    const tree = "├── src/\n│   ├── core/\n└── tests/";
    const msg = buildBakeMapUserMessage("data", false, tree);
    expect(msg).toContain("<directory_tree>");
    expect(msg).toContain("├── src/");
    expect(msg).toContain("</directory_tree>");
  });

  test("buildBakeMapUserMessage omits directory tree when null", () => {
    const msg = buildBakeMapUserMessage("data", false, null);
    expect(msg).not.toContain("<directory_tree>");
  });

  test("buildBakeMapAck returns acknowledgment", () => {
    const ack = buildBakeMapAck();
    expect(ack).toContain("Baked Map indexed");
  });

  test("buildBakeMapUserMessage includes description and usage", () => {
    const msg = buildBakeMapUserMessage("data", false);
    expect(msg).toContain("<description>");
    expect(msg).toContain("<how_to_use>");
    expect(msg).toContain("navigate()");
  });
});

// ── Directory Tree ──

describe("buildDirectoryTree", () => {
  test("returns null for non-existent directory", () => {
    const tree = buildDirectoryTree("/non/existent/path");
    expect(tree).toBeNull();
  });

  test("returns tree for valid directory", () => {
    const tree = buildDirectoryTree(process.cwd());
    expect(tree).not.toBeNull();
    expect(tree).toContain("docs/");
  });

  test("uses tree characters", () => {
    const tree = buildDirectoryTree(process.cwd());
    expect(tree).not.toBeNull();
    // Should contain tree connectors
    expect(tree!).toMatch(/[├└│]/);
  });
});
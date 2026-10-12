import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AppConfig, ContextManagementConfig, EffortLevel } from "../../types/index.js";
import {
  extractBaseModel as _leafExtractBaseModel,
  getModelId as _leafGetModelId,
  isAdaptiveOnly as _leafIsAdaptiveOnly,
  parseOpusVersion as _leafParseOpusVersion,
  supportsTemperature as _leafSupportsTemperature,
} from "./model-id.js";
import { getModelContextWindow } from "./models.js";
import { isBuiltinProvider } from "./providers/index.js";

const parseOpusVersion = _leafParseOpusVersion;
const isAdaptiveOnly = _leafIsAdaptiveOnly;

export const extractBaseModel = _leafExtractBaseModel;
export const getModelId = _leafGetModelId;
export const supportsTemperature = _leafSupportsTemperature;

interface ModelCapabilities {
  provider: "anthropic" | "openai" | "google" | "xai" | "deepseek" | "other";
  thinking: boolean;
  adaptiveThinking: boolean;
  effort: boolean;
  speed: boolean;
  contextManagement: boolean;
  interleavedThinking: boolean;
  openaiReasoning: boolean;
  openaiServiceTier: boolean;
  googleThinking: boolean;
  /** Use thinkingLevel (Gemini 3+) vs thinkingBudget (Gemini 2.5). */
  googleThinkingLevel: boolean;
  xaiReasoning: boolean;
  deepseekThinking: boolean;
  /** Body-injection reasoning_effort for OpenAI-compatible reasoning SKUs. */
  compatReasoning: boolean;
}

interface ProviderConstraints {
  anthropicOptions: boolean;
  openaiOptions: boolean;
  effort: boolean;
  speed: boolean;
  contextManagement: boolean;
  adaptiveThinking: boolean;
  interleavedThinking: boolean;
  compatReasoningBody: boolean;
}

const NO_SUPPORT: ProviderConstraints = {
  anthropicOptions: false,
  openaiOptions: false,
  effort: false,
  speed: false,
  contextManagement: false,
  adaptiveThinking: false,
  interleavedThinking: false,
  compatReasoningBody: false,
};

const ANTHROPIC_FULL: ProviderConstraints = {
  ...NO_SUPPORT,
  anthropicOptions: true,
  effort: true,
  speed: true,
  contextManagement: true,
  adaptiveThinking: true,
  interleavedThinking: true,
};

const OPENAI_FULL: ProviderConstraints = {
  ...NO_SUPPORT,
  openaiOptions: true,
};

const COMPAT_ONLY: ProviderConstraints = {
  ...NO_SUPPORT,
  compatReasoningBody: true,
};

const PROVIDER_CONSTRAINTS: Record<string, ProviderConstraints> = {
  anthropic: ANTHROPIC_FULL,
  openai: OPENAI_FULL,
  copilot: COMPAT_ONLY,
  "github-models": COMPAT_ONLY,
};

function parseModelId(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { provider: "", model: modelId };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

type ClaudeGen = "legacy" | "3.5" | "4+" | "non-claude";

const LEGACY_PREFIXES = [
  "claude-3-haiku",
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3.0",
  "claude-2",
  "claude-instant",
];

function getClaudeGen(model: string): ClaudeGen {
  let m = model;
  if (m.startsWith("us.")) m = m.slice(3);
  if (m.startsWith("anthropic.")) m = m.slice("anthropic.".length);
  if (!m.startsWith("claude")) return "non-claude";
  for (const p of LEGACY_PREFIXES) {
    if (m.startsWith(p)) return "legacy";
  }
  if (m.startsWith("claude-3.5") || m.startsWith("claude-3-5")) return "3.5";
  return "4+";
}

//
// For direct providers (anthropic/, openai/), the provider prefix tells us everything.
// to determine the underlying provider family.

/** GPT models that take reasoning effort: gpt-5 and every later generation (gpt-5.6-luna, gpt-6-astra, gpt-6.1-sol). */
const GPT_REASONING = /^gpt-([5-9]|\d{2,})/;

export type ModelFamily =
  | "claude"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "deepseek-reasoner"
  | "other";

export function detectModelFamily(modelId: string): ModelFamily {
  const { provider } = parseModelId(modelId);
  const base = extractBaseModel(modelId);

  // Kimi K2.5 ships an Anthropic-compatible endpoint and was tuned against
  // Claude-shaped prompts — route to claude family.
  if (provider === "moonshot" || base.startsWith("kimi")) return "claude";

  // Direct providers — no guessing needed
  if (provider === "anthropic") return "claude";
  // Claude Code runs Claude models through the local CLI; its options are its own.
  if (provider === "claude-code") return "claude";
  if (provider === "openai") return "openai";
  if (provider === "xai") return "xai";
  if (provider === "google") return "google";
  if (provider === "deepseek") return isDeepSeekReasoner(base) ? "deepseek-reasoner" : "deepseek";

  if (base.startsWith("claude") || base.startsWith("anthropic.claude")) return "claude";
  if (
    base.startsWith("gpt-") ||
    base.startsWith("o1") ||
    base.startsWith("o3") ||
    base.startsWith("o4")
  )
    return "openai";
  if (base.startsWith("gemini")) return "google";
  if (base.startsWith("grok")) return "xai";
  if (base.startsWith("deepseek"))
    return isDeepSeekReasoner(base) ? "deepseek-reasoner" : "deepseek";
  const model = parseModelId(modelId).model;
  if (model.startsWith("anthropic/")) return "claude";
  if (model.startsWith("openai/")) return "openai";
  if (model.startsWith("google/")) return "google";
  if (model.startsWith("x-ai/") || model.startsWith("xai/")) return "xai";
  if (model.startsWith("deepseek/")) {
    const sub = model.slice("deepseek/".length);
    return isDeepSeekReasoner(sub) ? "deepseek-reasoner" : "deepseek";
  }
  if (model.startsWith("moonshotai/") || model.startsWith("moonshot/")) return "claude";

  return "other";
}

function getModelCapabilities(modelId: string): ModelCapabilities {
  const base = extractBaseModel(modelId);
  const family = detectModelFamily(modelId);

  const BASE: ModelCapabilities = {
    provider: "other",
    thinking: false,
    adaptiveThinking: false,
    effort: false,
    speed: false,
    contextManagement: false,
    interleavedThinking: false,
    openaiReasoning: false,
    openaiServiceTier: false,
    googleThinking: false,
    googleThinkingLevel: false,
    xaiReasoning: false,
    deepseekThinking: false,
    compatReasoning: false,
  };

  if (family === "openai") {
    const isReasoning =
      base.startsWith("o1") ||
      base.startsWith("o3") ||
      base.startsWith("o4") ||
      GPT_REASONING.test(base);
    return {
      ...BASE,
      provider: "openai",
      openaiReasoning: isReasoning,
      openaiServiceTier: true,
    };
  }

  if (family === "google") {
    // Gemini 2.5 = thinkingBudget; Gemini 3+ = thinkingLevel
    const isGemini3 = /gemini-3(\.|-|$)/.test(base);
    const isGemini25 = /gemini-2\.5/.test(base);
    const supportsThinking = isGemini3 || isGemini25;
    return {
      ...BASE,
      provider: "google",
      googleThinking: supportsThinking,
      googleThinkingLevel: isGemini3,
    };
  }

  if (family === "xai") {
    // Reasoning SKUs: grok-3-mini, grok-4*, grok-4.1*, grok-4.20*, *-reasoning
    const isReasoning =
      base.startsWith("grok-3-mini") || base.startsWith("grok-4") || base.includes("reasoning");
    return {
      ...BASE,
      provider: "xai",
      xaiReasoning: isReasoning,
    };
  }

  if (family === "deepseek") {
    // deepseek-reasoner auto-thinks; deepseek-chat needs explicit thinking flag
    const isChat = base === "deepseek-chat" || base.startsWith("deepseek-v3");
    return {
      ...BASE,
      provider: "deepseek",
      deepseekThinking: isChat,
      compatReasoning: true,
    };
  }

  if (family !== "claude") {
    // Generic OpenAI-compatible reasoning SKUs (qwen3, glm-4.5+, kimi-thinking, gpt-oss, etc.)
    const isCompatReasoning =
      /qwen3/.test(base) ||
      /glm-(4\.[5-9]|[5-9])/.test(base) ||
      /kimi-(k2|thinking)/.test(base) ||
      /gpt-oss/.test(base) ||
      /deepseek-r1/.test(base) ||
      /minimax-m[2-9]/.test(base);
    return {
      ...BASE,
      compatReasoning: isCompatReasoning,
    };
  }

  // Claude — generation-based capabilities
  const gen = getClaudeGen(base);

  if (gen === "legacy") {
    return { ...BASE, provider: "anthropic" };
  }

  if (gen === "3.5") {
    return {
      ...BASE,
      provider: "anthropic",
      thinking: true,
    };
  }

  return {
    ...BASE,
    provider: "anthropic",
    thinking: true,
    adaptiveThinking: true,
    effort: !base.includes("haiku"),
    speed: base.includes("opus"),
    contextManagement: !base.includes("haiku"),
    interleavedThinking: true,
  };
}

function getProviderConstraints(providerId: string): ProviderConstraints {
  if (!providerId) return NO_SUPPORT;

  const exact = PROVIDER_CONSTRAINTS[providerId];
  if (exact) return exact;

  return NO_SUPPORT;
}

interface EffectiveCaps extends ModelCapabilities {
  anthropicOptions: boolean;
  openaiOptions: boolean;
  compatReasoningBody: boolean;
}

function getEffectiveCaps(modelId: string): EffectiveCaps {
  const model = getModelCapabilities(modelId);
  const { provider } = parseModelId(modelId);
  const pc = getProviderConstraints(provider);
  const family = detectModelFamily(modelId);

  return {
    ...model,
    anthropicOptions: pc.anthropicOptions && family === "claude",
    openaiOptions: pc.openaiOptions && family === "openai",
    compatReasoningBody:
      pc.compatReasoningBody && (model.compatReasoning || model.deepseekThinking),
    adaptiveThinking: model.adaptiveThinking && pc.adaptiveThinking,
    effort: model.effort && pc.effort,
    speed: model.speed && pc.speed,
    contextManagement: model.contextManagement && pc.contextManagement,
    interleavedThinking: model.interleavedThinking && pc.interleavedThinking,
  };
}

export function isAnthropicNative(modelId: string): boolean {
  return detectModelFamily(modelId) === "claude";
}

/**
 * Low-cardinality public-model SHAPE: a family prefix followed by up to 5
 * version/variant tokens (e.g. claude-sonnet-4-5, gemini-3.1-pro-preview,
 * gpt-5.4-mini). A shape gate — not a per-family allow-list — so new public
 * models surface automatically, while a free-form string that could embed
 * secrets/org/project names fails the shape and collapses to "other".
 */
const TELEMETRY_MODEL_SLUG = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,5}$/;

export function telemetryModelInfo(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  const rawProvider = slash >= 0 ? modelId.slice(0, slash) : "";
  const builtin = isBuiltinProvider(rawProvider);
  const provider = builtin ? rawProvider : "custom";

  // Use the segment after the FIRST slash (not extractBaseModel's lastIndexOf,
  // which would strip "claude-../../etc/passwd" down to a clean "passwd" and
  // sneak path traversal past the gate). Any remaining slash fails the shape.
  const raw = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
  // Report the real base name for any built-in provider as long as it has a
  // low-cardinality public-model SHAPE (family prefix + version/variant tokens,

  // shape gate, not a per-family allow-list: new public models surface
  // automatically, while a string that could embed secrets/org/project names
  // never reaches the wire.
  const known = builtin && raw.length <= 40 && TELEMETRY_MODEL_SLUG.test(raw);
  const model = known ? raw : "other";
  return { provider, model };
}

export function getSupportedClaudeEfforts(modelId: string): EffortLevel[] | null {
  const base = extractBaseModel(modelId);
  if (!base.startsWith("claude")) return null;

  // Haiku does not support the effort parameter — Anthropic API rejects it.
  if (base.includes("haiku")) return null;

  // Opus 4.7+: full range
  const v = parseOpusVersion(base);
  if (v && (v.major >= 5 || (v.major === 4 && v.minor >= 7))) {
    return ["max", "xhigh", "high", "medium", "low"];
  }

  // Opus 4.6 and Sonnet 4.6: max but NOT xhigh (xhigh is Opus 4.7+ only).
  if (
    base.includes("opus-4-6") ||
    base.includes("opus-4.6") ||
    base.includes("sonnet-4-6") ||
    base.includes("sonnet-4.6")
  ) {
    return ["max", "high", "medium", "low"];
  }

  // Opus 4.5: supports the effort param incl. max, but NOT xhigh.
  if (base.includes("opus-4-5") || base.includes("opus-4.5")) {
    return ["max", "high", "medium", "low"];
  }

  // Other Claude 4+ models with effort capability
  return ["high", "medium", "low"];
}

/** Clamp an effort value to the nearest supported level (descending). Returns null if the model has no effort support. */
export function clampEffort(modelId: string, effort: EffortLevel): EffortLevel | null {
  const supported = getSupportedClaudeEfforts(modelId);
  if (!supported) return null;
  if (supported.includes(effort)) return effort;
  // Walk down from the requested level until we find a supported one.
  const order: EffortLevel[] = ["max", "xhigh", "high", "medium", "low"];
  const requestedIdx = order.indexOf(effort);
  for (let i = requestedIdx; i < order.length; i++) {
    const level = order[i];
    if (level && supported.includes(level)) return level;
  }
  return supported[supported.length - 1] ?? null;
}

export function getSupportedEfforts(modelId: string): string[] | null {
  const family = detectModelFamily(modelId);
  const base = extractBaseModel(modelId);

  if (family === "claude") {
    const efforts = getSupportedClaudeEfforts(modelId);
    return efforts ? ["off", ...efforts] : null;
  }
  if (family === "deepseek") return ["off", "high", "max"];
  if (family === "openai") {
    const isReasoning =
      base.startsWith("o1") ||
      base.startsWith("o3") ||
      base.startsWith("o4") ||
      GPT_REASONING.test(base);
    return isReasoning ? ["off", "none", "minimal", "low", "medium", "high"] : null;
  }
  if (family === "xai") return ["off", "low", "medium", "high"];
  if (family === "google") return ["off", "minimal", "low", "medium", "high"];
  return null;
}

/** Programmatic tool calling (allowedCallers) requires Claude 4+ non-haiku. */
export function supportsProgrammaticToolCalling(modelId: string): boolean {
  const base = extractBaseModel(modelId);
  const gen = getClaudeGen(base);
  if (gen !== "4+") return false;
  return !base.includes("haiku");
}

/** Resolve which Anthropic server tool versions a model supports.
 *  Based on https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference */
export function getAnthropicToolVersions(modelId: string): {
  /** computer_20251124 (zoom) vs 20250124 vs null */
  computerUse: "20251124" | "20250124" | null;
  /** text_editor_20250728 (Claude 4) vs 20250124 (3.7) vs null */
  textEditor: "20250728" | "20250124" | null;
  /** Whether allowed_callers / programmatic tool calling is supported */
  programmaticToolCalling: boolean;
} {
  const base = extractBaseModel(modelId);
  const gen = getClaudeGen(base);
  const family = detectModelFamily(modelId);

  if (family !== "claude") {
    return {
      computerUse: null,
      textEditor: null,
      programmaticToolCalling: false,
    };
  }

  const isHaiku = base.includes("haiku");
  const is46 =
    base.includes("opus-4-6") ||
    base.includes("sonnet-4-6") ||
    base.includes("claude-opus-4-6") ||
    base.includes("claude-sonnet-4-6");
  const isOpus45 = base.includes("opus-4-5") || base.includes("opus-4.5");

  // Programmatic tool calling: Claude 4+ non-Haiku
  const programmaticToolCalling = gen === "4+" && !isHaiku;

  // Computer use: 20251124 for Opus 4.6, Sonnet 4.6, Opus 4.5; 20250124 for other Claude 4+/3.5
  let computerUse: "20251124" | "20250124" | null = null;
  if (is46 || isOpus45) {
    computerUse = "20251124";
  } else if (gen === "4+" || gen === "3.5") {
    computerUse = "20250124";
  }

  // Text editor: 20250728 for Claude 4, 20250124 for 3.5/3.7
  let textEditor: "20250728" | "20250124" | null = null;
  if (gen === "4+") {
    textEditor = "20250728";
  } else if (gen === "3.5") {
    textEditor = "20250124";
  }

  return { computerUse, textEditor, programmaticToolCalling };
}

function buildContextEdits(
  config: ContextManagementConfig | undefined,
  contextWindow: number,
  thinkingEnabled: boolean,
): unknown[] | null {
  const edits: unknown[] = [];

  // Default: preserve all thinking blocks for maximum cache hits.
  // Clearing thinking busts the prompt cache at the clearing point.
  // With keep: "all", thinking stays in context and the prefix stays stable.
  // The API default (without this edit) only keeps the last 1 turn — sending
  // keep: "all" explicitly overrides that to preserve the full prefix.
  if (config?.clearThinking !== false && thinkingEnabled) {
    edits.push({
      type: "clear_thinking_20251015",
      keep: "all",
    });
  }

  // Opt-in: clear old tool uses server-side. Off by default because it busts
  // the prompt cache every time it fires. Only enable for very long sessions
  // where context pressure outweighs cache savings.
  if (config?.clearToolUses === true) {
    // Trigger late — 65% of window, minimum 120k. Most conversations never hit this.
    const clearTrigger = Math.max(120_000, Math.floor(contextWindow * 0.65));
    // When we do bust cache, clear at least 40k tokens to make it worthwhile.
    const clearAtLeast = Math.max(40_000, Math.floor(contextWindow * 0.2));
    edits.push({
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: clearTrigger },
      keep: { type: "tool_uses", value: 5 },
      clearToolInputs: true,
      clearAtLeast: { type: "input_tokens", value: clearAtLeast },
    });
  }

  // Server-side compaction (Anthropic): opt-in via config (disabled by default).
  // Summarizes older context when approaching context limit. Uses pause_after_compaction
  // so we can inject plan state / working context after the summary.
  if (config?.compact && contextWindow >= 200_000) {
    // Trigger at 80% of context window — late enough to maximize usable context,
    // early enough to leave room for the summary + continued work.
    // Minimum 160k tokens to avoid triggering on small context windows.
    const trigger = Math.max(160_000, Math.floor(contextWindow * 0.8));
    edits.push({
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: trigger },
      instructions: [
        "Write a concise summary of the conversation so far.",
        "Focus on: files modified, key decisions made, current task progress, and next steps.",
        "Preserve exact file paths, function names, and error messages.",
        "Do NOT list what you plan to do — only what has already been done and what remains.",
        "Do NOT dump internal state or repeat tool outputs.",
        "Keep the summary under 2000 tokens.",
        "Wrap in <summary></summary> tags.",
      ].join("\n"),
    });
  }

  return edits.length > 0 ? edits : null;
}

//
// Ephemeral cache breakpoints for prompt caching. Set on all provider keys
// so caching works regardless of which provider routes to Anthropic/Claude.
// The Vercel AI SDK silently ignores keys that don't match the active provider.

export type CacheTTL = "5m" | "1h";

const CACHE_EPHEMERAL_5M = {
  cacheControl: { type: "ephemeral" as const, ttl: "5m" as const },
} as const;
const CACHE_EPHEMERAL_1H = {
  cacheControl: { type: "ephemeral" as const, ttl: "1h" as const },
} as const;

function buildCacheProviderOptions(ttl: CacheTTL): ProviderOptions {
  const cache = ttl === "1h" ? CACHE_EPHEMERAL_1H : CACHE_EPHEMERAL_5M;
  return {
    anthropic: cache,
  } as ProviderOptions;
}

const EPHEMERAL_CACHE_5M = buildCacheProviderOptions("5m");
const EPHEMERAL_CACHE_1H = buildCacheProviderOptions("1h");

/** Resolve cache ProviderOptions for a given TTL. Memoized — same reference per TTL. */
export function getEphemeralCache(ttl: CacheTTL = "5m"): ProviderOptions {
  return ttl === "1h" ? EPHEMERAL_CACHE_1H : EPHEMERAL_CACHE_5M;
}

/** Back-compat default (5m). New code should call getEphemeralCache(config.cache?.ttl). */
export const EPHEMERAL_CACHE: ProviderOptions = EPHEMERAL_CACHE_5M;

/**
 * Adds Anthropic's request-level automatic cache breakpoint, which follows the end of the
 * conversation as an agent loop grows. Paired with a breakpoint on the system prompt (same TTL),
 * every step reads the tools, system prompt and earlier steps from the cache.
 */
export function withAutomaticCache(
  providerOptions: ProviderOptions | undefined,
  ttl: CacheTTL = "5m",
): ProviderOptions {
  const anthropic = (providerOptions as Record<string, Record<string, unknown>> | undefined)
    ?.anthropic;
  return {
    ...providerOptions,
    anthropic: { ...anthropic, cacheControl: { type: "ephemeral", ttl } },
  } as ProviderOptions;
}

export interface ProviderOptionsResult {
  providerOptions: ProviderOptions;
  headers: Record<string, string> | undefined;

  contextWindow: number;
}

async function buildAnthropicOptions(
  modelId: string,
  caps: EffectiveCaps,
  config: AppConfig,
): Promise<{
  opts: Record<string, unknown>;
  headers: Record<string, string>;
  thinkingEnabled: boolean;
}> {
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};
  const headers: Record<string, string> = {};
  let thinkingEnabled = false;

  if (caps.thinking) {
    const mode = config.thinking?.mode ?? "off";
    const adaptiveOnly = isAdaptiveOnly(modelId);
    if (mode === "auto" || mode === "adaptive" || (mode === "enabled" && adaptiveOnly)) {
      // Opus 4.7+ only supports adaptive thinking — type:"enabled" returns 400.
      if (caps.adaptiveThinking) {
        opts.thinking = { type: "adaptive" };
        thinkingEnabled = true;
      }
    } else if (mode === "enabled") {
      opts.thinking = {
        type: "enabled",
        ...(config.thinking?.budgetTokens ? { budgetTokens: config.thinking.budgetTokens } : {}),
      };
      thinkingEnabled = true;
    }
  }

  if (caps.effort && config.performance?.effort && config.performance.effort !== "off") {
    const clamped = clampEffort(modelId, config.performance.effort);
    if (clamped) opts.effort = clamped;
  }

  if (caps.speed && config.performance?.speed && config.performance.speed !== "off") {
    opts.speed = config.performance.speed;
  }

  if (config.performance?.toolStreaming === false) {
    opts.toolStreaming = false;
  }

  if (config.performance?.disableParallelToolUse) {
    opts.disableParallelToolUse = true;
  }

  if (config.performance?.sendReasoning === false) {
    opts.sendReasoning = false;
  }

  if (caps.contextManagement) {
    const contextWindow = await getModelContextWindow(modelId);
    const edits = buildContextEdits(config.contextManagement, contextWindow, thinkingEnabled);
    if (edits) {
      opts.contextManagement = { edits };
    }
  }

  // Interleaved thinking: adaptive mode enables it automatically (no header needed).
  // Manual mode on Sonnet 4.6 still requires the beta header.
  if (thinkingEnabled && caps.interleavedThinking && opts.thinking?.type !== "adaptive") {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  return { opts, headers, thinkingEnabled };
}

function buildOpenAIOptions(
  caps: EffectiveCaps,
  config: AppConfig,
): { opts: Record<string, unknown> } {
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};

  if (caps.openaiReasoning) {
    const effort = config.performance?.openaiReasoningEffort;
    if (effort && effort !== "off") {
      opts.reasoningEffort = effort;
    }
    const summary = config.performance?.openaiReasoningSummary;
    if (summary && summary !== "off") {
      opts.reasoningSummary = summary;
    } else if (opts.reasoningEffort) {
      // @ai-sdk/openai 4 defaults the Responses API summary to "detailed" whenever an
      // effort is set; null keeps summaries off unless configured.
      opts.reasoningSummary = null;
    }
    const verbosity = config.performance?.openaiVerbosity;
    if (verbosity && verbosity !== "off") {
      opts.verbosity = verbosity;
    }
  }

  if (caps.openaiServiceTier) {
    const tier = config.performance?.serviceTier;
    if (tier && tier !== "off") {
      opts.serviceTier = tier;
    }
  }

  if (config.performance?.disableParallelToolUse) {
    opts.parallelToolCalls = false;
  }

  return { opts };
}

/** The efforts a chat can pick, in picker order; `default` keeps the global setting. */
export const CHAT_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

/** Effort levels from most to least reasoning, for clamping a requested level. */
const EFFORT_ORDER = ["max", "xhigh", "high", "medium", "low"] as const;

/**
 * The configuration one call runs with when its workflow route or its chat sets a reasoning
 * effort: every effort knob (Anthropic, OpenAI, OpenAI-compatible, Codex, Claude Code) is
 * replaced for that call. `default` sends none. A level the model does not support walks down to
 * the next supported one. OpenAI-compatible providers read their effort when the model is
 * created, so the caller passes this configuration to `resolveModel` too.
 */
export function withRouteEffort(
  modelId: string,
  config: AppConfig,
  effort: EffortLevel | "default" | undefined,
): AppConfig {
  if (!effort) return config;
  if (effort === "default")
    return {
      ...config,
      performance: {
        ...config.performance,
        effort: "off",
        openaiReasoningEffort: "off",
        compatReasoningEffort: "off",
      },
    };
  const supported = getSupportedEfforts(modelId) ?? [];
  const start = EFFORT_ORDER.indexOf(effort);
  const openai = EFFORT_ORDER.slice(start).find((level) => supported.includes(level));
  return {
    ...config,
    performance: {
      ...config.performance,
      effort,
      openaiReasoningEffort: (openai as "low" | "medium" | "high" | undefined) ?? "off",
      compatReasoningEffort: effort === "max" ? "xhigh" : effort,
    },
  };
}

/** Levels Codex accepts for its reasoning models; it has no `max`. */
const CODEX_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];

function isOpenAIReasoningBase(base: string): boolean {
  return /^o[134]/.test(base) || GPT_REASONING.test(base);
}

/** Claude Code takes model aliases (`opus`, `sonnet`, `fable`) as well as full Claude ids. */
function claudeCodeEfforts(modelId: string, base: string): readonly EffortLevel[] {
  if (base.includes("haiku")) return [];
  if (base.startsWith("claude")) return getSupportedClaudeEfforts(modelId) ?? [];
  if (base.startsWith("sonnet")) return ["low", "medium", "high", "max"];
  return ["low", "medium", "high", "xhigh", "max"];
}

/**
 * The reasoning efforts a chat or route can choose for a model, lowest first: the levels BAKED
 * actually sends to that model's provider. Empty when the model takes no effort, so a picker
 * shows only the provider default.
 */
export function getModelEffortLevels(modelId: string): EffortLevel[] {
  const { provider } = parseModelId(modelId);
  const base = extractBaseModel(modelId);
  const caps = getEffectiveCaps(modelId);
  let levels: readonly string[] = [];
  if (provider === "codex") levels = isOpenAIReasoningBase(base) ? CODEX_EFFORTS : [];
  else if (provider === "claude-code") levels = claudeCodeEfforts(modelId, base);
  else if (caps.anthropicOptions && caps.effort) levels = getSupportedClaudeEfforts(modelId) ?? [];
  else if (caps.openaiOptions && caps.openaiReasoning) levels = getSupportedEfforts(modelId) ?? [];
  else if (caps.compatReasoningBody) levels = CODEX_EFFORTS;
  return [...EFFORT_ORDER].reverse().filter((level) => levels.includes(level));
}

/** The level to send: the requested one, or the next lower level the model supports. */
function clampToLevels(
  effort: EffortLevel,
  levels: readonly EffortLevel[],
): EffortLevel | undefined {
  return EFFORT_ORDER.slice(EFFORT_ORDER.indexOf(effort)).find((level) => levels.includes(level));
}

/**
 * Codex and Claude Code run through their own CLIs, so their effort travels as provider options
 * under their own name and each adapter turns it into the CLI's setting.
 */
function buildCliEffortOptions(modelId: string, config: AppConfig): Record<string, unknown> {
  const effort = config.performance?.effort;
  if (!effort || effort === "off") return {};
  const { provider } = parseModelId(modelId);
  if (provider !== "codex" && provider !== "claude-code") return {};
  const level = clampToLevels(effort, getModelEffortLevels(modelId));
  return level ? { [provider]: { reasoningEffort: level } } : {};
}

export async function buildProviderOptions(
  modelId: string,
  config: AppConfig,
): Promise<ProviderOptionsResult> {
  const caps = getEffectiveCaps(modelId);
  const providerOptions: Record<string, unknown> = {};
  let headers: Record<string, string> = {};

  // Fetch accurate context window (triggers metadata fetch if cache empty)
  const contextWindow = await getModelContextWindow(modelId);

  if (caps.anthropicOptions) {
    const result = await buildAnthropicOptions(modelId, caps, config);
    if (Object.keys(result.opts).length > 0) {
      providerOptions.anthropic = result.opts;
    }
    headers = result.headers;
  }

  if (caps.openaiOptions) {
    const result = buildOpenAIOptions(caps, config);
    if (Object.keys(result.opts).length > 0) {
      providerOptions.openai = result.opts;
    }
  }

  Object.assign(providerOptions, buildCliEffortOptions(modelId, config));

  // that declares a reasoning config. The actual body injection is handled

  // here for logging, degradation, and future extensibility.
  return {
    providerOptions: providerOptions as ProviderOptions,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    contextWindow,
  };
}

export function degradeProviderOptions(modelId: string, level: number): ProviderOptionsResult {
  if (level >= 2) {
    return { providerOptions: {}, headers: undefined, contextWindow: 0 };
  }

  const caps = getEffectiveCaps(modelId);
  const providerOptions: Record<string, unknown> = {};

  if (caps.anthropicOptions && caps.thinking) {
    // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
    const opts: Record<string, any> = isAdaptiveOnly(modelId)
      ? { thinking: { type: "adaptive" }, effort: "low" }
      : { thinking: { type: "enabled", budgetTokens: 5_000 } };
    providerOptions.anthropic = opts;
  }

  if (caps.openaiOptions && caps.openaiReasoning) {
    providerOptions.openai = { reasoningEffort: "low", reasoningSummary: null };
  }

  return {
    providerOptions: providerOptions as ProviderOptions,
    headers: undefined,
    contextWindow: 0,
  };
}

export function isProviderOptionsError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("not supported") ||
    lower.includes("not available") ||
    lower.includes("does not support") ||
    lower.includes("invalid parameter") ||
    lower.includes("inputschema") ||
    lower.includes("thinking is not supported") ||
    lower.includes("adaptive thinking") ||
    lower.includes("clear_thinking") ||
    lower.includes("context management") ||
    lower.includes("unknown parameter") ||
    lower.includes("temperature is deprecated")
  );
}
function isDeepSeekReasoner(base: string): boolean {
  // deepseek-reasoner = R1 path. V3.1 with explicit 'think' suffix also lacks function calling.
  return base === "deepseek-reasoner" || base.includes("reasoner") || base.endsWith("-think");
}

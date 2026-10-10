/** Model prices in USD per million tokens, shared by the status bar and workflow estimates. */

export interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

// Prices in USD per million tokens. Sources (verified 2026-04-30):
// Anthropic: https://docs.claude.com/en/docs/about-claude/pricing
// OpenAI:    https://openai.com/api/pricing/
// Google:    https://ai.google.dev/gemini-api/docs/pricing
// DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic Claude ──────────────────────────────────────────────
  // Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-04-30)
  // cacheWrite = 5-min TTL (1.25× base). 1h TTL would be 2× base; SDK doesn't
  // expose which TTL was used, and we always request the 5m default.
  // cacheRead = 0.1× base input.
  "claude-fable-5": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "claude-mythos-5": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "claude-opus-4-8": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-1": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-opus-4-0": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-3.7-sonnet": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-3.5-sonnet": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  "claude-3.5-haiku": { input: 0.8, cacheWrite: 1.0, cacheRead: 0.08, output: 4 },
  "claude-3-opus": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-3-haiku": { input: 0.25, cacheWrite: 0.3, cacheRead: 0.03, output: 1.25 },

  // ── OpenAI ────────────────────────────────────────────────────────
  // Source: https://openai.com/api/pricing/ (2026-04-30)
  // Only GPT-5.5 / 5.4 / 5.4-mini are on the official flagship page.
  // Older models retained as fallbacks for historical model IDs.
  // cacheRead = 10% of input across the GPT-5.x family.
  "gpt-5.5": { input: 5, cacheWrite: 5, cacheRead: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cacheWrite: 0.75, cacheRead: 0.075, output: 4.5 },
  // Legacy / no-longer-listed (estimates retained for back-compat with old IDs)
  "gpt-4.1": { input: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cacheWrite: 0.4, cacheRead: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cacheWrite: 0.1, cacheRead: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cacheWrite: 2.5, cacheRead: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },
  o3: { input: 10, cacheWrite: 10, cacheRead: 2, output: 40 },
  "o3-mini": { input: 1.1, cacheWrite: 1.1, cacheRead: 0.275, output: 4.4 },
  "o4-mini": { input: 1.1, cacheWrite: 1.1, cacheRead: 0.275, output: 4.4 },

  // ── Google Gemini ─────────────────────────────────────────────────
  // Source: https://ai.google.dev/gemini-api/docs/pricing (2026-04-30)
  // Pro tiers double for prompts >200k; we use the ≤200k rate (typical agent context).
  // cacheRead = 10% of input.
  "gemini-3.1-pro": { input: 2, cacheWrite: 2, cacheRead: 0.2, output: 12 },
  "gemini-3-flash": { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 3 },
  "gemini-3.1-flash-lite": { input: 0.25, cacheWrite: 0.25, cacheRead: 0.025, output: 1.5 },
  "gemini-2.5-pro": { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 },
  "gemini-2.5-flash": { input: 0.3, cacheWrite: 0.3, cacheRead: 0.03, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.4 },
  "gemini-2.0-flash": { input: 0.1, cacheWrite: 0.1, cacheRead: 0.025, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, cacheWrite: 0.075, cacheRead: 0.019, output: 0.3 },

  // ── DeepSeek ──────────────────────────────────────────────────────
  // Source: https://api-docs.deepseek.com/quick_start/pricing (2026-06-02)
  // deepseek-chat / deepseek-reasoner are aliases for deepseek-v4-flash (non-thinking / thinking),
  // deprecated 2026-07-24. cacheRead = cache-hit input rate (no separate cache-write charge).
  "deepseek-v4-pro": { input: 0.435, cacheWrite: 0.435, cacheRead: 0.003625, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, cacheWrite: 0.14, cacheRead: 0.0028, output: 0.28 },
  "deepseek-chat": { input: 0.14, cacheWrite: 0.14, cacheRead: 0.0028, output: 0.28 },
  "deepseek-reasoner": { input: 0.14, cacheWrite: 0.14, cacheRead: 0.0028, output: 0.28 },
  "deepseek-v3": { input: 0.28, cacheWrite: 0.28, cacheRead: 0.028, output: 0.42 },
  "deepseek-r1": { input: 0.28, cacheWrite: 0.28, cacheRead: 0.028, output: 0.42 },

  // ── Groq ───────────────────────────────────────────────────────────
  // Source: https://groq.com/pricing/ (2026-07)
  // cacheRead = 50% of input (Groq prompt caching discount)
  "llama-3.3-70b": { input: 0.59, cacheWrite: 0.59, cacheRead: 0.295, output: 0.79 },
  "llama-3.1-8b": { input: 0.05, cacheWrite: 0.05, cacheRead: 0.025, output: 0.08 },
  "llama-4-scout": { input: 0.11, cacheWrite: 0.11, cacheRead: 0.055, output: 0.34 },
  "qwen3-32b": { input: 0.29, cacheWrite: 0.29, cacheRead: 0.145, output: 0.59 },
  "gpt-oss-20b": { input: 0.075, cacheWrite: 0.075, cacheRead: 0.0375, output: 0.3 },
  "gpt-oss-120b": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },

  // ── xAI Grok ───────────────────────────────────────────────────────
  // Source: https://docs.x.ai/developers/pricing (2026-05-29)
  // grok-4.3 is the flagship; -fast variants are the cheap high-throughput tier.
  // cacheRead from the model card cached-input rate.
  "grok-4.3": { input: 1.25, cacheWrite: 1.25, cacheRead: 0.2, output: 2.5 },
  "grok-4.20": { input: 1.25, cacheWrite: 1.25, cacheRead: 0.2, output: 2.5 },
  "grok-4.1-fast": { input: 0.2, cacheWrite: 0.2, cacheRead: 0.05, output: 0.5 },
  "grok-4-fast": { input: 0.2, cacheWrite: 0.2, cacheRead: 0.05, output: 0.5 },
  "grok-code-fast": { input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 1.5 },
  "grok-4": { input: 3, cacheWrite: 3, cacheRead: 0.75, output: 15 },
  "grok-3": { input: 3, cacheWrite: 3, cacheRead: 0.75, output: 15 },
  "grok-3-mini": { input: 0.3, cacheWrite: 0.3, cacheRead: 0.075, output: 0.5 },

  // ── Mistral ────────────────────────────────────────────────────────
  // Source: https://docs.mistral.ai/getting-started/models/compare (2026-06)
  "mistral-large": { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 1.5 },
  "mistral-medium": { input: 1.5, cacheWrite: 1.5, cacheRead: 0.15, output: 7.5 },
  "mistral-small": { input: 0.15, cacheWrite: 0.15, cacheRead: 0.015, output: 0.6 },
  codestral: { input: 0.3, cacheWrite: 0.3, cacheRead: 0.03, output: 0.9 },
  magistral: { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 1.5 },
  ministral: { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.1 },
  pixtral: { input: 0.15, cacheWrite: 0.15, cacheRead: 0.015, output: 0.15 },
  devstral: { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.3 },
};

const FREE_PRICING: ModelPricing = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const DEFAULT_PRICING: ModelPricing = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };

// ── GitHub Copilot (premium request model) ─────────────────────
// Copilot bills per "premium request" ($0.04 × multiplier per API call).
// Per-token costs are estimated from multiplier / typical request size.
// Models with multiplier 0 (GPT-4o, GPT-4.1, GPT-5-mini) are free on paid plans.
// Source: https://docs.github.com/en/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests (verified 2026-04-30)
// Premium request multiplier → per-1M-token cost estimate.
// (Starting 2026-06-01 Copilot moves to usage-based billing; multipliers remain informative.)
// Formula: multiplier × $0.04 per request, ~5k tokens/request avg → $/1M = multiplier × $8
// input:output ratio ~4:1 in typical coding, so input = mult×$2, output = mult×$10
const FREE: ModelPricing = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const M025: ModelPricing = { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 2.5 };
const M033: ModelPricing = { input: 0.66, cacheWrite: 0.66, cacheRead: 0.07, output: 3.3 };
const M1: ModelPricing = { input: 2, cacheWrite: 2, cacheRead: 0.2, output: 10 };
const M3: ModelPricing = { input: 6, cacheWrite: 6, cacheRead: 0.6, output: 30 };
const M30: ModelPricing = { input: 60, cacheWrite: 60, cacheRead: 6, output: 300 };
const M75: ModelPricing = { input: 15, cacheWrite: 15, cacheRead: 1.5, output: 75 };

const COPILOT_PRICING: Record<string, ModelPricing> = {
  // multiplier 0 (free on paid plans)
  "gpt-4o": FREE,
  "gpt-4o-mini": FREE,
  "gpt-4.1": FREE,
  "gpt-5-mini": FREE,
  "raptor-mini": FREE,
  // multiplier 0.25
  "grok-code-fast": M025,
  grok: M025,
  "gpt-5.4-nano": M025,
  // multiplier 0.33
  "claude-haiku-4.5": M033,
  "gpt-5.4-mini": M033,
  "gpt-5.1-codex-mini": M033,
  "gemini-3-flash": M033,
  // multiplier 1
  "claude-sonnet-4.6": M1,
  "claude-sonnet-4.5": M1,
  "claude-sonnet-4": M1,
  "claude-3.7-sonnet": M1,
  "claude-3.5-sonnet": M1,
  "gemini-2.5-pro": M1,
  "gemini-3.1-pro": M1,
  "gemini-3-pro": M1,
  "gpt-5.1": M1,
  "gpt-5.2": M1,
  "gpt-5.2-codex": M1,
  "gpt-5.3": M1,
  "gpt-5.3-codex": M1,
  "gpt-5.4": M1,
  "o3-mini": M1,
  "o4-mini": M1,
  // multiplier 3
  "claude-opus-4.5": M3,
  "claude-opus-4.6": M3,
  // multiplier 7.5
  "claude-opus-4.7": M75,
  "claude-opus-4.8": M75,
  // multiplier 7.5
  "gpt-5.5": M75,
  // multiplier 10 (Opus 4.8 fast mode)
  "claude-opus-4.8-fast": { input: 20, cacheWrite: 20, cacheRead: 2, output: 100 },
  // multiplier 30 (Opus 4.6/4.7 fast mode)
  "claude-opus-4.6-fast": M30,
  "claude-opus-4.7-fast": M30,
};

function matchCopilotPricing(model: string): ModelPricing | undefined {
  const entries = Object.entries(COPILOT_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, pricing] of entries) {
    if (model.includes(key)) return pricing;
  }
  return undefined;
}

export function isModelFree(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.endsWith(":free") || id.endsWith("-free")) return true;
  return false;
}

/**
 * The table price of a model, or null when the table has no entry for it or its family. Callers
 * that must not invent a number (estimates) use this; the status bar uses `matchPricing`.
 */
export function findPricing(modelId: string): ModelPricing | null {
  const id = modelId.toLowerCase();

  // Local and free models — zero cost
  if (isModelFree(modelId)) return FREE_PRICING;

  // GitHub Copilot: premium request-based pricing
  if (id.startsWith("copilot/")) {
    const model = id.slice("copilot/".length);
    return matchCopilotPricing(model) ?? M1;
  }
  // GitHub Models: per-token pricing via multipliers ($0.00001/unit)
  // The catalog provides real per-model pricing; fall through to standard matching
  // since github-models model IDs include provider prefix (openai/gpt-4o etc)
  if (id.startsWith("github-models/")) {
    const model = id.slice("github-models/".length);
    const entries = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
    for (const [key, pricing] of entries) {
      if (model.includes(key)) return pricing;
    }
    return null;
  }
  // Sort by key length descending so "claude-opus-4-6" matches before "claude-opus-4"
  const entries = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, pricing] of entries) {
    if (id.includes(key)) return pricing;
  }
  if (id.includes("fable") || id.includes("mythos"))
    return MODEL_PRICING["claude-fable-5"] ?? DEFAULT_PRICING;
  if (id.includes("opus")) return MODEL_PRICING["claude-opus-4-8"] ?? DEFAULT_PRICING;
  if (id.includes("sonnet")) return DEFAULT_PRICING; // the default is the Sonnet price
  if (id.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5"] ?? DEFAULT_PRICING;
  if (id.includes("gemini")) return MODEL_PRICING["gemini-2.5-flash"] ?? DEFAULT_PRICING;
  if (id.includes("grok")) return MODEL_PRICING["grok-4.3"] ?? DEFAULT_PRICING;
  if (id.includes("gpt")) return MODEL_PRICING["gpt-5.4"] ?? DEFAULT_PRICING;
  if (id.includes("deepseek")) return MODEL_PRICING["deepseek-chat"] ?? DEFAULT_PRICING;
  return null;
}

/** The table price, or a Sonnet-class default for models the table does not know. */
export function matchPricing(modelId: string): ModelPricing {
  return findPricing(modelId) ?? DEFAULT_PRICING;
}

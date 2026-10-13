/**
 * Embedder resolution — pick the right embedding model for the current
 * provider + config + task router state, with safe fallback to hashbag-v2.
 *
 * Pipeline:
 *   1. config.memory.embeddingModel       (explicit user override)
 *   2. config.taskRouter.semantic         (only when it names an embedding model)
 *   3. heuristic from active chat model's provider
 *   4. null → hashbag-v2
 *
 * Failures NEVER throw. Every error returns null, which the caller treats
 * as "stay on hashbag-v2". This module is pure — no I/O, no side effects.
 */

import type { AppConfig } from "../../types/index.js";

export interface EmbedderResolution {
  /** AI SDK model id ("provider/model"), or null when no provider embedder applies. */
  modelId: string | null;
  /** Where the choice came from — surfaced in audit/logs. */
  source: "explicit" | "task-router" | "heuristic" | "none";
  /** Human-readable reason, used by logBackgroundError on failure. */
  reason: string;
}

const PROVIDER_DEFAULTS: Readonly<Record<string, string | null>> = {
  openai: "openai/text-embedding-3-small",
  // No embedding API on these providers — fall back to hashbag.
  anthropic: null,
  codex: null,
  "claude-code": null,
  copilot: null,
  "github-models": null,
};

/** Whether a model id names an embedding model ("openai/text-embedding-3-small"). */
export function isEmbeddingModelId(modelId: string): boolean {
  return /embed/i.test(modelId.slice(modelId.indexOf("/") + 1));
}

function extractProviderId(modelId: string): string {
  if (!modelId) return "";
  const slashIdx = modelId.indexOf("/");
  return slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
}

/**
 * Resolve which embedding model to use. Pure function — never throws.
 *
 * @param config Full AppConfig.
 * @param activeModelId The chat model currently in use ("provider/model").
 *                      May be "none" or empty during boot — handled.
 */
export function resolveEmbeddingModel(
  config: AppConfig | null | undefined,
  activeModelId: string | null | undefined,
): EmbedderResolution {
  // 1. Explicit override always wins.
  const explicit = config?.memory?.embeddingModel;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return {
      modelId: explicit.trim(),
      source: "explicit",
      reason: "config.memory.embeddingModel",
    };
  }
  // Explicit null disables the provider embedder entirely.
  if (explicit === null) {
    return { modelId: null, source: "none", reason: "explicitly disabled via config" };
  }

  // 2. The taskRouter.semantic slot picks the chat model that writes semantic summaries. It
  // counts only when it names an embedding model; a chat model there (codex/gpt-6.1-sol) has no
  // embedding API, and wiring it would fail on every start.
  const semantic = config?.taskRouter?.semantic?.trim();
  if (semantic && isEmbeddingModelId(semantic)) {
    return {
      modelId: semantic,
      source: "task-router",
      reason: "taskRouter.semantic",
    };
  }

  // 3. Heuristic from active provider.
  const provider = extractProviderId(activeModelId ?? "");
  if (!provider || provider === "none") {
    return { modelId: null, source: "none", reason: "no active provider" };
  }
  if (provider in PROVIDER_DEFAULTS) {
    const def = PROVIDER_DEFAULTS[provider];
    if (def) {
      return { modelId: def, source: "heuristic", reason: `default for ${provider}` };
    }
    return {
      modelId: null,
      source: "none",
      reason: `provider ${provider} has no embedding API; using hashbag-v2`,
    };
  }

  // Unknown provider (custom OpenAI-compatible) — default to no embedder,
  // user can set memory.embeddingModel explicitly.
  return {
    modelId: null,
    source: "none",
    reason: `unknown provider ${provider}; set config.memory.embeddingModel to enable`,
  };
}

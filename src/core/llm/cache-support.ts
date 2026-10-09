import { detectModelFamily, type ModelFamily } from "./provider-options.js";

export interface CacheSupport {
  enabled: boolean;
  explicit: boolean;
}

const NONE: CacheSupport = { enabled: false, explicit: false };
const EXPLICIT: CacheSupport = { enabled: true, explicit: true };
const IMPLICIT: CacheSupport = { enabled: true, explicit: false };

export function supportsPromptCache(modelId: string): CacheSupport {
  const family: ModelFamily = detectModelFamily(modelId);

  switch (family) {
    case "claude":
      // Direct Anthropic + all gateways routing to Claude + Kimi K2 (Anthropic-compatible)
      return EXPLICIT;
    case "google":
      return IMPLICIT;
    case "openai":
      // GPT-4o/4.1/5.x and o-series cache automatically above 1024 tokens.
      return IMPLICIT;
    case "deepseek":
    case "deepseek-reasoner":
      // Persistent prefix cache, automatic.
      return IMPLICIT;
    case "xai":
      // Implicit prefix matching since late 2025.
      return IMPLICIT;
    case "other":
      return NONE;
    default:
      return NONE;
  }
}

/** Convert a Claude-style TTL string to milliseconds. */
export function cacheTtlToMs(ttl: "5m" | "1h"): number {
  return ttl === "1h" ? 60 * 60_000 : 5 * 60_000;
}

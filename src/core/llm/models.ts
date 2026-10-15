import { loadConfig } from "../../config/index.js";
import { toErrorMessage } from "../../utils/errors.js";
import { inferModelGroup } from "./model-utils.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import type { ProviderModelInfo } from "./providers/types.js";

// Re-export for backward compatibility
export type { ProviderModelInfo } from "./providers/types.js";

export interface FetchModelsResult {
  models: ProviderModelInfo[];
  error?: string;
}

export interface SubProvider {
  id: string;
  name: string;
}

export interface GroupedModelsResult {
  subProviders: SubProvider[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  error?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  envVar: string;
  grouped?: boolean;
  badge?: string;
  noAuthLabel?: string;
  authErrorLabel?: string;
  fallbackModels?: ProviderModelInfo[];
}

function buildProviderConfigs(): ProviderConfig[] {
  return getAllProviders().map((p) => ({
    id: p.id,
    name: p.name,
    envVar: p.envVar,
    grouped: p.grouped,
    badge: p.badge,
    noAuthLabel: p.noAuthLabel,
    authErrorLabel: p.authErrorLabel,
    fallbackModels: p.fallbackModels,
  }));
}

export const PROVIDER_CONFIGS: ProviderConfig[] = buildProviderConfigs();

const DEFAULT_CONTEXT_TOKENS = 128_000;
const METADATA_FETCH_TIMEOUT = 5_000;

type ContextWindowSource = "api" | "fallback" | "override";

interface ContextWindowResult {
  tokens: number;
  source: ContextWindowSource;
}

export function matchesContextOverride(model: string, pattern: string): boolean {
  const lowerModel = model.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const bareModel = lowerModel.split("/").pop() ?? lowerModel;
  const barePattern = lowerPattern.split("/").pop() ?? lowerPattern;
  return (
    bareModel === barePattern ||
    lowerModel === lowerPattern ||
    lowerModel.endsWith(`/${lowerPattern}`)
  );
}

function findContextOverride(
  provider: ReturnType<typeof getProvider>,
  model: string,
): number | undefined {
  if (!provider?.contextWindowOverrides) return undefined;

  for (const [pattern, tokens] of provider.contextWindowOverrides) {
    if (matchesContextOverride(model, pattern)) return tokens;
  }

  return undefined;
}

export function applyProviderContextOverride(
  providerId: string,
  model: ProviderModelInfo,
): ProviderModelInfo {
  const tokens = findContextOverride(getProvider(providerId), model.id);
  return tokens ? { ...model, contextWindow: tokens } : model;
}

/**
 * Synchronous cache-only lookup — returns best-known value from populated caches.
 * Used internally and as fallback when async fetch times out.
 */
export function getModelContextInfoSync(modelId: string): ContextWindowResult {
  return knownContextInfo(modelId) ?? { tokens: DEFAULT_CONTEXT_TOKENS, source: "fallback" };
}

/**
 * The window a model is known to have, from the user's override, the provider's model list or a
 * pattern table; null when nothing names it and only the default would be a guess.
 */
export function knownModelContextWindow(modelId: string): number | null {
  return knownContextInfo(modelId)?.tokens ?? null;
}

function knownContextInfo(modelId: string): ContextWindowResult | null {
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  const model = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // -1. User-configured per-model override (highest priority).
  try {
    const cfg = loadConfig();
    const userOverride = cfg.contextWindowOverrides?.[modelId];
    if (typeof userOverride === "number" && userOverride > 0) {
      return { tokens: userOverride, source: "fallback" };
    }
  } catch {
    // config unavailable — ignore
  }

  // 0. Provider-specific overrides for known-incorrect upstream API values
  const ownProvider = providerId ? getProvider(providerId) : null;
  const overrideTokens = providerId
    ? findContextOverride(ownProvider ?? undefined, model)
    : getAllProviders()
        .map((provider) => findContextOverride(provider, model))
        .find((tokens) => tokens !== undefined);
  if (overrideTokens) return { tokens: overrideTokens, source: "override" };

  // 1. Provider's own API data (most accurate)
  if (providerId && !ownProvider?.grouped) {
    const entry = modelCache.get(providerId);
    if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) {
      const match = entry.models.find((m) => m.id === model);
      if (match?.contextWindow) return { tokens: match.contextWindow, source: "api" };
    }
  }
  if (providerId) {
    const grouped = getCachedGroupedModels(providerId);
    if (grouped) {
      for (const models of Object.values(grouped.modelsByProvider)) {
        const match = models.find((m) => m.id === model || modelId.endsWith(m.id));
        if (match?.contextWindow) return { tokens: match.contextWindow, source: "api" };
      }
    }
  }

  // 3. Hardcoded fallback patterns — own provider only for grouped providers
  if (ownProvider) {
    for (const [pattern, tokens] of ownProvider.contextWindows) {
      if (model.includes(pattern)) return { tokens, source: "fallback" };
    }
  }
  if (!ownProvider?.grouped) {
    for (const provider of getAllProviders()) {
      if (provider === ownProvider) continue;
      for (const [pattern, tokens] of provider.contextWindows) {
        if (model.includes(pattern)) return { tokens, source: "fallback" };
      }
    }
  }
  return null;
}

/**
 * Get the context window size (in tokens) for a model ID.
 * Async — fetches metadata if cache is empty, with 5s timeout.
 * Falls back to hardcoded patterns on timeout/failure.
 */
export async function getModelContextWindow(modelId: string): Promise<number> {
  return (await getModelContextInfo(modelId)).tokens;
}

/**
 * Synchronous cache-only context window lookup.
 * Returns best-known value from already-populated caches.
 * Use only where async is impossible (e.g. React render). Prefer getModelContextWindow.
 */
export function getModelContextWindowSync(modelId: string): number {
  return getModelContextInfoSync(modelId).tokens;
}

export async function getModelContextInfo(modelId: string): Promise<ContextWindowResult> {
  // Fast path: check caches first (no async needed)
  const cached = getModelContextInfoSync(modelId);
  if (cached.source !== "fallback") {
    return cached;
  }

  // User-configured override resolved as "fallback" — still authoritative.
  try {
    const cfg = loadConfig();
    if (cfg.contextWindowOverrides?.[modelId]) {
      return cached;
    }
  } catch {
    // ignore
  }

  // Cache miss on a non-hardcoded model — fetch metadata
  try {
    await ensureModelMetadata(modelId);
  } catch {
    // timeout or network failure — fall through to sync result
  }

  // Re-check after fetch
  return getModelContextInfoSync(modelId);
}

/**
 * Fetch and cache metadata for a model's provider. Deduped, 5s timeout.
 * Safe to call multiple times — no-ops if cache is already populated.
 */
export async function ensureModelMetadata(modelId: string): Promise<void> {
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  if (!providerId) return;

  const provider = getProvider(providerId);

  const doFetch = async () => {
    if (provider?.grouped) {
      // fetchGroupedModels is already deduped via cache check
      await fetchGroupedModels(providerId);
    } else if (provider) {
      await fetchProviderModels(providerId);
    }
  };

  // Race against timeout — never block forever
  await Promise.race([
    doFetch(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("metadata fetch timeout")), METADATA_FETCH_TIMEOUT),
    ),
  ]);
}

export function getShortModelLabel(modelId: string): string {
  if (modelId === "none") return "No model";
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  const bareModel = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 1. Provider API cache (direct providers)
  if (providerId) {
    const entry = modelCache.get(providerId);
    if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) {
      const match = entry.models.find((m) => m.id === bareModel);
      if (match) return match.name;
    }
  }
  for (const entry of groupedCache.values()) {
    if (Date.now() - entry.ts > MODEL_CACHE_TTL) continue;
    for (const models of Object.values(entry.result.modelsByProvider)) {
      const match = models.find((m) => m.id === bareModel || m.id === modelId);
      if (match && match.name !== match.id) return match.name;
    }
  }

  // 3. Fallback models from provider definitions
  const stripped = bareModel.replace(/-\d{8}$/, "");
  let bestFallback: { name: string; specificity: number } | null = null;
  for (const provider of getAllProviders()) {
    for (const m of provider.fallbackModels) {
      if (m.id === bareModel || m.id === stripped) return m.name;
      if (stripped.startsWith(m.id) || m.id.startsWith(stripped)) {
        const specificity = m.id.length;
        if (!bestFallback || specificity > bestFallback.specificity) {
          bestFallback = { name: m.name, specificity };
        }
      }
    }
  }
  if (bestFallback) return bestFallback.name;

  // 5. Smart fallback — strip date suffix, clean up
  const clean = bareModel.replace(/-\d{8}$/, "");
  return clean.length > 24 ? `${clean.slice(0, 21)}...` : clean;
}

const MODEL_CACHE_TTL = 30 * 60_000;
const modelCache = new Map<string, { models: ProviderModelInfo[]; ts: number }>();

function getCached<T>(cache: Map<string, { result: T; ts: number }>, key: string): T | null;
function getCached<T>(cache: Map<string, { models: T; ts: number }>, key: string): T | null;
function getCached(
  cache: Map<string, { result?: unknown; models?: unknown; ts: number }>,
  key: string,
): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > MODEL_CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.result ?? entry.models ?? null;
}

export function getCachedModels(providerId: string): ProviderModelInfo[] | null {
  return getCached(modelCache, providerId);
}

export function invalidateProviderModelCache(providerId: string): void {
  modelCache.delete(providerId);
  groupedCache.delete(providerId);
}

export async function fetchProviderModels(
  providerId: string,
  { bypassCache = false }: { bypassCache?: boolean } = {},
): Promise<FetchModelsResult> {
  // Check cache first
  const entry = modelCache.get(providerId);
  if (!bypassCache && entry && Date.now() - entry.ts <= MODEL_CACHE_TTL)
    return { models: entry.models };

  const provider = getProvider(providerId);
  if (!provider) return { models: [] };

  try {
    const models = await provider.fetchModels();
    if (models) {
      const normalized = models.map((m) => applyProviderContextOverride(providerId, m));
      modelCache.set(providerId, { models: normalized, ts: Date.now() });
      return { models: normalized };
    }
    return {
      models: provider.fallbackModels.map((m) => applyProviderContextOverride(providerId, m)),
    };
  } catch (err) {
    const msg = toErrorMessage(err);
    return { models: [], error: `API error: ${msg}` };
  }
}

/**
 * Pre-warm model caches for ALL providers in parallel.
 * Fire-and-forget — each provider fetch is independent and swallows errors.
 * Call at boot so the LlmSelector popup opens instantly with cached data.
 */
export function prewarmAllModels(): void {
  for (const cfg of PROVIDER_CONFIGS) {
    if (cfg.grouped) {
      fetchGroupedModels(cfg.id).catch(() => {});
    } else {
      fetchProviderModels(cfg.id).catch(() => {});
    }
  }
}

const groupedCache = new Map<string, { result: GroupedModelsResult; ts: number }>();

export function getCachedGroupedModels(providerId: string): GroupedModelsResult | null {
  return getCached(groupedCache, providerId);
}

const GROUP_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  other: "Other",
};

export async function fetchGroupedModels(
  providerId: string,
  { bypassCache = false }: { bypassCache?: boolean } = {},
): Promise<GroupedModelsResult> {
  const entry = groupedCache.get(providerId);
  if (!bypassCache && entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) return entry.result;

  // Generic fallback: use fetchModels/fallbackModels and group by model prefix
  return fetchGenericGrouped(providerId);
}

// Backward-compat wrapper
async function fetchGenericGrouped(providerId: string): Promise<GroupedModelsResult> {
  const { models, error } = await fetchProviderModels(providerId);
  if (error || models.length === 0) {
    return { subProviders: [], modelsByProvider: {}, error };
  }

  const grouped: Record<string, ProviderModelInfo[]> = {};
  for (const m of models) {
    const group = inferModelGroup(m.id);
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(m);
  }

  const subProviders = Object.keys(grouped).map((g) => ({
    id: g,
    name: GROUP_DISPLAY_NAMES[g] ?? g,
  }));

  const result: GroupedModelsResult = { subProviders, modelsByProvider: grouped };
  groupedCache.set(providerId, { result, ts: Date.now() });
  return result;
}

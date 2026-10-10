import { extractReasoningMiddleware, type LanguageModel, wrapLanguageModel } from "ai";
import { getProviderApiKey } from "../secrets.js";
import { detectModelFamily } from "./provider-options.js";
import { getAllProviders, getProvider } from "./providers/index.js";

export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  envVar: string;
}

let cachedStatuses: ProviderStatus[] | null = null;
const providerStatusListeners = new Set<(statuses: ProviderStatus[]) => void>();

export function getCachedProviderStatuses(): ProviderStatus[] | null {
  return cachedStatuses;
}

export function subscribeProviderStatuses(
  listener: (statuses: ProviderStatus[]) => void,
): () => void {
  providerStatusListeners.add(listener);
  return () => {
    providerStatusListeners.delete(listener);
  };
}

export async function checkProviders(): Promise<ProviderStatus[]> {
  const results = await Promise.all(
    getAllProviders().map(async (p) => {
      let available: boolean;
      if (p.checkAvailability) {
        available = await p.checkAvailability();
      } else {
        available = p.envVar === "" ? true : Boolean(getProviderApiKey(p.envVar));
      }
      return { id: p.id, name: p.name, envVar: p.envVar, available };
    }),
  );
  cachedStatuses = results;
  for (const listener of providerStatusListeners) listener(results);
  return results;
}

let activeProviderId: string | null = null;

export function getActiveProviderId(): string | null {
  return activeProviderId;
}

function extractProviderId(modelId: string): string {
  const slashIdx = modelId.indexOf("/");
  return slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
}

/**
 * Notify the provider system that the active model changed.
 * Deactivates the previous provider and activates the new one if they differ.
 */
export async function notifyProviderSwitch(newModelId: string): Promise<void> {
  const newProviderId = extractProviderId(newModelId);
  // self-heal after a crashed child process. onActivate implementations must
  if (newProviderId === activeProviderId) {
    for (const listener of providerSwitchListeners) {
      try {
        await listener(newModelId);
      } catch {}
    }
    return;
  }

  activeProviderId = newProviderId;

  for (const listener of providerSwitchListeners) {
    try {
      await listener(newModelId);
    } catch {}
  }
}

/**
 * Deactivate the current provider (e.g. on app shutdown).
 */
export function deactivateCurrentProvider(): void {
  if (activeProviderId) {
    const provider = getProvider(activeProviderId);
    if (provider?.onDeactivate) {
      provider.onDeactivate();
    }
    activeProviderId = null;
  }
}

export function resolveModel(modelId: string): LanguageModel {
  if (modelId === "none") {
    throw new Error("No model selected — use Ctrl+L or /model to choose a provider and model");
  }
  const slashIdx = modelId.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid model ID "${modelId}" — expected "provider/model" format`);
  }

  const providerId = modelId.slice(0, slashIdx);
  const model = modelId.slice(slashIdx + 1);

  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider "${providerId}"`);
  }
  const base = provider.createModel(model);

  // Only attach the inline-reasoning extractor for families that emit thinking
  // as <think>/<thinking> tags inside their TEXT stream (local / OpenAI-compatible
  // models). Native-reasoning families (Claude, OpenAI, Google, xAI, DeepSeek-R)
  // stream reasoning on a separate channel — running the extractor on them makes
  // it scan normal answer text for tags, which corrupts/withholds output when the
  // text legitimately contains the word "think"/"thinking" near angle brackets.
  const family = detectModelFamily(modelId);
  const NATIVE_REASONING_FAMILIES = new Set([
    "claude",
    "openai",
    "google",
    "xai",
    "deepseek-reasoner",
  ]);
  if (NATIVE_REASONING_FAMILIES.has(family)) {
    return base as LanguageModel;
  }

  // Some providers (e.g. Codex) return a v2 model spec while wrapLanguageModel is
  // typed for v3; the reasoning middleware works on both at runtime. Bridge the
  // version-spec gap with a cast — keep the public LanguageModel return type.
  return wrapLanguageModel({
    model: base as Parameters<typeof wrapLanguageModel>[0]["model"],
    // Models that inline-emit thinking as <think>/<thinking> tags in their text
    // stream (some local/OpenAI-compatible models) get them split out into
    // native reasoning parts.
    middleware: [
      extractReasoningMiddleware({ tagName: "think" }),
      extractReasoningMiddleware({ tagName: "thinking" }),
    ],
  }) as LanguageModel;
}
type ProviderSwitchListener = (newModelId: string) => void | Promise<void>;
const providerSwitchListeners = new Set<ProviderSwitchListener>();
/**
 * Subscribe to provider/model switches. Listeners fire AFTER the new
 * provider's onActivate completes. Used by ContextManager to refresh
 * the memory embedder when the user changes models. Listeners must not
 * throw — errors are swallowed.
 */
export function onProviderSwitch(listener: ProviderSwitchListener): () => void {
  providerSwitchListeners.add(listener);
  return () => {
    providerSwitchListeners.delete(listener);
  };
}

/**
 * Why a model cannot be called right now, or null when it can: a malformed ID, an unknown
 * provider, or a provider without credentials. `missingCredentials` marks the case that only the
 * user can fix before a run. A provider's own availability check is given `timeoutMs`; one that
 * does not answer in time counts as unavailable.
 */
export async function modelReadinessProblem(
  modelId: string,
  timeoutMs = 5000,
): Promise<{ problem: string; missingCredentials: boolean } | null> {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1)
    return { problem: `${modelId} is not a provider/model ID`, missingCredentials: false };
  const provider = getProvider(modelId.slice(0, slash));
  if (!provider)
    return {
      problem: `${modelId}: unknown provider ${modelId.slice(0, slash)}`,
      missingCredentials: false,
    };
  let available: boolean;
  if (provider.checkAvailability) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    let answer: boolean | "timeout";
    try {
      answer = await Promise.race([provider.checkAvailability().catch(() => false), timeout]);
    } finally {
      clearTimeout(timer);
    }
    // A check that does not answer says nothing about credentials, so it must not refuse a start.
    if (answer === "timeout")
      return {
        problem: `${modelId}: ${provider.name} did not answer the availability check within ${timeoutMs} ms`,
        missingCredentials: false,
      };
    available = answer;
  } else available = provider.envVar === "" || Boolean(getProviderApiKey(provider.envVar));
  return available
    ? null
    : {
        problem: `${modelId}: ${provider.name} is not available${provider.envVar ? ` (set ${provider.envVar} or add the key with /keys)` : ""}`,
        missingCredentials: true,
      };
}

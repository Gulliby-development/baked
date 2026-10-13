import { getCachedProviderStatuses } from "./provider.js";
import { getProvider } from "./providers/index.js";

/** Providers that serve exactly one vendor's models, in the order an automatic route tries them. */
const SINGLE_VENDOR_PROVIDERS = ["claude-code", "codex", "anthropic", "openai"] as const;

/** The first listed model of each available single-vendor provider, as `provider/model`. */
export function availableVendorModels(availableProviders: readonly string[]): string[] {
  const models: string[] = [];
  for (const id of SINGLE_VENDOR_PROVIDERS) {
    if (!availableProviders.includes(id)) continue;
    const first = getProvider(id)?.fallbackModels[0]?.id;
    if (first) models.push(`${id}/${first}`);
  }
  return models;
}

/** `availableVendorModels` of the last provider check; empty before any check ran. */
export function cachedVendorModels(): string[] {
  const statuses = getCachedProviderStatuses() ?? [];
  return availableVendorModels(statuses.filter((s) => s.available).map((s) => s.id));
}

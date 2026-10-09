export { anthropic } from "./anthropic.js";
export { codex } from "./codex.js";
export { copilot } from "./copilot.js";
export { githubModels } from "./github-models.js";
export { openai } from "./openai.js";
export type { ProviderDefinition, ProviderModelInfo } from "./types.js";

import { anthropic } from "./anthropic.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { githubModels } from "./github-models.js";
import { openai } from "./openai.js";
import type { ProviderDefinition } from "./types.js";

const BUILTIN_PROVIDERS: ProviderDefinition[] = [anthropic, openai, codex, copilot, githubModels];

const allProviders: ProviderDefinition[] = [...BUILTIN_PROVIDERS];
const providerMap = new Map(allProviders.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDefinition | undefined {
  return providerMap.get(id);
}

const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDERS.map((p) => p.id));

export function isBuiltinProvider(id: string): boolean {
  return BUILTIN_PROVIDER_IDS.has(id);
}

export function getAllProviders(): ProviderDefinition[] {
  return allProviders;
}

export interface ProviderSecretEntry {
  secretKey: string;
  envVar: string;
  providerId: string;
  label: string;
  keyUrl?: string;
}

/** Derive secret key entries from all registered providers (single source of truth). */
export function getProviderSecretEntries(): ProviderSecretEntry[] {
  return allProviders
    .filter((p): p is typeof p & { secretKey: string } => !!(p.envVar && p.secretKey))
    .map((p) => ({
      secretKey: p.secretKey,
      envVar: p.envVar,
      providerId: p.id,
      label: p.name,
      keyUrl: p.keyUrl,
    }));
}

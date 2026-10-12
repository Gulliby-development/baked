/**
 * The model a first start falls back to when the person picked none: the default model of the
 * only provider that can run without further setup.
 */
import { getDefaultKeyPriority, getSecretSources, type SecretKey } from "../secrets.js";
import { getAllProviders } from "./providers/index.js";
import type { ProviderDefinition } from "./providers/types.js";

/** Whether the provider can run now: a key is set, another tool's login was found, or its CLI is signed in. */
async function isReady(provider: ProviderDefinition): Promise<boolean> {
  if (
    provider.secretKey &&
    getSecretSources(provider.secretKey as SecretKey, getDefaultKeyPriority()).active !== "none"
  )
    return true;
  if (provider.detectLogin?.()) return true;
  // A CLI provider (no key of its own) is ready once its CLI is installed and signed in.
  if (!provider.envVar && provider.checkAvailability)
    return provider.checkAvailability().catch(() => false);
  return false;
}

/** `provider/model` of the only ready provider's first model; null when none or several are ready. */
export async function soleReadyModel(
  providers: ProviderDefinition[] = getAllProviders(),
): Promise<string | null> {
  const ready: ProviderDefinition[] = [];
  for (const provider of providers) if (await isReady(provider)) ready.push(provider);
  const [only] = ready;
  if (!only || ready.length > 1) return null;
  const models = (await only.fetchModels().catch(() => null)) ?? only.fallbackModels;
  const first = models[0] ?? only.fallbackModels[0];
  return first ? `${only.id}/${first.id}` : null;
}

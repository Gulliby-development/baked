import type { ChatContextSize } from "../../types/index.js";
import { getProvider } from "./providers/index.js";
import type { ContextSizeOption } from "./providers/types.js";

/** Context sizes a chat can pick besides token counts. */
export const CHAT_CONTEXT_KEYWORDS = ["default", "max"] as const;

function splitModelId(modelId: string): { providerId: string; model: string } | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  return { providerId: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

/**
 * The context windows a `provider/model` ID offers, smallest first, with the full model ID that
 * asks for each. Empty when the provider offers one size, so pickers hide.
 */
export function getModelContextOptions(modelId: string): ContextSizeOption[] {
  const parts = splitModelId(modelId);
  if (!parts) return [];
  const options = getProvider(parts.providerId)?.contextSizes?.(parts.model) ?? [];
  if (options.length < 2) return [];
  return [...options]
    .sort((a, b) => a.tokens - b.tokens)
    .map((o) => ({ tokens: o.tokens, modelId: `${parts.providerId}/${o.modelId}` }));
}

/** The context sizes in tokens a chat can pick for a model, smallest first; empty for one size. */
export function getModelContextSizes(modelId: string): number[] {
  return getModelContextOptions(modelId).map((o) => o.tokens);
}

/** The option a size picks: exact, else the largest below it, else the smallest. */
function pick(options: ContextSizeOption[], size: "max" | number): ContextSizeOption | undefined {
  if (size === "max") return options.at(-1);
  return (
    options.find((o) => o.tokens === size) ??
    [...options].reverse().find((o) => o.tokens < size) ??
    options[0]
  );
}

/**
 * The model ID a chat's turns run with for its context size. `default` keeps the chosen model.
 * The coordinator always takes the largest window its model offers, whatever the size says. A
 * model with one size runs as chosen.
 */
export function withContextSize(
  modelId: string,
  size: ChatContextSize | undefined,
  options: { coordinator?: boolean } = {},
): string {
  const choices = getModelContextOptions(modelId);
  if (choices.length === 0) return modelId;
  const wanted = options.coordinator ? "max" : !size || size === "default" ? null : size;
  if (wanted === null) return modelId;
  return pick(choices, wanted)?.modelId ?? modelId;
}

/**
 * The window in tokens a chat runs with when its model offers several, or null when it offers
 * one. Pickers show it as the current choice.
 */
export function chatContextTokens(
  modelId: string,
  size: ChatContextSize | undefined,
  options: { coordinator?: boolean } = {},
): number | null {
  const choices = getModelContextOptions(modelId);
  if (choices.length === 0) return null;
  const effective = withContextSize(modelId, size, options).toLowerCase();
  return (
    choices.find((o) => o.modelId.toLowerCase() === effective)?.tokens ?? choices[0]?.tokens ?? null
  );
}

/** Parses `default`, `max`, a token count, or a short form such as `200k` or `1m`. */
export function parseContextSize(value: string): ChatContextSize | null {
  const text = value.trim().toLowerCase().replace(/[_,]/g, "");
  if (text === "default" || text === "max") return text;
  const match = text.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!match) return null;
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const tokens = Math.round(Number(match[1]) * scale);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/**
 * The model ID of the largest window a model offers, when it runs with a smaller one; null when it
 * offers one size or already runs with the largest. Workflow routes with `context: auto` move a
 * step whose context does not fit to it (#1256).
 */
export function largerContextModel(modelId: string): string | null {
  const largest = getModelContextOptions(modelId).at(-1);
  if (!largest || largest.modelId.toLowerCase() === modelId.toLowerCase()) return null;
  return largest.modelId;
}

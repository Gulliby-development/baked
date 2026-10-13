/**
 * The company whose model family a model id belongs to, independent of the provider that serves
 * it: `claude-code/opus` and `anthropic/claude-opus-4-8` are both `anthropic`, `codex/gpt-5.5` and
 * `openai/gpt-5.5` are both `openai`. Copilot and GitHub Models serve several families, so their
 * vendor comes from the model name. Independent review compares vendors, not provider ids.
 */
const PROVIDER_VENDORS: Record<string, string> = {
  anthropic: "anthropic",
  "claude-code": "anthropic",
  openai: "openai",
  codex: "openai",
};

const NAME_VENDORS: [RegExp, string][] = [
  [/^(anthropic\/)?claude/, "anthropic"],
  [/^(openai\/)?(gpt|o\d|codex|chatgpt)/, "openai"],
  [/^(google\/)?gemini/, "google"],
  [/^(xai\/)?grok/, "xai"],
  [/^(mistral(-ai)?\/)?(mistral|codestral|devstral|ministral)/, "mistral"],
  [/^(meta\/)?llama/, "meta"],
  [/^(deepseek\/)?deepseek/, "deepseek"],
];

export function modelVendor(modelId: string): string {
  const slash = modelId.indexOf("/");
  const provider = slash >= 0 ? modelId.slice(0, slash) : "";
  const known = PROVIDER_VENDORS[provider];
  if (known) return known;
  const name = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
  for (const [pattern, vendor] of NAME_VENDORS) if (pattern.test(name)) return vendor;
  // An unknown family is its own vendor: a model only matches itself.
  return provider ? `${provider}:${name}` : name;
}

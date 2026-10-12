/**
 * The reasoning effort `buildProviderOptions` put under a CLI provider's own name, for adapters
 * that turn it into the CLI's setting. Undefined leaves the CLI's default.
 */
export function cliReasoningEffort(
  providerOptions: Record<string, Record<string, unknown> | undefined> | undefined,
  provider: "codex" | "claude-code",
): string | undefined {
  const effort = providerOptions?.[provider]?.reasoningEffort;
  return typeof effort === "string" ? effort : undefined;
}

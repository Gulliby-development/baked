/** Budget wording shared by the estimate API, terminal UI and desktop renderer. */
export function estimateBudgetText(
  tokens: { low: number; high: number },
  budget: { maxTotalTokens: number; fits: "yes" | "maybe" | "no" },
  withMargin: number,
): string {
  if (tokens.high > budget.maxTotalTokens)
    return `${tokens.low > budget.maxTotalTokens ? "does not fit the shared budget" : "low end fits the shared budget"}; high end exceeds the shared budget, consider extending to ${withMargin.toLocaleString("en-US")} tokens with margin`;
  return budget.fits === "yes"
    ? "fits the shared budget"
    : "may not fit the shared budget with margin";
}

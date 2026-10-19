/** Budget wording shared by the estimate API, terminal UI and desktop renderer. */
export function estimateBudgetText(
  tokens: { low: number; high: number },
  budget: { maxTotalTokens: number; fits: "yes" | "maybe" | "no" },
  withMargin: number,
): string {
  if (tokens.high > budget.maxTotalTokens)
    return `${tokens.low > budget.maxTotalTokens ? "does not fit the budget" : "low end fits the budget"}; high end exceeds the budget, consider extending to ${withMargin.toLocaleString("en-US")} tokens with margin`;
  return budget.fits === "yes" ? "fits the budget" : "may not fit the budget with margin";
}

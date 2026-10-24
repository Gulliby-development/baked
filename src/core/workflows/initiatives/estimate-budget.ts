/**
 * Finished features, of at least `MIN_HIGH_RATIO_INITIATIVES` initiatives, whose actual-to-low
 * ratio must be measured before the ratios bound the high end of a feature still to run. With fewer
 * the high end stays where the estimate's rules put it, often about twice the low end: R62 stepvet used 1.32x its
 * low end and R63 eolscope 1.05x, and the high end of about 2.04x said "exceeds the shared budget"
 * of a run that used 37% of the extension it prompted (#1982).
 */
export const MIN_HIGH_RATIO_SAMPLES = 6;
/**
 * How far finished features landed above the low end of their estimate, measured
 * leave-one-initiative-out: each finished feature is priced from the other initiatives' features
 * by the estimate's own rules (size class, path fit, path floor), as a feature still to run is.
 * This initiative's accepted features count against the low end the earlier initiatives gave them.
 */
export interface HighCalibration {
  /** Ratios measured, and the initiatives they come from. */
  samples: number;
  initiatives: number;
  /** The lowest, median and `HIGH_RATIO_QUANTILE` ratio of actual tokens to the low end. */
  low: number;
  median: number;
  high: number;
  /** The same ratios over whole initiatives: what their features used against their summed low ends. */
  total: { low: number; median: number; high: number };
}

/** The measured spread in words, for the budget text and the split warning. */
export function highCalibrationText(c: HighCalibration | null): string {
  return c
    ? `finished features used ${c.low.toFixed(2)}-${c.high.toFixed(2)}x their low end, median ${c.median.toFixed(2)}x, over ${c.samples} features of ${c.initiatives} initiatives, ${c.total.low.toFixed(2)}-${c.total.high.toFixed(2)}x per initiative`
    : `uncalibrated: fewer than ${MIN_HIGH_RATIO_SAMPLES} finished features measure how far actual tokens land above the low end`;
}

/** The expected value and the measured spread of the high end, when the caller knows them. */
export interface BudgetDetail {
  expectedTokens: number;
  /** How far finished features landed above their low end, in words (`highCalibrationText`). */
  spread: string;
}

/**
 * Budget wording shared by the estimate API, terminal UI and desktop renderer. With `detail` the
 * warning says what the estimate expects and where its high end comes from, so a high end that
 * exceeds the budget while the expected value fits it reads as the risk it is (#1982).
 */
export function estimateBudgetText(
  tokens: { low: number; high: number },
  budget: { maxTotalTokens: number; fits: "yes" | "maybe" | "no" },
  withMargin: number,
  detail?: BudgetDetail,
): string {
  const limit = budget.maxTotalTokens;
  if (tokens.high > limit) {
    const extend = `consider extending to ${withMargin.toLocaleString("en-US")} tokens with margin`;
    if (tokens.low > limit)
      return `does not fit the shared budget; high end exceeds the shared budget, ${extend}`;
    if (!detail)
      return `low end fits the shared budget; high end exceeds the shared budget, ${extend}`;
    const expected = `expected ${detail.expectedTokens.toLocaleString("en-US")} tokens ${detail.expectedTokens <= limit ? "fits" : "exceeds"} the shared budget`;
    return `low end fits the shared budget, ${expected}; high end exceeds the shared budget (${detail.spread}), ${extend}`;
  }
  return budget.fits === "yes"
    ? "fits the shared budget"
    : "may not fit the shared budget with margin";
}

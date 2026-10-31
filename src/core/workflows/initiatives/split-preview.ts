// The budget of a split awaiting approval (#2502), as the terminal app and the desktop app show it.
// Free of Node imports: the desktop renderer reads it too.

/**
 * What the split awaiting approval needs from the pool, read before approval (#2502): R79, R80 and
 * R81 picked a pool before approving from a guess, and the first share gate parked the first
 * feature seconds after approval. Display only: the share gate, `extendWithinDollars` and every
 * other decision read the approved split, never this preview.
 */
export interface SplitBudgetPreview {
  /** The plan revision the preview estimates. */
  planRevision: number;
  /** Each waiting feature's low, expected and high token estimate, by feature id. */
  lows: Record<string, number>;
  expected: Record<string, number>;
  high: Record<string, number>;
  sumLow: number;
  sumExpected: number;
  sumHigh: number;
  /** The shared token pool now. */
  limitTokens: number;
  /**
   * The pool the dollar cap pays for: used tokens plus what the dollars left buy at the estimate's
   * price for the waiting features (the measured price without one); null without a cap or price.
   */
  capTokens: number | null;
  usdPerMillion: number | null;
  /**
   * The share gate the first ready feature would meet right after approval at the current pool:
   * `park` when the gate would hold it, with its start share and its estimated need.
   */
  firstGate: {
    featureId: string;
    verdict: "pass" | "park";
    shareTokens: number | null;
    need: { low: number; high: number } | null;
    reason: string | null;
  } | null;
  /**
   * The pool to extend to before approving, the split approval's one amount (`splitExtension`,
   * #2525): the high end with margin, held to what the dollar cap pays for; null when the pool
   * covers the high end. The approval message and its `extend` remedy name the same amount.
   */
  suggestedTokens: number | null;
  /** The forecast notice's sentence with the one-line extend command; null without a suggestion. */
  notice: string | null;
}

/** A token count as the estimates write it (`tokenText`): 840k, 2.4M. */
const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

/**
 * The preview in one line, for the split approval of the TUI and the desktop app: the waiting
 * features' lows, expected and high tokens, what the dollar cap pays for, the first share gate at
 * the current pool and the pool to extend to.
 */
export function splitPreviewLine(preview: SplitBudgetPreview): string {
  const cap =
    preview.capTokens !== null
      ? `; the dollar cap pays for about ${tokens(preview.capTokens)}${preview.usdPerMillion !== null ? ` at $${preview.usdPerMillion.toFixed(2)} per million` : ""}`
      : "";
  const gate = preview.firstGate;
  const detail = gate
    ? [
        gate.shareTokens !== null ? `share ${tokens(gate.shareTokens)}` : "",
        gate.need ? `need ${tokens(gate.need.low)}-${tokens(gate.need.high)}` : "",
      ].filter(Boolean)
    : [];
  const first = gate
    ? ` At the ${tokens(preview.limitTokens)} pool the first share gate would ${gate.verdict === "park" ? "park" : "start"} ${gate.featureId}${detail.length ? ` (${detail.join(", ")})` : ""}.`
    : "";
  const extend =
    preview.suggestedTokens !== null
      ? ` Extend to ${tokens(preview.suggestedTokens)} before approving.`
      : "";
  return `Budget before approval: lows ${tokens(preview.sumLow)}, expected ${tokens(preview.sumExpected)}, high ${tokens(preview.sumHigh)}${cap}.${first}${extend}`;
}

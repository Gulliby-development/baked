/** Recovery data and helpers shared with the desktop renderer, without runtime dependencies. */
export const REMEDY_ACTIONS = [
  "resume",
  "repair",
  "extend",
  "accept-workspace",
  "reroute",
  "revise",
  "replan",
  "deliver",
  "recover",
  "fork",
  "cancel",
  "pause",
] as const;

export interface Remedy {
  action: (typeof REMEDY_ACTIONS)[number];
  runId?: string;
  initiativeId?: string;
  featureId?: string;
  setting?: string;
  /** For `extend`: the token limit that answers the block, so one command or click applies it. */
  suggestedTokens?: number;
  /** For `extend`: the dollar cap that answers the block. */
  suggestedUsd?: number;
}

export interface RecoveryAdvice {
  message: string;
  summary: string;
  remedies: Remedy[];
}

export function recoveryAdvice(
  message: string,
  summary: string,
  ...remedies: Remedy[]
): RecoveryAdvice {
  return { message, summary, remedies };
}

/**
 * The amounts an `extend` answer suggests (#2042): those on the block's remedy, else the token
 * forecast's suggested pool. Null when nothing names an amount. Front ends prefill their extend
 * form with it, so the answer is one command or one click.
 */
export function extendSuggestion(
  advice: RecoveryAdvice | null | undefined,
  poolSuggested?: number | null,
): { tokens?: number; usd?: number } | null {
  const remedy = advice?.remedies.find(
    (r) => r.action === "extend" && (r.suggestedTokens || r.suggestedUsd),
  );
  if (remedy)
    return {
      ...(remedy.suggestedTokens ? { tokens: remedy.suggestedTokens } : {}),
      ...(remedy.suggestedUsd ? { usd: remedy.suggestedUsd } : {}),
    };
  return poolSuggested ? { tokens: poolSuggested } : null;
}

/** A suggested amount in words, for a remedy label: "33.1M tokens", "$31.50", or both. */
export function suggestionText(suggestion: { tokens?: number; usd?: number } | null): string {
  if (!suggestion) return "";
  return [
    ...(suggestion.tokens ? [`${(suggestion.tokens / 1_000_000).toFixed(1)}M tokens`] : []),
    ...(suggestion.usd ? [`$${suggestion.usd.toFixed(2)}`] : []),
  ].join(" and ");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate untrusted API or stored data and keep only the recovery fields. */
export function recoveryOf(value: unknown): RecoveryAdvice | undefined {
  if (
    !record(value) ||
    typeof value.message !== "string" ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.remedies)
  ) {
    return undefined;
  }
  const remedies: Remedy[] = [];
  for (const entry of value.remedies) {
    if (!record(entry)) return undefined;
    const action = REMEDY_ACTIONS.find((action) => action === entry.action);
    if (!action) return undefined;
    const remedy: Remedy = { action };
    for (const key of ["runId", "initiativeId", "featureId", "setting"] as const) {
      const field = entry[key];
      if (field !== undefined && typeof field !== "string") return undefined;
      if (key in entry) remedy[key] = field;
    }
    for (const key of ["suggestedTokens", "suggestedUsd"] as const) {
      const field = entry[key];
      if (field === undefined) continue;
      if (typeof field !== "number" || !Number.isFinite(field) || field <= 0) return undefined;
      remedy[key] = field;
    }
    remedies.push(remedy);
  }
  return { message: value.message, summary: value.summary, remedies };
}

export function errorRecovery(error: unknown): RecoveryAdvice | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) return undefined;
  const details = error.details;
  return details && typeof details === "object" && "recovery" in details
    ? recoveryOf(details.recovery)
    : undefined;
}

export function renderRecovery(
  message: string,
  advice: RecoveryAdvice | null | undefined,
  label: (remedy: Remedy) => string,
): string {
  if (!advice) return message;
  const actions = advice.remedies.map(label).join("; ");
  return actions ? `${advice.summary} ${actions}.` : advice.summary;
}

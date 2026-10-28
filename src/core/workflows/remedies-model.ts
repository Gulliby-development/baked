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
  // A person's answer to a blocked corrective's unowned file (#2155): one act each, as the host
  // applies it when `corrective_unowned_file` is enforced.
  "route",
  "widen",
  "upstream",
  // A person's acceptance of a required check that cannot run (#2358): its timeouts become a
  // known limitation of the run instead of a stop. Never applied by the host.
  "accept-limitation",
] as const;

/** The remedies that answer a corrective's block on files it may not write (#2155). */
export const HOST_REMEDIES = ["route", "widen", "upstream"] as const;
export type HostRemedy = (typeof HOST_REMEDIES)[number];

/** The remedies `resume --remedy` takes: a corrective's host decisions and a check's limitation. */
export const RESUME_REMEDIES = [...HOST_REMEDIES, "accept-limitation"] as const;
export type ResumeRemedy = (typeof RESUME_REMEDIES)[number];

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
  /** For `extend`: the active-time limit in ms that answers the block (#2336). */
  suggestedTimeMs?: number;
  /** For `extend`: the shared agent-calls limit that answers the block (#2345). */
  suggestedCalls?: number;
  /** For `accept-limitation`: the required check whose timeouts the run would accept. */
  checkId?: string;
  /** For `route`, `widen` and `upstream`: the blocked corrective. */
  taskId?: string;
  /** For `route`, `widen` and `upstream`: the files the corrective may not write. */
  paths?: string[];
  /** For `route`: the task that wrote them; for `upstream`: the feature that owns them. */
  owner?: string;
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
 * The amounts an `extend` answer suggests: a token pool, a dollar cap, an active time in ms, a
 * shared agent-calls limit.
 */
export interface ExtendAmounts {
  tokens?: number;
  usd?: number;
  timeMs?: number;
  calls?: number;
}

/**
 * The amounts an `extend` answer suggests (#2042): those on the block's remedy, else the token
 * forecast's suggested pool, the time forecast's suggested time (#2336) and the calls forecast's
 * suggested limit (#2345). Null when nothing names an amount. Front ends prefill their extend
 * form with it, so the answer is one command or one click.
 */
export function extendSuggestion(
  advice: RecoveryAdvice | null | undefined,
  poolSuggested?: number | null,
  timeSuggested?: number | null,
  callsSuggested?: number | null,
): ExtendAmounts | null {
  const remedy = advice?.remedies.find(
    (r) =>
      r.action === "extend" &&
      (r.suggestedTokens || r.suggestedUsd || r.suggestedTimeMs || r.suggestedCalls),
  );
  if (remedy)
    return {
      ...(remedy.suggestedTokens ? { tokens: remedy.suggestedTokens } : {}),
      ...(remedy.suggestedUsd ? { usd: remedy.suggestedUsd } : {}),
      ...(remedy.suggestedTimeMs ? { timeMs: remedy.suggestedTimeMs } : {}),
      ...(remedy.suggestedCalls ? { calls: remedy.suggestedCalls } : {}),
    };
  if (!poolSuggested && !timeSuggested && !callsSuggested) return null;
  return {
    ...(poolSuggested ? { tokens: poolSuggested } : {}),
    ...(timeSuggested ? { timeMs: timeSuggested } : {}),
    ...(callsSuggested ? { calls: callsSuggested } : {}),
  };
}

/**
 * A suggested amount in words, for a remedy label: "33.1M tokens", "$31.50", "540 min",
 * "600 calls" or several.
 */
export function suggestionText(suggestion: ExtendAmounts | null): string {
  if (!suggestion) return "";
  return [
    ...(suggestion.tokens ? [`${(suggestion.tokens / 1_000_000).toFixed(1)}M tokens`] : []),
    ...(suggestion.usd ? [`$${suggestion.usd.toFixed(2)}`] : []),
    ...(suggestion.timeMs ? [`${Math.round(suggestion.timeMs / 60_000)} min`] : []),
    ...(suggestion.calls ? [`${suggestion.calls} calls`] : []),
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
    for (const key of [
      "runId",
      "initiativeId",
      "featureId",
      "setting",
      "taskId",
      "owner",
      "checkId",
    ] as const) {
      const field = entry[key];
      if (field !== undefined && typeof field !== "string") return undefined;
      if (key in entry) remedy[key] = field;
    }
    for (const key of [
      "suggestedTokens",
      "suggestedUsd",
      "suggestedTimeMs",
      "suggestedCalls",
    ] as const) {
      const field = entry[key];
      if (field === undefined) continue;
      if (typeof field !== "number" || !Number.isFinite(field) || field <= 0) return undefined;
      remedy[key] = field;
    }
    if (entry.paths !== undefined) {
      if (!Array.isArray(entry.paths) || !entry.paths.every((p) => typeof p === "string"))
        return undefined;
      remedy.paths = [...entry.paths];
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

/**
 * A blocked `invalid_output` stop whose advice offers no plain resume: the repeat guard would
 * refuse one (`repeatsInvalidOutput`), so the run views offer a switch of the model instead of a
 * retry (#2201).
 */
export function retryRefused(
  run: { status: string; reason?: string | null },
  advice: RecoveryAdvice | null | undefined,
): boolean {
  return (
    run.status === "blocked" &&
    run.reason === "invalid_output" &&
    !!advice?.remedies.length &&
    !advice.remedies.some((remedy) => remedy.action === "resume")
  );
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

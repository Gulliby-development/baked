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

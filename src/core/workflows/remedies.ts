import { z } from "zod";

/** Recovery intent travels with the legacy CLI message; clients choose their own labels. */
export const RemedySchema = z.object({
  action: z.enum([
    "resume",
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
  ]),
  runId: z.string().optional(),
  initiativeId: z.string().optional(),
  featureId: z.string().optional(),
  setting: z.string().optional(),
});
export type Remedy = z.infer<typeof RemedySchema>;
export const RecoveryAdviceSchema = z.object({
  message: z.string(),
  summary: z.string(),
  remedies: z.array(RemedySchema),
});
export type RecoveryAdvice = z.infer<typeof RecoveryAdviceSchema>;

export function recoveryAdvice(
  message: string,
  summary: string,
  ...remedies: Remedy[]
): RecoveryAdvice {
  return { message, summary, remedies };
}

export function recoveryOf(value: unknown): RecoveryAdvice | undefined {
  const parsed = RecoveryAdviceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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

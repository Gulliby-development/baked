import { z } from "zod";
import { REMEDY_ACTIONS, type RecoveryAdvice, type Remedy } from "./remedies-model.js";

export {
  errorRecovery,
  type RecoveryAdvice,
  type Remedy,
  recoveryAdvice,
  recoveryOf,
  renderRecovery,
} from "./remedies-model.js";

/** Recovery intent travels with the legacy CLI message; clients choose their own labels. */
export const RemedySchema = z.object({
  action: z.enum(REMEDY_ACTIONS),
  runId: z.string().optional(),
  initiativeId: z.string().optional(),
  featureId: z.string().optional(),
  setting: z.string().optional(),
}) satisfies z.ZodType<Remedy>;

export const RecoveryAdviceSchema = z.object({
  message: z.string(),
  summary: z.string(),
  remedies: z.array(RemedySchema),
}) satisfies z.ZodType<RecoveryAdvice>;

import { z } from "zod";
import type { HostEdit } from "./host-edits-model.js";

export type { HostEdit } from "./host-edits-model.js";

export const HostEditSchema = z.object({
  task: z.string().nullable(),
  field: z.string(),
  kind: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  text: z.string(),
}) satisfies z.ZodType<HostEdit>;

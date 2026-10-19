import { z } from "zod";

export const HostEditSchema = z.object({
  task: z.string().nullable(),
  field: z.string(),
  kind: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  text: z.string(),
});
export type HostEdit = z.infer<typeof HostEditSchema>;

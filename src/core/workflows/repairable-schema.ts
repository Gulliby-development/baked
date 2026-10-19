import { z } from "zod";
import type { RepairBlock } from "./repairable.js";

/** Backend validation, separate from the dependency-free helpers desktop imports. */
export const RepairBlockSchema = z
  .object({
    limit: z.enum([
      "maxTaskRepairs",
      "maxRepairRounds",
      "maxCorrectiveTasks",
      "maxIterations",
      "maxStageVisits",
      "freshRestart",
    ]),
    scope: z.enum(["task", "round", "review", "convergence", "transition", "run"]),
    required: z.number().int().positive(),
    taskIds: z.array(z.string()).default([]),
    transitionId: z.string().optional(),
  })
  .strict()
  .refine(
    (block) =>
      block.limit !== "maxTaskRepairs" || (block.scope === "task" && block.taskIds.length > 0),
  )
  .refine(
    (block) =>
      block.limit !== "maxIterations" ||
      (block.scope === "transition" && Boolean(block.transitionId)),
  )
  .refine(
    (block) =>
      block.limit !== "maxRepairRounds" || block.scope === "round" || block.scope === "review",
  ) satisfies z.ZodType<RepairBlock>;

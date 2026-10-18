import { z } from "zod";

/** The refused operation, recorded with the diagnostic that stopped this run. */
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
  );
export type RepairBlock = z.infer<typeof RepairBlockSchema>;

/** Shared by the service, run controls and initiative feature controls. */
interface RepairCandidate {
  status: string;
  reason?: string;
  repairBlock?: RepairBlock | undefined;
  pendingRequestIds?: readonly string[];
}

export function canRepairRun(
  run: RepairCandidate,
): run is RepairCandidate & { repairBlock: RepairBlock } {
  return (
    run.status === "blocked" &&
    run.reason === "no_progress" &&
    !run.pendingRequestIds?.length &&
    RepairBlockSchema.safeParse(run.repairBlock).success
  );
}

export function repairText(block: RepairBlock): string {
  return block.limit === "freshRestart"
    ? "The same findings repeated after a clean-context restart. Another repair may repeat them again."
    : `The run reached ${block.limit} (${block.scope}). One more repair allows the refused operation.`;
}

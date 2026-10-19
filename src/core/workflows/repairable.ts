/** The refused operation, recorded with the diagnostic that stopped this run. */
export interface RepairBlock {
  limit:
    | "maxTaskRepairs"
    | "maxRepairRounds"
    | "maxCorrectiveTasks"
    | "maxIterations"
    | "maxStageVisits"
    | "freshRestart";
  scope: "task" | "round" | "review" | "convergence" | "transition" | "run";
  required: number;
  taskIds: string[];
  transitionId?: string | undefined;
}

/** Shared by the service, run controls and initiative feature controls. */
interface RepairCandidate {
  status: string;
  reason?: string;
  /** The store validates the diagnostic before exposing it in a run snapshot. */
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
    run.repairBlock !== undefined
  );
}

export function repairText(block: RepairBlock): string {
  return block.limit === "freshRestart"
    ? "The same findings repeated after a clean-context restart. Another repair may repeat them again."
    : `The run reached ${block.limit} (${block.scope}). One more repair allows the refused operation.`;
}

import { WorkflowFault } from "../workflows/errors.js";
import type { WorkflowStore } from "../workflows/store.js";
export function validateEvidence(
  store: WorkflowStore,
  runId: string,
  snapshotId: string,
  ids: string[],
  required = true,
): void {
  if (required && ids.length === 0)
    throw new WorkflowFault("OUTPUT_INVALID", "A conclusion requires host evidence");
  const evidence = store.evidence(runId);
  for (const id of ids) {
    const entry = evidence.find((e) => e.id === id);
    if (!entry || entry.snapshot_id !== snapshotId || entry.validity !== "current")
      throw new WorkflowFault("OUTPUT_INVALID", `Unknown or stale evidence ${id}`);
    store.readArtifact(runId, entry.artifact_id);
  }
}

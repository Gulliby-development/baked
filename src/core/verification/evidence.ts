import { WorkflowFault } from "../workflows/errors.js";
import type { EvidenceRow, WorkflowStore } from "../workflows/store.js";

/** Characters of an evidence id a reference must share before the host resolves it. */
const MIN_PREFIX = 8;

/** Evidence of the snapshot that can still be cited, in the order the host numbered it. */
export function currentEvidence(
  store: WorkflowStore,
  runId: string,
  snapshotId: string,
): EvidenceRow[] {
  return store
    .evidence(runId)
    .filter((e) => e.snapshot_id === snapshotId && e.validity === "current");
}

/** The short handle of the nth current evidence entry: E1, E2, ... */
export const evidenceHandle = (index: number): string => `E${String(index + 1)}`;

/**
 * The evidence id a reference names: the id itself, a handle (E1..En) or an id that is
 * unambiguous by its first characters, the way a copy with a mistyped tail still is. A reference
 * that names nothing, or more than one entry, is returned unchanged for the validator to reject.
 */
export function resolveEvidenceId(offered: readonly EvidenceRow[], reference: string): string {
  // The same row can be offered twice (the run and worktree snapshots of an attempt that changed
  // nothing); it is still one entry, or the prefix repair below sees two (expenses-py T010, #1032).
  const current = [...new Map(offered.map((e) => [e.id, e])).values()];
  const id = reference.trim();
  if (current.some((e) => e.id === id)) return id;
  const handle = /^E(\d+)$/i.exec(id);
  if (handle) return current[Number(handle[1]) - 1]?.id ?? reference;
  if (id.length < MIN_PREFIX) return reference;
  const lower = id.toLowerCase();
  const exact = current.filter((e) => e.id.toLowerCase().startsWith(lower));
  if (exact.length === 1 && exact[0]) return exact[0].id;
  if (exact.length > 1) return reference;
  const head = lower.slice(0, MIN_PREFIX);
  const near = current.filter((e) => e.id.toLowerCase().startsWith(head));
  return near.length === 1 && near[0] ? near[0].id : reference;
}

export const resolveEvidenceIds = (current: readonly EvidenceRow[], ids: string[]): string[] => [
  ...new Set(ids.map((id) => resolveEvidenceId(current, id))),
];

/** A line for a correction message: the ids and handles a result may cite. */
export function validEvidenceNote(current: readonly EvidenceRow[]): string {
  return current.length
    ? `Valid evidence ids (handle=id): ${current.map((e, i) => `${evidenceHandle(i)}=${e.id}`).join(", ")}.`
    : "There is no current evidence for this snapshot.";
}

/** Each cited id must be current evidence of the snapshot, or of one of the snapshots, given. */
export function validateEvidence(
  store: WorkflowStore,
  runId: string,
  snapshotId: string | readonly string[],
  ids: string[],
  required = true,
): void {
  if (required && ids.length === 0)
    throw new WorkflowFault("OUTPUT_INVALID", "A conclusion requires host evidence");
  const evidence = store.evidence(runId);
  const snapshots: readonly string[] = typeof snapshotId === "string" ? [snapshotId] : snapshotId;
  for (const id of ids) {
    const entry = evidence.find((e) => e.id === id);
    if (!entry || !snapshots.includes(entry.snapshot_id) || entry.validity !== "current")
      throw new WorkflowFault("OUTPUT_INVALID", `Unknown or stale evidence ${id}`);
    store.readArtifact(runId, entry.artifact_id);
  }
}

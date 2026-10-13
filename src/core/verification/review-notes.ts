import type { Review } from "../workflows/schemas.js";
import type { ReviewNote } from "../workflows/types.js";

type ReviewFinding = Review["findings"][number];

const noteKey = (n: Pick<ReviewNote, "kind" | "file" | "symbol">): string =>
  JSON.stringify([n.kind, n.file, n.symbol]);

/**
 * Keeps review and convergence findings that start no correction as notes, so the run report shows
 * them instead of losing them (commitbump dde8747e: an inferred language finding raised in two
 * rounds reached neither the findings table nor the report). A note repeats the latest earlier note
 * on the same kind, file and symbol from another snapshot: a re-raised claim comes back renumbered
 * and reworded, so neither the id nor the wording matches. A finding already noted for the same
 * snapshot (a resumed stage) is not added again.
 */
export function addReviewNotes(
  notes: ReviewNote[],
  source: string,
  snapshotId: string | null,
  findings: { finding: ReviewFinding; reason: ReviewNote["reason"] }[],
): void {
  for (const { finding, reason } of findings) {
    if (
      notes.some(
        (n) => n.source === source && n.findingId === finding.id && n.snapshotId === snapshotId,
      )
    )
      continue;
    const note: ReviewNote = {
      findingId: finding.id,
      source,
      severity: finding.severity,
      kind: finding.kind,
      basis: finding.basis ?? null,
      file: finding.file,
      symbol: finding.symbol,
      claim: finding.claim,
      reason,
      repeatOf: null,
      snapshotId,
    };
    const earlier = notes.findLast(
      (n) => n.snapshotId !== snapshotId && noteKey(n) === noteKey(note),
    );
    note.repeatOf = earlier?.findingId ?? null;
    notes.push(note);
  }
}

/** Why a finding the host does not repair starts no correction, for its note. */
export function noteReason(
  finding: ReviewFinding,
  blocks: boolean,
  severities: readonly string[],
): ReviewNote["reason"] {
  if (!blocks) return "inferred";
  if (!severities.includes(finding.severity)) return "severity";
  return "repro";
}

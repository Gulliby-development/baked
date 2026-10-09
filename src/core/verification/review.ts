import { workspacePath } from "../specs/validate.js";
import { WorkflowFault } from "../workflows/errors.js";
import type { Review, Spec } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import { validateEvidence } from "./evidence.js";
export function validateReview(
  store: WorkflowStore,
  runId: string,
  snapshotId: string,
  hash: string,
  spec: Spec,
  review: Review,
  completeCoverage: boolean,
): void {
  if (review.snapshotHash !== hash)
    throw new WorkflowFault("OUTPUT_INVALID", "Review refers to a different snapshot");
  if (review.verdict === "changes_requested" && review.findings.length === 0)
    throw new WorkflowFault("OUTPUT_INVALID", "Changes requested without an actionable finding");
  if (review.verdict === "pass" && review.coverage.some((c) => c.verdict === "fail"))
    throw new WorkflowFault(
      "OUTPUT_INVALID",
      "Passing review contradicts failed criterion coverage",
    );
  const seen = new Set<string>();
  for (const item of review.coverage) {
    if (seen.has(item.criterionId) || !spec.criteria.some((c) => c.id === item.criterionId))
      throw new WorkflowFault("OUTPUT_INVALID", `Invalid criterion ${item.criterionId}`);
    seen.add(item.criterionId);
    validateEvidence(
      store,
      runId,
      snapshotId,
      item.evidenceIds,
      item.verdict === "pass" || item.verdict === "fail",
    );
  }
  if (completeCoverage && spec.criteria.some((c) => !seen.has(c.id)))
    throw new WorkflowFault("OUTPUT_INVALID", "Convergence omitted criteria");
  for (const finding of review.findings) {
    if (finding.file) workspacePath(store.workspace, finding.file);
    if (
      finding.requirementIds.some((id) => !spec.requirements.some((r) => r.id === id)) ||
      finding.criterionIds.some((id) => !spec.criteria.some((c) => c.id === id))
    )
      throw new WorkflowFault("OUTPUT_INVALID", "Finding has unknown requirement/criterion IDs");
    validateEvidence(store, runId, snapshotId, finding.evidenceIds);
  }
}

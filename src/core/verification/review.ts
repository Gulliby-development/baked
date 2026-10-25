import { workspacePath } from "../specs/validate.js";
import { WorkflowFault } from "../workflows/errors.js";
import type { Review, Spec } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import {
  currentEvidence,
  resolveEvidenceIds,
  validateEvidence,
  validEvidenceNote,
} from "./evidence.js";
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

/** The coverage the converge stage writes for a criterion the reviewer left out and the host settles. */
export const OMITTED_DEFERRED = {
  manual:
    "Deferred: omitted from the convergence report; a person provides the evidence for this manual criterion",
  "post-release":
    "Deferred: omitted from the convergence report; post-release evidence, settled by the host",
} as const;

/**
 * Whether the host settles a criterion a convergence report left out, so the omission requests no
 * change: a manual criterion (a person answers it after convergence) and a post-release criterion
 * the approval deferred. An omitted automated criterion, or a post-release one the approval did
 * not defer, stays the reviewer's to cover (#2190).
 */
export function hostSettledOmission(
  criterion: Spec["criteria"][number],
  deferredCriteria: readonly string[],
): boolean {
  if (criterion.method === "manual") return true;
  return criterion.method === "post-release" && deferredCriteria.includes(criterion.id);
}

/**
 * Replaces what the host knows and the model copied: the snapshot hash is set, evidence
 * references (handles, ids with a mistyped tail) become ids of the snapshot's current evidence,
 * and criteria the review does not mention are listed as inconclusive, so the review is judged on
 * what it says. Mutates the review; running it again changes nothing.
 */
export function completeReview(
  store: WorkflowStore,
  runId: string,
  snapshotId: string,
  hash: string,
  spec: Spec,
  review: Review,
  pad = true,
): void {
  review.snapshotHash = hash;
  const current = currentEvidence(store, runId, snapshotId);
  const resolve = (ids: string[]) => resolveEvidenceIds(current, ids);
  for (const item of review.coverage) item.evidenceIds = resolve(item.evidenceIds);
  for (const finding of review.findings) finding.evidenceIds = resolve(finding.evidenceIds);
  if (!pad) return;
  for (const criterion of spec.criteria) {
    const item = review.coverage.find((c) => c.criterionId === criterion.id);
    if (criterion.method === "manual") {
      // A manual criterion has no evidence before work finishes, so the required reviewer neither
      // passes nor fails it; the converge stage asks a person for the evidence.
      if (!item)
        review.coverage.push({
          criterionId: criterion.id,
          verdict: "deferred",
          evidenceIds: [],
          explanation: "A person provides the evidence for this manual criterion",
        });
      else if (item.verdict === "inconclusive") item.verdict = "deferred";
    } else if (!item)
      review.coverage.push({
        criterionId: criterion.id,
        verdict: "inconclusive",
        evidenceIds: [],
        explanation: "Criterion not covered by this review",
      });
  }
  // An inconclusive verdict caused only by manual criteria is the reviewer's pass over the rest.
  if (
    review.verdict === "inconclusive" &&
    review.coverage.some((c) => c.verdict === "deferred") &&
    review.coverage.every((c) => c.verdict === "pass" || c.verdict === "deferred")
  )
    review.verdict = review.findings.length ? "changes_requested" : "pass";
}

/** Criteria a review marks `fail` that none of its findings names (#1143). */
export function unnamedFailures(review: Pick<Review, "coverage" | "findings">): string[] {
  return review.coverage
    .filter(
      (c) =>
        c.verdict === "fail" &&
        !review.findings.some((f) => f.criterionIds.includes(c.criterionId)),
    )
    .map((c) => c.criterionId);
}

/** The correction for a review that fails criteria without a finding that names them. */
export function unnamedFailureAdvice(criterionIds: readonly string[]): string {
  return `Criteria ${criterionIds.join(", ")} have the verdict fail, but no finding names them, so nothing can repair them. For each, add a finding whose criterionIds include it, with the file and the claim your explanation gives; or change the verdict to pass when the criterion is met, or to inconclusive when this environment cannot establish it. Then call submit_result again with the complete review.`;
}

/** What `validateReview` rejects, as correction messages for the agent that submitted it. */
export function reviewProblems(
  store: WorkflowStore,
  runId: string,
  snapshotId: string,
  hash: string,
  spec: Spec,
  review: Review,
  pad = true,
): string[] {
  completeReview(store, runId, snapshotId, hash, spec, review, pad);
  try {
    validateReview(store, runId, snapshotId, hash, spec, review, false);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      /evidence/i.test(message)
        ? `${message}. ${validEvidenceNote(currentEvidence(store, runId, snapshotId))}`
        : message,
    ];
  }
}

import { hashJson } from "../specs/hash.js";
import { DEFAULT_REVIEW_MIN_CONFIDENCE, type Review } from "../workflows/schemas.js";
export function fingerprint(finding: Review["findings"][number]): string {
  return hashJson({
    kind: finding.kind,
    file: finding.file,
    symbol: finding.symbol,
    requirements: [...finding.requirementIds].sort(),
    criteria: [...finding.criterionIds].sort(),
    claim: finding.claim.trim().replace(/\s+/g, " ").toLowerCase(),
  });
}
/**
 * Whether a review or convergence finding may start a correction. An edge case of a standard or
 * convention the spec does not name stays a note: run de6cf1ab spent every repair round on ISO 8601
 * forms a link shortener never needed. Security findings and critical ones still block. A finding
 * the reviewer is not confident about (below `minConfidence`) is a note whatever its kind: a
 * reviewer asked for gaps always finds some (#635), unless `reproduced`: the host ran its repro and
 * it showed the claim (#1210).
 */
export function findingBlocks(
  finding: Review["findings"][number],
  minConfidence = DEFAULT_REVIEW_MIN_CONFIDENCE,
  reproduced = false,
): boolean {
  if (!reproduced && (finding.confidence ?? 1) < minConfidence) return false;
  return (
    finding.basis !== "inferred" || finding.kind === "security" || finding.severity === "critical"
  );
}
/**
 * Whether a finding is a note only for its confidence while a repro could still show it: a missing
 * or correctness claim on behavior the request or spec names. bytelens efe010c4 shipped accepting
 * `struct u8` although the request says `invalid name "X"` applies also to type names; convergence
 * raised it at medium with low confidence and no repro, and it ended a note (#1210).
 */
export function confidenceOnlyNote(
  finding: Review["findings"][number],
  minConfidence = DEFAULT_REVIEW_MIN_CONFIDENCE,
): boolean {
  return (
    (finding.confidence ?? 1) < minConfidence &&
    (finding.kind === "missing" || finding.kind === "correctness") &&
    finding.basis !== "inferred" &&
    findingBlocks(finding, minConfidence, true)
  );
}
export function requiresSecurityReview(paths: string[], forced: boolean): boolean {
  return (
    forced ||
    paths.some((p) =>
      /(^|\/)(auth|security|permissions?|secrets?|api|routes?|tools|providers|config)(\/|\.)|package\.json|lock$|migration/i.test(
        p,
      ),
    )
  );
}

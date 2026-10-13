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
 * reviewer asked for gaps always finds some (#635).
 */
export function findingBlocks(
  finding: Review["findings"][number],
  minConfidence = DEFAULT_REVIEW_MIN_CONFIDENCE,
): boolean {
  if ((finding.confidence ?? 1) < minConfidence) return false;
  return (
    finding.basis !== "inferred" || finding.kind === "security" || finding.severity === "critical"
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

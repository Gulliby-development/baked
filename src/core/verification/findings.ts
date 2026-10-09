import { hashJson } from "../specs/hash.js";
import type { Review } from "../workflows/schemas.js";
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

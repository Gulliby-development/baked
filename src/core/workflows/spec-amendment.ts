import type { Review, Spec } from "./schemas.js";
import { isTestPath } from "./test-integrity.js";

/**
 * A review finding whose defect is in the spec, not the code (#1034). The approved spec or plan
 * asks for something the request rules out, and the finding says to change that criterion, the
 * plan or a task (pngvet a2da6c24: AC-003 asked for 100 generated cases with a seed, the request
 * said "no random generators"). A corrective task cannot write `spec.json`, so it changes the
 * tests to follow the request; the test-integrity guard then read the dropped generated tests as
 * gaming and its own corrective restored them, which was the contradiction again, until the run
 * ended `no_progress` after 1.19M tokens of correctives.
 *
 * Such a finding records an amendment: the request wins over the criteria it names, every later
 * agent reads that next to the request, and the guard accepts the tests the correction changes.
 */
export interface SpecAmendment {
  findingId: string;
  criterionIds: string[];
  requirementIds: string[];
  /** Test files the finding names: the correction may drop the tests that served the wording. */
  paths: string[];
  claim: string;
  suggestedFix: string;
}

/** The finding sets the spec against what the request (the brief) states. */
const REQUEST = /\b(?:request|brief)(?:'s)?\b/i;
/** The fix changes a document of the approved package, not only the code. */
const SPEC_CHANGE =
  /\b(?:remove|drop|delete|change|amend|reword|rewrite|revise|update|replace)\b[^.]*?\b(?:from|in|of)\s+(?:the\s+)?(?:approved\s+)?(?:spec(?:\.json)?|plan(?:\.md)?|tasks\.json|(?:AC|FR)-\d+|criteri(?:on|a)|requirements?)\b/i;

/** The amendment a review finding records, or null when the code, not the spec, is at fault. */
export function specAmendmentOf(
  finding: Review["findings"][number],
  spec: Pick<Spec, "criteria" | "requirements">,
): SpecAmendment | null {
  if (finding.kind !== "contradicts") return null;
  const text = `${finding.claim}\n${finding.suggestedFix}`;
  if (!REQUEST.test(text) || !SPEC_CHANGE.test(finding.suggestedFix)) return null;
  const named = (id: string) => new RegExp(`\\b${id}\\b`).test(text);
  const criterionIds = [
    ...new Set([...finding.criterionIds, ...spec.criteria.map((c) => c.id).filter(named)]),
  ];
  const requirementIds = [
    ...new Set([...finding.requirementIds, ...spec.requirements.map((r) => r.id).filter(named)]),
  ];
  return {
    findingId: finding.id,
    criterionIds,
    requirementIds,
    paths: finding.file && isTestPath(finding.file) ? [finding.file] : [],
    claim: finding.claim,
    suggestedFix: finding.suggestedFix,
  };
}

/** The line every later agent reads with the request. */
export function amendmentNote(path: string, amendment: SpecAmendment): string {
  const ids = [...amendment.criterionIds, ...amendment.requirementIds];
  const scope = ids.length ? ids.join(", ") : "the spec, the plan and the tasks";
  return `Spec amendment (${path}): a review found that the approved spec contradicts the request: ${amendment.claim.slice(0, 1000)} The request is authoritative over ${scope}: read them as the request states (${amendment.suggestedFix.slice(0, 600)}). Code and tests follow the request; a test that only served the contradicting wording is changed or removed, and that is not a weakened test. Reviews and convergence judge ${scope} by what the request states and do not raise the contradicting wording again.`;
}

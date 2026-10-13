import { describesProgram } from "./coverage.js";
import type { Spec } from "./schemas.js";

/**
 * Request coverage: every deliverable the request names maps to requirements or to an exclusion
 * the request itself states. envguard 45495079 put the CLI the request asked for in outOfScope
 * ("the request is to build the envguard CLI itself"), and the gap surfaced only when a person
 * rejected the approval. The spec author lists the deliverables with a quote from the request;
 * the host checks the quotes, the mapping and every exclusion against the request text.
 */

/** One row of the coverage table on the approval view. */
export interface DeliverableCoverage {
  /** The request's own words for the deliverable. */
  deliverable: string;
  requirementIds: string[];
  criterionIds: string[];
  /** The request's words that leave it out, when it is excluded. */
  outOfScope: string | null;
  /** Whether it maps to a requirement, or to an exclusion the request states. */
  mapped: boolean;
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Whether `quote` is a passage of the request, ignoring case, quotes and whitespace. */
export function quotesRequest(quote: string, request: string): boolean {
  const passage = normalize(quote).replace(/^[.,;: ]+|[.,;: ]+$/g, "");
  return passage.length > 0 && normalize(request).includes(passage);
}

/** The coverage table of a spec's deliverables, checked against the request. */
export function requestCoverage(spec: Spec, request: string): DeliverableCoverage[] {
  const requirements = new Set(spec.requirements.map((r) => r.id));
  return (spec.deliverables ?? []).map((d) => {
    const requirementIds = d.requirementIds.filter((id) => requirements.has(id));
    const excluded = d.outOfScope !== undefined && quotesRequest(d.outOfScope, request);
    return {
      deliverable: d.quote,
      requirementIds,
      criterionIds: spec.criteria
        .filter((c) => c.requirementIds.some((id) => requirementIds.includes(id)))
        .map((c) => c.id),
      outOfScope: d.outOfScope ?? null,
      mapped:
        quotesRequest(d.quote, request) &&
        (requirementIds.length > 0 ? d.outOfScope === undefined : excluded),
    };
  });
}

/** Deliverables a spec leaves unmapped; auto approval declines while any remain. */
export function unmappedDeliverables(spec: Spec, request: string): string[] {
  if (!request.trim()) return [];
  if (!spec.deliverables?.length)
    return describesProgram(request) ? ["the spec lists no deliverables of the request"] : [];
  return requestCoverage(spec, request)
    .filter((row) => !row.mapped)
    .map((row) => row.deliverable);
}

/** The deliverable defects as corrections for the spec author at submission. */
export function deliverableProblems(spec: Spec, request: string): string[] {
  if (!request.trim()) return [];
  if (!spec.deliverables?.length)
    return describesProgram(request)
      ? [
          "deliverables is empty: list every deliverable the request names or describes as the product (a CLI, an API, a library, tests, documentation), each with a quote copied verbatim from the request and the requirementIds that cover it.",
        ]
      : [];
  const requirements = new Set(spec.requirements.map((r) => r.id));
  const problems: string[] = [];
  for (const d of spec.deliverables) {
    if (!quotesRequest(d.quote, request))
      problems.push(
        `deliverable "${d.quote}" is not a passage of the request: copy the request's own words for it.`,
      );
    for (const id of d.requirementIds)
      if (!requirements.has(id))
        problems.push(`deliverable "${d.quote}" names unknown requirement ${id}.`);
    if (d.outOfScope !== undefined) {
      if (d.requirementIds.length)
        problems.push(
          `deliverable "${d.quote}" has requirements and an outOfScope quote: keep one of them.`,
        );
      else if (!quotesRequest(d.outOfScope, request))
        problems.push(
          `deliverable "${d.quote}" is out of scope, but "${d.outOfScope}" is not a passage of the request. Only the request can leave out what it names: quote the request's words that exclude or defer it, or cover it with requirements.`,
        );
    } else if (!d.requirementIds.length)
      problems.push(
        `deliverable "${d.quote}" maps to no requirement: cover it with requirements and criteria, or quote the request's words that leave it out in outOfScope.`,
      );
  }
  return problems;
}

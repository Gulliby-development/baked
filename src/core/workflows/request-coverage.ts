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

// A request sentence that turns something down: "No CI workflow is wanted", "without a GUI".
const NEGATION = /\b(?:no|not|without|never|don't|do not|nor|skip|out of scope)\b/i;
const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const contentWords = (text: string): string[] => [
  ...new Set(normalize(text).match(/[a-z0-9]{4,}/g) ?? []),
];

/**
 * The spec with each deliverable that has neither requirements nor an exclusion mapped by the
 * host, instead of a whole new spec from the author (R19 logslice-update: "deliverable maps to no
 * requirement" twice; #1037). An entry of the spec's outOfScope that quotes the request and names
 * the deliverable becomes its exclusion; otherwise the requirements whose text holds the
 * deliverable's words (all of them for a short quote, at least two) cover it; otherwise a
 * sentence of the request that turns those words down becomes its exclusion. A deliverable none
 * of these fits stays for the author.
 */
export function repairDeliverables(
  spec: Spec,
  request: string,
): { spec: Spec; repaired: string[] } {
  if (!request.trim() || !spec.deliverables?.length) return { spec, repaired: [] };
  const repaired: string[] = [];
  const deliverables = spec.deliverables.map((d) => {
    if (d.requirementIds.length || d.outOfScope !== undefined) return d;
    const wanted = contentWords(d.quote);
    if (!wanted.length) return d;
    const needed = Math.min(2, wanted.length);
    const shared = (text: string): number => {
      const have = new Set(contentWords(text));
      return wanted.filter((w) => have.has(w)).length;
    };
    const exclusion = spec.outOfScope.find(
      (entry) => quotesRequest(entry, request) && shared(entry) >= needed,
    );
    if (exclusion) {
      repaired.push(d.quote);
      return { ...d, outOfScope: exclusion };
    }
    const covering = spec.requirements.filter((r) => shared(r.text) >= needed).map((r) => r.id);
    if (covering.length) {
      repaired.push(d.quote);
      return { ...d, requirementIds: covering };
    }
    const declined = sentences(request).find((s) => NEGATION.test(s) && shared(s) >= needed);
    if (!declined) return d;
    repaired.push(d.quote);
    return { ...d, outOfScope: declined };
  });
  return repaired.length ? { spec: { ...spec, deliverables }, repaired } : { spec, repaired };
}

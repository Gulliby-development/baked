import { quoteInRequest } from "./derivation-audit.js";
import {
  criterionText,
  MIN_REQUEST_QUOTE,
  quotedSpans,
  type ReportedSide,
  requestQuote,
} from "./request-conflict.js";
import type { Spec } from "./schemas.js";

/**
 * Host decisions that settle a finding or a conflict for the request or the platform, decided on
 * evidence the host checks, not on the wording of a model's text (#2032, follow-up of #2016). R65
 * uritpl cli T003 showed the cost of a wording rule: "the detailed contract defines" did not match
 * where "the request defines" did, and a person was asked after 1.42M tokens. The sites:
 *
 * - `analysis-request`: a blocking `inconsistency` finding of the analysis that the request
 *   settles (`requestSettles`).
 * - `review-request`: a review finding that records a spec amendment for the request
 *   (`specAmendmentOf`).
 * - `platform-limit`: a spec conflict whose one side is what the platform cannot do.
 * - `docs-example`: a documentation task torn between the rule for examples and the request's
 *   worked example.
 *
 * Evidence is `verified` when a quote the request holds backs the finding (its `quote` field, its
 * request sides, or a span it quotes), or, for a platform limit, a line of a failing check's or a
 * probe's recorded output; `unverified` when the model offered such evidence and the host could not
 * find it; `absent` when it offered none. Verified evidence settles on every report; offered
 * evidence the host cannot find settles nothing, whatever the words; a finding with none falls back
 * to the site's wording rule, for a conflict only on a task's first report. Each decision records
 * its inputs as `conflicts/evidence/<site>-<ref>-<n>.json` (kind `evidence-decision`, kept in bench
 * traces, no prose), replayed by `replayEvidenceDecisions`.
 */
export const EVIDENCE_DECISION_KIND = "evidence-decision";
export const EVIDENCE_DECISIONS_DIR = "conflicts/evidence/";

export type EvidenceSite =
  | "analysis-request"
  | "review-request"
  | "platform-limit"
  | "docs-example";
export type EvidenceState = "verified" | "unverified" | "absent";

export interface EvidenceInput {
  site: EvidenceSite;
  /**
   * The site decides this finding or report at all: a blocking inconsistency, a `contradicts`
   * finding whose fix changes the spec, a conflict under `clarification: assume` of a task the
   * site has not settled before (and, for an example, a task that writes only documentation).
   */
  eligible: boolean;
  evidence: EvidenceState;
  /** The site's wording rule matched: the decision before #2032, now only the fallback. */
  wording: boolean;
  /** The wording fallback applies: every finding, or a task's first conflict report. */
  fallback: boolean;
}

/** What `conflicts/evidence/<site>-<ref>-<n>.json` records. */
export interface EvidenceRecord extends EvidenceInput {
  /** The finding id or the task id. */
  ref: string;
  /** The how-manieth decision of this site on this ref, from 1. */
  report: number;
  decision: boolean;
}

export type EvidenceRule = (input: EvidenceInput) => boolean;

/** Whether the site settles the finding or the conflict. */
export const evidenceDecision: EvidenceRule = (input) =>
  input.eligible &&
  (input.evidence === "verified" ||
    (input.evidence === "absent" && input.wording && input.fallback));

/** The path of a site's `report`-th decision on `ref`. */
export const evidenceRecordPath = (site: EvidenceSite, ref: string, report: number): string =>
  `${EVIDENCE_DECISIONS_DIR}${site}-${ref}-${report}.json`;

/**
 * Whether the request backs a finding: its `quote` decides when it gives one; otherwise any span
 * its texts quote that the request holds (and no criterion it sets against the request does).
 * A quoted span the request does not hold may quote the spec, so it is not offered evidence.
 */
export function requestEvidence(
  request: string,
  quote: string | undefined,
  texts: readonly string[],
  criteria: readonly string[],
): EvidenceState {
  if (quote !== undefined)
    return requestQuote(quote, request, criteria) ? "verified" : "unverified";
  return texts.flatMap(quotedSpans).some((span) => requestQuote(span, request, criteria))
    ? "verified"
    : "absent";
}

/** The criterion texts a finding names by id, the side a request quote must not be part of. */
export function namedCriteria(
  spec: Pick<Spec, "criteria"> | null | undefined,
  texts: readonly string[],
): string[] {
  const text = texts.join("\n");
  return (spec?.criteria ?? [])
    .filter((c) => new RegExp(`(?<![\\w-])${c.id}(?![\\w-])`).test(text))
    .map(criterionText);
}

/**
 * Whether a conflict's request sides, or the spans its report quotes, show the request (the
 * `docs-example` site: the worked example the report says the rule for examples stands against).
 */
export function reportRequestEvidence(
  request: string,
  report: string,
  reported: readonly ReportedSide[] | undefined,
): EvidenceState {
  const sides = (reported ?? []).filter((s) => s.kind === "request");
  if (sides.length)
    return sides.some((s) => requestQuote(s.quote, request, [])) ? "verified" : "unverified";
  return requestEvidence(request, undefined, [report], []);
}

/**
 * Whether a conflict's platform sides name recorded output that shows the limit: a check of the
 * task whose latest run failed, or a probe the task ran, holding the side's quote. Quotes shorter
 * than a request quote's minimum show nothing.
 */
export function platformEvidence(
  reported: readonly ReportedSide[] | undefined,
  failing: Readonly<Record<string, string>>,
  probes: readonly string[],
): EvidenceState {
  const sides = (reported ?? []).filter((s) => s.kind === "platform");
  if (!sides.length) return "absent";
  const shown = (quote: string, output: string | undefined) =>
    output !== undefined &&
    quote.replace(/\s+/g, " ").trim().length >= MIN_REQUEST_QUOTE &&
    quoteInRequest(quote, output);
  return sides.some((side) =>
    side.ref === "probe" || side.ref === undefined
      ? probes.some((output) => shown(side.quote, output))
      : shown(side.quote, failing[side.ref]),
  )
    ? "verified"
    : "unverified";
}

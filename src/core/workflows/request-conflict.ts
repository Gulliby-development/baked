import { citedCriteria } from "./conflict-rows.js";
import { quoteInRequest } from "./derivation-audit.js";
import type { Analysis, Spec } from "./schemas.js";

/**
 * A spec conflict between a criterion and the request, settled for the request on verified quotes
 * (#2016). uritpl cli T003 (bench round 65): AC-005 gave column 6 where the request's own example
 * shows name columns (5). Whether the request won was decided by the wording of the report ("the
 * request defines" matched, "the detailed contract defines" did not) and only for a task's first
 * report, so a second implementer session of 1.0M tokens ran and a person was asked.
 *
 * The host now decides on evidence it checks itself, on every report of a task: the sides the
 * report names (`conflictSides`, or the criterion ids and quoted spans of its text) are checked
 * against the spec and the request, and a criterion that contradicts a verified request quote
 * loses to the request. When no side quotes the request, a targeted re-audit of the cited criteria
 * against the request decides, with each quote it cites checked against the request
 * (`checkedDerivations`, #1823). A test the run did not write keeps the question for a person.
 * Each decision records its inputs as `conflicts/request/<task>-<n>.json` (kind
 * `request-conflict`, kept in bench traces), replayed by `replayRequestConflicts`.
 */
export const REQUEST_CONFLICT_KIND = "request-conflict";
export const REQUEST_CONFLICTS_DIR = "conflicts/request/";
/** The shortest request quote that counts, in characters after spacing and quote marks. */
export const MIN_REQUEST_QUOTE = 12;

/** `platform` (#2032): ref is a check id or `probe`, and the quote is a line of its output. */
export type SideKind = "criterion" | "requirement" | "request" | "test" | "platform";

/** A side as the implementer reports it (`conflictSides` of the implementation result). */
export interface ReportedSide {
  kind: SideKind;
  ref?: string | undefined;
  quote: string;
}

/** A side after the host checked it: the quote is not kept, so a trace holds no prose. */
export interface CheckedSide {
  kind: SideKind;
  ref: string | null;
  /** The quote is in the spec text of its criterion or requirement, or in the request. */
  verified: boolean;
  /** `sides`: the report's `conflictSides`; `report`: read off its text (ids, quoted spans). */
  source: "sides" | "report";
}

/** The re-audit's verdict on one cited criterion. */
export interface ReauditVerdict {
  criterionId: string;
  matches: boolean;
  /** The derivation quotes the request and the request holds the quote. */
  quoteVerified: boolean;
}

/** `request`: the request wins; `reaudit`: ask the re-audit first; `none`: today's path. */
export type RequestConflictDecision = "request" | "reaudit" | "none";

export interface RequestConflictInput {
  sides: CheckedSide[];
  /** Test files of the conflict that the run did not write, or that were written first. */
  foreignTests: number;
  /** The automated criteria the conflict cites. */
  criterionIds: string[];
  /**
   * The criteria came from a test file the request supplies verbatim, not from the report's ids
   * (#2006, part c): those whose literals the supplied file lacks.
   */
  supplied?: true;
  /** The re-audit's verdicts; null when it has not run for this report. */
  reaudit: ReauditVerdict[] | null;
  /** A re-audit of this task's conflict ran before, on an earlier report. */
  reauditedBefore: boolean;
}

/** What `conflicts/request/<task>-<n>.json` records. */
export interface RequestConflictRecord extends RequestConflictInput {
  taskId: string;
  /** The task's how-manieth conflict report this decision was made on, from 1. */
  report: number;
  decision: RequestConflictDecision;
}

export type RequestConflictRule = (input: RequestConflictInput) => RequestConflictDecision;

/** Whether the checked sides set a verified criterion or requirement against a verified request. */
export function sidesSettle(sides: readonly CheckedSide[]): boolean {
  const request = sides.filter((s) => s.kind === "request");
  return (
    request.length > 0 &&
    request.every((s) => s.verified) &&
    sides.some((s) => (s.kind === "criterion" || s.kind === "requirement") && s.verified)
  );
}

/**
 * The decision on recorded inputs. The request wins when the sides settle it or when the re-audit
 * found a cited criterion that contradicts a verified request quote; a test the run did not write
 * keeps today's path (a person, or the test task's correction).
 */
export const requestConflictDecision: RequestConflictRule = (input) => {
  if (input.foreignTests > 0) return "none";
  if (sidesSettle(input.sides)) return "request";
  if (input.reaudit === null)
    return input.criterionIds.length && !input.reauditedBefore ? "reaudit" : "none";
  return input.reaudit.some((v) => !v.matches && v.quoteVerified) ? "request" : "none";
};

const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_"'‘’“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const criterionText = (c: Spec["criteria"][number]) => `${c.given}\n${c.when}\n${c.then}`;

/** A request quote that shows a side of its own: long enough, in the request, not in the criteria. */
export function requestQuote(quote: string, request: string, criteria: readonly string[]): boolean {
  return (
    squash(quote).length >= MIN_REQUEST_QUOTE &&
    quoteInRequest(quote, request) &&
    !criteria.some((text) => quoteInRequest(quote, text))
  );
}

/** Spans a report quotes: double quotes, backticks or typographic quotes. */
export function quotedSpans(report: string): string[] {
  return [...report.matchAll(/"([^"\n]+)"|`([^`\n]+)`|“([^”\n]+)”/g)].map((m) =>
    (m[1] ?? m[2] ?? m[3] ?? "").trim(),
  );
}

/**
 * The sides of a conflict, checked against the spec and the request. Without `conflictSides` the
 * criteria the report cites by id and each span it quotes that the request holds (and no cited
 * criterion does) are its sides, so a report that quotes the request settles whatever words
 * surround the quote.
 */
export function checkedSides(
  spec: Pick<Spec, "criteria" | "requirements">,
  request: string,
  report: string,
  reported: readonly ReportedSide[] | undefined,
): CheckedSide[] {
  if (reported?.length) {
    const cited = reported.flatMap((side) =>
      side.kind === "criterion"
        ? spec.criteria.filter((c) => c.id === side.ref).map(criterionText)
        : [],
    );
    return reported.map((side) => {
      const ref = side.ref ?? null;
      let verified = false;
      if (side.kind === "criterion") {
        const criterion = spec.criteria.find((c) => c.id === ref);
        verified = !!criterion && quoteInRequest(side.quote, criterionText(criterion));
      } else if (side.kind === "requirement") {
        const requirement = spec.requirements.find((r) => r.id === ref);
        verified = !!requirement && quoteInRequest(side.quote, requirement.text);
      } else if (side.kind === "request") verified = requestQuote(side.quote, request, cited);
      // A platform side is checked against the task's failing checks and probes (#2032).
      else if (side.kind === "test") verified = ref !== null;
      return { kind: side.kind, ref, verified, source: "sides" as const };
    });
  }
  const criteria = citedCriteria(spec, report);
  const texts = criteria.map(criterionText);
  return [
    ...criteria.map((c) => ({
      kind: "criterion" as const,
      ref: c.id,
      verified: true,
      source: "report" as const,
    })),
    ...quotedSpans(report)
      .filter((span) => requestQuote(span, request, texts))
      .map(() => ({
        kind: "request" as const,
        ref: null,
        verified: true,
        source: "report" as const,
      })),
  ];
}

/** The automated criteria a conflict cites, by the report's text and its criterion sides. */
export function conflictCriteria(
  spec: Pick<Spec, "criteria">,
  report: string,
  reported: readonly ReportedSide[] | undefined,
): Spec["criteria"] {
  const named = new Set(
    (reported ?? []).filter((s) => s.kind === "criterion" && s.ref).map((s) => s.ref),
  );
  const cited = new Set(citedCriteria(spec, report).map((c) => c.id));
  return spec.criteria.filter(
    (c) => c.method === "automated" && (cited.has(c.id) || named.has(c.id)),
  );
}

/** The test paths a conflict's sides name. */
export const sideTests = (reported: readonly ReportedSide[] | undefined): string[] =>
  (reported ?? []).flatMap((s) => (s.kind === "test" && s.ref ? [s.ref] : []));

/** The re-audit's verdicts on the cited criteria, each quote checked against the request again. */
export function reauditVerdicts(
  derivations: Analysis["derivations"],
  criterionIds: readonly string[],
  request: string,
): ReauditVerdict[] {
  return criterionIds.map((criterionId) => {
    const own = (derivations ?? []).filter((d) => d.criterionId === criterionId);
    const against = own.filter(
      (d) => !d.matches && d.quote !== undefined && quoteInRequest(d.quote, request),
    );
    // A mismatch without a request quote the request holds leaves the criterion standing.
    return { criterionId, matches: !against.length, quoteVerified: against.length > 0 };
  });
}

/** What the targeted re-audit of a criterion the request may settle is told (#2016). */
export const REQUEST_REAUDIT_NOTE =
  "Request re-audit: the implementer reports that these criteria contradict the request (report). Recompute each criterion's expected outcome (its then, and each literal row it states) from the request first and the requirements second, one entry per criterion or row in `derivations`: the criterion's literal as written in row, the value the request gives in recomputed, whether they match, and the derivation. For a position, column, offset, length or count, read it off the index table of the input (inputs) and cite the indexes you used; where the request gives a worked example of the rule, apply the example's own counting. When the request states the value or gives an example that fixes it, copy the request's exact words into `quote`; the host checks the quote against the request, and only a quoted mismatch overrules the criterion. A reading the request leaves open matches. Raise no findings.";

/** Where a task's conflict settled for the request is recorded, once per task. */
export const requestConflictPath = (taskId: string): string =>
  `assumptions/conflicts/${taskId}-request.json`;

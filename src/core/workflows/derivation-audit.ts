import { hashJson } from "../specs/hash.js";
import type { Analysis, RunPolicy, Spec } from "./schemas.js";

/**
 * The derivation audit (#1465, opt-in with `derivationAudit: "on"`). The spec author writes
 * criteria with literal input and expected rows (`crc:3:3:0:1:0:0 / 01 | 4`) that it derives by
 * hand; in a rule-heavy domain a derived row can contradict the requirements, and the wrong row
 * then becomes a failing test and a spec conflict (bench R40 tonemath theory AC-008, 763k tokens and
 * a question to a person; R42 fecsmith crc AC-004, 0.65M tokens of rework). With the audit on, the
 * analyzer recomputes every such row from the requirements, and the host raises each row it cannot
 * reproduce as a blocking finding that goes back to the spec author once before anyone is asked.
 */

/** A table cell boundary (`a | b`, not `||`) or a mapping arrow (`a → b`). */
const ROW = /\S\s*(?<!\|)\|(?!\|)\s*\S|\S\s*→\s*\S/;

/** The criteria a derivation audit recomputes: automated ones that state literal rows. */
export function auditedCriteria(spec: Spec): Spec["criteria"] {
  return spec.criteria.filter(
    (c) => c.method === "automated" && [c.given, c.when, c.then].some((text) => ROW.test(text)),
  );
}

export function derivationAuditOn(policy: Pick<RunPolicy, "derivationAudit">): boolean {
  return policy.derivationAudit === "on";
}

export function derivationAuditCarryOn(
  policy: Pick<RunPolicy, "derivationAudit" | "derivationAuditCarry">,
): boolean {
  return policy.derivationAuditCarry === "on";
}

type Derivation = NonNullable<Analysis["derivations"]>[number];

/** Audited rows carried from an earlier pass: the criterion, its key and its derivations. */
export interface CarriedAudit {
  criterionId: string;
  key: string;
  derivations: Derivation[];
}

/** A criterion's audit key: its own text and the text of the requirements it derives from. */
export function auditKey(
  spec: Pick<Spec, "requirements">,
  criterion: Spec["criteria"][number],
): string {
  return hashJson({
    criterion,
    requirements: criterion.requirementIds.map(
      (id) => spec.requirements.find((r) => r.id === id) ?? id,
    ),
  });
}

/**
 * The derivations an earlier pass made for criteria that have not changed since (#1851): same
 * criterion text, same requirement text, every row reproduced. R57 modeplan foundation's second
 * analysis pass audited all 121 rows again (318k tokens) to answer one coverage finding.
 */
export function carriedDerivations(spec: Spec, carried: readonly CarriedAudit[]): Derivation[] {
  return auditedCriteria(spec).flatMap((criterion) => {
    const entry = carried.find((c) => c.criterionId === criterion.id);
    return entry && entry.key === auditKey(spec, criterion) ? entry.derivations : [];
  });
}

/** The audited criteria of this pass whose rows all matched, for the next pass to carry. */
export function auditCarry(spec: Spec, derivations: Analysis["derivations"]): CarriedAudit[] {
  return auditedCriteria(spec).flatMap((criterion) => {
    const rows = (derivations ?? []).filter((d) => d.criterionId === criterion.id);
    return rows.length && rows.every((d) => d.matches)
      ? [{ criterionId: criterion.id, key: auditKey(spec, criterion), derivations: rows }]
      : [];
  });
}

/** This pass's derivations with the carried ones: a carried criterion keeps its earlier rows. */
export function withCarried(
  derivations: Analysis["derivations"],
  carried: readonly Derivation[],
): Analysis["derivations"] {
  if (!carried.length) return derivations;
  const ids = new Set(carried.map((d) => d.criterionId));
  return [...carried, ...(derivations ?? []).filter((d) => !ids.has(d.criterionId))];
}

/**
 * What the analyzer is told to do, with the criteria in full (a digested spec may omit them).
 * Criteria in `carried` were audited by an earlier pass and are left out; none left means none.
 */
export function derivationAuditExtra(
  spec: Spec,
  carried: ReadonlySet<string> = new Set(),
): {
  criteria: Spec["criteria"];
  requirements: Spec["requirements"];
  note: string;
} | null {
  const criteria = auditedCriteria(spec).filter((c) => !carried.has(c.id));
  if (!criteria.length) return null;
  const ids = new Set(criteria.flatMap((c) => c.requirementIds));
  const skipped = carried.size
    ? ` The rows of ${[...carried].sort().join(", ")} were reproduced by an earlier pass and have not changed since; the host keeps those derivations, so leave them out of derivations.`
    : "";
  return {
    criteria,
    requirements: spec.requirements.filter((r) => ids.has(r.id)),
    note:
      "Derivation audit: these criteria state literal rows (an input and the output it must give). Recompute every row from the requirements alone, without looking at the row's own expected value, and record one entry per row in `derivations`: the row as written, the value the requirements give, whether they match, and the derivation step by step. A row whose expected value is a position, column, offset, length or count is counted, not estimated: write out the index of each character of its input up to the value in the derivation. A row that the request itself states is authoritative: when the requirements give something else, it is the requirement that is wrong, so record matches false and say so in the derivation. A derivation that rests on the request (the request states, gives or lists the row or its rule) copies the request's exact words in `quote`; the host checks the quote against the request, and a row whose quote the request does not contain is raised as a mismatch. A row the request does not list is derived from the rule as the request words it, and a reading of that rule the request leaves open is a finding of kind ambiguity, not a citation. The host raises every row with matches false as a blocking finding, so do not report those rows again in `findings`." +
      skipped,
  };
}

/** Wording of a derivation that settles its row by what the request states (#1823). */
const CITES_REQUEST =
  /\bthe\s+(?:request|brief)(?:'s)?\s+(?:itself\s+)?(?:explicitly\s+|expressly\s+|clearly\s+|also\s+)?(?:states?|stated|gives?|given|lists?|listed|says|said|shows?|spells?|specifies|defines?|contains?|includes?|provides?)\b|\bthe\s+(?:request|brief)'s\s+(?:own\s+)?(?:example|explicit|stated|worked)\b|\b(?:stated|given|listed|shown|spelled)\s+(?:verbatim\s+)?(?:in|by)\s+the\s+(?:request|brief)\b/i;

/**
 * Whether a derivation rests on the request: it quotes it, says so, or derives its row from a
 * requirement that says the request states it (a spec author can copy an invented example into a
 * requirement as well as into a row).
 */
export function citesRequest(
  derivation: Pick<
    NonNullable<Analysis["derivations"]>[number],
    "criterionId" | "derivation" | "quote"
  >,
  spec?: Pick<Spec, "criteria" | "requirements">,
): boolean {
  if (derivation.quote !== undefined || CITES_REQUEST.test(derivation.derivation)) return true;
  const ids = spec?.criteria.find((c) => c.id === derivation.criterionId)?.requirementIds ?? [];
  return (spec?.requirements ?? []).some((r) => ids.includes(r.id) && CITES_REQUEST.test(r.text));
}

/** Text compared as the request words it: case, Markdown emphasis, quote marks and spacing aside. */
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_"'\u2018\u2019\u201c\u201d]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Whether the request holds the quote, its parts around an ellipsis in order. */
export function quoteInRequest(quote: string, request: string): boolean {
  const text = plain(request);
  const parts = quote
    .split(/\.{3}|\u2026/)
    .map(plain)
    .filter(Boolean);
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return parts.length > 0;
}

/**
 * The derivations with every citation of the request checked against it (#1823): a row that rests
 * on request text the request does not contain, or on the request without a quote, does not
 * match, so it goes back to the spec author as a `DERIVE-` finding. R55 routeshadow's audit
 * passed `GET // n -> RS005 at 1:6` by citing an example the brief never gave, and the wrong
 * column shipped (49 of 22,611 differential invocations).
 */
export function checkedDerivations(
  derivations: Analysis["derivations"],
  request: string,
  spec?: Pick<Spec, "criteria" | "requirements">,
): Analysis["derivations"] {
  return derivations?.map((d) => {
    if (!citesRequest(d, spec) || (d.quote !== undefined && quoteInRequest(d.quote, request)))
      return d;
    const why =
      d.quote === undefined
        ? "The derivation or its requirement cites the request without quoting it"
        : `The cited request text ${JSON.stringify(d.quote.slice(0, 400))} is not in the request`;
    return {
      ...d,
      matches: false,
      derivation: `${why}, so the row does not rest on the request: ${d.derivation}`.slice(
        0,
        16000,
      ),
    };
  });
}

/** Problems with the audit part of an analysis, so the analyzer completes it before submitting. */
export function derivationProblems(spec: Spec, analysis: Pick<Analysis, "derivations">): string[] {
  const audited = auditedCriteria(spec);
  const known = new Set(spec.criteria.map((c) => c.id));
  const derivations = analysis.derivations ?? [];
  const problems = [
    ...new Set(derivations.map((d) => d.criterionId).filter((id) => !known.has(id))),
  ].map((id) => `derivations names ${id}, which is not a criterion of the spec.`);
  for (const criterion of audited)
    if (!derivations.some((d) => d.criterionId === criterion.id))
      problems.push(
        `Derivation audit: ${criterion.id} states literal rows and has no entry in derivations; recompute each of its rows from ${criterion.requirementIds.join(", ")} and add one entry per row.`,
      );
  for (const d of derivations)
    if (d.quote === undefined && citesRequest(d, spec))
      problems.push(
        `Derivation audit: the entry for ${d.criterionId} row ${JSON.stringify(d.row)} rests on the request (the derivation or its requirement says the request states it); copy the request's exact words it relies on into quote, or derive the row from the requirements if the request does not state it.`,
      );
  return problems;
}

/** The id the host gives the finding of one criterion's rows that the requirements do not give. */
const findingId = (criterionId: string) => `DERIVE-${criterionId}`;

export function isDerivationFinding(finding: { id: string }): boolean {
  return finding.id.startsWith("DERIVE-");
}

/** One blocking finding per criterion with rows the analyzer could not reproduce. */
export function derivationFindings(
  spec: Spec,
  analysis: Pick<Analysis, "derivations">,
): Analysis["findings"] {
  const byCriterion = new Map<string, NonNullable<Analysis["derivations"]>>();
  for (const derivation of analysis.derivations ?? []) {
    if (derivation.matches) continue;
    byCriterion.set(derivation.criterionId, [
      ...(byCriterion.get(derivation.criterionId) ?? []),
      derivation,
    ]);
  }
  return [...byCriterion].flatMap(([criterionId, rows]) => {
    const criterion = spec.criteria.find((c) => c.id === criterionId);
    if (!criterion) return [];
    const listed = rows
      .map((r) => `row "${r.row}": the requirements give "${r.recomputed}" (${r.derivation})`)
      .join("; ");
    return [
      {
        id: findingId(criterionId),
        kind: "inconsistency" as const,
        refs: ["spec.json", criterionId, ...criterion.requirementIds],
        description:
          `Derivation audit: ${criterionId} states ${rows.length === 1 ? "a row" : `${String(rows.length)} rows`} that ${criterion.requirementIds.join(", ")} do not give: ${listed}. The requirements outrank the criterion: correct each row to the value they give, unless the request itself states the row, in which case correct the requirement.`.slice(
            0,
            16000,
          ),
        blocking: true,
      },
    ];
  });
}

/** The note that sends rows the requirements do not give back to the spec author. */
export const DERIVATION_RETURN_NOTE =
  "Derivation audit findings: these criterion rows do not follow from the requirements, which outrank the criteria. Correct each row in spec.json to the value the requirements give, or correct the requirement when the request itself states the row, and keep every other part of the spec unchanged:";

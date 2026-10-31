import { hashJson } from "../specs/hash.js";
import type { Analysis, RunPolicy, Spec, TaskGraph } from "./schemas.js";

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

/**
 * A value counted from an input in an outcome: a `line:column` pair, a column, offset, position,
 * index, width, length or count with its number, or a number of characters, bytes or columns.
 */
const COMPUTED =
  /\b\d+:\d+\b|\b(?:columns?|col|offsets?|positions?|index|width|length|count)\s+(?:of\s+\S+\s+)?(?:is\s+|=\s*)?\d+\b|\b\d+\s+(?:characters?|chars?|bytes?|columns?|code\s+points?)\b/i;

/** A literal input: a code span or a quoted string. */
const LITERAL = /`[^`\n]+`|"[^"\n]+"|\u201c[^\u201d\n]+\u201d/;

/**
 * What a criterion gives the derivation audit to recompute (#1465, #2022): `rows` when it states
 * literal rows (a table or a mapping), `computed` when its `then` states a position, column,
 * offset, width or count of a literal input its given or when names (R65 uritpl cli AC-005, `1:6`
 * for the second name of `{a}{a}`, which a rows-only audit never looked at), and null otherwise.
 */
export function auditShape(criterion: Spec["criteria"][number]): "rows" | "computed" | null {
  if (criterion.method !== "automated") return null;
  if ([criterion.given, criterion.when, criterion.then].some((text) => ROW.test(text)))
    return "rows";
  return COMPUTED.test(criterion.then) &&
    (LITERAL.test(criterion.given) || LITERAL.test(criterion.when))
    ? "computed"
    : null;
}

/** The criteria a derivation audit recomputes: those `auditShape` gives a shape. */
export function auditedCriteria(spec: Spec): Spec["criteria"] {
  return spec.criteria.filter((c) => auditShape(c) !== null);
}

export function derivationAuditOn(policy: Pick<RunPolicy, "derivationAudit">): boolean {
  return policy.derivationAudit === "on";
}

export function derivationAuditCarryOn(
  policy: Pick<RunPolicy, "derivationAudit" | "derivationAuditCarry">,
): boolean {
  return policy.derivationAuditCarry === "on";
}

/** Whether a derivation return amends the criteria in place and keeps the plan (#2219). */
export function derivationAmendOn(
  policy: Pick<RunPolicy, "derivationAudit" | "derivationAmend">,
): boolean {
  return policy.derivationAmend === "on";
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
      "Derivation audit: these criteria state literal rows (an input and the output it must give), or a value computed from a literal input in their then (a line and column, offset, position, width, length or count). For a criterion of the second kind, each such value is a row: write the input and the value as the criterion states them as `row`. Recompute every row from the requirements alone, without looking at the row's own expected value, and record one entry per row in `derivations`: the row as written, the value the requirements give, whether they match, and the derivation step by step. A row whose expected value is a position, column, offset, length or count is counted, not estimated: write out the index of each character of its input up to the value in the derivation. A row that the request itself states is authoritative: when the requirements give something else, it is the requirement that is wrong, so record matches false and say so in the derivation. A derivation that rests on the request (the request states, gives or lists the row or its rule) copies the request's exact words in `quote`; the host checks the quote against the request, and a row whose quote the request does not contain is raised as a mismatch. A row the request does not list is derived from the rule as the request words it, and a reading of that rule the request leaves open is a finding of kind ambiguity, not a citation. The host raises every row with matches false as a blocking finding, so do not report those rows again in `findings`." +
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
const UNQUOTED = ", so the row does not rest on the request: ";

/**
 * Whether a derivation is a mismatch only because `checkedDerivations` found no quote of the
 * request it rests on (#2561): it recomputed the row from a restatement, so it decides nothing
 * about what the request gives. R82 tinyflate T009's re-audit, "The cited request text ... is not
 * in the request, so the row does not rest on the request: The settled clarification specifies
 * 306 repeated x bytes", settled the conflict for the requirements.
 */
export function unquotedDerivation(d: { matches: boolean; derivation: string }): boolean {
  return (
    !d.matches &&
    d.derivation.includes(UNQUOTED) &&
    (d.derivation.startsWith("The derivation or its requirement cites the request without") ||
      d.derivation.startsWith("The cited request text "))
  );
}

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
      derivation: `${why}${UNQUOTED}${d.derivation}`.slice(0, 16000),
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
        auditShape(criterion) === "computed"
          ? `Derivation audit: ${criterion.id} states a value computed from a literal input (a column, offset, width, length or count) and has no entry in derivations; recompute each such value from ${criterion.requirementIds.join(", ")} and add one entry per value.`
          : `Derivation audit: ${criterion.id} states literal rows and has no entry in derivations; recompute each of its rows from ${criterion.requirementIds.join(", ")} and add one entry per row.`,
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
      .map(
        (r) =>
          `row ${JSON.stringify(r.row)}: the requirements give ${JSON.stringify(r.recomputed)} (${r.derivation})`,
      )
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

/**
 * A derivation amendment in flight (#2219): the criteria the return names, the rows the audit
 * could not reproduce, and the hash of the spec with those criteria's given, when and then left
 * out. The specify stage compares the amended spec against it to decide whether the plan stands.
 */
export interface DerivationAmend {
  criterionIds: string[];
  rows: string[];
  baseline: string;
}

/** A criterion without its given, when and then. */
function withoutText(criterion: Spec["criteria"][number]): unknown {
  const { given: _given, when: _when, then: _then, ...kept } = criterion;
  return kept;
}

/**
 * The spec with the text of `criterionIds` left out, and its revision number: what an amendment
 * of exactly those criteria leaves as it was.
 */
function amendMask(spec: Spec, criterionIds: readonly string[]): unknown {
  const { revision: _revision, ...rest } = spec;
  return {
    ...rest,
    criteria: spec.criteria.map((c) => (criterionIds.includes(c.id) ? withoutText(c) : c)),
  };
}

/**
 * Whether a blocking analysis outcome may be answered by an amendment (#2219): every blocking
 * finding is a derivation audit finding (no ambiguity, coverage or other structural finding), and
 * the rows it names are few enough for one bounded revision.
 */
export function amendableReturn(blocking: readonly { id: string }[], maxFindings: number): boolean {
  return (
    blocking.length > 0 && blocking.length <= maxFindings && blocking.every(isDerivationFinding)
  );
}

/** The amendment the derivation return starts: the criteria its findings name and their rows. */
export function startAmend(
  spec: Spec,
  derivations: Analysis["derivations"],
  findings: readonly { id: string }[],
): DerivationAmend {
  const criterionIds = findings.map((f) => f.id.slice("DERIVE-".length));
  return {
    criterionIds,
    rows: (derivations ?? [])
      .filter((d) => !d.matches && criterionIds.includes(d.criterionId))
      .map((d) => d.row),
    baseline: hashJson(amendMask(spec, criterionIds)),
  };
}

/**
 * Whether the plan and tasks stand after the spec author amended the criteria (#2219), and why
 * not when they do not. They stand when the amended spec differs from the one analyzed only in the
 * given, when and then of the amended criteria (same criteria, ids, requirement ids, methods and
 * requirement text, so no task's criterion list or writes can change), when no wrong row is
 * copied into plan.md or tasks.json, and when no task carries rows of its own (`rowsAsData`).
 */
export function amendKeepsPlan(
  amend: DerivationAmend,
  spec: Spec,
  plan: string | null,
  graph: TaskGraph | null,
  rowsAsData: boolean,
): { keep: true } | { keep: false; reason: string } {
  if (plan === null || !graph) return { keep: false, reason: "no plan to keep" };
  if (rowsAsData) return { keep: false, reason: "tasks carry acceptance rows (rowsAsData)" };
  if (hashJson(amendMask(spec, amend.criterionIds)) !== amend.baseline)
    return {
      keep: false,
      reason: "the amendment changed more than the given, when and then of the amended criteria",
    };
  const tasks = JSON.stringify(graph.tasks);
  const copied = amend.rows.filter(
    (row) =>
      row.trim().length > 0 &&
      (plan.includes(row) || tasks.includes(JSON.stringify(row).slice(1, -1))),
  );
  if (copied.length)
    return {
      keep: false,
      reason: `plan.md or tasks.json copies a corrected row: ${copied.map((r) => JSON.stringify(r)).join(", ")}`,
    };
  return { keep: true };
}

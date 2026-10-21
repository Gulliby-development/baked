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

/** What the analyzer is told to do, with the criteria in full (a digested spec may omit them). */
export function derivationAuditExtra(spec: Spec): {
  criteria: Spec["criteria"];
  requirements: Spec["requirements"];
  note: string;
} | null {
  const criteria = auditedCriteria(spec);
  if (!criteria.length) return null;
  const ids = new Set(criteria.flatMap((c) => c.requirementIds));
  return {
    criteria,
    requirements: spec.requirements.filter((r) => ids.has(r.id)),
    note: "Derivation audit: these criteria state literal rows (an input and the output it must give). Recompute every row from the requirements alone, without looking at the row's own expected value, and record one entry per row in `derivations`: the row as written, the value the requirements give, whether they match, and the derivation step by step. A row whose expected value is a position, column, offset, length or count is counted, not estimated: write out the index of each character of its input up to the value in the derivation. A row that the request itself states is authoritative: when the requirements give something else, it is the requirement that is wrong, so record matches false and say so in the derivation. The host raises every row with matches false as a blocking finding, so do not report those rows again in `findings`.",
  };
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

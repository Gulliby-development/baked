import {
  type CaseContext,
  criterionCases,
  isCheckCommand,
} from "../verification/criteria-cases.js";
import type { Analysis, Spec } from "./schemas.js";

/**
 * The criterion rows a spec conflict contests (#1709). A test task can transcribe a row's input
 * with one character changed (an escape, a flag or a space dropped), see the code disagree with
 * the row's expected cell and report `spec_conflict` quoting its own transcription. R51 sedstep
 * T006 dropped `\!` from `s/(a)/&\1\n\t\!\0/`, reported column 14 against the row's column 16,
 * and the person, shown only the task's paraphrase, overruled a row the derivation audit had
 * verified (910k tokens over three generations). The host compares the test with the row before
 * anyone is asked, and quotes the row verbatim when it does ask.
 */

export interface ContestedRow {
  criterion: Spec["criteria"][number];
  /** The derivation audit's entries for the criterion; empty when it was not audited. */
  audit: NonNullable<Analysis["derivations"]>;
  /** Literals of the criterion the task's tests spell with a small change, and how they spell them. */
  misquoted: { literal: string; quoted: string }[];
}

/** The automated criteria a report names by id. */
export function citedCriteria(spec: Pick<Spec, "criteria">, report: string): Spec["criteria"] {
  return spec.criteria.filter(
    (c) =>
      c.method === "automated" &&
      new RegExp(`(?<![\\w-])${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(
        report,
      ),
  );
}

/** A literal as a test spells it, without the escape layer of the host language. */
const spelling = (text: string) => text.replace(/\\/g, "");

/** String literals of a test or data file, and their cells: C#, Python, Go, Rust, Java, JS. */
function quotedValues(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`([^`]*)`/g)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    values.push(value);
    // A row of `@CsvSource`, a table string or a data file: each cell is a value of its own.
    if (/[,|;\t]/.test(value)) values.push(...value.split(/\s*[,|;\t]\s*/));
  }
  for (const line of text.split("\n"))
    if (/[,|\t]/.test(line)) values.push(...line.split(/\s*[,|\t]\s*/));
  return values.map((value) => value.trim()).filter(Boolean);
}

/** Levenshtein distance, or `limit + 1` once it is known to exceed `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/**
 * How the test files spell `literal` when none spells it exactly but one string comes within a
 * few characters of it: the transcription changed the row. Null when a file holds it as written
 * (escapes aside) or no string is close, so a test that builds the value differently is left alone.
 */
export function misquotation(literal: string, texts: string[]): string | null {
  const wanted = spelling(literal).trim();
  if (wanted.length < 6 || texts.some((text) => spelling(text).includes(wanted))) return null;
  const limit = Math.max(1, Math.floor(wanted.length * 0.15));
  let best: { quoted: string; score: number } | null = null;
  for (const value of texts.flatMap(quotedValues)) {
    const score = distance(spelling(value), wanted, limit);
    if (score > 0 && score <= limit && (!best || score < best.score))
      best = { quoted: value, score };
  }
  return best?.quoted ?? null;
}

/**
 * The rows a conflict report contests: the automated criteria it names, each with the audit's
 * verdicts and the literals the task's test files changed when they copied them.
 */
export function contestedRows(
  spec: Pick<Spec, "criteria">,
  report: string,
  tests: string[],
  derivations: Analysis["derivations"],
  checks: CaseContext["checks"],
): ContestedRow[] {
  return citedCriteria(spec, report).map((criterion) => {
    const cases = criterionCases(spec, { criterionIds: [criterion.id] }, { checks });
    const misquoted = cases.flatMap((c) => {
      const quoted = misquotation(c.literal, tests);
      return quoted === null ? [] : [{ literal: c.literal, quoted }];
    });
    return {
      criterion,
      audit: (derivations ?? []).filter((d) => d.criterionId === criterion.id),
      misquoted,
    };
  });
}

/** Whether the audit recomputed every row of the criterion from the requirements and agreed. */
export const auditVerified = (row: ContestedRow): boolean =>
  row.audit.length > 0 && row.audit.every((d) => d.matches);

/**
 * Each character of an input literal with its index, so a count of positions is read off the
 * table instead of done in the head (jsonsplice paths T006, bench round 53: an audit counted a
 * comment's column as 10 where FR-005 gives 11, twice, #1788). UTF-16 indexes, with UTF-8 byte
 * offsets as well when the literal is not ASCII. Empty past 200 characters.
 */
export function indexTable(literal: string): string {
  if (!literal.length || literal.length > 200) return "";
  const units = [...literal].reduce<{ at: number; byte: number; parts: string[]; bytes: string[] }>(
    (acc, ch) => {
      acc.parts.push(`${acc.at}:${JSON.stringify(ch)}`);
      acc.bytes.push(`${acc.byte}:${JSON.stringify(ch)}`);
      acc.at += ch.length;
      acc.byte += new TextEncoder().encode(ch).length;
      return acc;
    },
    { at: 0, byte: 0, parts: [], bytes: [] },
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII is the range 0-127.
  const ascii = /^[\x00-\x7f]*$/.test(literal);
  return `UTF-16 index ${units.parts.join(" ")}${ascii ? "" : `; UTF-8 byte offset ${units.bytes.join(" ")}`}`;
}

/**
 * What a second, targeted audit of contested rows gets (#1788): the criteria and their
 * requirements, the implementer's report with its own derivation, and an index table of each
 * quoted input, so the two derivations can be compared cell by cell.
 */
export function reauditExtra(
  spec: Pick<Spec, "criteria" | "requirements">,
  rows: ContestedRow[],
  report: string,
  checks: CaseContext["checks"],
): {
  criteria: Spec["criteria"];
  requirements: Spec["requirements"];
  report: string;
  inputs: { criterionId: string; literal: string; index: string }[];
  note: string;
} {
  const criteria = rows.map((r) => r.criterion);
  const ids = new Set(criteria.flatMap((c) => c.requirementIds));
  const inputs = rows.flatMap((r) =>
    criterionCases(spec, { criterionIds: [r.criterion.id] }, { checks }).flatMap((c) => {
      const index = indexTable(c.literal);
      return index ? [{ criterionId: r.criterion.id, literal: c.literal, index }] : [];
    }),
  );
  return {
    criteria,
    requirements: spec.requirements.filter((r) => ids.has(r.id)),
    report: report.slice(0, 3000),
    inputs,
    note: "Derivation re-audit: the derivation audit recomputed these rows and found that they match the requirements, but the implementer ran the code and reports a different value with its own derivation (report). Recompute every row of these criteria again from the requirements alone, one entry per row in `derivations`, as in the derivation audit. For a position, column, offset, length or count, read it off the index table of the input (inputs) and cite the indexes you used in the derivation; do not count in your head. Decide each row on the requirements, not on which side said it first. Raise no findings.",
  };
}

/** The criterion as the spec states it, and what the audit found, for a question to a person. */
export function verbatimRow(row: ContestedRow): string {
  const { criterion } = row;
  const audit = row.audit.length
    ? ` Derivation audit (the analyzer's own recomputation, not a run of the code): ${row.audit
        .map(
          (d) =>
            `row ${JSON.stringify(d.row)} ${d.matches ? "matches" : `does not match; the requirements give ${JSON.stringify(d.recomputed)}`}`,
        )
        .join("; ")}.`
    : "";
  const misquoted = row.misquoted.length
    ? ` The task's test spells ${row.misquoted.map((m) => `${JSON.stringify(m.literal)} as ${JSON.stringify(m.quoted)}`).join(", ")}.`
    : "";
  return `${criterion.id} as written: Given ${criterion.given}; When ${criterion.when}; Then ${criterion.then}.${audit}${misquoted}`;
}

/**
 * The commands of the run's checks a conflict report quotes, when everything it quotes is one: a
 * task torn between a criterion that names a host check and a brief that forbids starting it
 * (srcwhere T007, bench round 52: "-m ruff check ."). Empty when the report quotes anything else.
 */
export function quotedCheckCommands(report: string, checks: CaseContext["checks"]): string[] {
  const quoted = [...report.matchAll(/"([^"\n]{2,})"|`([^`\n]{2,})`/g)].map((m) =>
    (m[1] ?? m[2] ?? "").trim(),
  );
  return quoted.length && quoted.every((q) => isCheckCommand(q, checks))
    ? [...new Set(quoted)]
    : [];
}

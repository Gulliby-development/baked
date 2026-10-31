import { LONG_RUN, runSpans } from "../verification/byte-runs.js";
import type { TaskGraph } from "./schemas.js";
import { suppliedRows } from "./sizing.js";

/**
 * A restatement of a prescribed row checked against the request's own text (#2561). R82 tinyflate
 * deflate 82f19908 prescribes `tests/deflate_match_test.c` rows 7 and 8 with 300 bytes of `0x78`
 * (expected `ab1805440300`) and 259 of `0x71` (`2b1c0500`). A reviewer wrote "the request supplies
 * 306 repeated x bytes and 283 repeated q bytes" (a miscount), a skeptic confirmed it, the
 * corrective T008 wrote 306/283 and reported a spec conflict, and the second audit of T009 settled
 * it for the requirements (`assumptions/conflicts/T009-reaudited.json`: "The settled clarification
 * specifies 306 repeated x bytes ... This yields ab1805240200"), although the re-audit itself said
 * the request held no quote for it. Every later brief demanded 306/283 and the new streams, and the
 * run blocked `invalid_output` with the file at the request's 300/259 and every check passing.
 *
 * The request's rows are read only through `suppliedRows` (the one reader of row blocks); a
 * restatement (a finding, a skeptic's explanation, a settled conflict, a decision's answer, a
 * task's description) is read for the two things that can contradict a row: a count of a long
 * byte run it attributes to the request (`runClaims`: "the request supplies 306 repeated x bytes",
 * "the exact prescribed 306-byte x input", "the required 306"), and a re-audit's recomputed
 * expected value for a row the request gives with another (`derivationRowConflicts`). A claim
 * contradicts the request when the files it is about hold prescribed runs of its byte, none with
 * its count, and the nearest is within a quarter of it (a miscount, not another number).
 *
 * Every contradiction found records `conflicts/row-claims/<site>-<ref>.json` (kind `row-claim`).
 * With the policy field `rowClaimCheck` absent (on) the request wins: a finding is refuted by the
 * host, a conflict is settled for the request's rows instead of for the requirements, a decision or
 * settled conflict recorded before is overridden (`overrides`, which `conflictDecisions` and
 * `settledConflicts` skip), and the task's brief names the rows as the request gives them.
 * `rowClaimCheck: "off"` records the same in shadow (`would_override`) and changes nothing.
 */
export const ROW_CLAIM_KIND = "row-claim";
export const ROW_CLAIM_DIR = "conflicts/row-claims/";

/** A count of a long byte run a text attributes to the request. */
export interface RunClaim {
  count: number;
  /** The byte, when the text names it (`x`, `'x'`, `0x78`); null when it does not. */
  byte: number | null;
}

/** One way a restatement contradicts a prescribed row. */
export interface RowClaimConflict {
  path: string;
  /** The row's place in the request's block(s) for the file, from 1. */
  row: number;
  /** `run`: a long run's count; `literal`: a recomputed expected value. */
  kind: "run" | "literal";
  /** The run's byte (`run` only, when the restatement names one). */
  byte?: number;
  /** What the restatement gives: a count, or the literal it recomputed. */
  claimed: number | string;
  /**
   * What the request gives: the row's count (every long count of the files, joined, for a count
   * with no byte), or the row's literals the restatement lacks.
   */
  prescribed: number | string;
}

export interface RowClaimRecord {
  schemaVersion: 1;
  /** Where the restatement was read. */
  site: "finding" | "refutation" | "decision" | "resume" | "task";
  /** The finding id, the task id or the artifact path the restatement comes from. */
  ref: string;
  taskId?: string;
  mode: "shadow" | "on";
  conflicts: RowClaimConflict[];
  /** `overridden`: the request's rows won; `would_override`: shadow, recorded only. */
  verdict: "overridden" | "would_override";
  /** The decision and assumption paths the request's rows override (`on` only). */
  overrides?: string[];
}

const BYTE = String.raw`(?:0x[0-9a-fA-F]{2}(?![0-9a-fA-F])|'[!-~]'|"[!-~]"|\x60[!-~]\x60|[A-Za-z0-9](?![\w-]))`;
const COUNT = String.raw`(?<![\w.-])(?<n>\d{2,7})`;
const KIND = "(?:repeated|identical|consecutive)";
/** A count with its unit: `306 repeated x bytes`, `306-byte x input`, `0x78 repeated 306 times`. */
const UNITS: RegExp[] = [
  String.raw`${COUNT}(?:\s+${KIND})?(?:\s+(?<b>${BYTE}))?(?:\s+${KIND})?\s+bytes?\b(?:\s+of\s+(?<o>${BYTE}))?`,
  String.raw`${COUNT}-byte\b(?:\s+(?<b>${BYTE}))?`,
  String.raw`(?<![\w-])(?<b>${BYTE})\s+(?:${KIND}\s+)?(?<n>\d{2,7})\s+times\b`,
].map((source) => new RegExp(source, "gi"));
const BARE = new RegExp(COUNT, "g");
/** Words that attribute what follows to the request. */
const ATTRIBUTES =
  /\b(?:request(?:s|ed)?|prescrib\w*|suppl(?:y|ies|ied)|brief|settled|clarification|specif(?:y|ies|ied)|required|requires|exact|original|restor\w*)\b/gi;
/** Words that say a count is the file's, not the request's. */
const FILE_VERBS =
  /\b(?:contains?|contained|has|have|had|holds?|held|uses?|used|spells?|delivered|writes?|wrote|written|found|current(?:ly)?|now)\b/i;
const SENTENCE = /(?<=[.;!?])\s+|\n+|:\s+/;
const CLAUSE = /,\s*(?:but|while|whereas|yet)\b|\bbut\b|\binstead of\b|\brather than\b|\bnot\b/i;

const byteOf = (spelled: string | undefined): number | null => {
  if (!spelled) return null;
  if (/^0x/i.test(spelled)) return Number.parseInt(spelled.slice(2), 16);
  const bare = spelled.replace(/^['"`]|['"`]$/g, "");
  return bare.length === 1 ? bare.charCodeAt(0) : null;
};

/** Whether `before`, the clause text ahead of a count, attributes it to the request. */
function attributed(before: string, words: number): boolean {
  const tail = before.split(/\s+/).filter(Boolean).slice(-words).join(" ");
  const matches = [...tail.matchAll(ATTRIBUTES)];
  const last = matches.at(-1);
  if (!last) return false;
  return !FILE_VERBS.test(tail.slice((last.index ?? 0) + last[0].length));
}

/**
 * The long-run counts a text attributes to the request: a count with its unit within eight words
 * after an attributing word of its clause ("the request supplies 306 repeated x bytes and 283
 * repeated q bytes"), and a bare count right after one ("instead of the required 306") in a
 * sentence that names a unit, with the sentence's byte when it names one only. A count the clause
 * gives the file ("line 11 contains 312 repeated x bytes") is not a claim about the request.
 */
export function runClaims(text: string): RunClaim[] {
  const out: RunClaim[] = [];
  for (const sentence of text.split(SENTENCE)) {
    const units = UNITS.flatMap((re) =>
      [...sentence.matchAll(re)].map((m) => ({
        at: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
        count: Number(m.groups?.n),
        byte: byteOf(m.groups?.b ?? m.groups?.o),
      })),
    ).filter((u) => u.count >= LONG_RUN);
    if (!units.length) continue;
    const bytes = [...new Set(units.map((u) => u.byte).filter((b) => b !== null))];
    const sentenceByte = bytes.length === 1 ? (bytes[0] ?? null) : null;
    const clauseStart = (at: number) => {
      let start = 0;
      for (const m of sentence.slice(0, at).matchAll(new RegExp(CLAUSE.source, "gi")))
        start = (m.index ?? 0) + m[0].length;
      return start;
    };
    for (const u of units)
      if (attributed(sentence.slice(clauseStart(u.at), u.at), 8))
        out.push({ count: u.count, byte: u.byte ?? sentenceByte });
    for (const m of sentence.matchAll(BARE)) {
      const at = m.index ?? 0;
      const count = Number(m.groups?.n);
      if (count < LONG_RUN || units.some((u) => at >= u.at && at < u.end)) continue;
      if (attributed(sentence.slice(clauseStart(at), at), 3))
        out.push({ count, byte: sentenceByte });
    }
  }
  return out;
}

/** One long run of a prescribed row. */
interface PrescribedRun {
  path: string;
  row: number;
  byte: number;
  count: number;
}

const plain = (path: string) => path.trim().replace(/^(?:\.\/)+/, "");

/** The test files a graph writes. */
export function graphPaths(graph: Pick<TaskGraph, "tasks"> | null | undefined): string[] {
  return [
    ...new Set(
      (graph?.tasks ?? []).flatMap((t) =>
        t.writes.filter((w) => w.action !== "delete").map((w) => plain(w.path)),
      ),
    ),
  ];
}

/** The rows the request prescribes for `paths` (`suppliedRows`), by file. */
function rowLines(request: string, paths: readonly string[]): Map<string, string[]> {
  return new Map([...suppliedRows(request, paths)].map(([path, block]) => [path, block.lines]));
}

function prescribedRuns(rows: Map<string, string[]>): PrescribedRun[] {
  return [...rows].flatMap(([path, lines]) =>
    lines.flatMap((line, i) =>
      runSpans(line).flatMap((span) =>
        span.readings.flatMap((runs) =>
          runs
            .filter((r) => r.count >= LONG_RUN)
            .map((r) => ({ path, row: i + 1, byte: r.byte, count: r.count })),
        ),
      ),
    ),
  );
}

/** The files of `rows` a text names, or all of them when it names none. */
function scoped(rows: Map<string, string[]>, text: string): Map<string, string[]> {
  const named = [...rows].filter(([path]) => text.includes(path));
  return named.length ? new Map(named) : rows;
}

/**
 * The prescribed rows of the test files of `paths` a restatement's run counts contradict: for each
 * count it attributes to the request (`runClaims`), when the files hold prescribed runs of its byte
 * (of any byte when it names none), none with the count, and the nearest within a quarter of it.
 */
export function rowClaimConflicts(
  request: string,
  paths: readonly string[],
  text: string,
): RowClaimConflict[] {
  const claims = runClaims(text);
  if (!claims.length) return [];
  const runs = prescribedRuns(scoped(rowLines(request, paths), text));
  const out: RowClaimConflict[] = [];
  for (const claim of claims) {
    const candidates = runs.filter((r) => claim.byte === null || r.byte === claim.byte);
    if (!candidates.length || candidates.some((r) => r.count === claim.count)) continue;
    const nearest = candidates.reduce((a, b) =>
      Math.abs(b.count - claim.count) < Math.abs(a.count - claim.count) ? b : a,
    );
    if (Math.abs(nearest.count - claim.count) > nearest.count / 4) continue;
    if (
      out.some((c) => c.path === nearest.path && c.row === nearest.row && c.claimed === claim.count)
    )
      continue;
    // A count with no byte is no row's: it names every count the files give instead.
    out.push({
      path: nearest.path,
      row: nearest.row,
      kind: "run",
      ...(claim.byte === null ? {} : { byte: nearest.byte }),
      claimed: claim.count,
      prescribed:
        claim.byte === null
          ? [...new Set(candidates.map((r) => r.count))].join(", ")
          : nearest.count,
    });
  }
  return out;
}

const QUOTED = /"((?:\\.|[^"\\])*)"/g;
const HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{8,}(?![0-9A-Za-z])/g;

/**
 * The prescribed rows a re-audit's recomputation gives another expected value for: a derivation of
 * `<path> row N` (the request's row N of that file) whose recomputed hex literals of eight digits
 * or more are not in the row as the request gives it.
 */
export function derivationRowConflicts(
  request: string,
  paths: readonly string[],
  derivations: readonly { row: string; recomputed: string; matches: boolean }[],
): RowClaimConflict[] {
  const rows = rowLines(request, paths);
  return derivations.flatMap((d): RowClaimConflict[] => {
    if (d.matches) return [];
    const at = /^\s*(\S+)\s+row\s+(\d+)\b/i.exec(d.row);
    if (!at) return [];
    const path = plain(at[1] ?? "");
    const row = Number(at[2]);
    const line = rows.get(path)?.[row - 1];
    if (!line) return [];
    const given = [...line.matchAll(QUOTED)].map((m) => m[1] ?? "");
    const lower = line.toLowerCase();
    const claimed = [...d.recomputed.matchAll(HEX)]
      .map((m) => m[0])
      .filter((hex) => !lower.includes(hex.toLowerCase()));
    if (!claimed.length) return [];
    const lacked = given.filter(
      (g) => g.length < 64 && !d.recomputed.includes(g) && /[0-9a-fA-F]{8,}/.test(g),
    );
    return [
      {
        path,
        row,
        kind: "literal",
        claimed: claimed.join(" "),
        prescribed: lacked.join(" ") || line.slice(0, 120),
      },
    ];
  });
}

const hexByte = (byte: number) => `0x${byte.toString(16).padStart(2, "0")}`;

/** One conflict in the words of a brief. */
export function rowClaimText(c: RowClaimConflict): string {
  if (c.kind === "literal")
    return `${c.path} row ${c.row}: the request gives ${JSON.stringify(c.prescribed)}, not ${JSON.stringify(c.claimed)}`;
  return c.byte === undefined
    ? `${c.path}: ${c.claimed} bytes is the count of none of its rows' runs (they are ${c.prescribed} bytes)`
    : `${c.path} row ${c.row}: the request gives ${c.prescribed} bytes of ${hexByte(c.byte)}, not ${c.claimed}`;
}

/**
 * The brief's account of the contradicted rows: each conflict, then each row verbatim as the
 * request gives it (long runs written as their counts, so the note stays short).
 */
export function rowClaimNote(
  request: string,
  conflicts: readonly RowClaimConflict[],
  source: string,
): string {
  const rows = rowLines(request, [...new Set(conflicts.map((c) => c.path))]);
  const quoted = [...new Set(conflicts.map((c) => `${c.path}\u0000${c.row}`))].flatMap((key) => {
    const [path = "", row = "0"] = key.split("\u0000");
    const line = rows.get(path)?.[Number(row) - 1];
    if (!line) return [];
    const short = line.replace(
      /([0-9a-fA-F]{2})\1{15,}/g,
      (run, unit: string) => `[${unit} repeated ${run.length / unit.length} times]`,
    );
    return [`${path} row ${row} as the request gives it: ${short.slice(0, 400)}`];
  });
  return `${source} restates prescribed rows differently from the request, and the request's text wins: ${conflicts.map(rowClaimText).join("; ")}. ${quoted.join(" ")} Keep each of these rows exactly as the request gives it, its input and its expected output, and make the code give them; a finding, settled conflict or task description that asks for other counts or other expected values miscounted the request.`;
}

/** The decision and assumption paths the request's rows overrode (`on` records only). */
export function overriddenPaths(records: readonly RowClaimRecord[]): Set<string> {
  return new Set(records.filter((r) => r.mode === "on").flatMap((r) => r.overrides ?? []));
}

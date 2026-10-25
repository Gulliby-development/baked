import { misquotation } from "./conflict-rows.js";

/**
 * The host's own correction of a test that misquotes a criterion (#2047). nodepluck eval T004
 * (bench round 66): the test spelled AC-007's row with ten zeros where the criterion has eleven,
 * the task reported `spec_conflict`, the host settled it as a misquote (`settleContestedRows`) and
 * a fresh implementer session on the full task prompt (1.23M tokens, 28 steps, 14 check runs)
 * changed that one literal. The host had the exact literal, the test's spelling and the file.
 *
 * When every misquoted literal's spelling occurs exactly once in the task's test files, carries no
 * escape, and the criterion's literal needs no character a string literal of a supported language
 * may escape (beyond those the test's spelling already uses unescaped), the replacement is exact
 * and unambiguous: the host makes it as a journaled edit and runs the task's required checks. When
 * they pass, the task goes on as implemented without another session; when one fails, the edit is
 * put back and the session opens as before. Every misquote settle records its inputs as
 * `conflicts/misquote/<task>.json` (kind `misquote-fix`, kept in bench traces), replayed by
 * `replayMisquoteFixes`. With the policy field `misquoteFix` absent the decision is shadow: it is
 * recorded and the session opens.
 */
export const MISQUOTE_FIX_KIND = "misquote-fix";
export const MISQUOTE_FIX_DIR = "conflicts/misquote/";

/** A literal of a criterion the test spells with a small change, and how it spells it. */
export interface Misquote {
  /** The criterion. */
  id: string;
  literal: string;
  quoted: string;
}

/** What the decision knows of one misquoted literal; no text, so a trace holds no prose. */
export interface MisquoteSite {
  criterionId: string;
  /** How often the test's spelling occurs in the task's test files, all of them together. */
  occurrences: number;
  /** The test's spelling holds no backslash: its source text is its value. */
  unescaped: boolean;
  /**
   * Every character of the criterion's literal either occurs unescaped in the test's spelling or
   * is one that no string literal of a supported language escapes or interpolates.
   */
  plain: boolean;
  /** After the replacement the test files hold the literal as written (`misquotation` is null). */
  held: boolean;
}

export interface MisquoteFixVerdict {
  apply: boolean;
  /** Why a session corrects the test instead; null when the host would apply the edit. */
  reason: string | null;
}

/** What `conflicts/misquote/<task>.json` records: the decision's inputs, verdict and outcome. */
export interface MisquoteFixRecord extends MisquoteFixVerdict {
  taskId: string;
  /** `shadow`: recorded only, the session opens; `on`: the host applies an exact replacement. */
  mode: "shadow" | "on";
  sites: MisquoteSite[];
  /** The task's required checks on the host's edit; null when the host did not edit. */
  checks: "passed" | "failed" | "none" | null;
  /** The test files the host edited (put back when `checks` is `failed`). */
  files: string[];
  /**
   * What corrects the test when the host does not (#2058): `continue`, the task's next attempt
   * continues at a bounded cap with the one-line finding (and the failing check's output);
   * `session`, a full new session as before; null when the host's edit stands.
   */
  fallback?: MisquoteFallback | null;
}

export type MisquoteFallback = "continue" | "session";

export type MisquoteFixRule = (sites: readonly MisquoteSite[]) => MisquoteFixVerdict;

/** The cap of a misquote continuation (#2058): one literal to copy, then the task's checks. */
export const MISQUOTE_CONTINUE_STEPS = 8;
export const MISQUOTE_CONTINUE_TOKENS = 150_000;

const no = (reason: string): MisquoteFixVerdict => ({ apply: false, reason });

/** Characters no string literal of C#, Go, Java, JavaScript, Python or Rust escapes or interpolates. */
const PLAIN = /^[A-Za-z0-9 _.,:;!?@#&*+\-=/<>()[\]|^~]$/u;

/**
 * The one rule for whether the host corrects a misquoted test itself (#2047): every misquote's
 * spelling occurs exactly once in the task's test files, carries no escape, the criterion's
 * literal is plain, and the replacement leaves the test holding the literal as written.
 */
export const misquoteFixDecision: MisquoteFixRule = (sites) => {
  if (!sites.length) return no("no misquoted literal");
  for (const s of sites) {
    if (s.occurrences === 0)
      return no(`the test's spelling of ${s.criterionId}'s literal is not in its test files`);
    if (s.occurrences > 1)
      return no(
        `the test's spelling of ${s.criterionId}'s literal occurs ${s.occurrences} times, so the replacement is ambiguous`,
      );
    if (!s.unescaped)
      return no(
        `the test spells ${s.criterionId}'s literal with escapes the host does not rewrite`,
      );
    if (!s.plain)
      return no(
        `${s.criterionId}'s literal has characters a string literal may need to escape or interpolate`,
      );
    if (!s.held)
      return no(`after the replacement the test still does not hold ${s.criterionId}'s literal`);
  }
  return { apply: true, reason: null };
};

/** Non-overlapping occurrences of `part` in `text`. */
function occurrences(text: string, part: string): number {
  if (!part) return 0;
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count++;
  return count;
}

/**
 * The decision's inputs for the misquotes of a task, and the files as the exact replacement
 * leaves them (each misquote's single occurrence replaced by the literal, in order). `edits` holds
 * only the files that change.
 */
export function misquoteFixPlan(
  misquoted: readonly Misquote[],
  files: readonly { path: string; text: string }[],
): { sites: MisquoteSite[]; edits: { path: string; before: string; after: string }[] } {
  const after = new Map(files.map((f) => [f.path, f.text]));
  const sites = misquoted.map((m): MisquoteSite => {
    const found = [...after].map(([path, text]) => ({ path, count: occurrences(text, m.quoted) }));
    const total = found.reduce((sum, f) => sum + f.count, 0);
    const own = new Set(m.quoted);
    const plain = [...m.literal].every((ch) => (own.has(ch) && ch !== "\\") || PLAIN.test(ch));
    const unescaped = !m.quoted.includes("\\");
    const site = found.find((f) => f.count === 1);
    if (total === 1 && unescaped && plain && site) {
      const text = after.get(site.path) ?? "";
      after.set(
        site.path,
        text.replace(m.quoted, () => m.literal),
      );
    }
    return { criterionId: m.id, occurrences: total, unescaped, plain, held: false };
  });
  const texts = [...after.values()];
  for (const [i, m] of misquoted.entries()) {
    const site = sites[i];
    if (site)
      site.held =
        texts.some((text) => text.includes(m.literal)) && misquotation(m.literal, texts) === null;
  }
  return {
    sites,
    edits: files.flatMap((f) => {
      const text = after.get(f.path) ?? f.text;
      return text === f.text ? [] : [{ path: f.path, before: f.text, after: text }];
    }),
  };
}

/**
 * The fallback when the host does not correct the test itself (#2058). nodepluck eval T004: a
 * fresh session on the full task prompt spent 1.23M tokens on one literal. A misquote the host
 * names (a criterion, the row's literal and the test's spelling) is corrected by the task's next
 * attempt as a continuation at `MISQUOTE_CONTINUE_STEPS` / `MISQUOTE_CONTINUE_TOKENS`, with the
 * finding and, when the host's edit failed a check, that check's output. A task that already used
 * its continuation, or a settle with no misquote site, opens the full session as before.
 */
export function misquoteFallback(
  record: Pick<MisquoteFixRecord, "sites" | "apply" | "checks">,
  continued: boolean,
): MisquoteFallback | null {
  if (record.apply && record.checks === "passed") return null;
  return record.sites.length && !continued ? "continue" : "session";
}

/** The one-line finding a misquote continuation gets: the criterion, its literal, the test's. */
export function misquoteFinding(misquoted: readonly Misquote[]): string {
  return `The test misquotes the criterion rows: ${misquoted.map((m) => `${m.id} states ${JSON.stringify(m.literal)}, the test has ${JSON.stringify(m.quoted)}`).join("; ")}.`;
}

/** The record of a misquote settle's host-fix decision. */
export function misquoteFixRecord(
  taskId: string,
  mode: MisquoteFixRecord["mode"],
  sites: MisquoteSite[],
  decide: MisquoteFixRule = misquoteFixDecision,
): MisquoteFixRecord {
  return { taskId, mode, sites, ...decide(sites), checks: null, files: [] };
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { familyKey } from "./finding-chain.js";
import type { Repro, Spec } from "./schemas.js";

/**
 * The cross-run list of defect classes by domain (#1970): the bench control apps repeated one
 * class every round because each run started with nothing (md-site's emphasis delimiters in R55,
 * R56, R57, R59 and R62, 277k to 506k tokens each). A run whose policy turns it on adds the
 * families of its resolved correctness findings to a file in the BAKED data directory, keyed by
 * domain; the planner and the planned implementers of a later run whose request or spec names
 * that domain get the class names with a few cases, as examples and never as criteria.
 */

/** The file in the BAKED data directory. */
export const DEFECT_CLASSES_FILE = "defect-classes.json";
/** Classes kept per domain, the most recently seen first. */
export const CLASSES_PER_DOMAIN = 8;
/** Cases kept per class, the newest. */
export const CASES_PER_CLASS = 3;

/** The domains a class is filed under, each with the words that name it in a request or a finding. */
export const DOMAINS: readonly { key: string; label: string; words: RegExp }[] = [
  {
    key: "markdown",
    label: "Markdown",
    words: /\b(markdown|commonmark|emphasis|inline code|code spans?|md)\b/i,
  },
  {
    key: "csv",
    label: "CSV and delimited text",
    words: /\b(csv|tsv|comma[- ]separated|delimited|quoting)\b/i,
  },
  {
    key: "url",
    label: "URLs and HTTP",
    words: /\b(urls?|redirects?|http|headers?|query strings?|percent[- ]encod\w*|shorten\w*)\b/i,
  },
  {
    key: "decimal",
    label: "Decimal numbers and money",
    // Not "totals" or "expenses": they name an app's subject, not decimal arithmetic (#2140).
    words: /\b(decimals?|rounding|currency|money|amounts?)\b/i,
  },
  {
    key: "dates",
    label: "Dates and times",
    words: /\b(dates?|times?tamps?|time ?zones?|iso ?8601|calendar)\b/i,
  },
  {
    key: "text-layout",
    label: "Text layout and whitespace",
    words: /\b(whitespace|trailing spaces?|indentation|man ?pages?|line wrap\w*|columns?)\b/i,
  },
  { key: "json", label: "JSON and structured data", words: /\b(json|yaml|toml|schema)\b/i },
  {
    key: "cli",
    label: "Command-line arguments",
    words: /\b(cli|command[- ]line|flags?|arguments?|argv)\b/i,
  },
];

/**
 * The bucket of classes whose findings name no domain, in a run whose request names none or
 * several (#2140). It is shown only to a run whose request and spec name no domain at all.
 */
export const GENERAL_DOMAIN = "general";
/** The longest command or input a case keeps whole; a longer one is kept as a one-line summary. */
export const CASE_TEXT_MAX = 2000;
/** The longest expected or printed value a case keeps; a longer one keeps its end. */
export const CASE_VALUE_MAX = 500;
/** The characters of each argument a summarized command keeps. */
const SUMMARY_ARG = 80;

/** One case of a class: the command that showed it and what it printed against what was required. */
export interface DefectCase {
  command: string;
  stdin?: string;
  expected: string;
  actual: string;
  /**
   * True when the command or input was longer than `CASE_TEXT_MAX` and is a summary (the
   * executable and each argument's first characters), to read and never to run (#2140).
   */
  summarized?: true;
}

export interface DefectClass {
  /** The reviewer's family label, folded (`familyKey`). */
  family: string;
  /** Runs that resolved a finding of the class. */
  runs: number;
  /** When a run last added it (ISO time). */
  seen: string;
  cases: DefectCase[];
}

export type DefectClasses = Record<string, DefectClass[]>;

/** The text a run's domains are read from: the request as written, the spec's title and requirements. */
export function defectRunText(state: {
  requestText: string;
  prompt: string;
  spec?: Spec | null | undefined;
}): string {
  return [
    state.requestText || state.prompt,
    state.spec?.title ?? "",
    ...(state.spec?.requirements ?? []).map((r) => r.text),
  ].join("\n");
}

/** The domains whose words a text names. */
export function domainsOf(text: string): string[] {
  return DOMAINS.filter((d) => d.words.test(text)).map((d) => d.key);
}

/** How many times each domain's words occur in a text. */
function domainScores(text: string): Map<string, number> {
  return new Map(
    DOMAINS.map((d) => [d.key, text.match(new RegExp(d.words.source, "gi"))?.length ?? 0]),
  );
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** A value's end, where a repro's last line (what was printed against what was required) is. */
const tail = (text: string, max: number) =>
  text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
const oneLine = (text: string) => cut(text.replace(/\s+/g, " "), SUMMARY_ARG);

/**
 * A repro as a case of the list (#2140): its command line and input whole up to
 * `CASE_TEXT_MAX`, else a one-line summary marked `summarized` (never a program cut mid-way),
 * and its two values with their ends kept.
 */
export function defectCase(repro: Repro): DefectCase {
  const whole = [repro.executable, ...repro.args].join(" ");
  const longCommand = whole.length > CASE_TEXT_MAX;
  const longStdin = (repro.stdin?.length ?? 0) > CASE_TEXT_MAX;
  const command = longCommand
    ? `${[repro.executable, ...repro.args.map(oneLine)].join(" ")} (summary of a ${String(whole.length)}-character command)`
    : whole;
  const stdin =
    repro.stdin && longStdin
      ? `${oneLine(repro.stdin)} (summary of ${String(repro.stdin.length)} characters of input)`
      : repro.stdin;
  return {
    command,
    ...(stdin ? { stdin } : {}),
    expected: tail(repro.expected, CASE_VALUE_MAX),
    actual: tail(repro.actual, CASE_VALUE_MAX),
    ...(longCommand || longStdin ? { summarized: true as const } : {}),
  };
}

/**
 * The one domain a finding is filed under (#2140): the domain whose words occur most often in
 * its family, claim, symbol, file path and repro command, a tie going to a domain the run names
 * and then to `DOMAINS` order. A finding that names no domain goes to the run's domain when the
 * run names exactly one, else to `GENERAL_DOMAIN`; never to every domain the run names.
 */
export function defectDomain(
  finding: {
    family?: string | null | undefined;
    claim: string;
    file: string | null;
    symbol: string | null;
    repro?: Repro | undefined;
  },
  runDomains: readonly string[],
): string {
  const scores = domainScores(
    [
      finding.family ?? "",
      finding.claim,
      finding.symbol ?? "",
      finding.file ?? "",
      ...(finding.repro ? [finding.repro.executable, ...finding.repro.args] : []),
    ].join(" "),
  );
  let best: string | null = null;
  let bestScore = 0;
  for (const { key } of DOMAINS) {
    const score = scores.get(key) ?? 0;
    if (
      score > bestScore ||
      (score > 0 &&
        score === bestScore &&
        runDomains.includes(key) &&
        !runDomains.includes(best ?? ""))
    ) {
      best = key;
      bestScore = score;
    }
  }
  if (best) return best;
  return runDomains.length === 1 ? (runDomains[0] ?? GENERAL_DOMAIN) : GENERAL_DOMAIN;
}

/** What one run adds: a family seen in it, under each domain it belongs to, with its cases. */
export interface DefectAddition {
  domain: string;
  family: string;
  cases: DefectCase[];
}

/**
 * The resolved correctness findings of a run as additions (#1970). Each finding is filed under
 * one domain (`defectDomain`, #2140); a finding without a family names no class and is left
 * out. One run counts once per class.
 */
export function defectAdditions(
  findings: readonly {
    kind: string;
    family?: string | null | undefined;
    claim: string;
    file: string | null;
    symbol: string | null;
    repro?: Repro | undefined;
  }[],
  runText: string,
): DefectAddition[] {
  const runDomains = domainsOf(runText);
  const additions = new Map<string, DefectAddition>();
  for (const finding of findings) {
    const family = familyKey(finding.family);
    if (finding.kind !== "correctness" || !family) continue;
    const domain = defectDomain(finding, runDomains);
    const key = `${domain}\u0000${family}`;
    const addition = additions.get(key) ?? { domain, family, cases: [] };
    if (finding.repro) addition.cases.push(defectCase(finding.repro));
    additions.set(key, addition);
  }
  return [...additions.values()];
}

/**
 * The list with a run's additions merged in: a known class counts one more run and keeps its
 * newest cases, a new class is added, and each domain keeps its `CLASSES_PER_DOMAIN` most
 * recently seen classes.
 */
export function mergeDefectClasses(
  current: DefectClasses,
  additions: readonly DefectAddition[],
  seen: string,
): DefectClasses {
  const merged: DefectClasses = Object.fromEntries(
    Object.entries(current).map(([domain, classes]) => [domain, classes.map((c) => ({ ...c }))]),
  );
  for (const addition of additions) {
    const classes = merged[addition.domain] ?? [];
    merged[addition.domain] = classes;
    const known = classes.find((c) => c.family === addition.family);
    const target = known ?? { family: addition.family, runs: 0, seen, cases: [] };
    target.runs += 1;
    target.seen = seen;
    const key = (c: DefectCase) => JSON.stringify([c.command, c.stdin ?? null]);
    const fresh = addition.cases.filter((c) => !target.cases.some((k) => key(k) === key(c)));
    target.cases = [...target.cases, ...fresh].slice(-CASES_PER_CLASS);
    if (!known) classes.push(target);
  }
  for (const [domain, classes] of Object.entries(merged))
    merged[domain] = classes
      .sort((a, b) => b.seen.localeCompare(a.seen) || b.runs - a.runs)
      .slice(0, CLASSES_PER_DOMAIN);
  return merged;
}

export function readDefectClasses(file: string): DefectClasses {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { domains?: unknown };
    const domains = parsed.domains;
    if (!domains || typeof domains !== "object") return {};
    const read: DefectClasses = {};
    for (const [domain, classes] of Object.entries(domains as Record<string, unknown>))
      if (Array.isArray(classes))
        read[domain] = classes
          .filter(
            (c): c is DefectClass =>
              typeof c?.family === "string" &&
              typeof c?.runs === "number" &&
              typeof c?.seen === "string" &&
              Array.isArray(c?.cases),
          )
          .slice(0, CLASSES_PER_DOMAIN);
    return read;
  } catch {
    return {};
  }
}

/**
 * Adds a run's classes to the shared file: read back first so other processes' classes are kept,
 * then written through a temporary file and a rename (AGENTS.md, shared host state). Returns the
 * list as written; a file that cannot be written leaves the next run without it.
 */
export function addDefectClasses(
  file: string,
  additions: readonly DefectAddition[],
  seen: string,
): DefectClasses {
  const merged = mergeDefectClasses(readDefectClasses(file), additions, seen);
  if (!additions.length) return merged;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, domains: merged }));
    renameSync(temporary, file);
  } catch {
    // The list only helps the next run; the run itself does not depend on it.
  }
  return merged;
}

/**
 * The classes a run's planner and planned implementers are shown (#1970), read through this one
 * helper: the domains the run's request and spec name, each with its classes and their cases,
 * or the `GENERAL_DOMAIN` bucket when they name no domain at all (#2140). Null when nothing of
 * the list applies.
 */
export function defectClassesFor(
  file: string,
  runText: string,
): {
  domains: { domain: string; label: string; classes: DefectClass[] }[];
  note: string;
} | null {
  const list = readDefectClasses(file);
  const named = domainsOf(runText);
  const domains = (named.length ? named : [GENERAL_DOMAIN]).flatMap((domain) => {
    const classes = list[domain] ?? [];
    const label =
      DOMAINS.find((d) => d.key === domain)?.label ??
      (domain === GENERAL_DOMAIN ? "Not bound to a domain" : domain);
    return classes.length ? [{ domain, label, classes }] : [];
  });
  if (!domains.length) return null;
  return {
    domains,
    note: "Defect classes earlier runs on this machine corrected in the same domain, each with cases that showed it. They are examples of what tends to go wrong, never requirements: design the code so the class cannot occur (for nested delimiters, a delimiter stack rather than a pattern per case), and follow the spec where it differs.",
  };
}

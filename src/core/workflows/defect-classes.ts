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
    words: /\b(decimals?|rounding|currency|money|amounts?|totals?|expenses?)\b/i,
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

/** One case of a class: the command that showed it and what it printed against what was required. */
export interface DefectCase {
  command: string;
  stdin?: string;
  expected: string;
  actual: string;
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

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A repro as a case of the list: its command line, its input and its two values, each cut short. */
export function defectCase(repro: Repro): DefectCase {
  return {
    command: cut([repro.executable, ...repro.args].join(" "), 300),
    ...(repro.stdin ? { stdin: cut(repro.stdin, 200) } : {}),
    expected: cut(repro.expected, 200),
    actual: cut(repro.actual, 200),
  };
}

/** What one run adds: a family seen in it, under each domain it belongs to, with its cases. */
export interface DefectAddition {
  domain: string;
  family: string;
  cases: DefectCase[];
}

/**
 * The resolved correctness findings of a run as additions (#1970). A finding's domains are the
 * ones its family, claim, file and symbol name, else the ones the run's request and spec name; a
 * finding without a family names no class and is left out. One run counts once per class.
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
    const own = domainsOf(
      [finding.family, finding.claim, finding.file ?? "", finding.symbol ?? ""].join(" "),
    );
    for (const domain of own.length ? own : runDomains) {
      const key = `${domain}\u0000${family}`;
      const addition = additions.get(key) ?? { domain, family, cases: [] };
      if (finding.repro) addition.cases.push(defectCase(finding.repro));
      additions.set(key, addition);
    }
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
 * helper: the domains the run's request and spec name, each with its classes and their cases.
 * Null when the run names no domain the list holds.
 */
export function defectClassesFor(
  file: string,
  runText: string,
): {
  domains: { domain: string; label: string; classes: DefectClass[] }[];
  note: string;
} | null {
  const list = readDefectClasses(file);
  const domains = domainsOf(runText).flatMap((domain) => {
    const classes = list[domain] ?? [];
    const label = DOMAINS.find((d) => d.key === domain)?.label ?? domain;
    return classes.length ? [{ domain, label, classes }] : [];
  });
  if (!domains.length) return null;
  return {
    domains,
    note: "Defect classes earlier runs on this machine corrected in the same domain, each with cases that showed it. They are examples of what tends to go wrong, never requirements: design the code so the class cannot occur (for nested delimiters, a delimiter stack rather than a pattern per case), and follow the spec where it differs.",
  };
}

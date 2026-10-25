import {
  type LanguageRecord,
  none,
  rowOf,
  SUPPORTED_LANGUAGES,
} from "../intelligence/language-records.js";
import type { ReproOutcome } from "./repro.js";

/**
 * The edge-input probe of a source task (#1808): before the test tasks run against a source
 * task's code, one small call proposes extreme but legal inputs the task's criteria allow, and
 * the host runs them through the project's own entry points. The costliest control correctives
 * fixed exactly this class, found only by the final review: a non-ASCII redirect target that
 * Bun's `Headers` rejects (R54 url-shortener, 2.43M tokens), an amount `1e4300` past Python's
 * integer-string limit (R54 expenses-py, 586k), Decimal totals past 28 digits (R53, 295k).
 */

/** The probe's record of a source task: `probes/edge/<task>.json`, kind `EDGE_KIND`. */
export const EDGE_KIND = "edge-probe";
export const EDGE_DIR = "probes/edge/";
/** Cases one probe runs. */
export const EDGE_CASES = 12;

/** The input classes the probe draws from, the same for every language. */
export const EDGE_TAXONOMY: readonly string[] = [
  "huge and tiny numbers (many digits, large exponents, values just past a type's range, negative zero)",
  "very long strings and many items (thousands of characters or entries)",
  "non-ASCII text: accented and CJK letters, emoji, combining characters, right-to-left text",
  "empty and whitespace-only values, and values with leading or trailing spaces",
  "boundary dates and sizes (year 1 and 9999, leap days, zero and maximum sizes)",
  "reserved words of the program itself used as data (a route, command or keyword name)",
];

/**
 * Limits of each language's standard library and runtime that an extreme legal input reaches;
 * the probe is told the rows of the languages its task writes. A language whose runtime has no
 * such limit worth naming has a `none` row.
 */
export const NUMERIC_LIMITS: LanguageRecord<readonly string[]> = {
  typescript: [
    "Number loses integers past 2^53 and prints large values in exponent form",
    "Headers and URLs reject non-ASCII header values without encoding",
  ],
  javascript: [
    "Number loses integers past 2^53 and prints large values in exponent form",
    "Headers and URLs reject non-ASCII header values without encoding",
  ],
  python: [
    "int(str) and str(int) refuse more than 4300 digits (sys.set_int_max_str_digits)",
    "decimal's default context rounds past 28 significant digits",
    "the console encoding may not encode non-ASCII output on Windows",
  ],
  go: [
    "strconv.ParseInt and Atoi fail past int64; int arithmetic wraps silently",
    "float64 formatting switches to exponent form for large values",
  ],
  rust: [
    "integer overflow panics in debug builds and wraps in release",
    "str::parse fails past the target type's range",
  ],
  java: [
    "int and long arithmetic overflow silently; Integer.parseInt fails past int",
    "double formatting switches to exponent form for large values",
  ],
  kotlin: ["Int and Long arithmetic overflow silently; toInt() fails past Int"],
  scala: ["Int and Long arithmetic overflow silently; toInt fails past Int"],
  csharp: [
    "int arithmetic wraps unless checked; int.Parse fails past Int32",
    "decimal holds 28 to 29 significant digits",
  ],
  c: ["signed integer overflow is undefined behavior; strtol saturates at LONG_MAX"],
  cpp: ["signed integer overflow is undefined behavior; std::stoi throws past int"],
  ruby: none("Integer is arbitrary precision; no numeric limit worth a probe row"),
  php: ["integers past PHP_INT_MAX become floats"],
  swift: ["integer overflow traps at runtime"],
  lua: ["integers past 2^63 wrap; tonumber of a long digit string gives a float"],
  elixir: none("integers are arbitrary precision; no numeric limit worth a probe row"),
  dart: ["int is 64-bit on the VM and 2^53-exact when compiled to JavaScript"],
  zig: ["integer overflow is a panic in safe builds"],
  bash: ["arithmetic is 64-bit signed and wraps silently"],
  ocaml: ["int is 63-bit and wraps silently"],
  objc: ["NSInteger overflow wraps; NSNumber loses integers past 2^53 as double"],
  vue: none("a Vue component's limits are its script language's (typescript, javascript)"),
  svelte: none("a Svelte component's limits are its script language's (typescript, javascript)"),
  rescript: ["int is 32-bit and wraps silently"],
  solidity: ["uint256 arithmetic reverts on overflow since 0.8; unchecked blocks wrap"],
  sql: [
    "INTEGER is 32-bit and BIGINT 64-bit: PostgreSQL and SQL Server raise an overflow error, SQLite stores any integer as 64-bit",
    "NUMERIC and DECIMAL round or reject values past their declared precision and scale",
    "VARCHAR(n) rejects or truncates text past n characters, by dialect",
  ],
  powershell: [
    "[int] and [long] arithmetic past their range silently widens to [double] and loses integers past 2^53",
    "casting a too large value or numeric string to [int] throws",
    "[decimal] holds 28 to 29 significant digits",
  ],
  r: [
    "integer (1L) arithmetic past 2147483647 gives NA with a warning, not an error; as.integer of a larger value is NA",
    "numeric is a double: integers past 2^53 lose precision, and 0.1 + 0.2 == 0.3 is FALSE (compare with all.equal)",
    "NA propagates through arithmetic and comparisons, and an if() on NA is an error",
  ],
};

/** The taxonomy and the limits rows of `languages`, as the probe's input shows them. */
export function edgeTaxonomy(languages: readonly string[]): {
  classes: readonly string[];
  limits: { language: string; limits: readonly string[] }[];
} {
  const supported = [...new Set(languages)].filter((l) =>
    (SUPPORTED_LANGUAGES as readonly string[]).includes(l),
  );
  return {
    classes: EDGE_TAXONOMY,
    limits: supported.flatMap((language) => {
      const limits = rowOf(NUMERIC_LIMITS, language);
      return limits ? [{ language, limits }] : [];
    }),
  };
}

/**
 * Whether a probed case is a defect (#1808). The host runs each case as a repro whose actual is
 * its expected value: `reproduced` is a case the code gets right, `refuted` one that ran and
 * printed something else, `inconclusive` one that could not show either (a crash with a nonzero
 * exit, a program no check starts), which is left to the review.
 */
export type EdgeRule = (status: ReproOutcome["status"]) => "finding" | "pass";
export const edgeDecision: EdgeRule = (status) => (status === "refuted" ? "finding" : "pass");

/** What `probes/edge/<task>.json` records: each case's criterion, outcome and decision. */
export interface EdgeRecord {
  schemaVersion: 1;
  taskId: string;
  languages: string[];
  cases: {
    criterionId: string;
    status: ReproOutcome["status"];
    reason: string;
    decision: "finding" | "pass";
  }[];
}

/** The value a probed case printed, for its finding's repro: the output's last non-empty line. */
export function printedValue(output: string): string {
  const lines = output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 2000);
}

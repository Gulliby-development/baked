import stripAnsi from "strip-ansi";
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
 * exit, a program no check starts), which is left to the review. Whether an inconclusive case is
 * a crash inside the task's own files is `edgeCrashDecision`'s (#2136, shadow).
 */
export type EdgeRule = (status: ReproOutcome["status"]) => "finding" | "pass";
export const edgeDecision: EdgeRule = (status) => (status === "refuted" ? "finding" : "pass");

/**
 * How much of a probed case's output its record keeps (#2136): the end, where a crash's innermost
 * frames are. When the first error line falls before that end (a runtime that prints more after
 * the stack, as Bun on CI did), the tail opens with it, so the actual is kept. The crash decision
 * reads the same tail, so a record replays exactly.
 */
export const OUTPUT_TAIL_CHARS = 400;
export function outputTail(output: string): string {
  const tail = output.slice(-OUTPUT_TAIL_CHARS);
  if (output.length <= OUTPUT_TAIL_CHARS) return tail;
  const error = outputLines(output)
    .find((line) => ERROR_LINE.test(line))
    ?.trim()
    .slice(0, OUTPUT_TAIL_CHARS / 2);
  if (!error || stripAnsi(tail).includes(error)) return tail;
  const head = `${error}\n...\n`;
  return head + output.slice(-(OUTPUT_TAIL_CHARS - head.length));
}

/**
 * The stack-frame spelling of each runtime (#2136): one pattern per spelling, whose `file` group
 * names the source file of the frame. A new runtime's frame spelling joins this table with a case
 * in `tests/workflow-scenario-edge-crash.test.ts`. JVM frames name only the file's base name.
 */
export const CRASH_FRAMES: readonly { runtime: string; frame: RegExp; baseName?: true }[] = [
  // `    at createLink (C:\p\src\storage.ts:70:10)`, `    at file:///p/src/a.ts:3:9`
  {
    runtime: "bun, node, deno",
    frame:
      /^\s*at\s+(?:.*?\s\()?(?:file:\/\/\/?)?(?<file>(?:[A-Za-z]:)?[^():\s][^():]*?):\d+(?::\d+)?\)?\s*$/,
  },
  // `  File "/p/src/store.py", line 12, in add`
  { runtime: "python", frame: /^\s*File "(?<file>[^"]+)", line \d+/ },
  // `\t/p/internal/store.go:42 +0x1d`
  { runtime: "go", frame: /^\s+(?<file>(?:[A-Za-z]:)?[^\s:]+\.go):\d+(?:\s+\+0x[0-9a-f]+)?\s*$/ },
  // `\tat com.acme.Store.add(Store.java:57)`
  {
    runtime: "jvm",
    frame: /^\s*at\s+[\w$.<>/]+\((?<file>[\w$-]+\.(?:java|kt|scala|groovy)):\d+\)/,
    baseName: true,
  },
  // `   at Acme.Store.Add(String code) in /p/src/Store.cs:line 12`
  { runtime: ".net", frame: /^\s*at\s.+\sin\s(?<file>.+?):line\s\d+/ },
  // `thread 'main' panicked at src/store.rs:5:9:`, `   at ./src/store.rs:5:9`
  { runtime: "rust", frame: /(?:panicked at |^\s+at )(?<file>(?:[A-Za-z]:)?[^\s:]+\.rs):\d+/ },
  // `/p/lib/store.rb:12:in 'add': boom (RuntimeError)`, `\tfrom /p/lib/store.rb:3:in '<main>'`
  { runtime: "ruby", frame: /^\s*(?:from\s+)?(?<file>(?:[A-Za-z]:)?[^\s:]+\.rb):\d+:in\s/ },
  // `PHP Fatal error:  Uncaught Exception: boom in /p/src/Store.php:12`
  { runtime: "php", frame: /\bin (?<file>(?:[A-Za-z]:)?[^\s:]+\.php)(?::| on line )\d+/ },
  // `#0 /p/src/Store.php(12): add()`
  { runtime: "php trace", frame: /^#\d+\s+(?<file>[^\s(]+\.php)\(\d+\)/ },
  // `    (acme 0.1.0) lib/store.ex:12: Acme.Store.add/1`
  { runtime: "elixir", frame: /^\s+(?:\([\w.]+ [\w.-]+\)\s+)?(?<file>[^\s:]+\.exs?):\d+:/ },
  // `#0      add (file:///p/lib/store.dart:12:5)`
  { runtime: "dart", frame: /^#\d+\s+.*\((?:file:\/\/\/?)?(?<file>[^()]+\.dart):\d+(?::\d+)?\)/ },
  // `Fatal error: boom: file Sources/Store/Store.swift, line 12`
  { runtime: "swift", frame: /\bfile (?<file>[^\s,]+\.swift), line \d+/ },
  // AddressSanitizer: `    #0 0x55d1 in add /p/src/store.c:12:5`
  {
    runtime: "c, c++ (sanitizers)",
    frame: /^\s*#\d+\s+0x[0-9a-f]+\s+in\s+\S+\s+(?<file>(?:[A-Za-z]:)?[^\s:]+):\d+/,
  },
  // `lua: src/store.lua:12: boom`, `\tsrc/store.lua:12: in function 'add'`
  { runtime: "lua", frame: /^\s*(?:lua\S*:\s+)?(?<file>[^\s:]+\.lua):\d+:/ },
  // `./store.sh: line 12: boom: command not found`
  { runtime: "bash", frame: /^(?<file>[^\s:]+\.(?:sh|bash)): line \d+:/ },
];

/** A line that opens an uncaught error, in any runtime's spelling; Python's `Traceback` is not one. */
const ERROR_LINE =
  /^\s*(?:error:|Uncaught\b|Unhandled exception|Exception in thread|panic:|thread '.*' panicked|Fatal error:|PHP (?:Fatal|Parse) error|fatal error:|\*\* \(\w+\)|[\w.$]*(?:Error|Exception|Panic)\b[^:\n]*:)/;

const normalPath = (path: string): string =>
  path
    .replaceAll("\\", "/")
    .replace(/^file:\/\/\/?/, "")
    .replace(/^\.\//, "");

/** Whether a frame's file is `path`: the same path, or one ending in `/path` (an absolute frame). */
function namesFile(frameFile: string, path: string, baseName: boolean): boolean {
  const file = normalPath(frameFile);
  const own = normalPath(path);
  if (file === own || file.endsWith(`/${own}`)) return true;
  return baseName && own.split("/").at(-1) === file;
}

// A runtime that colours its output (FORCE_COLOR, as on CI) wraps `error` and paths in escapes.
const outputLines = (output: string): string[] =>
  stripAnsi(output).replace(/\r\n?/g, "\n").split("\n");

/** The frame lines of `output` that name one of `files`, by the frame table. */
export function ownFrames(output: string, files: readonly string[]): string[] {
  return outputLines(output).filter((line) =>
    CRASH_FRAMES.some(({ frame, baseName }) => {
      const file = frame.exec(line)?.groups?.file;
      return Boolean(file && files.some((path) => namesFile(file, path, Boolean(baseName))));
    }),
  );
}

/**
 * Whether an inconclusive probed case is a crash of the probed code itself (#2136): its output
 * holds a stack frame inside one of `files`, the files the probed task writes. Its repro's actual
 * is the first error line, or that frame's line. A case whose command itself fails (a syntax error
 * of the command, a module that does not exist, frames only outside those files) stays `pass`.
 * R68 url-shortener: T001's storage module threw `Missing parameter "code"` at `src/storage.ts:70`
 * on every call, both cases were inconclusive and passed, and the run blocked at 1.19M tokens.
 * Shadow: the decision is recorded with the case and a `decision.would_stop` of
 * `edge_crash_finding` names the finding it would be; nothing opens until that reason is promoted.
 */
export type EdgeCrashRule = (
  status: ReproOutcome["status"],
  output: string,
  files: readonly string[],
) => { decision: "finding" | "pass"; actual: string | null };
export const edgeCrashDecision: EdgeCrashRule = (status, output, files) => {
  if (status !== "inconclusive") return { decision: "pass", actual: null };
  const frames = ownFrames(output, files);
  if (!frames.length) return { decision: "pass", actual: null };
  const error = outputLines(output).find((line) => ERROR_LINE.test(line));
  return { decision: "finding", actual: (error ?? frames[0] ?? "").trim().slice(0, 2000) };
};

/** What `probes/edge/<task>.json` records: each case's criterion, outcome and decision. */
export interface EdgeRecord {
  schemaVersion: 1;
  taskId: string;
  languages: string[];
  /** The task's source files, which a crash's frame must name (#2136); absent before #2136. */
  files?: string[];
  cases: {
    criterionId: string;
    status: ReproOutcome["status"];
    reason: string;
    decision: "finding" | "pass";
    /** The output's last `OUTPUT_TAIL_CHARS` characters (#2136); absent before #2136. */
    outputTail?: string;
    /** `edgeCrashDecision` on `outputTail`, recorded in shadow (#2136); absent before #2136. */
    crash?: "finding" | "pass";
  }[];
}

/**
 * What a probed case's record keeps of its output (#2136): the tail and the shadow crash decision
 * on it against `files`, with the crash's actual for the would-stop record (null for `pass`). The
 * edge probe, the chain battery and the sibling probe record it alike.
 */
export function caseCrash(
  outcome: Pick<ReproOutcome, "status" | "output"> | undefined,
  files: readonly (string | null)[],
): { outputTail: string; crash: "finding" | "pass"; actual: string | null } {
  const tail = outputTail(outcome?.output ?? "");
  const own = files.filter((f): f is string => Boolean(f));
  const crash = edgeCrashDecision(outcome?.status ?? "inconclusive", tail, own);
  return { outputTail: tail, crash: crash.decision, actual: crash.actual };
}

/** A probed case as `probes/edge/<task>.json` keeps it, with the crash's actual (#2136). */
export function edgeCase(
  criterionId: string,
  outcome: Pick<ReproOutcome, "status" | "reason" | "output">,
  files: readonly string[],
): { recorded: EdgeRecord["cases"][number]; crashActual: string | null } {
  const { actual, ...crash } = caseCrash(outcome, files);
  return {
    recorded: {
      criterionId,
      status: outcome.status,
      reason: outcome.reason,
      decision: edgeDecision(outcome.status),
      ...crash,
    },
    crashActual: actual,
  };
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

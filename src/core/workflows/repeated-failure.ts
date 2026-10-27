import { tmpdir } from "node:os";
import stripAnsi from "strip-ansi";
import { hashJson } from "../specs/hash.js";

/**
 * A corrective whose required checks fail exactly as the corrective before it in the same chain
 * did (#1996). cfgquill lint a843cc11 (bench round 64): T005, T006 and T007 each failed gofmt and
 * tests-written with `internal\lint\rules_test.go:26:2217: illegal byte order mark`, byte for byte,
 * and each was a full model task (T007 alone 3.43M tokens); the chain stopped only when
 * `maxTaskRepairs` was spent, with a message that names a count, not the cause. A defect no model
 * action changes (a host-written region, a toolchain refusal) looks like three model failures
 * unless the rounds' evidence is compared.
 *
 * Each corrective's failing required checks are recorded as `repeats/tasks/<task>.json` (kind
 * `repeated-failure`, kept in bench traces): per check its id, its output normalized by
 * `normalizeCheckOutput`, and the files the output names failing; the hash covers all three. The
 * stop reason `repeated_failure` (`stop-reasons.ts`) is in shadow mode: a corrective whose hash
 * equals the one of the corrective it corrects records `decision.would_stop` with both round ids,
 * once per chain. `replayRepeatedFailures` (`trace.ts`) decides each record again.
 */
export const REPEAT_KIND = "repeated-failure";
/** One record per corrective whose required checks failed: `repeats/tasks/<task>.json`. */
export const REPEAT_TASKS_DIR = "repeats/tasks/";
/** The tail of each check's normalized output a record keeps and hashes. */
export const REPEAT_OUTPUT_CHARS = 4000;

export interface RepeatCheck {
  id: string;
  /** The check's output, normalized and cut to its last `REPEAT_OUTPUT_CHARS` characters. */
  text: string;
  /** The files the output names failing, sorted. */
  files: string[];
}

export type RepeatDecision = "first" | "progress" | "repeat";

/** What `repeats/tasks/<task>.json` records: the decision's inputs, with output stood in by a trace. */
export interface RepeatRecord {
  taskId: string;
  /** The corrective this one corrects, whose record it is compared with; null after a planned task. */
  previous: string | null;
  /** The first task of the chain: the planned task the first corrective was opened for. */
  root: string;
  checks: RepeatCheck[];
  hash: string;
  previousHash: string | null;
  /** The offset of the first character where the two rounds' evidence differs; null when equal. */
  firstDifference: number | null;
  decision: RepeatDecision;
}

/** Compares two rounds' failing checks; `replayRepeatedFailures` takes another rule to replay. */
export type RepeatRule = (previous: RepeatCheck[] | null, current: RepeatCheck[]) => RepeatDecision;

// Wall-clock stamps, durations, rates, seeds and addresses, by shape rather than by runner (#2281):
// go test's `0.012s`, bun's `[1.23ms]`, jest's `(5 ms)`, pytest's `in 0.12s`, busted's
// `: 0.015 seconds`, CTest's `0.01 sec`, Gradle's `BUILD FAILED in 1m 3s`, dotnet's
// `Duration: 12 ms`, PHPUnit's `Time: 00:00.012`, Minitest's `810.4 runs/s` and seed, Dart's
// `00:01 +3 -1:`, sbt's `Total time: 3 s, completed Oct 27, 2026, 1:02:03 AM`, busted's Windows
// `table: 00000184D28BE670`. A whole number with a unit stays unless a word that introduces a
// time comes before it (`in`, `after`, `took`, `Time:`, `Duration:`, `elapsed`), since it is as
// often a value the test asserts (`expected 5s`); line and column positions never match.
const UNIT = "(?:ns|µs|us|ms|milliseconds?|seconds?|secs?|sec|s|minutes?|mins?|min|m)";
const NUMBER = "\\d+(?:\\.\\d+)?";
const SPAN = `${NUMBER}\\s?(?:${UNIT}|h|hours?)\\b(?:,?\\s${NUMBER}\\s?${UNIT}\\b)*`;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const CLOCK = /\b\d{2}:\d{2}:\d{2}[.,]\d+\b/g;
// PHPUnit's `Time: 00:00.012`; Maven's `Total time:  01:05 min`.
const MINUTE_CLOCK = /(?<![\d:])\b\d{1,2}:\d{2}(?:[.,]\d+\b|(?::\d{2})? min\b)/g;
// Dart's progress line `00:01 +3 -1: Some tests failed.`
const DART_ELAPSED = /^\d{1,2}:\d{2}(?::\d{2})?(?= [+~-]\d)/gm;
// sbt's `Total time: 3 s, completed Oct 27, 2026, 1:02:03 AM`; vitest's `Start at  04:42:53`.
const COMPLETED_AT = /, completed [A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2}:\d{2}(?: [AP]M)?/g;
const STARTED_AT = /\b(Start(?:ed)? at)\s+\d{1,2}:\d{2}:\d{2}\b/g;
// vitest's summary `Duration  1.23s (transform 20ms, setup 0ms, ...)` and file line
// `❯ a.test.ts (2 tests | 1 failed) 7ms`.
const VITEST_DURATION = /^(\s*Duration)\s+\d.*$/gm;
const VITEST_FILE = /(\(\d+ tests?(?: \| \d+ \w+)*\))\s+\d+(?:\.\d+)?m?s\b/g;
// Swift's `in 0.004 (0.005) seconds`; prove's `0 wallclock secs ( 0.01 usr ... =  0.05 CPU)`;
// Pester's `[-] rejects 12ms (9ms|3ms)`; GoogleTest's `(1 ms total)`; node:test's `duration_ms 1.2`.
const SWIFT_DURATION = /\b\d+\.\d+ \(\d+\.\d+\) seconds\b/g;
const PROVE_DURATION = /\b\d+ wallclock secs \([^)]*\)/g;
const PESTER_DURATION = /\b\d+(?:\.\d+)?m?s \(\d+(?:\.\d+)?m?s\|\d+(?:\.\d+)?m?s\)/g;
const GTEST_TOTAL = /\(\d+(?:\.\d+)? ?ms total\)/g;
const DURATION_MS = /\b(duration_ms:?\s*)\d+(?:\.\d+)?/g;
// Zig's build summary `run test 1 passed 1 failed 3ms MaxRSS:1M`.
const ZIG_DURATION = /\b\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m)(\s+MaxRSS:)/g;
const MEMORY = /\b(MaxRSS:|Memory: )\d+(?:\.\d+)?\s?[KMG]?i?B?\b/g;
// Two or more parts (`1m 3s`, `1 minute 2.5 seconds`), anywhere.
const COMPOUND_DURATION = new RegExp(
  `\\b${NUMBER}\\s?(?:${UNIT}|h|hours?)\\b(?:,?\\s${NUMBER}\\s?${UNIT}\\b)+`,
  "g",
);
const INTRODUCED_DURATION = new RegExp(
  `\\b(in|after|took|[Tt]ime|[Dd]uration|[Ee]lapsed)(\\s*[:=]?\\s*)(?:<\\s*)?${SPAN}`,
  "g",
);
const DECIMAL_DURATION = new RegExp(`\\b\\d+\\.\\d+\\s?${UNIT}\\b`, "g");
const BRACKETED_DURATION = /([[(])\s*(?:<\s*)?\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s)\s*([\])])/g;
// Minitest's `810.4 runs/s, 1620.8 assertions/s`.
const RATE = /\b\d+(?:\.\d+)?\s?([A-Za-z]+)\/s\b/g;
// Minitest's `--seed 12345`, RSpec's and ExUnit's `Randomized with seed 52731`, GoogleTest's
// `with a seed of 1234`, pytest-randomly's `--randomly-seed=1234`; Alcotest's run ID.
const SEED = /\b(seed(?:\s+of)?[\s=:]*)\d+/gi;
const RUN_ID = /\b(This run has ID `)[A-Z0-9]+'/g;
// `0x` addresses, and Lua's `table: 00000184D28BE670` (Windows prints no `0x`).
const ADDRESS =
  /\b0x[0-9a-f]{6,}\b|(?<=\b(?:table|function|userdata|thread|cdata|builtin): )[0-9a-f]{8,}\b/gi;

const tempRoots = (): string[] =>
  [tmpdir().replaceAll("\\", "/"), "/tmp", "/var/folders", "/private/var/folders"].filter(
    (root, index, all) => root.length > 1 && all.indexOf(root) === index,
  );

/**
 * A check's output with what changes between two runs of the same failure taken out: terminal
 * colors, line endings and trailing spaces, path separators, wall-clock stamps, durations, rates,
 * memory sizes, random seeds and run IDs, temporary directories and memory addresses. Line and column positions stay, so a failure that
 * moved is progress, never a repeat. A check runner whose failing output carries another such
 * value adds its rule here, with the case in `tests/repeated-failure.test.ts` (two runs of each
 * toolchain's failing check hash equal; every runner of `TEST_RUNNERS` has one).
 */
export function normalizeCheckOutput(output: string): string {
  let text = stripAnsi(output).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  text = text.replaceAll("\\", "/");
  for (const root of tempRoots()) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}/[^\\s:'"\`)]+`, "gi"), "<tmp>");
  }
  text = text.replace(/[A-Za-z]:\/Users\/[^/\s]+\/AppData\/Local\/Temp\/[^\s:'"`)]+/gi, "<tmp>");
  text = text
    .replace(TIMESTAMP, "<time>")
    .replace(CLOCK, "<time>")
    .replace(MINUTE_CLOCK, "<duration>")
    .replace(DART_ELAPSED, "<time>")
    .replace(COMPLETED_AT, ", completed <time>")
    .replace(STARTED_AT, "$1 <time>")
    .replace(VITEST_DURATION, "$1 <duration>")
    .replace(VITEST_FILE, "$1 <duration>")
    .replace(SWIFT_DURATION, "<duration>")
    .replace(PROVE_DURATION, "<duration>")
    .replace(PESTER_DURATION, "<duration>")
    .replace(GTEST_TOTAL, "(<duration> total)")
    .replace(DURATION_MS, "$1<duration>")
    .replace(ZIG_DURATION, "<duration>$1")
    .replace(MEMORY, "$1<memory>")
    .replace(COMPOUND_DURATION, "<duration>")
    .replace(INTRODUCED_DURATION, "$1$2<duration>")
    .replace(BRACKETED_DURATION, "$1<duration>$2")
    .replace(DECIMAL_DURATION, "<duration>")
    .replace(RATE, "<rate> $1/s")
    .replace(SEED, "$1<seed>")
    .replace(RUN_ID, "$1<id>'")
    .replace(ADDRESS, "<address>")
    // A runner that pads a column to the width of its duration (CTest, Julia) pads it differently.
    .replace(/ +<duration>/g, " <duration>");
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/** One failing check of a round, as the record keeps it. */
export function repeatCheck(id: string, output: string, files: readonly string[]): RepeatCheck {
  return {
    id,
    text: normalizeCheckOutput(output).slice(-REPEAT_OUTPUT_CHARS),
    files: [...new Set(files.map((f) => f.replaceAll("\\", "/")))].sort(),
  };
}

const ordered = (checks: readonly RepeatCheck[]): RepeatCheck[] =>
  [...checks].sort((a, b) => a.id.localeCompare(b.id) || a.text.localeCompare(b.text));

/** The hash of a round's failing checks: each check's id, normalized output and files. */
export function failureHash(checks: readonly RepeatCheck[]): string {
  return hashJson(ordered(checks).map((c) => ({ id: c.id, text: c.text, files: c.files })));
}

const evidenceText = (checks: readonly RepeatCheck[]): string =>
  ordered(checks)
    .map((c) => `${c.id}\n${c.files.join("\n")}\n${c.text}`)
    .join("\n\0\n");

/** The offset of the first character where two rounds' evidence differs, or null when equal. */
export function firstDifference(
  previous: readonly RepeatCheck[],
  current: readonly RepeatCheck[],
): number | null {
  const a = evidenceText(previous);
  const b = evidenceText(current);
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether a corrective's failing checks repeat the corrective's before it: `first` without an
 * earlier corrective's record, `repeat` when the hashes are equal (the same checks, outputs and
 * files), `progress` otherwise. Only the round right before counts: a failure that comes back
 * after a different one in between is not a repeat.
 */
export const repeatedFailureDecision: RepeatRule = (previous, current) =>
  previous === null
    ? "first"
    : failureHash(previous) === failureHash(current)
      ? "repeat"
      : "progress";

/** The record of one corrective's failing checks, decided against its predecessor's record. */
export function repeatRecord(
  taskId: string,
  /** The task the corrective was opened for. */
  corrected: string | null,
  /** That task's own record, when it is a corrective whose checks failed. */
  previous: RepeatRecord | null,
  checks: RepeatCheck[],
  decide: RepeatRule = repeatedFailureDecision,
): RepeatRecord {
  const hash = failureHash(checks);
  return {
    taskId,
    previous: previous ? previous.taskId : null,
    root: previous?.root ?? corrected ?? taskId,
    checks: ordered(checks),
    hash,
    previousHash: previous?.hash ?? null,
    firstDifference: previous ? firstDifference(previous.checks, checks) : null,
    decision: decide(previous?.checks ?? null, checks),
  };
}

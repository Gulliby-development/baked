import { tmpdir } from "node:os";

/**
 * The one table of values that change between two runs of the same failing check (#2281, #2295).
 * Three comparisons read it: the repeated-failure hash (`normalizeCheckOutput`,
 * `src/core/workflows/repeated-failure.ts`), the check baseline's shaped signature
 * (`shapedFailureSignature`, `output-counts.ts`, which the `baseline_signature` reason compares in
 * shadow beside the live `baseline_failure` match) and the check finding's failing lines
 * (`failureSignature`, `convergence.ts`). A value normalization goes here, never into one of them;
 * `tests/repeated-failure.test.ts` fails when any of the three tells two runs of one toolchain's
 * failing check apart.
 */
// Wall-clock stamps, durations, rates, seeds and addresses, by shape rather than by runner (#2281):
// go test's `0.012s`, bun's `[1.23ms]`, jest's `(5 ms)`, pytest's `in 0.12s`, busted's
// `: 0.015 seconds`, CTest's `0.01 sec`, Gradle's `BUILD FAILED in 1m 3s`, dotnet's
// `Duration: 12 ms`, PHPUnit's `Time: 00:00.012`, Minitest's `810.4 runs/s` and seed, Dart's
// `00:01 +3 -1:`, sbt's `Total time: 3 s, completed Oct 27, 2026, 1:02:03 AM` and
// `elapsed time: 4 s, cache 50%, 106 disk cache hits`, busted's Windows
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
// sbt 2's `[error] elapsed time: 4 s, cache 50%, 106 disk cache hits, 1 onsite task`: the time,
// the cache share and the counters after it all change between two runs of one failure (#2437).
const SBT_ELAPSED = /\b(elapsed time:)[^\n]*?, cache \d+%[^\n]*/g;
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
 * Text with the values that change between two runs of the same failure replaced by placeholders
 * (`<time>`, `<duration>`, `<rate>`, `<memory>`, `<seed>`, `<id>`, `<address>`, `<tmp>`): wall-clock
 * stamps, durations, rates, memory sizes, random seeds and run IDs, temporary directories and
 * memory addresses. Expects `/` path separators and `\n` line endings. Line and column positions
 * and asserted values stay, so a failure that moved or changed still differs.
 */
export function normalizeVolatile(input: string): string {
  let text = input;
  for (const root of tempRoots()) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}/[^\\s:'"\`)]+`, "gi"), "<tmp>");
  }
  text = text.replace(/[A-Za-z]:\/Users\/[^/\s]+\/AppData\/Local\/Temp\/[^\s:'"`)]+/gi, "<tmp>");
  return (
    text
      .replace(TIMESTAMP, "<time>")
      .replace(CLOCK, "<time>")
      .replace(MINUTE_CLOCK, "<duration>")
      .replace(DART_ELAPSED, "<time>")
      .replace(COMPLETED_AT, ", completed <time>")
      .replace(STARTED_AT, "$1 <time>")
      .replace(SBT_ELAPSED, "$1 <duration>")
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
      .replace(/ +<duration>/g, " <duration>")
  );
}

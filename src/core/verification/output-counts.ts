import { type LanguageRecord, none } from "../intelligence/language-records.js";
import { isTestFile } from "../intelligence/language-traits.js";
import type { Check } from "../workflows/types.js";
import { normalizeVolatile } from "./volatile.js";

/**
 * Counts read from check output, so an update run can compare a passing check with the same
 * check on the code it started from: a linter that exits 0 with more warnings, or a test suite
 * that runs fewer tests, passes on its exit code alone (bench R03). Every parser recognizes one
 * tool's summary line and returns null for anything else; a null on either side means no
 * comparison and never a finding. Each diagnostic parser states the severities it counts: errors
 * and warnings, never infos or hints (a Biome `useTemplate` info became a high finding and a
 * 489k-token correction, #1791), and `errors` is the error share where the summary gives it.
 */
export type CountKind = "diagnostics" | "tests";

export interface OutputCount {
  /** The tool whose summary was read; a comparison needs the same tool on both sides. */
  tool: string;
  count: number;
  /** Of a diagnostics count, how many are errors; absent where the summary does not split them. */
  errors?: number;
}

/** Where the baseline counts are stored for the run. */
export const CHECK_BASELINE_PATH = "facts/check-baseline.json";

/** A test file by its path; a run that deletes one may lower the test count. */
export const TEST_FILE = { test: (path: string): boolean => isTestFile(path) };

/** Signature of a check's command: a check is compared only with a baseline of the same command. */
export const commandKey = (check: Pick<Check, "executable" | "args" | "cwd">): string =>
  JSON.stringify([check.executable, check.args, check.cwd]);

const sum = (output: string, pattern: RegExp): number | null => {
  let total: number | null = null;
  for (const match of output.matchAll(pattern)) total = (total ?? 0) + Number(match[1]);
  return total;
};

const lines = (output: string, pattern: RegExp): number =>
  output.split(/\r?\n/).filter((line) => pattern.test(line)).length;

/**
 * The number of diagnostics a linter or type checker reported, by its summary line: errors and
 * warnings, with the errors among them where the tool says.
 */
export function diagnosticCount(output: string): OutputCount | null {
  // Biome: "Checked 12 files in 3ms. No fixes applied." then "Found 2 warnings." / "Found 3 infos."
  // Infos are hints (`useTemplate`, an unsafe-fix suggestion): Biome itself exits 0 on them.
  if (/\bChecked \d+ files? in\b/.test(output)) {
    const errors = sum(output, /\bFound (\d+) errors?\b/g) ?? 0;
    const warnings = sum(output, /\bFound (\d+) warnings?\b/g) ?? 0;
    return { tool: "biome", count: errors + warnings, errors };
  }
  // ESLint: "✖ 5 problems (2 errors, 3 warnings)"
  const eslint = output.match(/✖ (\d+) problems? \((\d+) errors?/);
  if (eslint) return { tool: "eslint", count: Number(eslint[1]), errors: Number(eslint[2]) };
  // Ruff: "Found 3 errors." / "All checks passed!"; every Ruff violation is an error.
  if (/^All checks passed!/m.test(output)) return { tool: "ruff", count: 0, errors: 0 };
  // tsc: "Found 2 errors in 1 file." / "Found 1 error in src/a.ts:3"
  const tsc = output.match(/^Found (\d+) errors? in\b/m);
  if (tsc) return { tool: "tsc", count: Number(tsc[1]), errors: Number(tsc[1]) };
  const ruff = output.match(/^Found (\d+) errors?\.?$/m);
  if (ruff) return { tool: "ruff", count: Number(ruff[1]), errors: Number(ruff[1]) };
  // Clippy: "warning: `app` (bin "app") generated 3 warnings"; a clean build only says Finished.
  // A build that finished has no errors.
  if (/^\s*Finished\b.*\btarget\(s\)/m.test(output) && /\b(?:Checking|Compiling)\b/.test(output))
    return {
      tool: "cargo",
      count: sum(output, /\bgenerated (\d+) warnings?\b/g) ?? 0,
      errors: 0,
    };
  // PHPStan (#1491): " [ERROR] Found 3 errors" / " [OK] No errors"; every finding is an error.
  const phpstan = output.match(/^\s*\[ERROR\] Found (\d+) errors?\b/m);
  if (phpstan) return { tool: "phpstan", count: Number(phpstan[1]), errors: Number(phpstan[1]) };
  if (/^\s*\[OK\] No errors\b/m.test(output)) return { tool: "phpstan", count: 0, errors: 0 };
  // Psalm: "3 errors found" / "No errors found!"; its info issues are not counted.
  const psalm = output.match(/^(\d+) errors? found\b/m);
  if (psalm) return { tool: "psalm", count: Number(psalm[1]), errors: Number(psalm[1]) };
  if (/^No errors found!/m.test(output)) return { tool: "psalm", count: 0, errors: 0 };
  // luacheck (#1495): "Total: 2 warnings / 1 error in 3 files", in colour even without a terminal.
  const luacheck = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
    .replace(/\u001b\[[0-9;]*m/g, "")
    .match(/^Total: (\d+) warnings? \/ (\d+) errors? in \d+ files?/m);
  if (luacheck)
    return {
      tool: "luacheck",
      count: Number(luacheck[1]) + Number(luacheck[2]),
      errors: Number(luacheck[2]),
    };
  // selene: "Results:" then "8 errors", "4 warnings" and "0 parse errors", one per line.
  const selene = output.match(
    /^Results:\r?\n(\d+) errors?\r?\n(\d+) warnings?\r?\n(\d+) parse errors?$/m,
  );
  if (selene) {
    const errors = Number(selene[1]) + Number(selene[3]);
    return { tool: "selene", count: errors + Number(selene[2]), errors };
  }
  // ShellCheck (#1497) prints each finding under its line, "^-- SC2086 (info): Double quote ...",
  // and no summary; a clean run prints nothing.
  const shellcheck = [...output.matchAll(/\^-*\^? SC\d+ \((error|warning|info|style)\): /g)];
  if (shellcheck.length)
    return {
      tool: "shellcheck",
      count: shellcheck.length,
      errors: shellcheck.filter((m) => m[1] === "error").length,
    };
  // clang-tidy (#1490): "src/sum.cpp:3:13: warning: statement should be inside braces
  // [readability-braces-around-statements]", an error with `--warnings-as-errors`. The check
  // names tell it from a compiler's own "[-Wunused-variable]".
  const tidy = [
    ...output.matchAll(/^\S.*?:\d+:\d+: (warning|error): .+ \[(?!-)[\w.-]+(?:,-?[\w.-]+)*\]$/gm),
  ];
  if (tidy.length)
    return {
      tool: "clang-tidy",
      count: tidy.length,
      errors: tidy.filter((m) => m[1] === "error").length,
    };
  // SQLFluff (#1499): one "L:   1 | P:  10 | LT01 | ..." line per violation, then "All Finished!";
  // a rule listed under `warnings` prints "WARNING:" after the code, and counts as a warning.
  if (/^All Finished\b/m.test(output)) {
    const violations = lines(output, /^L:\s*\d+\s*\|\s*P:\s*\d+\s*\|\s*\w+\s*\|/);
    const warned = lines(output, /^L:\s*\d+\s*\|\s*P:\s*\d+\s*\|\s*\w+\s*\|\s*WARNING:/);
    return { tool: "sqlfluff", count: violations, errors: violations - warned };
  }
  // PSScriptAnalyzer through the gate's format (#1498): one "path:4:3: Warning PSAvoidUsingWriteHost:
  // ..." line per finding, nothing on a clean run.
  const analyzer = lines(output, /:\d+:\d+: (?:Error|Warning|ParseError) \w+: /);
  if (analyzer)
    return {
      tool: "psscriptanalyzer",
      count: analyzer,
      errors: lines(output, /:\d+:\d+: (?:Error|ParseError) \w+: /),
    };
  // dart analyze and flutter analyze: "  error - lib/a.dart:3:14 - ... - invalid_assignment", then
  // "2 issues found." or "No issues found!". Infos are lints dart analyze exits 0 on.
  if (
    /^Analyzing \S.*\.\.\.$/m.test(output) &&
    /^(?:No issues found!|\d+ issues? found\.)$/m.test(output)
  ) {
    const errors = lines(output, /^\s*error - \S+:\d+:\d+ - /);
    return { tool: "dart", count: errors + lines(output, /^\s*warning - \S+:\d+:\d+ - /), errors };
  }
  // lintr through the gate (#1500): "R/sum.R:2:3: style: [object_name_linter] ..." per lint, then
  // the source line and a caret; nothing on a clean run.
  const lints = lines(output, /^\S.*:\d+:\d+: (?:style|warning|error): \[\w+\] /);
  if (lints)
    return { tool: "lintr", count: lints, errors: lines(output, /^\S.*:\d+:\d+: error: \[\w+\] /) };
  // styler through the gate: "R/sum.R: would be reformatted by styler" per file.
  const styled = lines(output, /: would be reformatted by styler$/);
  if (styled) return { tool: "styler", count: styled, errors: styled };
  // dotnet build: "    3 Warning(s)" and "    0 Error(s)"
  const warnings = output.match(/^\s*(\d+) Warning\(s\)/m);
  const errors = output.match(/^\s*(\d+) Error\(s\)/m);
  if (warnings && errors)
    return {
      tool: "dotnet",
      count: Number(warnings[1]) + Number(errors[1]),
      errors: Number(errors[1]),
    };
  return null;
}

/**
 * The test count of a JUnit XML report: the `tests` attribute of `<testsuites>`, else the sum over
 * its `<testsuite>` elements, else the number of `<testcase>` elements.
 */
export function junitCount(output: string): number | null {
  if (!/<testsuites?\b/.test(output)) return null;
  const root = /<testsuites\b[^>]*?\stests="(\d+)"/.exec(output);
  if (root) return Number(root[1]);
  const suites = sum(output, /<testsuite\b[^>]*?\stests="(\d+)"/g);
  if (suites !== null) return suites;
  const cases = [...output.matchAll(/<testcase\b/g)].length;
  return cases || null;
}

/** A test runner whose summary line `testCount` reads. */
export type TestRunner =
  | "bun"
  | "jest"
  | "vitest"
  | "pytest"
  | "cargo"
  | "dotnet"
  | "maven"
  | "go"
  | "phpunit"
  | "pest"
  | "rspec"
  | "minitest"
  | "busted"
  | "ctest"
  | "gtest"
  | "dart"
  | "sbt"
  | "swift"
  | "junit"
  | "tap"
  | "pester"
  | "testthat"
  | "exunit";

const TESTTHAT_SUMMARY = /^\[ FAIL (\d+) \| WARN (\d+) \| SKIP (\d+) \| PASS (\d+) \]/m;

const PESTER_SUMMARY =
  /^Tests Passed: (\d+), Failed: (\d+), Skipped: (\d+), Inconclusive: (\d+), NotRun: (\d+)/m;

/** Pest's summary: its counts by outcome, then the assertions (Jest's has a total instead). */
/** busted's summary: "2 successes / 1 failure / 1 error / 1 pending : 0.0015 seconds". */
const BUSTED_SUMMARY =
  /^(\d+) successe?s? \/ (\d+) failures? \/ (\d+) errors? \/ (\d+) pending : /m;
/**
 * busted's errors that are tests: "Error -> spec/a_spec.lua @ 10" and then the test's name. A file
 * that did not load is an error too, named "suite spec/a_spec.lua" or with no `@` line at all.
 */
const bustedTestErrors = (o: string): number | null =>
  /^Error (?:->|→) /m.test(o)
    ? [...o.matchAll(/^Error (?:->|→) \S+ @ \d+\r?\n(?!suite )/gm)].length
    : null;
/**
 * CTest's summary: "67% tests passed, 1 tests failed out of 3", and on a run without failures
 * "100% tests passed, 0 tests failed out of 2" or, in newer CTest, "100% tests passed out of 2".
 * Disabled tests are not counted.
 */
const CTEST_SUMMARY = /^\d+% tests passed(?:, \d+ tests? failed)? out of (\d+)$/m;
/**
 * CTest's lists of tests by outcome, "\t  2 - SumTest.Commutes (Failed)": under "The following
 * tests FAILED:" a test whose executable was not built is "(Not Run)", and under "The following
 * tests did not run:" a skipped one is "(Skipped)" (GTEST_SKIP, a SKIP_RETURN_CODE).
 */
const ctestListed = (o: string, outcome: RegExp): string[] =>
  [...o.matchAll(/^\s+\d+ - (.+?) \(([^)\n]+)\)\s*$/gm)]
    .filter((m) => outcome.test(m[2] ?? ""))
    .map((m) => (m[1] ?? "").trim());
/** GoogleTest's summary of a test binary: "[==========] 3 tests from 1 test suite ran. (0 ms total)". */
const GTEST_SUMMARY = /^\[==========\] (\d+) tests? from \d+ test (?:suites?|cases?) ran\./m;
const PEST_SUMMARY = /^\s*Tests:\s+((?:\d+ \w+(?:, )?)+) \(\d+ assertions?\)/m;

/**
 * The summary parsers, in the order `testCount` tries them: a more specific summary first, the
 * report formats any runner can print (JUnit XML, TAP) last. `ran` is the share of `count` that
 * executed, skipped and ignored tests left out, or null where the summary does not tell (#1832).
 */
const MAVEN_SUMMARY = /^\[\w+\] Tests run: (\d+), Failures: \d+, Errors: \d+, Skipped: (\d+)\s*$/gm;

const TEST_COUNTERS: readonly {
  tool: TestRunner;
  count: (output: string) => number | null;
  ran: (output: string) => number | null;
}[] = [
  {
    tool: "bun",
    // bun test: "Ran 42 tests across 3 files." after " 40 pass", " 2 skip", " 0 fail"
    count: (o) => num(o.match(/^Ran (\d+) tests? across \d+ files?/m)),
    ran: (o) => (/^Ran \d+ tests?/m.test(o) ? (sum(o, /^\s*(\d+) (?:pass|fail)$/gm) ?? 0) : null),
  },
  {
    tool: "jest",
    // jest: "Tests:       1 failed, 2 skipped, 12 passed, 15 total"
    count: (o) => num(o.match(/^Tests:\s+.*?\b(\d+) total\b/m)),
    ran: (o) => {
      const line = o.match(/^Tests:\s+(.*?\b\d+ total)\b/m)?.[1];
      return line === undefined ? null : (sum(line, /(\d+) (?:passed|failed)\b/g) ?? 0);
    },
  },
  {
    tool: "vitest",
    // vitest: "      Tests  12 passed (12)" / "Tests  1 failed | 11 passed | 2 skipped (14)"
    count: (o) => num(o.match(/^\s*Tests\s+.*\((\d+)\)\s*$/m)),
    ran: (o) => {
      const line = o.match(/^\s*Tests\s+(.*)\(\d+\)\s*$/m)?.[1];
      return line === undefined ? null : (sum(line, /(\d+) (?:passed|failed)\b/g) ?? 0);
    },
  },
  {
    tool: "pytest",
    // pytest: "===== 3 passed, 1 skipped in 0.12s =====", "===== 2 skipped in 0.01s ====="
    count: (o) => {
      const pytest = o.match(/^=+ (.*\d+ (?:passed|failed).*) in [\d.]+s\b.*=+\s*$/m);
      return pytest
        ? sum(pytest[1] ?? "", /(\d+) (?:passed|failed|skipped|xfailed|xpassed|errors?)\b/g)
        : null;
    },
    ran: (o) => {
      const line = o.match(
        // `pytest -q` prints the summary without the rule: "1 skipped in 0.01s".
        /^(?:=+ )?(\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed|errors?)\b.*) in [\d.]+s\b(?:.*=+)?\s*$/m,
      )?.[1];
      return line === undefined
        ? null
        : (sum(line, /(\d+) (?:passed|failed|xfailed|xpassed|errors?)\b/g) ?? 0);
    },
  },
  {
    tool: "cargo",
    // cargo test: "test result: ok. 4 passed; 0 failed; 1 ignored; ..." per test binary
    count: (o) => {
      if (!/^test result: /m.test(o)) return null;
      const passed = sum(o, /^test result: \w+\. (\d+) passed;/gm) ?? 0;
      const failed = sum(o, /; (\d+) failed;/g) ?? 0;
      const ignored = sum(o, /; (\d+) ignored;/g) ?? 0;
      return passed + failed + ignored;
    },
    ran: (o) =>
      /^test result: /m.test(o)
        ? (sum(o, /^test result: \w+\. (\d+) passed;/gm) ?? 0) + (sum(o, /; (\d+) failed;/g) ?? 0)
        : null,
  },
  {
    tool: "pester",
    // Pester 5: "Tests Passed: 1, Failed: 1, Skipped: 1, Inconclusive: 0, NotRun: 0" (#1498)
    count: (o) => {
      const m = o.match(PESTER_SUMMARY);
      return m ? [1, 2, 3, 4, 5].reduce((n, i) => n + Number(m[i]), 0) : null;
    },
    ran: (o) => {
      const m = o.match(PESTER_SUMMARY);
      return m ? Number(m[1]) + Number(m[2]) : null;
    },
  },
  {
    tool: "testthat",
    // testthat 3: "[ FAIL 1 | WARN 0 | SKIP 1 | PASS 3 ]", in expectations rather than tests (#1500).
    count: (o) => {
      const m = o.match(TESTTHAT_SUMMARY);
      return m ? Number(m[1]) + Number(m[3]) + Number(m[4]) : null;
    },
    ran: (o) => {
      const m = o.match(TESTTHAT_SUMMARY);
      return m ? Number(m[1]) + Number(m[4]) : null;
    },
  },
  {
    tool: "dotnet",
    // dotnet test: "Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12" (the
    // counts are padded) / "Total tests: 12"
    count: (o) => sum(o, /\bTotal(?: tests)?:\s*(\d+)\b/g),
    ran: (o) =>
      /\bTotal(?: tests)?:\s*\d+/.test(o)
        ? (sum(o, /\bPassed:\s*(\d+)\b/g) ?? 0) + (sum(o, /\bFailed:\s*(\d+)\b/g) ?? 0)
        : /\bNo test (?:is available|matches the given testcase filter)\b/.test(o)
          ? 0
          : null,
  },
  {
    tool: "maven",
    // Maven surefire: "Tests run: 12, Failures: 0, Errors: 0, Skipped: 0" (the summary, no time),
    // one per module of a multi-module build, which are added up (#2378).
    count: (o) => sum(o, MAVEN_SUMMARY),
    ran: (o) => {
      const runs = [...o.matchAll(MAVEN_SUMMARY)];
      return runs.length ? runs.reduce((total, m) => total + Number(m[1]) - Number(m[2]), 0) : null;
    },
  },
  {
    tool: "go",
    // go test -v: one "=== RUN   TestName" per top-level test; without -v there is no count.
    // "[no tests to run]" and "[no test files]" say that nothing ran, with exit 0.
    count: (o) => lines(o, /^=== RUN\s+[^/\s]+\s*$/) || null,
    ran: (o) =>
      lines(o, /^=== RUN\s+[^/\s]+\s*$/) ||
      (/\[no tests? (?:to run|files)\]|^testing: warning: no tests to run/m.test(o) &&
      !/^ok\s+\S+\s+[\d.]+s\s*$/m.test(o)
        ? 0
        : null),
  },
  {
    tool: "phpunit",
    // PHPUnit (#1491): "OK (5 tests, 10 assertions)", or after "FAILURES!" or "OK, but ..." the
    // line "Tests: 5, Assertions: 8, Failures: 1, Skipped: 1."
    count: (o) =>
      num(o.match(/^OK \((\d+) tests?, \d+ assertions?\)/m)) ??
      num(o.match(/^Tests: (\d+), Assertions: \d+\b/m)),
    ran: (o) => {
      const ok = num(o.match(/^OK \((\d+) tests?, \d+ assertions?\)/m));
      if (ok !== null) return ok;
      const line = o.match(/^Tests: (\d+), Assertions: \d+\b(.*)$/m);
      if (!line) return /^No tests executed!/m.test(o) ? 0 : null;
      return Number(line[1]) - (sum(line[2] ?? "", /\b(?:Skipped|Incomplete): (\d+)/g) ?? 0);
    },
  },
  {
    tool: "pest",
    // Pest: "  Tests:    1 failed, 1 skipped, 3 passed (6 assertions)"
    count: (o) => {
      const line = o.match(PEST_SUMMARY)?.[1];
      return line === undefined ? null : (sum(line, /(\d+) \w+/g) ?? 0);
    },
    ran: (o) => {
      const line = o.match(PEST_SUMMARY)?.[1];
      if (line === undefined) return null;
      return (
        (sum(line, /(\d+) \w+/g) ?? 0) - (sum(line, /(\d+) (?:skipped|todos?|incomplete)\b/g) ?? 0)
      );
    },
  },
  {
    tool: "rspec",
    // RSpec: "5 examples, 1 failure, 2 pending" (pending and `xit` examples are listed, not run),
    // "0 examples, 0 failures, 1 error occurred outside of examples" when a spec file did not load.
    count: (o) => num(o.match(/^(\d+) examples?, \d+ failures?\b/m)),
    ran: (o) => {
      const m = o.match(/^(\d+) examples?, \d+ failures?(?:, (\d+) pending)?\b/m);
      return m ? Number(m[1]) - Number(m[2] ?? 0) : null;
    },
  },
  {
    tool: "minitest",
    // Minitest (also through `rake test`): "4 runs, 2 assertions, 1 failures, 1 errors, 1 skips".
    count: (o) =>
      num(o.match(/^(\d+) runs?, \d+ assertions?, \d+ failures?, \d+ errors?, \d+ skips?$/m)),
    ran: (o) => {
      const m = o.match(
        /^(\d+) runs?, \d+ assertions?, \d+ failures?, \d+ errors?, (\d+) skips?$/m,
      );
      return m ? Number(m[1]) - Number(m[2]) : null;
    },
  },
  {
    tool: "busted",
    // busted's default output (#1495). Its error count also counts spec files that did not load,
    // so the errors are read from the list below the summary when it is there.
    count: (o) => {
      const m = o.match(BUSTED_SUMMARY);
      if (!m) return null;
      const errors = bustedTestErrors(o) ?? Number(m[3]);
      return Number(m[1]) + Number(m[2]) + errors + Number(m[4]);
    },
    ran: (o) => {
      const m = o.match(BUSTED_SUMMARY);
      if (!m) return null;
      return Number(m[1]) + Number(m[2]) + (bustedTestErrors(o) ?? Number(m[3]));
    },
  },
  {
    tool: "ctest",
    // CTest (#1490), before GoogleTest: `--output-on-failure` prints the output of each failing
    // GoogleTest binary inside CTest's own. Skipped tests are counted and did not run, nor did a
    // test whose executable was not built.
    count: (o) => num(o.match(CTEST_SUMMARY)),
    ran: (o) => {
      const total = num(o.match(CTEST_SUMMARY));
      if (total === null) return null;
      return total - ctestListed(o, /^(?:Skipped|Not Run)$/).length;
    },
  },
  {
    tool: "gtest",
    // A GoogleTest binary run on its own; DISABLED_ tests are not counted, skipped ones are.
    count: (o) => num(o.match(GTEST_SUMMARY)),
    ran: (o) => {
      const total = num(o.match(GTEST_SUMMARY));
      if (total === null) return null;
      return total - (num(o.match(/^\[ {2}SKIPPED \] (\d+) tests?, listed below:$/m)) ?? 0);
    },
  },
  {
    tool: "dart",
    // dart test and flutter test: "00:02 +12 ~1 -2: Some tests failed.", "00:00 +3: All tests
    // passed!". A test file that does not load counts as one failure (`-1`), named
    // "loading test/a_test.dart", and is no test.
    count: (o) => {
      const done = dartSummary(o);
      return done ? done.passed + done.skipped + done.failed - dartLoads(o) : null;
    },
    ran: (o) => {
      const done = dartSummary(o);
      return done ? done.passed + done.failed - dartLoads(o) : null;
    },
  },
  {
    tool: "sbt",
    // sbt prints one "Passed: Total 5, Failed 0, Errors 0, Passed 5, Ignored 1, Pending 1" (or
    // "Failed: Total ...") per project that ran tests, over every framework, except when ScalaTest is
    // the only one: then ScalaTest's "Tests: succeeded 2, failed 2, canceled 0, ignored 1, pending
    // 1" is the summary (#1496). Ignored, skipped and pending tests are not in sbt's Total.
    count: (o) => {
      const projects = sbtTotals(o);
      if (projects.length) return projects.reduce((n, t) => n + t.total + t.idle, 0);
      return scalatest(o, (m) => m.reduce((n, x) => n + x, 0));
    },
    // sbt 2's `testFull` on a build without a test prints no summary, only "[success] elapsed
    // time: 1 s" (#2440): a successful sbt run with neither a summary nor a suite line ran none.
    // Only `ran` reads it, so a `requireTests` check fails; `count` stays null, since the line says
    // nothing of the tests the build holds.
    ran: (o) => {
      const projects = sbtTotals(o);
      if (projects.length) return projects.reduce((n, t) => n + t.total, 0);
      const suites = scalatest(o, ([succeeded = 0, failed = 0]) => succeeded + failed);
      if (suites !== null) return suites;
      return SBT_SUCCESS.test(o) && !SBT_SUITE.test(withoutAnsi(o)) ? 0 : null;
    },
  },
  {
    tool: "swift",
    // swift test runs XCTest, then swift-testing (#1492): XCTest's "Test Suite 'All tests' failed
    // at ..." is followed by "Executed 3 tests, with 1 test skipped and 1 failure (0 unexpected)",
    // and swift-testing ends with "Test run with 3 tests failed after 0.001 seconds with 1 issue."
    // Its skipped tests are in that count and are listed one by one ("Test waits() skipped").
    count: (o) => swiftCount(o, false),
    ran: (o) => swiftCount(o, true),
  },
  {
    tool: "exunit",
    // mix test (#2490): ExUnit's summary of Elixir 1.20 ("Result: 2/3 passed") or of 1.14 to 1.19
    // ("3 tests, 1 failure"), after its "Finished in" line.
    count: (o) => exunitCount(o, false),
    ran: (o) => exunitCount(o, true),
  },
  // A language without a parser of its own (#1488): a JUnit XML report printed to the output
  // (`--reporter=junit`), then TAP (busted, bats, prove, node:test, pgTAP).
  {
    tool: "junit",
    count: junitCount,
    ran: (o) => {
      const total = junitCount(o);
      if (total === null) return null;
      const skipped =
        num(/<testsuites\b[^>]*?\sskipped="(\d+)"/.exec(o)) ??
        sum(o, /<testsuite\b[^>]*?\sskipped="(\d+)"/g) ??
        [...o.matchAll(/<skipped\b/g)].length;
      return total - skipped;
    },
  },
  {
    tool: "tap",
    count: (o) =>
      // A TAP plan `1..N` per top-level stream; an indented plan belongs to a subtest.
      num(o.match(/^Files=\d+, Tests=(\d+),/m)) ?? sum(o, /^1\.\.(\d+)(?:[ \t]+#.*)?\r?$/gm),
    ran: (o) => {
      const plan =
        num(o.match(/^Files=\d+, Tests=(\d+),/m)) ?? sum(o, /^1\.\.(\d+)(?:[ \t]+#.*)?\r?$/gm);
      return plan === null ? null : plan - lines(o, /^(?:not )?ok\b.*#\s*skip\b/i);
    },
  },
];

const num = (match: RegExpMatchArray | null): number | null => (match ? Number(match[1]) : null);

function swiftCount(o: string, ran: boolean): number | null {
  const xctest = [
    ...o.matchAll(
      /^Test Suite '(?:All tests|Selected tests)' (?:passed|failed) at .*\r?\n\s*Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?\d+ failures?/gm,
    ),
  ].at(-1);
  // `u`: swift-testing on macOS may lead with an SF Symbol outside the BMP, two UTF-16 units, so
  // XCTest's "Executed 0" beside it does not read as no test (#2419).
  const testing = [...o.matchAll(/^. Test run with (\d+) tests?\b/gmu)].at(-1);
  if (!xctest && !testing) return null;
  const skipped = ran ? Number(xctest?.[2] ?? 0) + lines(o, /^. Test .+ skipped(?::|\.|$)/) : 0;
  return Number(xctest?.[1] ?? 0) + Number(testing?.[1] ?? 0) - skipped;
}

/** sbt's per-project summary: the tests that ran (`Total`) and those that did not (`idle`). */
function sbtTotals(o: string): { total: number; idle: number }[] {
  return [...o.matchAll(/^\[(?:info|error)\] (?:Passed|Failed|Error): Total (\d+), (.*)$/gm)].map(
    (m) => ({
      total: Number(m[1]),
      idle: [...(m[2] ?? "").matchAll(/\b(?:Ignored|Skipped|Pending) (\d+)/g)].reduce(
        (n, x) => n + Number(x[1]),
        0,
      ),
    }),
  );
}
/** The last line of an sbt run that succeeded: sbt 1's "Total time: 3 s", sbt 2's "elapsed time: 1 s". */
const SBT_SUCCESS = /^\[success\] (?:Total|elapsed) time: /m;
/**
 * A test suite's heading line, as munit (`CalcSuite:`, its colours taken out) and ScalaTest
 * (`[info] CalcSpec:`) print it before its tests (`pairwick.XTests:`).
 */
const SBT_SUITE = /^(?:\[info\] )?[A-Za-z_$][\w$.]*:\r?$/m;
/** ScalaTest's own counts, summed over its "Tests: succeeded 2, failed 2, ..." lines. */
function scalatest(o: string, count: (numbers: number[]) => number): number | null {
  const lines = [
    ...o.matchAll(
      /^\[info\] Tests: succeeded (\d+), failed (\d+), canceled (\d+), ignored (\d+), pending (\d+)$/gm,
    ),
  ];
  return lines.length ? lines.reduce((n, m) => n + count(m.slice(1).map(Number)), 0) : null;
}

/**
 * ExUnit's "Finished in 0.03 seconds (0.00s async, 0.03s sync)" line, which Elixir 1.14 and later
 * print before the summary ("(0.02s on load, ...)" when the load time is known); RSpec's "Finished
 * in ... (files took ...)" is not it.
 */
const EXUNIT_FINISHED =
  /^Finished in \d[\d.]* seconds \((?:\d[\d.]*s on load, )?\d[\d.]*s async, \d[\d.]*s sync\)/m;
/**
 * ExUnit's summary up to Elixir 1.19 (#2490): the tests by type, the failures, then the excluded,
 * invalid and skipped counts, which the types' counts include. Elixir 1.14 to 1.18 print
 * "1 doctest, 3 tests, 1 failure, 1 excluded, 1 skipped", and only "0 failures" for a run of no
 * test; Elixir 1.19 prints "0 tests, 0 failures" there and the excluded as "3 tests, 0 failures
 * (3 excluded)" (ExUnit.CLIFormatter, print_summary).
 */
const EXUNIT_SUMMARY =
  /^((?:\d+ [a-z]+, )*)\d+ failures?((?:, \d+ (?:excluded|invalid|skipped))*)(?: \((\d+) excluded\))?\s*$/m;
/**
 * ExUnit's summary from Elixir 1.20 (#2490, R80 ratdec): "Result: 3 passed" when every test passed,
 * "Result: 2/3 passed" with "Failed: 1 test" below it, "Result: 0 tests" when none ran, each with a
 * per-type breakdown in parentheses when the run held several types ("(1 doctest, 2 tests)"), then
 * ", 1 invalid", ", 1 skipped" and ", 2 excluded". The passed and failed tests are counted; the
 * invalid, skipped and excluded ones are not (ExUnit.CLIFormatter, print_summary).
 */
const EXUNIT_RESULT =
  /^Result: (?:0 tests|(\d+) passed|\d+\/(\d+) passed)(?: \([^)\n]*\))?((?:, \d+ (?:invalid|skipped|excluded))*)\s*$/m;

/**
 * ExUnit's counts summed over the summaries after each "Finished in" line, one per Mix project
 * (`mix test` in an umbrella runs each app's tests): `ran` leaves out the excluded, invalid and
 * skipped tests. Null when the output holds no ExUnit summary.
 */
function exunitCount(output: string, ran: boolean): number | null {
  const o = withoutAnsi(output);
  const parts = o.split(new RegExp(EXUNIT_FINISHED.source, "m")).slice(1);
  if (!parts.length) return null;
  let total: number | null = null;
  for (const part of parts) {
    const result = part.match(EXUNIT_RESULT);
    const older = result ? null : part.match(EXUNIT_SUMMARY);
    if (!result && !older) continue;
    const idle = (text: string) => sum(text, /(\d+) (?:excluded|invalid|skipped)\b/g) ?? 0;
    let found: number;
    if (result) {
      const executed = Number(result[1] ?? result[2] ?? 0);
      found = ran ? executed : executed + idle(result[3] ?? "");
    } else {
      const all = sum(older?.[1] ?? "", /(\d+) [a-z]+, /g) ?? 0;
      const skipped = idle(older?.[2] ?? "") + Number(older?.[3] ?? 0);
      found = ran ? all - skipped : all;
    }
    total = (total ?? 0) + found;
  }
  return total;
}

/** The progress prefix of `dart test`: elapsed time, then passed `+N`, skipped `~N`, failed `-N`. */
const DART_PROGRESS = String.raw`^[\d:]+ \+(\d+)(?: ~(\d+))?(?: -(\d+))?: `;
/** The same prefix without its groups. */
const DART_LINE = String.raw`^[\d:]+ \+\d+(?: ~\d+)?(?: -\d+)?: `;
const DART_SUMMARY = new RegExp(
  `${DART_PROGRESS}(?:All tests passed!|Some tests failed\\.|All tests skipped\\.)\\s*$`,
  "gm",
);
function dartSummary(o: string): { passed: number; skipped: number; failed: number } | null {
  const last = [...o.matchAll(DART_SUMMARY)].at(-1);
  if (!last) return null;
  return { passed: Number(last[1]), skipped: Number(last[2] ?? 0), failed: Number(last[3] ?? 0) };
}
const dartLoads = (o: string): number =>
  lines(o, new RegExp(`${DART_LINE}loading \\S+ \\[E\\]\\s*$`));

/**
 * The test runners of each supported language whose summary `testCount` reads (#1717, #1733), so
 * the baseline comparison and the failure signature cover the language. A language whose runner
 * prints no summary these parsers read has a `none` row naming the runner.
 */
export const TEST_RUNNERS: LanguageRecord<readonly TestRunner[]> = {
  typescript: ["bun", "jest", "vitest", "tap"],
  javascript: ["bun", "jest", "vitest", "tap"],
  vue: ["vitest", "jest"],
  svelte: ["vitest", "jest"],
  rescript: ["vitest", "jest"],
  python: ["pytest"],
  rust: ["cargo"],
  go: ["go"],
  csharp: ["dotnet"],
  java: ["maven", "junit"],
  kotlin: ["maven", "junit"],
  scala: ["sbt", "maven", "junit"],
  c: ["ctest", "tap"],
  cpp: ["ctest", "gtest"],
  ruby: ["rspec", "minitest"],
  php: ["phpunit", "pest"],
  swift: ["swift"],
  lua: ["busted", "tap"],
  elixir: ["exunit"],
  dart: ["dart"],
  zig: none("zig build test prints no count"),
  bash: ["tap"],
  ocaml: none("dune test output has no common summary"),
  objc: none("xcodebuild test summaries are not read"),
  solidity: none("forge test summaries are not read"),
  // pgTAP through pg_prove prints TAP.
  sql: ["tap"],
  powershell: ["pester"],
  r: ["testthat"],
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: munit colours its output even without a terminal
const withoutAnsi = (o: string): string => o.replace(/\u001b\[[0-9;]*m/g, "");

const captured = (output: string, pattern: RegExp): string[] => [
  ...new Set([...output.matchAll(pattern)].map((m) => (m[1] ?? "").trim()).filter(Boolean)),
];

/**
 * The names of the tests a runner reports as failed, by runner: a `Record` over `TestRunner`, so a
 * new summary parser cannot land without its failure lines. The baseline replay (#1945) reads them
 * to say which of a run's tests fail on the code the run started from.
 */
export const FAILED_TESTS: Record<TestRunner, (output: string) => string[]> = {
  // "(fail) parser > keeps blank lines [0.81ms]"
  bun: (o) => captured(o, /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/gm),
  // "  ● parser › keeps blank lines", not the "● Test suite failed to run" header
  jest: (o) => captured(o, /^\s*● (?!Test suite failed to run)(.+?)\s*$/gm),
  // " FAIL  tests/parser.test.ts > parser > keeps blank lines"
  vitest: (o) => captured(o, /^\s*FAIL\s+(\S.* > .+?)\s*$/gm),
  // "FAILED tests/test_parser.py::test_keeps_blank - AssertionError", also an ERROR at setup
  pytest: (o) => captured(o, /^(?:FAILED|ERROR) (\S+::\S+)/gm),
  // "test parser::keeps_blank ... FAILED"
  cargo: (o) => captured(o, /^test (\S+) \.\.\. FAILED\s*$/gm),
  // "  Failed Parser.Tests.KeepsBlank [12 ms]"
  dotnet: (o) => captured(o, /^\s*Failed (\S+) \[/gm),
  // "[ERROR] app.ParserTest.keepsBlank -- Time elapsed: 0.01 s <<< FAILURE!" (surefire 3), or
  // "[ERROR] keepsBlank(app.ParserTest)  Time elapsed: 0.01 s  <<< ERROR!" (surefire 2)
  maven: (o) => captured(o, /^\[ERROR\] (\S+?)(?: --)?\s+Time elapsed: .*<<< (?:FAILURE|ERROR)!/gm),
  // "--- FAIL: TestKeepsBlank (0.00s)", subtests included
  go: (o) => captured(o, /^\s*--- FAIL: (\S+)/gm),
  // "1) Tests\\SumTest::testAdds" under "There was 1 failure:" or "There were 2 errors:", not
  // under the lists of skipped, incomplete or risky tests.
  phpunit: (o) =>
    [
      ...o.matchAll(
        /^There (?:was|were) \d+ (?:failures?|errors?):\s*$([\s\S]*?)(?=^There (?:was|were) |^FAILURES!|^ERRORS!|(?![\s\S]))/gm,
      ),
    ].flatMap((m) => captured(m[1] ?? "", /^\d+\) (\S+::\S+?)(?: with data set .*)?\s*$/gm)),
  // "  FAILED  Tests\\Unit\\SumTest > it adds two numbers"
  pest: (o) => captured(o, /^\s*FAILED\s+(\S.*? > .+?)\s*$/gm),
  // "rspec ./spec/calc_spec.rb:6 # Calc fails on purpose", the rerun list after "Failed examples:"
  rspec: (o) => captured(o, /^rspec \S+:\d+ # (.+?)\s*$/gm),
  // "  1) Failure:" or "  2) Error:", then "CalcTest#test_fail [/w/test/calc_test.rb:8]:"
  minitest: (o) =>
    captured(o, /^\s*\d+\) (?:Failure|Error):\r?\n(\S+#\S+?)(?: \[[^\]\n]*\])?:\s*$/gm),
  // "Failure -> spec/sum_spec.lua @ 7" or "Error -> ...", then "sum is commutative"; an error named
  // "suite spec/a_spec.lua" is a spec file that did not load, not a test.
  busted: (o) => captured(o, /^(?:Failure|Error) (?:->|→) \S+ @ \d+\r?\n(?!suite )(.+?)\s*$/gm),
  // CTest: "\t  2 - SumTest.Commutes (Failed)" under "The following tests FAILED:", also a crash
  // or a timeout ("(SEGFAULT)", "(Timeout)"); a test whose executable is missing is "(Not Run)".
  ctest: (o) => {
    const failed = o.split(/^The following tests FAILED:\r?$/m)[1];
    return failed ? [...new Set(ctestListed(failed, /^(?!Not Run$)/))] : [];
  },
  // GoogleTest: "[  FAILED  ] SumTest.Commutes (5 ms)", and again in the list under its summary;
  // parameterized and typed tests are "Prefix/Suite.Name/0" and "Suite/0.Name, where ...".
  gtest: (o) =>
    captured(
      o,
      /^\[ {2}FAILED {2}\] ((?:\w+\/)?\w+(?:\/\d+)?\.\w+(?:\/\w+)?)(?: \(\d+ ms\)|, where .*)?$/gm,
    ),
  // "[-] Get-Sum.is commutative 36ms (34ms|2ms)", not a container's "[-] tests/a.Tests.ps1 failed with:"
  pester: (o) => captured(o, /^\s*\[-\] (.+?) \d+(?:\.\d+)?m?s \(/gm),
  // "00:00 +1 -1: test/calc_test.dart: fails on purpose [E]", not a file that did not load
  dart: (o) =>
    captured(o, new RegExp(`${DART_LINE}(?!loading \\S+ \\[E\\])(.+?) \\[E\\]\\s*$`, "gm")),
  // munit "==> X CalcSuite.fails on purpose  0.038s munit.ComparisonFailException: ...", and
  // ScalaTest "[info] - fails on purpose *** FAILED ***" under its "[info] CalcSpec:" header
  sbt: (o) => {
    const text = withoutAnsi(o);
    const munit = captured(text, /^==> X (\S.*?)\s{2,}[\d.]+s\b/gm);
    let suite = "";
    const scalatest: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const header = /^\[info\] (\w[\w.$]*):$/.exec(line);
      if (header) suite = header[1] ?? "";
      const failed = /^\[info\] - (.+?) \*\*\* FAILED \*\*\*/.exec(line);
      if (failed) scalatest.push(suite ? `${suite}: ${failed[1]}` : (failed[1] ?? ""));
    }
    return [...new Set([...munit, ...scalatest])];
  },
  // XCTest "Test Case 'CalcXCTests.testFails' failed (0.001 seconds)" ('-[CalcTests.CalcXCTests
  // testFails]' on macOS), swift-testing "✘ Test failsToo() failed after 0.001 seconds with 1 issue."
  swift: (o) => [
    ...new Set([
      ...captured(o, /^Test Case '(.+?)' failed \(/gm),
      ...captured(o, /^. Test (?!run with )(.+?) failed after /gm),
    ]),
  ],
  // "── Failure ('test-sum.R:2:3'): adds ───", "-- Error (...): name ---" in an ASCII locale.
  testthat: (o) => captured(o, /^(?:──|--) (?:Failure|Error) \([^)]*\): (.+?) (?:─+|-+)$/gm),
  // A <testcase> with a <failure> or <error> child.
  junit: (o) =>
    [...o.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
      .filter((m) => /<(?:failure|error)\b/.test(m[2] ?? ""))
      .map((m) => {
        const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(m[1] ?? "")?.[1];
        return [attr("classname"), attr("name")].filter(Boolean).join(".");
      })
      .filter(Boolean),
  // ExUnit, Elixir 1.14 to 1.20: "  1) test keeps blank lines (ParserTest)", also a doctest
  // ("  2) doctest Parser.parse/1 (1) (ParserTest)"); not "  3) ParserTest: failure on setup_all
  // callback, all tests have been invalidated", a module whose tests did not run.
  exunit: (o) =>
    captured(
      withoutAnsi(o),
      /^\s*\d+\) ((?:test|doctest|property|feature) .+ \([A-Z][\w.]*\))\s*$/gm,
    ),
  // "not ok 3 - keeps blank lines", not a TODO or skipped test
  tap: (o) =>
    captured(o, /^not ok \d+(?: -)? (.+?)\s*$/gm).filter(
      (name) => !/#\s*(?:todo|skip)\b/i.test(name),
    ),
};

/**
 * The lines a runner prints when tests could not be built, collected or loaded, so they did not
 * run: a `Record` over `TestRunner`, so a new runner lands with its build-failure lines. The
 * baseline replay (#1960) reads them: an update whose new tests call an API the old code lacks
 * fails to compile there (R62 linehunk, Maven), which is not a failed test. No pattern matches what
 * a failing assertion prints.
 */
const C_BUILD_FAILURE =
  /^(?:\S.*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx):\d+(?::\d+)?: (?:fatal )?error: .+|\S.*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)\(\d+(?:,\d+)?\): (?:fatal )?error C\d+: .+|Unable to find executable: .+)$/;
export const BUILD_FAILURES: Record<TestRunner, RegExp> = {
  // "# Unhandled error between tests", "SyntaxError: Export named 'fold' not found in module ..."
  bun: /^(?:# Unhandled error between tests|error: Cannot find module .+|(?:SyntaxError|ResolveMessage): .+)$/,
  // "● Test suite failed to run", then "Cannot find module '../src/parser' from ..."
  jest: /^\s*(?:● Test suite failed to run|Cannot find module .+ from .+)$/,
  // "FAIL  tests/a.test.ts [ tests/a.test.ts ]", "Error: Failed to load url ../src/parser"
  vitest: /^\s*(?:FAIL\s+\S+ \[ .+ \]|Error: (?:Failed to load|Transform failed).*)$/,
  // "ERROR collecting tests/test_parser.py", "E   ModuleNotFoundError: No module named 'parser'"
  pytest: /^(?:_* ?ERROR collecting .+|E\s+(?:ModuleNotFoundError|ImportError|SyntaxError): .+)$/,
  // "error[E0425]: cannot find function `fold` in this scope", "error: could not compile `cidrfold`"
  cargo: /^error(?:\[E\d+\]: .+|: could not compile .+)$/,
  // "Parser.cs(12,5): error CS1501: No overload for method 'Run' takes 7 arguments"
  dotnet: /^.*\berror CS\d+: .+$/,
  // "[ERROR] COMPILATION ERROR :", "[ERROR] /src/test/java/AppTest.java:[12,9] cannot find symbol"
  maven: /^\[ERROR\] (?:COMPILATION ERROR.*|.*\.(?:java|kt|scala):\[\d+,\d+\] .+)$/,
  // "FAIL\texample.com/cidrfold [build failed]", "./fold_test.go:9:2: undefined: Fold"
  go: /^(?:FAIL\s+\S+ \[(?:build|setup) failed\]|\S+\.go:\d+:\d+: .+)$/,
  // "PHP Parse error:  syntax error, unexpected token "}" in /w/tests/SumTest.php on line 9"
  // PHPUnit 11 catches the parse error of a test file itself: "An error occurred inside PHPUnit.",
  // then "Message:  Unclosed '{' on line 2" and "Location: /w/tests/SumTest.php:3".
  phpunit: /^(?:(?:PHP )?(?:Parse|Fatal) error: .+|Location: \S+\.php:\d+)$/,
  pest: /^(?:(?:PHP )?(?:Parse|Fatal) error: .+|Location: \S+\.php:\d+)$/,
  // "An error occurred while loading ./spec/calc_spec.rb.", "While loading ./spec/a_spec.rb a
  // `raise SyntaxError` occurred, RSpec will now quit.": RSpec then runs no example at all.
  rspec: /^(?:An error occurred while loading \S+.*|While loading \S+ a `raise \w+` occurred.*)$/,
  // `rake test` loads every test file first: "/w/test/calc_test.rb:2:in `require': cannot load
  // such file -- calc (LoadError)", "/w/test/a_test.rb:9: syntax error ... (SyntaxError)".
  minitest: /^.*\.rb>?:\d+:.* \((?:LoadError|SyntaxError|NameError)\)$/,
  // "Error -> spec/a_spec.lua:3: <name> expected near 'end'" (a syntax error), and "suite
  // spec/a_spec.lua" under the error of a spec file whose top level failed (a missing `require`).
  busted: /^(?:Error (?:->|→) \S+\.luau?:\d+: .+|suite \S+\.luau?)$/,
  // GCC and Clang "tests/sum_test.cpp:3:33: error: 'sum3' was not declared in this scope", MSVC
  // "sum_test.cpp(3): error C3861: 'sum3': identifier not found", and CTest's "Unable to find
  // executable: build/sum_test" for a test the build gate did not build (#1490).
  ctest: C_BUILD_FAILURE,
  gtest: C_BUILD_FAILURE,
  // dart test loads each test file on its own: '  Failed to load "test/a_test.dart":', then the
  // compile error "test/a_test.dart:3:26: Error: Undefined name 'sum'.", or "Does not exist."
  dart: /^\s*Failed to load "[^"]+":.*$/,
  // sbt: Scala 3 "[error] -- [E006] Not Found Error: /w/src/test/scala/A.scala:2:31 ----", Scala 2
  // "[error] /w/src/test/scala/A.scala:2:31: not found: value x", then "(Test / compileIncremental)
  // Compilation failed" for the project whose sources do not compile.
  sbt: /^\[error\] (?:-- (?:\[E\d+\] )?.*: \S+\.scala:\d+:\d+ -*|\S+\.scala:\d+:\d+: .+|\(.*compileIncremental\) Compilation failed)$/,
  // swiftc: "/w/Tests/CalcTests/CalcTests.swift:6:27: error: cannot find 'sub' in scope"; an XCTest
  // failure names no column ("CalcTests.swift:6: error: CalcTests.testFails : XCTAssertEqual ...").
  swift: /^\S+\.swift:\d+:\d+: error: .+$/,
  // Gradle: "> Task :compileTestJava FAILED", "AppTest.java:12: error: cannot find symbol"
  junit: /^(?:> Task :\S*[cC]ompile\S* FAILED|.+\.(?:java|kt):\d+: error: .+)$/,
  // "Bail out! Cannot find module"
  tap: /^Bail out!.*$/,
  // "[-] Discovery in /w/tests/Sum.Tests.ps1 failed with:", "[-] /w/tests/Sum.Tests.ps1 failed with:"
  // (a BeforeAll that throws), and the "Container failed: 2" summary.
  pester: /^(?:\[-\] (?:Discovery in )?\S+\.Tests\.ps1 failed with:|Container failed: \d+)$/,
  // mix test compiles the test files before it runs any: "== Compilation error in file
  // test/a_test.exs ==" (Elixir 1.14 measured; 1.20 prints the same line, Kernel.ParallelCompiler),
  // also for a project file that does not compile.
  exunit: /^== Compilation error in file \S+\.exs?(?::\d+)? ==$/,
  // The package did not load: "Error in `load_all()`:" then "! Failed to load 'R/sum.R'".
  testthat: /^(?:Error in `(?:pkgload::)?load_all\(\)`:|! Failed to load '.+')$/,
};

// Compilers color their diagnostics even when not on a terminal (swiftc 6.4 prints "error:" in
// bold red, #1492), so the build-failure lines are read without ANSI colors.
const buildLines = (output: string): string[] =>
  withoutAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

/**
 * The first lines of a build failure in a check's output (`BUILD_FAILURES`): some or all of the
 * tests did not build, collect or load, so they did not run. Null when no runner printed one.
 */
export function buildFailure(output: string, limit = 5): string[] | null {
  const lines = buildLines(output);
  const found = lines.filter((line) => Object.values(BUILD_FAILURES).some((p) => p.test(line)));
  return found.length ? found.slice(0, limit) : null;
}

/**
 * The runner whose build-failure lines (`BUILD_FAILURES`) a check's output has, so the baseline
 * replay knows how to split that check per test target (#2020). Null when none has.
 */
export function buildRunner(output: string): TestRunner | null {
  const lines = buildLines(output);
  for (const [tool, pattern] of Object.entries(BUILD_FAILURES) as [TestRunner, RegExp][])
    if (lines.some((line) => pattern.test(line))) return tool;
  return null;
}

/**
 * The tests a check's output reports as failed, with the runner that printed them: the runner
 * whose summary the output has, else the first whose failure lines it has (`go test` without `-v`
 * prints `--- FAIL` lines and no count). Null when neither is in the output, so a caller cannot
 * read an empty list as "none failed".
 */
export function failedTests(output: string): { tool: TestRunner; names: string[] } | null {
  const counted = testCount(output)?.tool as TestRunner | undefined;
  if (counted) return { tool: counted, names: FAILED_TESTS[counted](output) };
  for (const { tool } of TEST_COUNTERS) {
    const names = FAILED_TESTS[tool](output);
    if (names.length) return { tool, names };
  }
  return null;
}

/** The number of tests a runner ran, by its summary line. */
export function testCount(output: string): OutputCount | null {
  for (const { tool, count } of TEST_COUNTERS) {
    const found = count(output);
    if (found !== null) return { tool, count: found };
  }
  return null;
}

/**
 * How many tests executed, by the runner's summary: skipped and ignored ones left out, and 0 for
 * a run that says it found none ("running 0 tests", "[no tests to run]"). Null when the output has
 * no summary that tells. A test file compiled out under the check's flags (a Rust
 * `#![cfg(feature = ...)]` file) prints "0 passed" with exit 0 (tonemath-update, bench round 56,
 * #1832).
 */
export function testsRan(output: string): OutputCount | null {
  for (const { tool, count, ran } of TEST_COUNTERS) {
    const found = ran(output);
    if (found !== null) return { tool, count: found };
    if (count(output) !== null) return null;
  }
  return null;
}

/**
 * The runners whose summary of zero tests, with exit 0, means the test target holds no test yet
 * (#2419): `testsRan` reads it as 0, so a `requireTests` check fails, and `noTestsCollected` must
 * know it. Each is recorded in the gate matrix's "no tests collected (#1864)" block. Swift 6.4 on
 * an empty `.testTarget`: XCTest "Executed 0 tests, with 0 failures" and swift-testing "Test run
 * with 0 tests in 0 suites passed"; busted 2.2 on a spec file without `it`: "0 successes / 0
 * failures / 0 errors / 0 pending"; testthat 3.2 on a test file without `test_that`: "[ FAIL 0 |
 * WARN 0 | SKIP 0 | PASS 0 ]"; Pester 5 on a `*.Tests.ps1` without `It`: "Tests Passed: 0,
 * Failed: 0, Skipped: 0, Inconclusive: 0, NotRun: 0"; `mix test` on a test module without
 * `test` (#2490): "0 failures" in Elixir 1.14 to 1.18, "0 tests, 0 failures" in 1.19 and "Result:
 * 0 tests" in 1.20, summed over an umbrella's apps, so another app's tests overrule it. cargo is
 * left out: its "0 passed" is a test binary with no test in a crate that may have others (#1832).
 */
const EMPTY_SUMMARIES: ReadonlySet<TestRunner> = new Set([
  "swift",
  "busted",
  "testthat",
  "pester",
  "exunit",
]);

/**
 * The lines of runners without a counter here that say, with exit 0, that the run held no test
 * (#2419), each with the line of the same runner that says another part of the run did hold
 * tests (dune runs every test executable), which overrules it.
 */
const EMPTY_RUN_LINES: readonly { runner: string; line: RegExp; held?: RegExp }[] = [
  // dotnet test (VSTest, SDK 8.0) on a test project without a test; another project's tests show
  // in the summary `testCount` reads. Not "No test matches the given testcase filter", a narrowed
  // run that selected nothing (#2378).
  { runner: "dotnet", line: /^No test is available in \S/m },
  // OUnit2 2.2 and Alcotest 1.7, the test libraries of `dune test`, on an empty suite.
  { runner: "ounit", line: /^Ran: 0 tests in: /m, held: /^Ran: [1-9]\d* tests? in: /m },
  {
    runner: "alcotest",
    line: /^Test Successful in \d[\d.]*s\. 0 tests? run\.\r?$/m,
    held: /^(?:Test Successful|\d+ failures?!) in \d[\d.]*s\. [1-9]\d* tests? run\./m,
  },
];

/**
 * Whether a test run exited with a summary that says the test target holds no test (#2419), as
 * opposed to tests that did not build or load (`buildFailure`) or a narrowed run that selected
 * none (XCTest's "Selected tests", #2378).
 */
export function emptyTestRun(output: string): boolean {
  if (buildFailure(output)) return false;
  const counted = testCount(output);
  if (counted && counted.count > 0) return false;
  if (counted && EMPTY_SUMMARIES.has(counted.tool as TestRunner))
    return !/^Test Suite 'Selected tests'/m.test(output);
  return EMPTY_RUN_LINES.some(({ line, held }) => line.test(output) && !held?.test(output));
}

/** Reads the count of a kind from a check's output. */
export const outputCount = (kind: CountKind, output: string): OutputCount | null =>
  kind === "diagnostics" ? diagnosticCount(output) : testCount(output);

/**
 * Every count a check's output has: a build-and-test command can report both diagnostics and
 * tests. A failing run's test count is not kept, since some tests never ran.
 */
export function outputCounts(output: string, passed: boolean): BaselineCount[] {
  const kinds: CountKind[] = passed ? ["diagnostics", "tests"] : ["diagnostics"];
  return kinds.flatMap((kind) => {
    const count = outputCount(kind, output);
    return count ? [{ kind, ...count }] : [];
  });
}

export interface BaselineCount extends OutputCount {
  kind: CountKind;
}

export interface BaselineRegression {
  kind: CountKind;
  /** What fell behind, for the finding's suggested fix. */
  message: string;
  /**
   * `high` for more errors or fewer tests; `low` when only warnings rose, which a quick fix
   * clears (#1791). A count that does not split its errors is taken as errors.
   */
  severity: "high" | "low";
}

/**
 * How a passing check falls behind the code the run started from: more diagnostics, or fewer
 * tests unless the run deletes test files. Null when the counts cannot be compared or held.
 */
export function baselineRegression(
  baseline: BaselineCount,
  output: string,
  deletesTests = false,
): BaselineRegression | null {
  const now = outputCount(baseline.kind, output);
  if (!now || now.tool !== baseline.tool) return null;
  if (baseline.kind === "diagnostics" && now.count > baseline.count) {
    const warningsOnly =
      now.errors !== undefined && baseline.errors !== undefined && now.errors <= baseline.errors;
    return {
      kind: "diagnostics",
      message: `${warningsOnly ? "warnings" : "diagnostics"} rose from ${baseline.count} to ${now.count} against the code the run started from (${now.tool}); fix the new ones, the check passing on its exit code is not enough`,
      severity: warningsOnly ? "low" : "high",
    };
  }
  if (baseline.kind === "tests" && now.count < baseline.count && !deletesTests)
    return {
      kind: "tests",
      message: `tests fell from ${baseline.count} to ${now.count} against the code the run started from (${now.tool}); restore the existing tests the change removed or skipped`,
      severity: "high",
    };
  return null;
}

/** A path into one of BAKED's worktrees, `.../.baked/worktrees/RUN/main` or `.../RUN/T005`. */
const WORKTREE_PATH =
  /(?:[A-Za-z]:)?(?:[\\/][^\\/\s"'`()<>:]+)*[\\/]\.baked[\\/]worktrees[\\/][^\\/\s"'`()<>:]+[\\/][^\\/\s"'`()<>:]+/g;

/**
 * A linter's or type checker's summary count: "Checked 2 files", "Found 3 errors", "in 2 files",
 * "5 files checked". Each file a run adds changes it while the diagnostics stay the same (dur
 * 741547f0: Biome failed on `biome.json` before and after T001 wrote `src/duration.ts`, #1218).
 */
const SUMMARY_COUNT =
  /\b(Checked|Found|in|Scanned) \d+ (files?|errors?|warnings?|infos?|problems?|diagnostics?)\b/g;
const singular = (noun: string): string => noun.replace(/s$/, "");
const FILES_DONE =
  /\b\d+ (files?) (checked|scanned|inspected|formatted|already formatted|left unchanged|would be left unchanged|would be reformatted)\b/g;
/**
 * Counts that grow when a task adds a file or a passing test while the failure stays the same
 * (#1425): mypy's "checked 4 source files", and the passed, skipped and total counts of test
 * summaries (pytest, jest, vitest, bun, cargo, dotnet, Maven, Gradle). Failed counts are kept.
 */
const GROWING_COUNTS: [RegExp, string][] = [
  [/\bchecked \d+ source files?\b/g, "checked <n> source file"],
  // ExUnit from Elixir 1.20 (#2490): "Result: 2/3 passed (1/1 doctest, 1/2 tests)"; its "Failed:
  // 1 test" line keeps the failed count.
  [/^Result: (?:\d+\/)?\d+ passed(?: \([^)\n]*\))?/gm, "Result: <n> passed"],
  [
    /\b\d+ (passed|skipped|deselected|xfailed|xpassed|warnings?|total|tests completed)\b/g,
    "<n> $1",
  ],
  [/\b(Passed|Skipped|Total|Tests run):\s*\d+/g, "$1: <n>"],
  // The JUnit block of a Gradle run's test reports (#1489) and any printed JUnit report.
  [/\b(tests|skipped)="\d+"/g, '$1="<n>"'],
  [/^(Gradle test reports \()\d+ files?/gm, "$1<n> files"],
  // RSpec "12 examples, 1 failure, 2 pending", Minitest "4 runs, 9 assertions, 1 failures, 0 errors,
  // 1 skips" with its rates "2931.07 runs/s, 1465.53 assertions/s" (#1493).
  [/\b\d+ (examples?|pending|runs?|assertions?|skips?)\b(?!\/s)/g, "<n> $1"],
  [/\b[\d.]+ (runs|assertions)\/s\b/g, "<n> $1/s"],
  // ExUnit up to Elixir 1.19 (#2490): "1 doctest, 3 tests, 1 failure", the failures kept; and the
  // lines of Mix compiling what changed since its last run, which are progress.
  [
    /^(?:\d+ (?:tests?|doctests?|propert(?:y|ies)|features?), )+(\d+ failures?)\b/gm,
    "<n> tests, $1",
  ],
  [/^(?:Compiling \d+ files? \(\.exs?\)|Generated \S+ app)\r?(?:\n|$)/gm, ""],
  // The random order seed of RSpec and Minitest: "Randomized with seed 1809", "--seed 1809".
  [/\b(seed|--seed) \d+\b/g, "$1 <n>"],
  // dart test prints a progress line as each test starts (#1494): only the failures, their
  // summary and its failed count stay, the passed and skipped counts go.
  [
    /^[\d:]+ \+\d+(?: ~\d+)?(?: -\d+)?: (?!.*\[E\]\s*$)(?!(?:All tests passed!|Some tests failed\.|All tests skipped\.)\s*$).*(?:\n|$)/gm,
    "",
  ],
  [/^[\d:]+ \+\d+(?: ~\d+)?( -\d+)?: /gm, "+<n>$1: "],
  [/^\s*Skip: .*(?:\n|$)/gm, ""],
  // sbt (#1496): munit's line per passing or ignored test, ScalaTest's line per test that did not
  // fail, the per-project and ScalaTest totals with their failures kept, and the sources counted.
  [/^\s*\+ \S.*? (?:<duration>|[\d.]+s)\s*(?:\n|$)/gm, ""],
  [/^==> i \S.* ignored\b.*(?:\n|$)/gm, ""],
  [/^\[info\] - (?!.*\*\*\* FAILED \*\*\*).*(?:\n|$)/gm, ""],
  [
    /^(\[(?:info|error)\] (?:Passed|Failed|Error): )Total \d+, (Failed \d+, Errors \d+), Passed \d+.*$/gm,
    "$1Total <n>, $2, Passed <n>",
  ],
  [/^\[info\] Total number of tests run: \d+$/gm, "[info] Total number of tests run: <n>"],
  [/\bSuites: completed \d+, aborted (\d+)/g, "Suites: completed <n>, aborted $1"],
  [
    /\bTests: succeeded \d+, failed (\d+), canceled (\d+), ignored \d+, pending \d+/g,
    "Tests: succeeded <n>, failed $1, canceled $2, ignored <n>, pending <n>",
  ],
  // sbt compiles only what changed since its last run: its compile lines are progress, not output.
  [/^\[info\] (?:compiling \d+ (?:Scala|Java)(?: and \w+)? sources?\b.*|done compiling)\n?/gm, ""],
  [/\b(Checking|Formatting) \d+ Scala sources\b/g, "$1 <n> Scala sources"],
  // swift test (#1492): SwiftPM's build steps ("[3/5] Compiling", and from Swift 6.2 "[29 / 51] Calc"
  // with thin spaces and phase lines such as "[Planning deferred tasks]" or "[Describing: 24 / 202]",
  // never Maven's "[INFO]") and build time ("Build
  // complete! (15.51 secs)"), XCTest's started and passed lines and its suite timestamps,
  // swift-testing's started, passed and skipped lines, with the failures kept.
  [/^\[\d+\s*\/\s*\d+\](?: .*)?(?:\n|$)/gm, ""],
  [/^\[[A-Z][a-z][^\]\n]*\]$\n?/gm, ""],
  [/^(Build complete!) \([\d.]+ ?s(?:ecs?)?\)/gm, "$1 (<duration>)"],
  [/^Test (?:Suite|Case) '.+' (?:started at .*|passed \(.*)(?:\n|$)/gm, ""],
  [/^(Test Suite '.+' failed) at .*$/gm, "$1"],
  [
    /\bExecuted \d+ tests?, with (?:\d+ tests? skipped and )?(\d+ failures? \(\d+ unexpected\)) in [\d.]+ \([\d.]+\) seconds/g,
    "Executed <n> tests, with $1 in <duration>",
  ],
  [/^. Test (?!run with ).+ (?:started\.|passed after .*|skipped(?::.*|\.)?)(?:\n|$)/gm, ""],
  [/^(. Test run with )\d+ (tests?)/gm, "$1<n> $2"],
  // dart format: "Formatted 3 files (1 changed) in 0.01 seconds."
  [/\bFormatted \d+ files? \((\d+) changed\)/g, "Formatted <n> files ($1 changed)"],
  // The progress line of RSpec, Minitest and RuboCop, one character per example or file.
  [/^[.*CEFRSW]+$\n?/gm, ""],
  [/^(\s*)\d+ (pass|skip|todo)$/gm, "$1<n> $2"],
  [/\b\d+ expect\(\) calls\b/g, "<n> expect() calls"],
  [/\bRan \d+ tests? across \d+ files?\b/g, "Ran <n> tests across <n> files"],
  [/\brunning \d+ tests?\b/g, "running <n> tests"],
  [/^(\s*Tests?(?: Files)?\b.*?)\s*\(\d+\)$/gm, "$1"],
  // `go test -v` lists every test it runs and every one that passes (#1733).
  [/^=== (?:RUN|PAUSE|CONT|NAME)\s.*(?:\n|$)/gm, ""],
  [/^\s*--- PASS: .*(?:\n|$)/gm, ""],
  // TAP numbers every test and prints a line per passing one (busted, bats, prove, node:test).
  [/^(\s*)ok \d+\b.*(?:\n|$)/gm, ""],
  [/^(\s*)not ok \d+\b/gm, "$1not ok"],
  [/^(?<indent>\s*)1\.\.\d+/gm, "$<indent>1..<n>"],
  // PHPUnit's progress line and its time and memory, its test and assertion counts, and Pest's
  // assertions (#1491); the failure and error counts are kept.
  [/^[.FEWRSIDN]+\s+\d+ \/ \d+ \(\s*\d+%\)\s*(?:\n|$)/gm, ""],
  [/^Time: [\d:.]+, Memory: [\d.]+ \w+\s*(?:\n|$)/gm, ""],
  [/^(Tests|Assertions): \d+/gm, "$1: <n>"],
  [/\b(Assertions): \d+/g, "$1: <n>"],
  [/\(\d+ assertions?\)/g, "(<n> assertions)"],
  // busted's progress line, one character per test (`+` success, `-` failure, `*` error, `.`
  // pending; `●◼✱◌` in a UTF-8 terminal), and its success count (#1495).
  [/^[+\-*.●◼✱◌]+$\n?/gm, ""],
  [/\b\d+ (successe?s?) \//g, "<n> success /"],
  // CTest's line per started and per passing test, the test numbers, and its pass share and total
  // (#1490); the failed count is kept.
  [/^\s*Start +\d+: .*(?:\n|$)/gm, ""],
  [/^\s*\d+\/\d+ Test +#\d+: .*\s Passed\b.*(?:\n|$)/gm, ""],
  [/^(\s*)\d+\/\d+ Test +#\d+:/gm, "$1Test:"],
  [/^\s+\d+ - /gm, "\t<n> - "],
  [/^\d+% tests passed, (\d+ tests? failed) out of \d+$/gm, "<n>% tests passed, $1 out of <n>"],
  [/^\d+% tests passed out of \d+$/gm, "<n>% tests passed out of <n>"],
  // GoogleTest's lines per started and passing test and its counts of tests and suites.
  [/^\[ (?:RUN| {6}OK) +\] .*(?:\n|$)/gm, ""],
  [
    /^(\[[=-]{10}\] (?:Running )?)\d+ tests? from \d+ test (?:suites?|cases?)/gm,
    "$1<n> tests from <n> test suites",
  ],
  [/^(\[-{10}\] )\d+ tests? from /gm, "$1<n> tests from "],
  [/^\[ {2}PASSED {2}\] \d+ tests?\./gm, "[  PASSED  ] <n> tests."],
  // clang-tidy's progress line per file and its count of warnings in headers it did not report.
  [/^\[\d+\/\d+\] Processing file .*(?:\n|$)/gm, ""],
  [/^\d+ warnings? generated\.(?:\n|$)/gm, ""],
  // Pester counts the files and tests it discovers (#1498).
  [/\bStarting discovery in \d+ files?\b/g, "Starting discovery in <n> files"],
  [/\bDiscovery found \d+ tests?\b/g, "Discovery found <n> tests"],
  // testthat's summary counts passing and skipped expectations (#1500).
  [/\| SKIP \d+ \| PASS \d+ \]/g, "| SKIP <n> | PASS <n> ]"],
  // TAP::Harness (prove, pg_prove) summarizes with totals, test numbers and CPU times (#1499):
  // "Failed 1/2 subtests", "(Wstat: 0 Tests: 2 Failed: 1)", "  Failed test:  2",
  // "Files=1, Tests=2,  0 wallclock secs ( 0.01 usr + ...)". The failed counts stay.
  [/\bFailed (\d+)\/\d+ subtests\b/g, "Failed $1/<n> subtests"],
  [/\(Wstat: (\d+) Tests: \d+ Failed: (\d+)\)/g, "(Wstat: $1 Tests: <n> Failed: $2)"],
  [/^(\s*Failed tests?:)\s+[\d, -]+$/gm, "$1 <n>"],
  [/^Files=\d+, Tests=\d+,.*$/gm, "Files=<n>, Tests=<n>"],
];

/**
 * The output of a failing check with what changes between two runs of the same failure left out
 * (colours, durations, timestamps, the workspace path), so the checks stage can tell a required
 * check that still fails exactly as it did on the code the run started from (#934). Every
 * worktree path counts as the workspace: the baseline is measured in the run worktree and a later
 * check may run in a task worktree (mouse-mover-update 3d7389cf, #1055).
 */
export const growingCounts = (text: string): string =>
  GROWING_COUNTS.reduce((out, [pattern, to]) => out.replace(pattern, to), text);

export function failureSignature(output: string, root: string): string {
  const text = withoutWorkspace(output, root)
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds|m)\b/g, "<duration>")
    .replace(/\[\d+(\.\d+)?(ms|s)\]/g, "<duration>")
    // ScalaTest "Run completed in 387 milliseconds.", sbt "Total time: 12 s, completed Oct 25, 2026,
    // 2:43:17 AM" (#1496).
    .replace(/\bRun completed in \d+ milliseconds\b/g, "Run completed in <duration>")
    .replace(
      /, completed [A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2}:\d{2}(?: [AP]M)?/g,
      ", completed <time>",
    );
  return withoutCounts(text);
}

/**
 * `failureSignature` with its volatile values taken out by shape (`normalizeVolatile`, the table
 * the repeated-failure hash reads) instead of by a few spellings (#2295): Gradle's `1m 3s`,
 * dotnet's `< 1 ms`, CTest's padded columns, Maven's `01:05 min`, addresses with or without `0x`,
 * seeds, run IDs and temporary paths compare equal, while a whole number with a unit that no word
 * introduces as a time (`expected 5s`) stays, as an asserted value. Recorded beside the live
 * signature in the check baseline (`shapes`); the `baseline_signature` reason records, in shadow,
 * where it would match and the live one does not.
 */
export function shapedFailureSignature(output: string, root: string): string {
  const text = withoutWorkspace(output, root)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\\", "/");
  return withoutCounts(normalizeVolatile(text));
}

/** The output without colours and with every worktree path of the project as `<root>`. */
function withoutWorkspace(output: string, root: string): string {
  const project = root.replace(/[\\/]\.baked[\\/]worktrees[\\/].*$/, "");
  return (
    output
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(WORKTREE_PATH, "<root>")
      .split(root)
      .join("<root>")
      .split(project)
      .join("<root>")
  );
}

/** The signature's counts that grow as tasks add files and tests, left out; blank lines dropped. */
function withoutCounts(text: string): string {
  return growingCounts(
    text
      // RuboCop: "Inspecting 3 files".
      .replace(/\bInspecting \d+ files?\b/g, "Inspecting <n> file")
      .replace(SUMMARY_COUNT, (_, verb: string, noun: string) => `${verb} <n> ${singular(noun)}`)
      .replace(FILES_DONE, (_, noun: string, verb: string) => `<n> ${singular(noun)} ${verb}`)
      .replace(/✖ \d+ problems? \(\d+ errors?, \d+ warnings?\)/g, "✖ <n> problems")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .join("\n")
      .trim(),
  );
}

/**
 * Whether a failure signature reports nothing the baseline's did not: every line of `after` is a
 * line of `before`. A folder a task creates removes its error from a check that named two missing
 * folders (`ruff check src tests`: E902 on `src` and `tests`, then on `tests` only), and the rest
 * is still the debt from before the run (#1913).
 */
export function withinBaseline(before: string, after: string): boolean {
  const lines = new Set(before.split("\n"));
  const found = after.split("\n").filter(Boolean);
  return found.length > 0 && found.every((line) => lines.has(line));
}

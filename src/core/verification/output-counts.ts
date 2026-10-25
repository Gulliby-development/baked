import { type LanguageRecord, none } from "../intelligence/language-records.js";
import { isTestFile } from "../intelligence/language-traits.js";
import type { Check } from "../workflows/types.js";

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
  // dart analyze and flutter analyze: "  error - lib/a.dart:3:14 - ... - invalid_assignment", then
  // "2 issues found." or "No issues found!". Infos are lints dart analyze exits 0 on.
  if (
    /^Analyzing \S.*\.\.\.$/m.test(output) &&
    /^(?:No issues found!|\d+ issues? found\.)$/m.test(output)
  ) {
    const errors = lines(output, /^\s*error - \S+:\d+:\d+ - /);
    return { tool: "dart", count: errors + lines(output, /^\s*warning - \S+:\d+:\d+ - /), errors };
  }
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
  | "rspec"
  | "minitest"
  | "dart"
  | "junit"
  | "tap";

/**
 * The summary parsers, in the order `testCount` tries them: a more specific summary first, the
 * report formats any runner can print (JUnit XML, TAP) last. `ran` is the share of `count` that
 * executed, skipped and ignored tests left out, or null where the summary does not tell (#1832).
 */
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
    // Maven surefire: "Tests run: 12, Failures: 0, Errors: 0, Skipped: 0" (the summary, no time).
    count: (o) =>
      num(o.match(/^\[\w+\] Tests run: (\d+), Failures: \d+, Errors: \d+, Skipped: \d+\s*$/m)),
    ran: (o) => {
      const m = o.match(
        /^\[\w+\] Tests run: (\d+), Failures: \d+, Errors: \d+, Skipped: (\d+)\s*$/m,
      );
      return m ? Number(m[1]) - Number(m[2]) : null;
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
  scala: none('sbt\'s "Tests: succeeded N" summary is not read'),
  c: none("C has no common test runner summary; ctest output is not read"),
  cpp: none("ctest and GoogleTest summaries are not read"),
  ruby: ["rspec", "minitest"],
  php: none("PHPUnit summaries are not read yet (#1491)"),
  swift: none("XCTest and swift-testing summaries are not read"),
  lua: ["tap"],
  elixir: none('ExUnit\'s "N tests, M failures" summary is not read'),
  dart: ["dart"],
  zig: none("zig build test prints no count"),
  bash: ["tap"],
  ocaml: none("dune test output has no common summary"),
  objc: none("xcodebuild test summaries are not read"),
  solidity: none("forge test summaries are not read"),
};

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
  // "rspec ./spec/calc_spec.rb:6 # Calc fails on purpose", the rerun list after "Failed examples:"
  rspec: (o) => captured(o, /^rspec \S+:\d+ # (.+?)\s*$/gm),
  // "  1) Failure:" or "  2) Error:", then "CalcTest#test_fail [/w/test/calc_test.rb:8]:"
  minitest: (o) =>
    captured(o, /^\s*\d+\) (?:Failure|Error):\r?\n(\S+#\S+?)(?: \[[^\]\n]*\])?:\s*$/gm),
  // "00:00 +1 -1: test/calc_test.dart: fails on purpose [E]", not a file that did not load
  dart: (o) =>
    captured(o, new RegExp(`${DART_LINE}(?!loading \\S+ \\[E\\])(.+?) \\[E\\]\\s*$`, "gm")),
  // A <testcase> with a <failure> or <error> child.
  junit: (o) =>
    [...o.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
      .filter((m) => /<(?:failure|error)\b/.test(m[2] ?? ""))
      .map((m) => {
        const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(m[1] ?? "")?.[1];
        return [attr("classname"), attr("name")].filter(Boolean).join(".");
      })
      .filter(Boolean),
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
  // "An error occurred while loading ./spec/calc_spec.rb.", "While loading ./spec/a_spec.rb a
  // `raise SyntaxError` occurred, RSpec will now quit.": RSpec then runs no example at all.
  rspec: /^(?:An error occurred while loading \S+.*|While loading \S+ a `raise \w+` occurred.*)$/,
  // `rake test` loads every test file first: "/w/test/calc_test.rb:2:in `require': cannot load
  // such file -- calc (LoadError)", "/w/test/a_test.rb:9: syntax error ... (SyntaxError)".
  minitest: /^.*\.rb>?:\d+:.* \((?:LoadError|SyntaxError|NameError)\)$/,
  // dart test loads each test file on its own: '  Failed to load "test/a_test.dart":', then the
  // compile error "test/a_test.dart:3:26: Error: Undefined name 'sum'.", or "Does not exist."
  dart: /^\s*Failed to load "[^"]+":.*$/,
  // Gradle: "> Task :compileTestJava FAILED", "AppTest.java:12: error: cannot find symbol"
  junit: /^(?:> Task :\S*[cC]ompile\S* FAILED|.+\.(?:java|kt):\d+: error: .+)$/,
  // "Bail out! Cannot find module"
  tap: /^Bail out!.*$/,
};

/**
 * The first lines of a build failure in a check's output (`BUILD_FAILURES`): some or all of the
 * tests did not build, collect or load, so they did not run. Null when no runner printed one.
 */
export function buildFailure(output: string, limit = 5): string[] | null {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd());
  const found = lines.filter((line) => Object.values(BUILD_FAILURES).some((p) => p.test(line)));
  return found.length ? found.slice(0, limit) : null;
}

/**
 * The runner whose build-failure lines (`BUILD_FAILURES`) a check's output has, so the baseline
 * replay knows how to split that check per test target (#2020). Null when none has.
 */
export function buildRunner(output: string): TestRunner | null {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd());
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
  [
    /\b\d+ (passed|skipped|deselected|xfailed|xpassed|warnings?|total|tests completed)\b/g,
    "<n> $1",
  ],
  [/\b(Passed|Skipped|Total|Tests run):\s*\d+/g, "$1: <n>"],
  // RSpec "12 examples, 1 failure, 2 pending", Minitest "4 runs, 9 assertions, 1 failures, 0 errors,
  // 1 skips" with its rates "2931.07 runs/s, 1465.53 assertions/s" (#1493).
  [/\b\d+ (examples?|pending|runs?|assertions?|skips?)\b(?!\/s)/g, "<n> $1"],
  [/\b[\d.]+ (runs|assertions)\/s\b/g, "<n> $1/s"],
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
  const project = root.replace(/[\\/]\.baked[\\/]worktrees[\\/].*$/, "");
  const text = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(WORKTREE_PATH, "<root>")
    .split(root)
    .join("<root>")
    .split(project)
    .join("<root>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds|m)\b/g, "<duration>")
    .replace(/\[\d+(\.\d+)?(ms|s)\]/g, "<duration>")
    // RuboCop: "Inspecting 3 files".
    .replace(/\bInspecting \d+ files?\b/g, "Inspecting <n> file")
    .replace(SUMMARY_COUNT, (_, verb: string, noun: string) => `${verb} <n> ${singular(noun)}`)
    .replace(FILES_DONE, (_, noun: string, verb: string) => `<n> ${singular(noun)} ${verb}`)
    .replace(/✖ \d+ problems? \(\d+ errors?, \d+ warnings?\)/g, "✖ <n> problems")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n")
    .trim();
  return growingCounts(text);
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

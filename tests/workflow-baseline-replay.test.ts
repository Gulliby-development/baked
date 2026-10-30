import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_FAILURES, buildFailure, buildRunner, FAILED_TESTS, failedTests, type TestRunner } from "../src/core/verification/output-counts.js";
import {
  BASELINE_REPLAY_NOTE,
  type BaselineReplay,
  GREENFIELD_NOTE,
  QUALITY_BASELINE_REPLAY,
  REPLAY_KEEP_GOING,
  REPLAY_TARGETS,
  replayCommand,
  replayEdits,
  replayStopped,
  replayTargetRecords,
  replayTargets,
} from "../src/core/workflows/quality/baseline-replay.js";
import { RESOLUTION_SOURCES, type ResolutionIo, replayResolution, resolutionDiff, UNCHANGED_RESOLUTION_NOTE } from "../src/core/workflows/quality/dependency-resolution.js";
import type { Check, ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";
import { runWorktreeDir } from "../src/core/workflows/worktree.js";

// Bench rounds 60 and 61 (#1945). Update briefs asked for proof that the new tests fail on the code
// before the change (taskplan, ignorewhy, tplfill, modeplan). No check of the run produced it, so
// convergence answered inconclusive, then fail, and stopped no_progress. With `baselineReplay: on`
// the host runs the test checks once more with the changed non-test files put back.

/** One failing test per runner, in the shape each runner prints it. */
const FAILURES = [
  { runner: "bun", output: "tests/a.test.ts:\n(pass) keeps lines [0.1ms]\n(fail) parser > keeps blank lines [0.2ms]\n\n 1 pass\n 1 fail\nRan 2 tests across 1 file. [5ms]", name: "parser > keeps blank lines" },
  { runner: "jest", output: "FAIL tests/a.test.js\n  ● parser › keeps blank lines\n\nTests:       1 failed, 1 passed, 2 total", name: "parser › keeps blank lines" },
  { runner: "vitest", output: " FAIL  tests/a.test.ts > parser > keeps blank lines\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)", name: "tests/a.test.ts > parser > keeps blank lines" },
  { runner: "tap", output: "TAP version 13\nok 1 - plain\nnot ok 2 - keeps blank lines\nnot ok 3 - later # TODO\n1..3", name: "keeps blank lines" },
  { runner: "pytest", output: "FAILED tests/test_parser.py::test_blank_lines - AssertionError\n==== 1 failed, 3 passed in 0.12s ====", name: "tests/test_parser.py::test_blank_lines" },
  { runner: "cargo", output: "test parser::blank_lines ... FAILED\ntest parser::plain ... ok\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out", name: "parser::blank_lines" },
  { runner: "go", output: "--- FAIL: TestBlankLines (0.00s)\nFAIL\nFAIL\texample.com/taskplan\t0.002s", name: "TestBlankLines" },
  { runner: "dotnet", output: "  Failed Parser.Tests.BlankLines [12 ms]\nFailed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4", name: "Parser.Tests.BlankLines" },
  { runner: "maven", output: "[ERROR] app.ParserTest.blankLines -- Time elapsed: 0.01 s <<< FAILURE!\n[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0", name: "app.ParserTest.blankLines" },
  { runner: "phpunit", output: "There was 1 failure:\n\n1) App\\Tests\\ParserTest::testBlankLines\nFailed asserting that false is true.\n\nFAILURES!\nTests: 4, Assertions: 4, Failures: 1.", name: "App\\Tests\\ParserTest::testBlankLines" },
  { runner: "pest", output: "   FAILED  Tests\\ParserTest > it keeps blank lines\n  Failed asserting that false is true.\n\n  Tests:    1 failed, 3 passed (4 assertions)", name: "Tests\\ParserTest > it keeps blank lines" },
  { runner: "busted", output: "+-\n1 success / 1 failure / 0 errors / 0 pending : 0.0014 seconds\n\nFailure -> spec/parser_spec.lua @ 7\nparser keeps blank lines\nspec/parser_spec.lua:8: Expected objects to be equal.\n", name: "parser keeps blank lines" },
  // RSpec 3.13 and Minitest 5.20 through `rake test` (#1493).
  { runner: "rspec", output: "Finished in 0.00714 seconds (files took 0.09504 seconds to load)\n5 examples, 1 failure, 2 pending\n\nFailed examples:\n\nrspec ./spec/calc_spec.rb:6 # Calc fails on purpose\n", name: "Calc fails on purpose" },
  { runner: "minitest", output: "  1) Failure:\nCalcTest#test_fail [/repo/test/calc_test.rb:8]:\nExpected: 4\n  Actual: 3\n\n  2) Error:\nCalcTest#test_error:\nRuntimeError: boom\n\n4 runs, 2 assertions, 1 failures, 1 errors, 1 skips", name: "CalcTest#test_error" },
  { runner: "dart", output: "00:00 +0: test/calc_test.dart: adds\n00:00 +1 -1: test/calc_test.dart: fails on purpose [E]\n  Expected: <4>\n    Actual: <3>\n00:00 +2 ~1 -1: Some tests failed.\n", name: "test/calc_test.dart: fails on purpose" },
  { runner: "swift", output: "Test Case '-[AppTests.CalcTests testFails]' started.\n/w/Tests/AppTests/CalcTests.swift:7: error: -[AppTests.CalcTests testFails] : XCTAssertEqual failed: (\"3\") is not equal to (\"4\")\nTest Case '-[AppTests.CalcTests testFails]' failed (0.001 seconds).\n", name: "-[AppTests.CalcTests testFails]" },
  { runner: "sbt", output: "[info] CalcSpec:\n[info] - adds\n[info] - fails on purpose *** FAILED ***\n[info]   3 did not equal 4 (CalcSpec.scala:7)\n[info] Tests: succeeded 1, failed 1, canceled 0, ignored 0, pending 0\n", name: "CalcSpec: fails on purpose" },
  { runner: "testthat", output: "[ FAIL 1 | WARN 0 | SKIP 0 | PASS 3 ]\n\n══ Failed tests ════════\n── Failure ('test-parser.R:4:3'): keeps blank lines ────────\nlength(lines) (`actual`) not equal to 2 (`expected`).\n\n[ FAIL 1 | WARN 0 | SKIP 0 | PASS 3 ]\nError: Test failures", name: "keeps blank lines" },
  // mix test, Elixir 1.14.0 (#2490).
  { runner: "exunit", output: ".\n\n  1) test fails on purpose (SumTest)\n     test/sum_test.exs:8\n     Assertion with == failed\n     code:  assert Proj.hello() == :moon\n     left:  :world\n     right: :moon\n     stacktrace:\n       test/sum_test.exs:9: (test)\n\n\nFinished in 0.02 seconds (0.00s async, 0.02s sync)\n2 tests, 1 failure\n\nRandomized with seed 0\n", name: "test fails on purpose (SumTest)" },
  { runner: "pester", output: "Starting discovery in 1 files.\nDiscovery found 2 tests in 210ms.\nRunning tests.\n[-] Parser.keeps blank lines 41ms (38ms|3ms)\n Expected 2, but got 1.\nTests completed in 702ms\nTests Passed: 1, Failed: 1, Skipped: 0, Inconclusive: 0, NotRun: 0", name: "Parser.keeps blank lines" },
] as const;

/**
 * Tests that do not build on the code before the change, per runner (#1960): R62 linehunk's new
 * test called a seven-parameter overload the old Applier.run lacks, and Maven failed to compile it.
 */
const BUILD_ERRORS = [
  { runner: "bun", output: "tests/a.test.ts:\n\n# Unhandled error between tests\n-------------------------------\nSyntaxError: Export named 'fold' not found in module '/repo/src/sign.ts'.\n-------------------------------\n\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file. [7.00ms]", line: "SyntaxError: Export named 'fold' not found in module '/repo/src/sign.ts'." },
  { runner: "jest", output: "FAIL tests/a.test.js\n  ● Test suite failed to run\n\n    Cannot find module '../src/fold' from 'tests/a.test.js'\n\nTests:       0 total", line: "  ● Test suite failed to run" },
  { runner: "vitest", output: " FAIL  tests/a.test.ts [ tests/a.test.ts ]\nError: Failed to load url ../src/fold (resolved id: ../src/fold) in /repo/tests/a.test.ts. Does the file exist?\n Test Files  1 failed (1)\n      Tests  no tests", line: "Error: Failed to load url ../src/fold (resolved id: ../src/fold) in /repo/tests/a.test.ts. Does the file exist?" },
  { runner: "tap", output: "TAP version 13\nBail out! Cannot find module '../src/fold'", line: "Bail out! Cannot find module '../src/fold'" },
  { runner: "pytest", output: "==================================== ERRORS ====================================\n___________________ ERROR collecting tests/test_parser.py ___________________\nImportError while importing test module '/repo/tests/test_parser.py'.\nE   ModuleNotFoundError: No module named 'parser.fold'\n=========================== 1 error in 0.05s ===========================", line: "E   ModuleNotFoundError: No module named 'parser.fold'" },
  { runner: "cargo", output: "   Compiling cidrfold v0.1.0 (/repo)\nerror[E0425]: cannot find function `fold` in this scope\n --> tests/fold.rs:4:13\nerror: could not compile `cidrfold` (test \"fold\") due to 1 previous error", line: "error[E0425]: cannot find function `fold` in this scope" },
  { runner: "go", output: "# example.com/cidrfold [example.com/cidrfold.test]\n./fold_test.go:9:2: undefined: Fold\nFAIL\texample.com/cidrfold [build failed]\nFAIL", line: "./fold_test.go:9:2: undefined: Fold" },
  { runner: "dotnet", output: "/repo/tests/ParserTests.cs(12,5): error CS1501: No overload for method 'Run' takes 7 arguments [/repo/tests/Tests.csproj]\n\nBuild FAILED.", line: "/repo/tests/ParserTests.cs(12,5): error CS1501: No overload for method 'Run' takes 7 arguments [/repo/tests/Tests.csproj]" },
  { runner: "maven", output: "[INFO] --- compiler:3.13.0:testCompile (default-testCompile) @ linehunk ---\n[ERROR] COMPILATION ERROR : \n[ERROR] /repo/src/test/java/app/StdinPatchTest.java:[31,20] method run in class app.Applier cannot be applied to given types;\n[INFO] BUILD FAILURE", line: "[ERROR] /repo/src/test/java/app/StdinPatchTest.java:[31,20] method run in class app.Applier cannot be applied to given types;" },
  { runner: "phpunit", output: "PHP Parse error:  syntax error, unexpected end of file in /repo/tests/SumTest.php on line 3\n", line: "PHP Parse error:  syntax error, unexpected end of file in /repo/tests/SumTest.php on line 3" },
  { runner: "phpunit", output: "An error occurred inside PHPUnit.\n\nMessage:  Unclosed '{' on line 2\nLocation: /repo/tests/SumTest.php:3\n\n#0 /repo/vendor/phpunit/phpunit/src/Runner/TestSuiteLoader.php(49): load()\n", line: "Location: /repo/tests/SumTest.php:3" },
  { runner: "pest", output: "PHP Fatal error:  Cannot redeclare App\\sum() in /repo/tests/SumTest.php on line 4\n", line: "PHP Fatal error:  Cannot redeclare App\\sum() in /repo/tests/SumTest.php on line 4" },
  // busted 2.2.0 (#1495): a spec file that does not parse, then one whose top level fails.
  { runner: "busted", output: "*\n0 successes / 0 failures / 1 error / 0 pending : 0.0012 seconds\n\nError -> spec/broken_spec.lua:3: <name> or '...' expected near 'end'\nspec/broken_spec.lua\n", line: "Error -> spec/broken_spec.lua:3: <name> or '...' expected near 'end'" },
  { runner: "ctest", output: "Test project /w/build\n    Start 1: sum_test\nCould not find executable /w/build/sum_test\nLooked in the following places:\n/w/build/sum_test\nUnable to find executable: /w/build/sum_test\n1/1 Test #1: sum_test .........................***Not Run   0.00 sec\n\n0% tests passed, 1 tests failed out of 1\n\nTotal Test time (real) =   0.00 sec\n\nThe following tests FAILED:\n\t  1 - sum_test (Not Run)\nErrors while running CTest\n", line: "Unable to find executable: /w/build/sum_test" },
  { runner: "gtest", output: "/w/tests/sum_test.cpp:5:15: error: 'sum' was not declared in this scope\n    5 |   EXPECT_EQ(sum(1, 2), 3);\n      |               ^~~\ngmake[2]: *** [CMakeFiles/sum_test.dir/build.make:76: CMakeFiles/sum_test.dir/tests/sum_test.cpp.o] Error 1\n", line: "/w/tests/sum_test.cpp:5:15: error: 'sum' was not declared in this scope" },
  { runner: "rspec", output: "\nAn error occurred while loading ./spec/broken_spec.rb. - Did you mean?\n                    rspec ./spec/calc_spec.rb\n\nFailure/Error: require_relative \"../lib/missing\"\n\nLoadError:\n  cannot load such file -- /repo/lib/missing\n# ./spec/broken_spec.rb:1:in `require_relative'\n\nFinished in 0.00007 seconds (files took 0.09928 seconds to load)\n0 examples, 0 failures, 1 error occurred outside of examples\n", line: "An error occurred while loading ./spec/broken_spec.rb. - Did you mean?" },
  { runner: "minitest", output: "<internal:/opt/ruby/lib/ruby/3.3.0/rubygems/core_ext/kernel_require.rb>:136:in `require': cannot load such file -- missing_lib (LoadError)\n\tfrom /repo/test/broken_test.rb:2:in `<top (required)>'\nrake aborted!\nCommand failed with status (1)", line: "<internal:/opt/ruby/lib/ruby/3.3.0/rubygems/core_ext/kernel_require.rb>:136:in `require': cannot load such file -- missing_lib (LoadError)" },
  { runner: "dart", output: "00:00 +0 -1: loading test/broken_test.dart [E]\n  Failed to load \"test/broken_test.dart\":\n  test/broken_test.dart:3:26: Error: Undefined name 'sum'.\n00:00 +1 -1: Some tests failed.\n", line: "  Failed to load \"test/broken_test.dart\":" },
  { runner: "sbt", output: "[error] -- [E006] Not Found Error: /w/src/test/scala/CalcSuite.scala:2:31 ---------------\n[error] 2 |  test(\"adds\") { assertEquals(sum(1, 2), 3) }\n[error] one error found\n[error] (Test / compileIncremental) Compilation failed\n", line: "[error] -- [E006] Not Found Error: /w/src/test/scala/CalcSuite.scala:2:31 ---------------" },
  { runner: "swift", output: "Building for debugging...\n/w/Tests/AppTests/CalcTests.swift:5:24: error: cannot find 'sum' in scope\nerror: fatalError\n", line: "/w/Tests/AppTests/CalcTests.swift:5:24: error: cannot find 'sum' in scope" },
  { runner: "junit", output: "> Task :compileTestJava FAILED\n/repo/src/test/java/app/StdinPatchTest.java:31: error: method run in class Applier cannot be applied to given types;\nBUILD FAILED in 2s", line: "> Task :compileTestJava FAILED" },
  // testthat 3.2 (#1500): the package does not load.
  { runner: "testthat", output: "Error in `load_all()`:\n! Failed to load 'R/fold.R'\nCaused by error in `parse()`:\n! /repo/R/fold.R:3:0: unexpected end of input\nExecution halted", line: "Error in `load_all()`:" },
  // mix test, Elixir 1.14.0 (#2490): a test file that calls a function nothing defines does not
  // compile, and no test runs.
  { runner: "exunit", output: "\n== Compilation error in file test/a_test.exs ==\n** (CompileError) test/a_test.exs:5: undefined function sub/2 (expected ATest to define such a function or for it to be imported, but none are available)\n\n", line: "== Compilation error in file test/a_test.exs ==" },
  // Pester 5.9 (#1498): a test file that does not parse fails its discovery.
  { runner: "pester", output: "Starting discovery in 1 files.\n[-] Discovery in /repo/tests/Fold.Tests.ps1 failed with:\nSystem.Management.Automation.ParseException: At /repo/tests/Fold.Tests.ps1:1 char:14\nMissing closing '}' in statement block or type definition.\nDiscovery found 0 tests in 222ms.\nTests completed in 300ms\nTests Passed: 0, Failed: 0, Skipped: 0, Inconclusive: 0, NotRun: 0\nContainer failed: 1\n  - /repo/tests/Fold.Tests.ps1", line: "[-] Discovery in /repo/tests/Fold.Tests.ps1 failed with:" },
] as const;

describe("baseline replay (#1945)", () => {
  for (const row of FAILURES)
    test(`${row.runner}: the failed test is read from the output`, () => {
      expect(failedTests(row.output)?.names).toContain(row.name);
    });

  test("every runner has its build-failure lines", () => {
    expect([...new Set(BUILD_ERRORS.map((row) => row.runner))].sort()).toEqual(Object.keys(BUILD_FAILURES).sort());
  });

  for (const row of BUILD_ERRORS)
    test(`${row.runner}: a test that does not build is a build failure, not a failed test`, () => {
      expect(buildFailure(row.output)).toContain(row.line);
      expect(failedTests(row.output)?.names ?? []).toEqual([]);
    });

  test("a failing assertion is not a build failure in any runner", () => {
    for (const row of FAILURES) expect({ runner: row.runner, build: buildFailure(row.output) }).toEqual({ runner: row.runner, build: null });
    expect(buildFailure("tests/a.test.ts:\nerror: expect(received).toBe(expected)\n(fail) a [0.1ms]\n 0 pass\n 1 fail")).toBeNull();
  });

  test("a passing run reads no failed test, and output no runner prints reads nothing", () => {
    expect(failedTests("(pass) a [0.1ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5ms]")?.names ?? []).toEqual([]);
    expect(failedTests("Segmentation fault")).toBeNull();
  });

  test("non-test files go back, created ones are removed, and tests stay as delivered", () => {
    const edits = replayEdits([
      { path: "src/sign.ts", before: "old\n", after: "new\n" },
      { path: "src/added.ts", before: null, after: "x\n" },
      { path: "src/lost.ts", before: undefined, after: "y\n" },
      { path: "tests/sign.test.ts", before: null, after: "t\n" },
    ] as never);
    expect(edits).toEqual({ revert: [{ path: "src/sign.ts", content: "old\n" }], remove: ["src/added.ts"], unknown: ["src/lost.ts"] });
  });

  test("the review is told how to read the record", () => {
    expect(BASELINE_REPLAY_NOTE.review).toContain(QUALITY_BASELINE_REPLAY);
    expect(BASELINE_REPLAY_NOTE.spec).toContain("automated");
  });

  const OLD = "export const sign = (n: number) => (n < 0 ? -1 : 0);\n";
  const NEW = "export const sign = (n: number) => (n < 0 ? -1 : 1);\n";

  class SignExecutor extends FixtureExecutor {
    reviews: string[] = [];
    constructor(
      private readonly dir: string,
      private readonly test = 'test("zero is positive", () => {\n  expect(sign(0)).toBe(1);\n});',
      private readonly code = NEW,
      private readonly greenfield = false,
      private readonly extra: Record<string, string> = {},
    ) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "review") this.reviews.push(request.prompt);
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "src/sign.ts", action: this.greenfield ? "create" : "modify" }, { path: "tests/sign.test.ts", action: "create" }, ...Object.keys(this.extra).map((path) => ({ path, action: existsSync(join(this.dir, path)) ? "modify" : "create" })));
        return result;
      }
      if (request.profile.output === "implementation") {
        writeFileSync(join(this.dir, "src/sign.ts"), this.code);
        for (const [path, content] of Object.entries(this.extra)) writeFileSync(join(this.dir, path), content);
        writeFileSync(
          join(this.dir, "tests/sign.test.ts"),
          ['import { expect, test } from "bun:test";', `import { ${this.code.includes("fold") ? "fold, " : ""}sign } from "../src/sign";`, this.test, ""].join("\n"),
        );
      }
      return super.execute(request);
    }
  }

  async function replay(on: boolean, shape: { greenfield?: boolean; test?: string; code?: string; extra?: Record<string, string>; checks?: Check[]; files?: Record<string, string> } = {}) {
    const first = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, ...(on ? { baselineReplay: "on" as const } : {}), checks: [...fixturePolicy.checks, { ...first, id: "unit", args: ["test", "tests/"] }, ...(shape.checks ?? [])] },
      executor: (root) => new SignExecutor(root, shape.test, shape.code, shape.greenfield, shape.extra),
    });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    };
    try {
      const { service, root } = fixture;
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Test User");
      git("config", "user.email", "test@example.test");
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), ".baked/\n");
      for (const [path, content] of Object.entries(shape.files ?? {})) {
        writeFileSync(join(root, path), content);
        if (content.startsWith("#!")) chmodSync(join(root, path), 0o755);
      }
      if (!shape.greenfield) writeFileSync(join(root, "src/sign.ts"), OLD);
      if (!shape.greenfield)
        writeFileSync(
          join(root, "tests/old.test.ts"),
          ['import { expect, test } from "bun:test";', 'import { sign } from "../src/sign";', 'test("negatives are negative", () => {', "  expect(sign(-5)).toBe(-1);", "});", ""].join("\n"),
        );
      git("add", ".");
      git("commit", "-q", "-m", "Initial");
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      // The run's own tree is untouched and the copy is gone.
      expect(readFileSync(join(root, "src/sign.ts"), "utf8")).toBe(shape.code ?? NEW);
      expect(existsSync(join(root, runWorktreeDir(root, run.runId), "quality-baseline-replay"))).toBe(false);
      const artifact = service.store.latestArtifact(run.runId, QUALITY_BASELINE_REPLAY);
      return {
        record: artifact ? (JSON.parse(service.store.readArtifact(run.runId, artifact.id)) as BaselineReplay) : null,
        reviews: (fixture.executor as SignExecutor).reviews,
      };
    } finally {
      await fixture.dispose();
    }
  }

  test("the new test fails on the code before the change and the old one still passes", async () => {
    const { record, reviews } = await replay(true);
    expect(record?.reverted).toEqual(["src/sign.ts"]);
    expect(record?.removed).toContain("value.txt");
    const unit = record?.checks.find((c) => c.id === "unit");
    expect(unit).toMatchObject({ status: "failed", runner: "bun" });
    expect(unit?.failedTests).toEqual(["zero is positive"]);
    expect(reviews.some((p) => p.includes("quality/baseline-replay.json is the baseline replay"))).toBe(true);
  }, 60_000);

  // R62 stepvet (#1960): 12 features of a new project, 19 replays, every one "verify failed" with
  // nothing put back and the feature's own sources removed.
  test("a feature that created all its code records why there is nothing to replay", async () => {
    const { record, reviews } = await replay(true, { greenfield: true });
    expect(record?.reverted).toEqual([]);
    expect(record?.removed).toContain("src/sign.ts");
    expect(record?.checks).toEqual([]);
    expect(record?.note).toBe(GREENFIELD_NOTE);
    expect(reviews.some((p) => p.includes("A note instead of checks means there was nothing to replay"))).toBe(true);
  }, 60_000);

  // R62 linehunk (#1960): the new test calls an API the old code lacks, so it does not build there.
  test("a new test that does not build on the old code is a build failure with its errors", async () => {
    const code = `${NEW}export const fold = (n: number) => sign(n) * 2;\n`;
    const { record } = await replay(true, { code, test: 'test("folds", () => {\n  expect(fold(-3)).toBe(-2);\n  expect(sign(0)).toBe(1);\n});' });
    const unit = record?.checks.find((c) => c.id === "unit");
    expect(unit).toMatchObject({ status: "failed", buildFailed: true, failedTests: [] });
    expect(unit?.buildErrors?.join("\n")).toContain("fold");
  }, 60_000);

  // R65 uritpl (#2020): pytest aborts the session at the first test file that does not collect, so
  // the replay named that file and no test of the others. A stand-in pytest prints what pytest
  // prints: on the old code test_fold.py does not import, and test_sign.py fails one assertion.
  const PYTEST = [
    'if grep -q ": 1)" src/sign.ts; then echo "==== 2 passed in 0.01s ===="; exit 0; fi',
    'echo "___________ ERROR collecting tests/test_fold.py ___________"',
    "echo \"E   ImportError: cannot import name 'fold' from 'sign'\"",
    'case " $* " in *" --continue-on-collection-errors "*)',
    '  echo "FAILED tests/test_sign.py::test_zero_is_positive - assert 0 == 1"',
    '  echo "==== 1 failed, 1 passed, 1 error in 0.05s ===="; exit 1;;',
    "esac",
    'echo "!!!!!!!! Interrupted: 1 error during collection !!!!!!!!"',
    'echo "==== 1 error in 0.05s ===="; exit 2',
    "",
  ].join("\n");

  test("a test file that does not collect no longer hides the names of the other files", async () => {
    const first = fixturePolicy.checks[0] as Check;
    const { record } = await replay(true, {
      files: { "pytest.sh": PYTEST },
      extra: { "tests/test_fold.py": "from sign import fold\n", "tests/test_sign.py": "def test_zero_is_positive(): pass\n" },
      checks: [{ ...first, id: "pytest", executable: "sh", args: ["pytest.sh", "-q"] }],
    });
    const check = record?.checks.find((c) => c.id === "pytest");
    expect(check).toMatchObject({ status: "failed", buildFailed: true, runner: "pytest" });
    expect(check?.targets?.slice().sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "tests/test_fold.py", status: "failed", failedTests: null, buildFailed: true, buildErrors: ["___________ ERROR collecting tests/test_fold.py ___________"] },
      { path: "tests/test_sign.py", status: "failed", failedTests: ["tests/test_sign.py::test_zero_is_positive"] },
    ]);
    // A runner that runs each file on its own is not run again.
    expect(record?.checks.find((c) => c.id === "unit")?.targets).toBeUndefined();
  }, 60_000);

  // R75 evalpin-update (#2364): cargo stopped after tests/cli.rs failed, so the 5 new tests of
  // tests/diff_show.rs never ran on the old code. Maven's reactor and Gradle stop the same way at
  // the first module or project. Each stand-in prints what its tool prints: it runs the second
  // target only with the tool's keep-going flag.
  const standIn = (flag: string, first: string[], stop: string[], second: string[]) =>
    [
      "#!/bin/sh",
      'if grep -q ": 1)" src/sign.ts; then echo "BUILD SUCCESS"; exit 0; fi',
      ...first.map((line) => `echo '${line}'`),
      `case " $* " in *" ${flag} "*) ;; *) ${stop.map((line) => `echo '${line}'; `).join("")}exit 1;; esac`,
      ...second.map((line) => `echo '${line}'`),
      "exit 1",
      "",
    ].join("\n");
  const testcase = (classname: string, name: string) => `<testcase name="${name}" classname="${classname}"><failure message="expected"/></testcase>`;
  const STOPS = [
    {
      toolchain: "rust (cargo)",
      tool: "cargo",
      line: "./cargo test",
      replay: "./cargo test --no-fail-fast",
      script: standIn(
        "--no-fail-fast",
        ["     Running tests/cli.rs (target/debug/deps/cli-1a2b)", "test help_and_command_diagnostics_use_one_exact_io_call ... FAILED", "test result: FAILED. 6 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out"],
        ["error: test failed, to rerun pass `--test cli`"],
        ["     Running tests/diff_show.rs (target/debug/deps/diff_show-3c4d)", "test shows_added_lines ... FAILED", "test shows_removed_lines ... FAILED", "test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out", "error: 2 targets failed:"],
      ),
      failed: ["help_and_command_diagnostics_use_one_exact_io_call", "shows_added_lines", "shows_removed_lines"],
    },
    {
      toolchain: "java and kotlin (Maven multi-module)",
      tool: "mvnw",
      line: "./mvnw -B verify",
      replay: "./mvnw -B verify --fail-at-end",
      script: standIn(
        "--fail-at-end",
        ["[ERROR] app.cli.CliTest.help -- Time elapsed: 0.01 s <<< FAILURE!", "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0"],
        ["[ERROR] After correcting the problems, you can resume the build with the command", "[ERROR]   mvn <args> -rf :cli"],
        ["[ERROR] app.diff.DiffShowTest.addedLines -- Time elapsed: 0.01 s <<< FAILURE!", "[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0"],
      ),
      failed: ["app.cli.CliTest.help", "app.diff.DiffShowTest.addedLines"],
    },
    {
      toolchain: "java and kotlin (Gradle)",
      tool: "gradlew",
      line: "./gradlew test",
      replay: "./gradlew test --continue",
      script: standIn("--continue", ["> Task :cli:test FAILED", testcase("app.cli.CliTest", "help")], ["BUILD FAILED in 2s"], ["> Task :diff:test FAILED", testcase("app.diff.DiffShowTest", "addedLines"), "BUILD FAILED in 3s"]),
      failed: ["app.cli.CliTest.help", "app.diff.DiffShowTest.addedLines"],
    },
  ];

  for (const row of STOPS)
    test(`${row.toolchain}: a failing target no longer hides the failing tests of the targets after it`, async () => {
      const first = fixturePolicy.checks[0] as Check;
      const { record } = await replay(true, { files: { [row.tool]: row.script }, checks: [{ ...first, id: "stops", executable: "sh", args: ["-c", row.line] }] });
      const check = record?.checks.find((c) => c.id === "stops");
      expect(check).toMatchObject({ status: "failed", args: ["-c", row.replay] });
      expect(check?.failedTests?.slice().sort()).toEqual(row.failed);
      expect(check?.targets).toBeUndefined();
      // A check the replay runs as written records no arguments of its own.
      expect(record?.checks.find((c) => c.id === "unit")?.args).toBeUndefined();
    }, 60_000);

  // R61 taskplan AC-005 (#1954): "baseline and updated dependency resolution identical" had no
  // evidence. The replay lists the resolution in its copy as delivered and after putting files back.
  test("a lock the run changed lists the moved dependency; an unchanged folder is identical", async () => {
    const lock = (version: string) => `version = 4\n\n[[package]]\nname = "serde"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;
    const { record, reviews } = await replay(true, { files: { "Cargo.lock": lock("1.0.200") }, extra: { "Cargo.lock": lock("1.0.201") } });
    expect(record?.reverted).toContain("Cargo.lock");
    expect(record?.dependencies).toEqual([{ source: "cargo", folder: ".", identical: false, added: [], removed: [], changed: ["serde 1.0.200 -> 1.0.201"] }]);
    expect(reviews.some((p) => p.includes("dependencies compares the resolved dependencies"))).toBe(true);
    const same = await replay(true, { files: { "Cargo.lock": lock("1.0.200") } });
    expect(same.record?.dependencies).toEqual([{ source: "cargo", folder: ".", identical: true, added: [], removed: [], changed: [], note: UNCHANGED_RESOLUTION_NOTE }]);
  }, 60_000);

  test("off by default: no replay and no note", async () => {
    const { record, reviews } = await replay(false);
    expect(record).toBeNull();
    expect(reviews.some((p) => p.includes("baseline replay"))).toBe(false);
  }, 60_000);
});

describe("baseline replay per test target (#2020)", () => {
  const dirs: Record<string, string[]> = {
    tests: ["version_tests.rs", "package_tests.rs", "common"],
    src: ["lib.rs", "main.rs"],
    "tests/App.Tests": ["App.Tests.csproj", "ParserTests.cs"],
    "tests/Cli.Tests": ["Cli.Tests.csproj"],
    "tests/Cli.Tests/Sub": ["RunTests.cs"],
  };
  const input = (args: string[], tests: string[] = []) => ({ args, tests, list: (dir: string) => dirs[dir] ?? [] });

  test("every runner has its row: runs, or why it needs none", () => {
    expect(Object.keys(REPLAY_TARGETS).sort()).toEqual(Object.keys(BUILD_FAILURES).sort());
    for (const [runner, row] of Object.entries(REPLAY_TARGETS))
      expect({ runner, row: typeof row === "function" || row.none.length > 0 }).toEqual({ runner, row: true });
  });

  // R65 eolscope-update: version_tests did not compile, so package_tests never ran.
  test("rust: each integration test file and the library tests run on their own", () => {
    expect(replayTargets("cargo", input(["test", "--all-features", "--", "--nocapture"]))).toEqual([
      { args: ["test", "--all-features", "--lib", "--", "--nocapture"], paths: ["src/lib.rs"] },
      { args: ["test", "--all-features", "--test", "package_tests", "--", "--nocapture"], paths: ["tests/package_tests.rs"] },
      { args: ["test", "--all-features", "--test", "version_tests", "--", "--nocapture"], paths: ["tests/version_tests.rs"] },
    ]);
    expect(replayTargets("cargo", input(["test", "--test", "one"]))).toEqual([]);
  });

  test("python: pytest collects past the files that do not collect", () => {
    expect(replayTargets("pytest", input(["-m", "pytest", "-q"], ["tests/test_a.py", "tests/conftest.txt"]))).toEqual([
      { args: ["-m", "pytest", "-q", "--continue-on-collection-errors"], paths: ["tests/test_a.py"] },
    ]);
  });

  test("csharp: each test project the run's tests are in, in place of the solution", () => {
    const tests = ["tests/App.Tests/ParserTests.cs", "tests/Cli.Tests/Sub/RunTests.cs"];
    expect(replayTargets("dotnet", input(["test", "App.sln", "--nologo"], tests))).toEqual([
      { args: ["test", "tests/App.Tests/App.Tests.csproj", "--nologo"], paths: ["tests/App.Tests/App.Tests.csproj"] },
      { args: ["test", "tests/Cli.Tests/Cli.Tests.csproj", "--nologo"], paths: ["tests/Cli.Tests/Cli.Tests.csproj"] },
    ]);
    expect(replayTargets("dotnet", input(["test"], tests.slice(0, 1)))[0]?.args).toEqual(["test", "tests/App.Tests/App.Tests.csproj"]);
  });

  test("java and kotlin: Maven fails at the end and Gradle continues", () => {
    expect(replayTargets("maven", input(["-q", "verify"]))).toEqual([{ args: ["-q", "verify", "--fail-at-end"], paths: null }]);
    expect(replayTargets("maven", input(["-fae", "verify"]))).toEqual([]);
    expect(replayTargets("junit", input(["test"]))).toEqual([{ args: ["test", "--continue"], paths: null }]);
  });

  // RSpec runs no example once a spec file does not load, and `rake test` loads every file first (#1493).
  test("ruby: each spec file, and each Minitest file through rake's TEST", () => {
    expect(replayTargets("rspec", input(["exec", "rspec"], ["spec/a_spec.rb", "spec/spec_helper.rb", "spec/b_spec.rb"]))).toEqual([
      { args: ["exec", "rspec", "spec/a_spec.rb"], paths: ["spec/a_spec.rb"] },
      { args: ["exec", "rspec", "spec/b_spec.rb"], paths: ["spec/b_spec.rb"] },
    ]);
    expect(replayTargets("rspec", input(["exec", "rspec", "spec/a_spec.rb"], ["spec/a_spec.rb"]))).toEqual([]);
    expect(replayTargets("minitest", input(["exec", "rake", "test"], ["test/a_test.rb", "test/test_helper.rb", "test/test_b.rb"]))).toEqual([
      { args: ["exec", "rake", "test", "TEST=test/a_test.rb"], paths: ["test/a_test.rb"] },
      { args: ["exec", "rake", "test", "TEST=test/test_b.rb"], paths: ["test/test_b.rb"] },
    ]);
    expect(replayTargets("minitest", input(["-Itest", "test/a_test.rb"], ["test/a_test.rb"]))).toEqual([]);
  });

  // mix test compiles every test file before it runs any (#2490).
  test("elixir: each ExUnit test file on its own", () => {
    expect(replayTargets("exunit", input(["test", "--exclude", "slow"], ["test/a_test.exs", "test/test_helper.exs", "test/support/case.ex", "test/b_test.exs"]))).toEqual([
      { args: ["test", "--exclude", "slow", "test/a_test.exs"], paths: ["test/a_test.exs"] },
      { args: ["test", "--exclude", "slow", "test/b_test.exs"], paths: ["test/b_test.exs"] },
    ]);
    expect(replayTargets("exunit", input(["test", "test/a_test.exs:12"], ["test/a_test.exs"]))).toEqual([]);
  });

  test("go, bun, jest, vitest and tap already run each target on their own", () => {
    for (const runner of ["go", "bun", "jest", "vitest", "tap"] as const) expect(replayTargets(runner, input(["test", "./..."], ["a_test.go"]))).toEqual([]);
    expect(replayTargets(null, input(["test"]))).toEqual([]);
  });

  test("the targets a run speaks for: its own outcome, or per file by the lines that name it", () => {
    const cargo = BUILD_ERRORS.find((row) => row.runner === "cargo")?.output ?? "";
    expect(replayTargetRecords({ paths: ["tests/fold.rs"], runner: "cargo" }, { status: "failed", output: cargo }, (p) => `crate/${p}`)).toEqual([
      { path: "crate/tests/fold.rs", status: "failed", failedTests: null, buildFailed: true, buildErrors: ["error[E0425]: cannot find function `fold` in this scope", 'error: could not compile `cidrfold` (test "fold") due to 1 previous error'] },
    ]);
    const passed = "running 2 tests\ntest a ... ok\ntest b ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out";
    expect(replayTargetRecords({ paths: ["tests/a.rs"], runner: "cargo" }, { status: "passed", output: passed }, (p) => p)).toEqual([
      { path: "tests/a.rs", status: "passed", failedTests: [] },
    ]);
    const maven = "[ERROR] app.ParserTest.blankLines -- Time elapsed: 0.01 s <<< FAILURE!\n[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0";
    expect(replayTargetRecords({ paths: null, runner: "maven" }, { status: "failed", output: maven }, (p) => p)).toEqual([
      { path: ".", status: "failed", failedTests: ["app.ParserTest.blankLines"] },
    ]);
  });

  test("the build runner is read from the build-failure lines", () => {
    // Pest prints PHP's own parse and fatal errors, as PHPUnit does, and a GoogleTest binary the
    // compiler errors CTest's build prints; each pair shares one replay row.
    const shared: Record<string, string> = { pest: "phpunit", gtest: "ctest" };
    for (const row of BUILD_ERRORS) expect({ row: row.runner, runner: buildRunner(row.output) }).toEqual({ row: row.runner, runner: shared[row.runner] ?? row.runner });
    expect(buildRunner("(fail) a [0.1ms]")).toBeNull();
  });

  test("the spec author and the reviewers are told the replay holds per target", () => {
    expect(BASELINE_REPLAY_NOTE.spec).toContain("per target");
    expect(BASELINE_REPLAY_NOTE.review).toContain("targets");
  });
});

/**
 * The replay's first run of a check per runner (#2364): the check's command, and the arguments the
 * replay runs instead, with the runner's keep-going flag and without its stop flags.
 */
const KEEP_GOING: { runner: TestRunner; executable: string; args: string[]; replay: string[] }[] = [
  { runner: "cargo", executable: "cargo", args: ["test", "--all-features", "--", "--nocapture"], replay: ["test", "--all-features", "--no-fail-fast", "--", "--nocapture"] },
  { runner: "cargo", executable: "cargo", args: ["nextest", "run", "--max-fail", "1"], replay: ["nextest", "run", "--no-fail-fast"] },
  { runner: "cargo", executable: "cargo", args: ["test", "--no-fail-fast"], replay: ["test", "--no-fail-fast"] },
  { runner: "maven", executable: "mvn", args: ["-B", "-ff", "verify"], replay: ["-B", "verify", "--fail-at-end"] },
  { runner: "maven", executable: "./mvnw", args: ["-fae", "test", "-Dsurefire.skipAfterFailureCount=1"], replay: ["-fae", "test"] },
  { runner: "junit", executable: "./gradlew", args: ["test", "--fail-fast"], replay: ["test", "--continue"] },
  { runner: "pytest", executable: "python", args: ["-m", "pytest", "-x", "-q"], replay: ["-m", "pytest", "-q", "--maxfail=0"] },
  { runner: "pytest", executable: "uv", args: ["run", "pytest", "--maxfail", "2"], replay: ["run", "pytest", "--maxfail=0"] },
  { runner: "jest", executable: "npx", args: ["jest", "--bail", "--ci"], replay: ["jest", "--ci"] },
  { runner: "vitest", executable: "pnpm", args: ["exec", "vitest", "run", "--bail=1"], replay: ["exec", "vitest", "run"] },
  { runner: "bun", executable: "bun", args: ["test", "--bail"], replay: ["test"] },
  { runner: "tap", executable: "mocha", args: ["-b", "--reporter", "tap"], replay: ["--reporter", "tap"] },
  { runner: "go", executable: "go", args: ["test", "-failfast", "./..."], replay: ["test", "./..."] },
  { runner: "phpunit", executable: "php", args: ["vendor/bin/phpunit", "--stop-on-failure", "tests"], replay: ["vendor/bin/phpunit", "tests"] },
  { runner: "pest", executable: "vendor/bin/pest", args: ["--bail"], replay: [] },
  { runner: "rspec", executable: "bundle", args: ["exec", "rspec", "--fail-fast=1"], replay: ["exec", "rspec"] },
  { runner: "minitest", executable: "bin/rails", args: ["test", "--fail-fast"], replay: ["test"] },
  { runner: "ctest", executable: "ctest", args: ["--test-dir", "build", "--stop-on-failure"], replay: ["--test-dir", "build"] },
  { runner: "cargo", executable: "sh", args: ["-c", "cargo test -q"], replay: ["-c", "cargo test -q --no-fail-fast"] },
  { runner: "exunit", executable: "mix", args: ["test", "--max-failures", "1", "--warnings-as-errors"], replay: ["test", "--warnings-as-errors"] },
];

describe("baseline replay keeps going past the first failing target (#2364)", () => {
  test("every runner has its row: flags and stop flags, or why it needs none", () => {
    expect(Object.keys(REPLAY_KEEP_GOING).sort()).toEqual(Object.keys(FAILED_TESTS).sort());
    for (const [runner, row] of Object.entries(REPLAY_KEEP_GOING))
      expect({ runner, row: "none" in row ? row.none.length > 0 : row.programs.length > 0 && Boolean(row.flags?.length || row.stop?.length) }).toEqual({ runner, row: true });
    const covered = new Set(KEEP_GOING.map((row) => row.runner));
    expect(Object.entries(REPLAY_KEEP_GOING).filter(([runner, row]) => !("none" in row) && !covered.has(runner as TestRunner))).toEqual([]);
  });

  for (const row of KEEP_GOING)
    test(`${row.runner}: ${row.executable} ${row.args.join(" ")}`, () => {
      expect(replayCommand(row.executable, row.args)).toEqual({ args: row.replay, runner: row.runner });
    });

  test("a command that names no runner runs as written", () => {
    expect(replayCommand("make", ["test"])).toEqual({ args: ["test"], runner: null });
    expect(replayCommand("dotnet", ["test", "App.sln"])).toEqual({ args: ["test", "App.sln"], runner: null });
    expect(replayCommand("cargo", ["clippy", "--fail-fast"])).toEqual({ args: ["clippy", "--fail-fast"], runner: null });
    // A test binary's own `--` arguments are its own.
    expect(replayCommand("npx", ["jest", "--", "--bail"]).args).toEqual(["jest", "--", "--bail"]);
  });

  test("a run that still stopped at its first failing target is read from its last lines", () => {
    expect(replayStopped("test result: FAILED. 6 passed; 1 failed\nerror: test failed, to rerun pass `--test cli`")).toBe("cargo");
    expect(replayStopped("        FAIL [   0.004s] app::cli help\n  Cancelling due to test failure: 3 tests still running")).toBe("cargo");
    expect(replayStopped("[ERROR] After correcting the problems, you can resume the build with the command\n[ERROR]   mvn <args> -rf :core")).toBe("maven");
    expect(replayStopped("error: 2 targets failed:\n    `--test cli`\n    `--test diff_show`")).toBeNull();
  });
});

describe("baseline replay: dependency resolution (#1954)", () => {
  /** One row per source: the folder's files before the change and as delivered, and what moved. */
  const ROWS: { source: string; files: Record<string, string>; output?: (version: string) => string; before: string; after: string; changed: string }[] = [
    { source: "npm", files: { "package-lock.json": "" }, before: JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1.0.0" } } }), after: JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1.1.0" } } }), changed: "a 1.0.0 -> 1.1.0" },
    { source: "bun", files: { "bun.lock": "" }, before: '{\n  "lockfileVersion": 1,\n  "packages": {\n    "a": ["a@1.0.0", "", {}, "sha"],\n  },\n}\n', after: '{\n  "lockfileVersion": 1,\n  "packages": {\n    "a": ["a@1.1.0", "", {}, "sha"],\n  },\n}\n', changed: "a 1.0.0 -> 1.1.0" },
    { source: "cargo", files: { "Cargo.lock": "" }, before: 'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\nsource = "registry"\n', after: 'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.201"\nsource = "registry"\n', changed: "serde 1.0.200 -> 1.0.201" },
    { source: "uv", files: { "uv.lock": "" }, before: '[[package]]\nname = "requests"\nversion = "2.32.0"\n\n[package.metadata]\nx = 1\n', after: '[[package]]\nname = "requests"\nversion = "2.33.0"\n', changed: "requests 2.32.0 -> 2.33.0" },
    { source: "poetry", files: { "poetry.lock": "" }, before: '[[package]]\nname = "click"\nversion = "8.1.0"\n', after: '[[package]]\nname = "click"\nversion = "8.2.0"\n', changed: "click 8.1.0 -> 8.2.0" },
    { source: "nuget", files: { "packages.lock.json": "" }, before: JSON.stringify({ dependencies: { "net10.0": { "Newtonsoft.Json": { resolved: "13.0.1" } } } }), after: JSON.stringify({ dependencies: { "net10.0": { "Newtonsoft.Json": { resolved: "13.0.3" } } } }), changed: "Newtonsoft.Json 13.0.1 -> 13.0.3" },
    { source: "dotnet", files: { "App.csproj": "" }, output: (v) => `Project 'App' has the following package references\n   [net10.0]:\n   Top-level Package      Requested   Resolved\n   > xunit                2.9.0       ${v}\n`, before: "2.9.0", after: "2.9.2", changed: "xunit 2.9.0 -> 2.9.2" },
    { source: "go", files: { "go.mod": "" }, output: (v) => `example.com/app\ngolang.org/x/text ${v}\n`, before: "v0.14.0", after: "v0.15.0", changed: "golang.org/x/text v0.14.0 -> v0.15.0" },
    { source: "maven", files: { "pom.xml": "" }, output: (v) => `[INFO] The following files have been resolved:\n[INFO]    org.slf4j:slf4j-api:jar:${v}:compile -- module org.slf4j\n[INFO]    org.junit.jupiter:junit-jupiter:jar:5.10.0:test\n[INFO] BUILD SUCCESS\n`, before: "2.0.9", after: "2.0.13", changed: "org.slf4j:slf4j-api 2.0.9 -> 2.0.13" },
    { source: "gradle", files: { "build.gradle.kts": "" }, output: (v) => `testRuntimeClasspath\n+--- com.google.guava:guava:32.0.0-jre -> ${v}\n\\--- junit:junit:4.13.2\n`, before: "33.0.0-jre", after: "33.2.0-jre", changed: "com.google.guava:guava 33.0.0-jre -> 33.2.0-jre" },
  ];

  test("every source has a row", () => {
    expect(ROWS.map((row) => row.source).sort()).toEqual(RESOLUTION_SOURCES.map((source) => source.id).sort());
  });

  for (const row of ROWS)
    test(`${row.source}: an unchanged tree is identical and a moved dependency is named`, async () => {
      const io = (text: string): ResolutionIo => ({
        names: () => Object.keys(row.files),
        read: () => (row.output ? null : text),
        run: async () => ({ status: "passed", output: row.output?.(text) ?? "" }),
      });
      const [lockfile] = Object.keys(row.files);
      const same = await replayResolution([lockfile as string], ["."], io(row.before), () => {});
      expect(same).toEqual([{ source: row.source, folder: ".", identical: true, added: [], removed: [], changed: [] }]);
      const sides = [row.after, row.before];
      let side = 0;
      const moving: ResolutionIo = { ...io(""), read: () => (row.output ? null : (sides[side] ?? null)), run: async () => ({ status: "passed", output: row.output?.(sides[side] ?? "") ?? "" }) };
      const moved = await replayResolution([lockfile as string], ["."], moving, () => { side = 1; });
      expect(moved).toEqual([{ source: row.source, folder: ".", identical: false, added: [], removed: [], changed: [row.changed] }]);
    });

  test("a folder whose dependency files did not change runs nothing; a listing that fails says why", async () => {
    let runs = 0;
    const io: ResolutionIo = { names: (folder) => (folder === "svc" ? ["go.mod"] : ["pom.xml", "mvnw"]), read: () => null, run: async (_folder, executable) => { runs++; return { status: "failed", output: `${executable}: offline` }; } };
    const diffs = await replayResolution(["svc/go.mod", "src/App.java"], [".", "svc"], io, () => {});
    expect(runs).toBe(2);
    expect(diffs).toEqual([
      { source: "go", folder: "svc", identical: false, added: [], removed: [], changed: [], note: "before the change: go list -m all did not list the dependencies: go: offline; delivered: go list -m all did not list the dependencies: go: offline" },
      { source: "maven", folder: ".", identical: true, added: [], removed: [], changed: [], note: UNCHANGED_RESOLUTION_NOTE },
    ]);
  });

  test("added and removed dependencies are listed with their versions", () => {
    const diff = resolutionDiff("npm", ".", new Map([["a", "1.0.0"], ["b", "2.0.0"]]), new Map([["a", "1.0.0"], ["c", "3.0.0"]]));
    expect(diff).toEqual({ source: "npm", folder: ".", identical: false, added: ["c 3.0.0"], removed: ["b 2.0.0"], changed: [] });
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_FAILURES, buildFailure, buildRunner, failedTests } from "../src/core/verification/output-counts.js";
import {
  BASELINE_REPLAY_NOTE,
  type BaselineReplay,
  GREENFIELD_NOTE,
  QUALITY_BASELINE_REPLAY,
  REPLAY_TARGETS,
  replayEdits,
  replayTargetRecords,
  replayTargets,
} from "../src/core/workflows/quality/baseline-replay.js";
import { RESOLUTION_SOURCES, type ResolutionIo, replayResolution, resolutionDiff, UNCHANGED_RESOLUTION_NOTE } from "../src/core/workflows/quality/dependency-resolution.js";
import type { Check, ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

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
  // RSpec 3.13 and Minitest 5.20 through `rake test` (#1493).
  { runner: "rspec", output: "Finished in 0.00714 seconds (files took 0.09504 seconds to load)\n5 examples, 1 failure, 2 pending\n\nFailed examples:\n\nrspec ./spec/calc_spec.rb:6 # Calc fails on purpose\n", name: "Calc fails on purpose" },
  { runner: "minitest", output: "  1) Failure:\nCalcTest#test_fail [/repo/test/calc_test.rb:8]:\nExpected: 4\n  Actual: 3\n\n  2) Error:\nCalcTest#test_error:\nRuntimeError: boom\n\n4 runs, 2 assertions, 1 failures, 1 errors, 1 skips", name: "CalcTest#test_error" },
  { runner: "dart", output: "00:00 +0: test/calc_test.dart: adds\n00:00 +1 -1: test/calc_test.dart: fails on purpose [E]\n  Expected: <4>\n    Actual: <3>\n00:00 +2 ~1 -1: Some tests failed.\n", name: "test/calc_test.dart: fails on purpose" },
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
  { runner: "rspec", output: "\nAn error occurred while loading ./spec/broken_spec.rb. - Did you mean?\n                    rspec ./spec/calc_spec.rb\n\nFailure/Error: require_relative \"../lib/missing\"\n\nLoadError:\n  cannot load such file -- /repo/lib/missing\n# ./spec/broken_spec.rb:1:in `require_relative'\n\nFinished in 0.00007 seconds (files took 0.09928 seconds to load)\n0 examples, 0 failures, 1 error occurred outside of examples\n", line: "An error occurred while loading ./spec/broken_spec.rb. - Did you mean?" },
  { runner: "minitest", output: "<internal:/opt/ruby/lib/ruby/3.3.0/rubygems/core_ext/kernel_require.rb>:136:in `require': cannot load such file -- missing_lib (LoadError)\n\tfrom /repo/test/broken_test.rb:2:in `<top (required)>'\nrake aborted!\nCommand failed with status (1)", line: "<internal:/opt/ruby/lib/ruby/3.3.0/rubygems/core_ext/kernel_require.rb>:136:in `require': cannot load such file -- missing_lib (LoadError)" },
  { runner: "dart", output: "00:00 +0 -1: loading test/broken_test.dart [E]\n  Failed to load \"test/broken_test.dart\":\n  test/broken_test.dart:3:26: Error: Undefined name 'sum'.\n00:00 +1 -1: Some tests failed.\n", line: "  Failed to load \"test/broken_test.dart\":" },
  { runner: "junit", output: "> Task :compileTestJava FAILED\n/repo/src/test/java/app/StdinPatchTest.java:31: error: method run in class Applier cannot be applied to given types;\nBUILD FAILED in 2s", line: "> Task :compileTestJava FAILED" },
] as const;

describe("baseline replay (#1945)", () => {
  for (const row of FAILURES)
    test(`${row.runner}: the failed test is read from the output`, () => {
      expect(failedTests(row.output)?.names).toContain(row.name);
    });

  test("every runner has its build-failure lines", () => {
    expect(BUILD_ERRORS.map((row) => row.runner).sort()).toEqual(Object.keys(BUILD_FAILURES).sort());
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
      for (const [path, content] of Object.entries(shape.files ?? {})) writeFileSync(join(root, path), content);
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
      expect(existsSync(join(root, ".baked/worktrees", run.runId, "quality-baseline-replay"))).toBe(false);
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
    for (const row of BUILD_ERRORS) expect({ row: row.runner, runner: buildRunner(row.output) }).toEqual({ row: row.runner, runner: row.runner });
    expect(buildRunner("(fail) a [0.1ms]")).toBeNull();
  });

  test("the spec author and the reviewers are told the replay holds per target", () => {
    expect(BASELINE_REPLAY_NOTE.spec).toContain("per target");
    expect(BASELINE_REPLAY_NOTE.review).toContain("targets");
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

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failureHash,
  firstDifference,
  normalizeCheckOutput,
  repeatCheck,
  repeatedFailureDecision,
  repeatRecord,
  unfinishedRepeatRemedies,
} from "../src/core/workflows/repeated-failure.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { invalidOutputBuildChange, invalidOutputDecision, invalidOutputKey } from "../src/core/workflows/invalid-output-repeat.js";
import { errorRecovery } from "../src/core/workflows/remedies.js";
import { unfinishedRepeatFault } from "../src/core/workflows/scheduler.js";
import { writeRefusalOf } from "../src/core/workflows/write-refusals.js";
import { failureSignature as failingLines, failuresCovered } from "../src/core/verification/convergence.js";
import { shapedFailureSignature, TEST_RUNNERS, withinBaseline } from "../src/core/verification/output-counts.js";
import { baselineSignatureDecision, signatureLines } from "../src/core/workflows/baseline-signature.js";

// #1996: two runs of the same failing check hash equal, whatever toolchain prints them; a moved
// position or another message is progress. A check runner whose failing output carries another
// value that changes between runs adds its pair here with its normalization (in
// `normalizeVolatile`, src/core/verification/volatile.ts); a runner of `TEST_RUNNERS` is named by
// the first word of its pair (#2281). Every pair holds for the three readers of that table: the
// repeated-failure hash, the check baseline's shaped signature and the check finding's failing
// lines (#2295).
const tmp = join(tmpdir(), "baked-check-x1").replaceAll("\\", "/");
const busted = (time: string, address: string) =>
  `●◼\n0 successes / 1 failure / 0 errors / 0 pending : ${time} seconds\n\nFailure → spec/parse_spec.lua @ 3\nparse rejects empty input\nspec/parse_spec.lua:5: Expected objects to be the same.\nPassed in:\n(table: ${address}) {\n  [1] = 'x' }\nExpected:\n(table: ${address}) { }\n`;
const gradle = (time: string) =>
  `> Task :test FAILED\n\nParserTest > rejectsEmpty() FAILED\n    org.opentest4j.AssertionFailedError at ParserTest.kt:12\n\n1 test completed, 1 failed\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':test'.\n> There were failing tests. See the report at: file:///work/build/reports/tests/test/index.html\n\nBUILD FAILED in ${time}\n4 actionable tasks: 2 executed, 2 up-to-date\n`;
const pairs: [string, string, string][] = [
  // #2437: R77 pairwick, sbt 2's `elapsed time` line after a failing scalafmtCheck.
  ["sbt (scalafmtCheck, R77 pairwick)", "[info] loading project definition from /work/project\n[warn] /work/src/main/scala/pairwick/Rules.scala isn't formatted properly!\n[error] (Compile / scalafmtCheck) 1 files aren't formatted properly\n[error] elapsed time: 4 s, cache 0%, 1 disk cache hit, 3 onsite tasks", "[info] loading project definition from /work/project\n[warn] /work/src/main/scala/pairwick/Rules.scala isn't formatted properly!\n[error] (Compile / scalafmtCheck) 1 files aren't formatted properly\n[error] elapsed time: 12 s, cache 50%, 106 disk cache hits, 1 onsite task"],
  ["gofmt", "internal\\lint\\rules_test.go:26:2217: illegal byte order mark\r\n", "internal/lint/rules_test.go:26:2217: illegal byte order mark\n"],
  ["go test", "--- FAIL: TestRules (0.00s)\n    rules_test.go:40: got 1\nFAIL\nFAIL\tcfgquill/internal/lint\t0.012s\n", "--- FAIL: TestRules (0.03s)\n    rules_test.go:40: got 1\nFAIL\nFAIL\tcfgquill/internal/lint\t0.457s\n"],
  ["bun test", "\u001b[31m(fail)\u001b[0m parse > rejects [1.23ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file. [45.00ms]", "(fail) parse > rejects [0.98ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file. [51.12ms]"],
  ["jest", "  ✕ rejects bad input (5 ms)\nTime:        1.234 s", "  ✕ rejects bad input (12 ms)\nTime:        0.871 s"],
  ["vitest", " ❯ test/parse.test.ts (2 tests | 1 failed) 7ms\n   × parse > rejects bad input\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n   Start at  04:42:53\n   Duration  412ms (transform 20ms, setup 0ms, collect 31ms, tests 7ms, environment 0ms, prepare 61ms)", " ❯ test/parse.test.ts (2 tests | 1 failed) 12ms\n   × parse > rejects bad input\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n   Start at  05:01:02\n   Duration  1.02s (transform 34ms, setup 1ms, collect 40ms, tests 12ms, environment 0ms, prepare 88ms)"],
  ["tap (node:test)", "not ok 1 - rejects bad input\n  ---\n  duration_ms: 1.234567\n  failureType: 'testCodeFailure'\n  ...\n# tests 1\n# fail 1\n# duration_ms 45.6789", "not ok 1 - rejects bad input\n  ---\n  duration_ms: 0.98765\n  failureType: 'testCodeFailure'\n  ...\n# tests 1\n# fail 1\n# duration_ms 51.2"],
  ["tap (node-tap)", "not ok 1 - rejects bad input # time=12ms\n# failed 1 test\n# time=245.123ms", "not ok 1 - rejects bad input # time=9ms\n# failed 1 test\n# time=301.5ms"],
  ["tap (prove)", "t/parse.t .. 1/2 \n#   Failed test 'rejects empty'\n#   at t/parse.t line 7.\nt/parse.t .. Dubious, test returned 1 (wstat 256, 0x100)\nFailed 1/2 subtests \nFiles=1, Tests=2,  0 wallclock secs ( 0.01 usr  0.00 sys +  0.03 cusr  0.01 csys =  0.05 CPU)\nResult: FAIL", "t/parse.t .. 1/2 \n#   Failed test 'rejects empty'\n#   at t/parse.t line 7.\nt/parse.t .. Dubious, test returned 1 (wstat 256, 0x100)\nFailed 1/2 subtests \nFiles=1, Tests=2,  1 wallclock secs ( 0.02 usr  0.01 sys +  0.05 cusr  0.00 csys =  0.08 CPU)\nResult: FAIL"],
  ["pytest", "FAILED tests/test_cli.py::test_parse - AssertionError\n1 failed in 0.12s", "FAILED tests/test_cli.py::test_parse - AssertionError\n1 failed in 0.31s"],
  ["pytest (randomly)", "Using --randomly-seed=1234567\nFAILED tests/test_cli.py::test_parse - AssertionError\n1 failed in 2.01s", "Using --randomly-seed=987\nFAILED tests/test_cli.py::test_parse - AssertionError\n1 failed in 1.50s"],
  ["cargo", "test parse ... FAILED\ntest result: FAILED. 0 passed; 1 failed; finished in 0.00s", "test parse ... FAILED\ntest result: FAILED. 0 passed; 1 failed; finished in 0.02s"],
  ["dotnet test", "  Failed App.Tests.ParserTests.RejectsEmpty [12 ms]\n  Error Message:\n   Assert.Equal() Failure\nFailed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1, Duration: 12 ms - App.Tests.dll (net8.0)", "  Failed App.Tests.ParserTests.RejectsEmpty [< 1 ms]\n  Error Message:\n   Assert.Equal() Failure\nFailed!  - Failed:     1, Passed:     0, Skipped:     0, Total:     1, Duration: < 1 ms - App.Tests.dll (net8.0)"],
  ["maven", "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.012 s <<< FAILURE! -- in app.ParserTest\n[INFO] BUILD FAILURE\n[INFO] Total time:  3.456 s\n[INFO] Finished at: 2026-10-27T01:02:03+02:00", "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.2 s <<< FAILURE! -- in app.ParserTest\n[INFO] BUILD FAILURE\n[INFO] Total time:  01:05 min\n[INFO] Finished at: 2026-10-27T02:03:04+02:00"],
  ["junit (Gradle, R73 jvmsig-update)", gradle("6s"), gradle("16s")],
  ["junit (Gradle, minutes)", gradle("8s"), gradle("1m 3s")],
  ["junit (console launcher)", "✘ rejectsEmpty()\n    => org.opentest4j.AssertionFailedError: expected: <1> but was: <2>\nTest run finished after 123 ms\n[         1 tests failed          ]", "✘ rejectsEmpty()\n    => org.opentest4j.AssertionFailedError: expected: <1> but was: <2>\nTest run finished after 87 ms\n[         1 tests failed          ]"],
  ["sbt", "[info] - rejects empty *** FAILED ***\n[info]   1 did not equal 2 (ParserSpec.scala:12)\n[info] Run completed in 387 milliseconds.\n[error] Failed tests:\n[error] \tapp.ParserSpec\n[error] Total time: 3 s, completed Oct 27, 2026, 1:02:03 AM", "[info] - rejects empty *** FAILED ***\n[info]   1 did not equal 2 (ParserSpec.scala:12)\n[info] Run completed in 1 second, 12 milliseconds.\n[error] Failed tests:\n[error] \tapp.ParserSpec\n[error] Total time: 12 s, completed Oct 27, 2026, 11:15:40 PM"],
  ["ctest", "1/1 Test #1: parse ............................***Failed    0.01 sec\n0% tests passed, 1 tests failed out of 1\nTotal Test time (real) =   0.01 sec", "1/1 Test #1: parse ............................***Failed    1.23 sec\n0% tests passed, 1 tests failed out of 1\nTotal Test time (real) =  12.10 sec"],
  ["gtest", "Note: Randomizing tests' orders with a seed of 1234 .\n[ RUN      ] Parse.Rejects\nparse_test.cc:12: Failure\n[  FAILED  ] Parse.Rejects (0 ms)\n[==========] 1 test from 1 test suite ran. (1 ms total)", "Note: Randomizing tests' orders with a seed of 98765 .\n[ RUN      ] Parse.Rejects\nparse_test.cc:12: Failure\n[  FAILED  ] Parse.Rejects (3 ms)\n[==========] 1 test from 1 test suite ran. (14 ms total)"],
  ["rspec", "Randomized with seed 12345\nF\n\nFailures:\n\n  1) Parser rejects empty input\n     Failure/Error: expect(parse('')).to be_nil\n     # ./spec/parser_spec.rb:5\n\nFinished in 0.0123 seconds (files took 0.1 seconds to load)\n1 example, 1 failure\n\nrspec ./spec/parser_spec.rb:4 # Parser rejects empty input", "Randomized with seed 54321\nF\n\nFailures:\n\n  1) Parser rejects empty input\n     Failure/Error: expect(parse('')).to be_nil\n     # ./spec/parser_spec.rb:5\n\nFinished in 1 minute 2.5 seconds (files took 0.32 seconds to load)\n1 example, 1 failure\n\nrspec ./spec/parser_spec.rb:4 # Parser rejects empty input"],
  ["minitest", "Run options: --seed 12345\n\n# Running:\n\nF\n\nFinished in 0.001234s, 810.4 runs/s, 1620.8 assertions/s.\n\n  1) Failure:\nParserTest#test_rejects_empty [test/parser_test.rb:5]:\nExpected nil.\n\n1 runs, 2 assertions, 1 failures, 0 errors, 0 skips", "Run options: --seed 777\n\n# Running:\n\nF\n\nFinished in 0.002000s, 500.0 runs/s, 1000.0 assertions/s.\n\n  1) Failure:\nParserTest#test_rejects_empty [test/parser_test.rb:5]:\nExpected nil.\n\n1 runs, 2 assertions, 1 failures, 0 errors, 0 skips"],
  ["phpunit", "PHPUnit 10.5.0 by Sebastian Bergmann and contributors.\n\nF\n\nTime: 00:00.012, Memory: 6.00 MB\n\nThere was 1 failure:\n\n1) ParserTest::testRejectsEmpty\nFailed asserting that 2 is identical to 1.\n\n/work/tests/ParserTest.php:12\n\nFAILURES!\nTests: 1, Assertions: 1, Failures: 1.", "PHPUnit 10.5.0 by Sebastian Bergmann and contributors.\n\nF\n\nTime: 00:01.345, Memory: 8.00 MB\n\nThere was 1 failure:\n\n1) ParserTest::testRejectsEmpty\nFailed asserting that 2 is identical to 1.\n\n/work/tests/ParserTest.php:12\n\nFAILURES!\nTests: 1, Assertions: 1, Failures: 1."],
  ["pest", "  FAILED  Tests\\ParserTest > it rejects empty\n  Failed asserting that 2 is identical to 1.\n\n  Tests:    1 failed (1 assertions)\n  Duration: 0.05s", "  FAILED  Tests\\ParserTest > it rejects empty\n  Failed asserting that 2 is identical to 1.\n\n  Tests:    1 failed (1 assertions)\n  Duration: 1.20s"],
  ["swift test", "Test Case '-[AppTests.ParserTests testRejectsEmpty]' started.\n/work/Tests/AppTests/ParserTests.swift:7: error: -[AppTests.ParserTests testRejectsEmpty] : XCTAssertEqual failed: (\"2\") is not equal to (\"1\")\nTest Case '-[AppTests.ParserTests testRejectsEmpty]' failed (0.002 seconds).\nExecuted 1 test, with 1 failure (0 unexpected) in 0.004 (0.005) seconds", "Test Case '-[AppTests.ParserTests testRejectsEmpty]' started.\n/work/Tests/AppTests/ParserTests.swift:7: error: -[AppTests.ParserTests testRejectsEmpty] : XCTAssertEqual failed: (\"2\") is not equal to (\"1\")\nTest Case '-[AppTests.ParserTests testRejectsEmpty]' failed (0.031 seconds).\nExecuted 1 test, with 1 failure (0 unexpected) in 0.032 (0.040) seconds"],
  ["busted (R73 flatelens)", busted("0.015", "0x5581e0c3a2b0"), busted("0.031", "0x5581e0d01f40")],
  ["busted (Windows)", busted("0.015234", "00000184D28BE670"), busted("0.031", "000001C3A0F21B30")],
  ["dart test", "00:00 +0: loading test/parse_test.dart\n00:01 +0 -1: parse rejects empty [E]\n  Expected: <1>\n    Actual: <2>\n  test/parse_test.dart 7:5  main.<fn>\n00:01 +0 -1: Some tests failed.", "00:00 +0: loading test/parse_test.dart\n00:03 +0 -1: parse rejects empty [E]\n  Expected: <1>\n    Actual: <2>\n  test/parse_test.dart 7:5  main.<fn>\n00:04 +0 -1: Some tests failed."],
  ["pester", "Starting discovery in 1 files.\nDiscovery found 2 tests in 12ms.\nRunning tests.\n[-] Parser.rejects empty 12ms (9ms|3ms)\n Expected 1, but got 2.\n at $r | Should -Be 1, /work/tests/Parser.Tests.ps1:5\nTests completed in 123ms\nTests Passed: 1, Failed: 1, Skipped: 0 NotRun: 0", "Starting discovery in 1 files.\nDiscovery found 2 tests in 31ms.\nRunning tests.\n[-] Parser.rejects empty 4ms (2ms|2ms)\n Expected 1, but got 2.\n at $r | Should -Be 1, /work/tests/Parser.Tests.ps1:5\nTests completed in 1.01s\nTests Passed: 1, Failed: 1, Skipped: 0 NotRun: 0"],
  ["testthat", "── Failure (test-parse.R:5:3): parse rejects empty ──\nparse(\"\") not equal to 1.\n[ FAIL 1 | WARN 0 | SKIP 0 | PASS 1 ]\n══ Results ══\nDuration: 0.5 s", "── Failure (test-parse.R:5:3): parse rejects empty ──\nparse(\"\") not equal to 1.\n[ FAIL 1 | WARN 0 | SKIP 0 | PASS 1 ]\n══ Results ══\nDuration: 1.2 s"],
  ["ExUnit", "Running ExUnit with seed: 52731, max_cases: 16\n\n  1) test rejects empty (ParserTest)\n     test/parser_test.exs:5\n     Assertion with == failed\n\nFinished in 0.03 seconds (0.00s async, 0.03s sync)\n1 test, 1 failure\n\nRandomized with seed 52731", "Running ExUnit with seed: 901, max_cases: 16\n\n  1) test rejects empty (ParserTest)\n     test/parser_test.exs:5\n     Assertion with == failed\n\nFinished in 0.1 seconds (0.02s async, 0.08s sync)\n1 test, 1 failure\n\nRandomized with seed 901"],
  // Runners without a summary parser (`none` in `TEST_RUNNERS`) whose failing checks still repeat.
  ["zig build test", "error: 'parse_test.test.rejects empty' failed: expected 1, found 2\nBuild Summary: 3/5 steps succeeded; 1 failed; 1/2 tests passed; 1 failed\ntest transitive failure\n└─ run test 1 passed 1 failed 3ms MaxRSS:1M", "error: 'parse_test.test.rejects empty' failed: expected 1, found 2\nBuild Summary: 3/5 steps succeeded; 1 failed; 1/2 tests passed; 1 failed\ntest transitive failure\n└─ run test 1 passed 1 failed 15ms MaxRSS:2M"],
  ["julia Test", "parse: Test Failed at /work/test/runtests.jl:5\n  Expression: parse(\"\") == 1\nTest Summary: | Pass  Fail  Total  Time\nparse         |    1     1      2  0.5s", "parse: Test Failed at /work/test/runtests.jl:5\n  Expression: parse(\"\") == 1\nTest Summary: | Pass  Fail  Total  Time\nparse         |    1     1      2  2.1s"],
  ["dune (Alcotest)", "Testing `parse'.\nThis run has ID `9KXJ1U9Z'.\n\n  [FAIL]        parse          0   rejects empty.\nASSERT same int\nFAIL same int\n   Expected: `1'\n   Received: `2'\n\n1 failure! in 0.001s. 2 tests run.", "Testing `parse'.\nThis run has ID `ZQ3MBB0A'.\n\n  [FAIL]        parse          0   rejects empty.\nASSERT same int\nFAIL same int\n   Expected: `1'\n   Received: `2'\n\n1 failure! in 0.004s. 2 tests run."],
  ["nim unittest", "[Suite] parse\n    /work/tests/test_parse.nim(7, 15): Check failed: parse(\"\") == 1\n    parse(\"\") was 2\n  [FAILED] rejects empty", "[Suite] parse\n    /work/tests/test_parse.nim(7, 15): Check failed: parse(\"\") == 1\n    parse(\"\") was 2\n  [FAILED] rejects empty"],
  ["hspec", "Parser\n  rejects empty FAILED [1]\n\nFailures:\n\n  test/ParserSpec.hs:9:5:\n  1) Parser rejects empty\n       expected: 1\n        but got: 2\n\nRandomized with seed 1234\n\nFinished in 0.0012 seconds\n2 examples, 1 failure", "Parser\n  rejects empty FAILED [1]\n\nFailures:\n\n  test/ParserSpec.hs:9:5:\n  1) Parser rejects empty\n       expected: 1\n        but got: 2\n\nRandomized with seed 99\n\nFinished in 0.0310 seconds\n2 examples, 1 failure"],
  ["temp paths", `error: ${tmp}/a1/out.txt missing at 2026-10-24T04:42:53.120Z`, `error: ${tmp}/b7/out.txt missing at 2026-10-24T05:01:02.004Z`],
  ["addresses", "panic: nil map at 0xc000123456", "panic: nil map at 0xc000fedcba"],
];

/** The runner a pair stands for: the first word of its name, lowercased. */
const pairRunner = (name: string): string => (name.split(" ")[0] ?? "").toLowerCase();

describe("repeated failure hash (#1996)", () => {
  test.each(pairs)("two runs of the same %s failure hash equal", (_name, a, b) => {
    expect(normalizeCheckOutput(a)).toBe(normalizeCheckOutput(b));
    expect(failureHash([repeatCheck("check", a, ["f"])])).toBe(failureHash([repeatCheck("check", b, ["f"])]));
  });

  test("a moved position, another message, another check or other files is progress", () => {
    const base = [repeatCheck("gofmt", "rules_test.go:26:2217: illegal byte order mark", ["rules_test.go"])];
    const variants = [
      [repeatCheck("gofmt", "rules_test.go:27:2217: illegal byte order mark", ["rules_test.go"])],
      [repeatCheck("gofmt", "rules_test.go:26:2217: expected declaration", ["rules_test.go"])],
      [repeatCheck("vet", "rules_test.go:26:2217: illegal byte order mark", ["rules_test.go"])],
      [repeatCheck("gofmt", "rules_test.go:26:2217: illegal byte order mark", ["rules.go"])],
      [...base, repeatCheck("tests-written", "rules_test.go:26:3024: illegal byte order mark", ["rules_test.go"])],
    ];
    for (const variant of variants) {
      expect(repeatedFailureDecision(base, variant)).toBe("progress");
      expect(firstDifference(base, variant)).not.toBeNull();
    }
    expect(repeatedFailureDecision(base, base)).toBe("repeat");
    expect(repeatedFailureDecision(null, base)).toBe("first");
    // Check order does not matter.
    const two = [repeatCheck("b", "x", []), repeatCheck("a", "y", [])];
    expect(failureHash(two)).toBe(failureHash([...two].reverse()));
  });

  test("every test runner BAKED reads has a pair (#2281)", () => {
    const runners = new Set(Object.values(TEST_RUNNERS).flatMap((row) => (Array.isArray(row) ? row : [])));
    const covered = new Set(pairs.map(([name]) => pairRunner(name)));
    // `go` is named `go test`, `dotnet` `dotnet test`, `swift` `swift test`, `dart` `dart test`.
    const missing = [...runners].filter((runner) => !covered.has(runner));
    expect(missing).toEqual([]);
  });

  test("a changed line, test name or asserted value is still progress on the new shapes (#2281)", () => {
    const lua = busted("0.015", "00000184D28BE670");
    const jvm = gradle("8s");
    const variants: [string, string][] = [
      [lua, lua.replace("parse_spec.lua:5:", "parse_spec.lua:6:")],
      [lua, lua.replace("parse rejects empty input", "parse rejects blank input")],
      [lua, lua.replace("@ 3", "@ 4")],
      [jvm, jvm.replace("ParserTest.kt:12", "ParserTest.kt:13")],
      [jvm, jvm.replace("rejectsEmpty()", "rejectsBlank()")],
    ];
    for (const [before, after] of variants) {
      expect(before).not.toBe(after);
      expect(repeatedFailureDecision([repeatCheck("test", before, [])], [repeatCheck("test", after, [])])).toBe("progress");
    }
    // A whole number the test asserts, and positions shaped like a clock, stay.
    const kept: [string, string][] = [
      ["expected timeout 5s, got 6s", "expected timeout 6s, got 6s"],
      ["parse.ts:12:34 expected 1", "parse.ts:12:35 expected 1"],
      ["test/parse_test.dart 7:5  main", "test/parse_test.dart 8:5  main"],
      ["expected 3 retries, got 2", "expected 3 retries, got 1"],
      ["Expected: 12 ms", "Expected: 13 ms"],
    ];
    for (const [a, b] of kept) expect(normalizeCheckOutput(a)).not.toBe(normalizeCheckOutput(b));
  });

  test("a record names its chain root and the corrective it was compared with", () => {
    const checks = [repeatCheck("gofmt", "bom", ["a.go"])];
    const first = repeatRecord("T005", "T003", null, checks);
    expect(first).toMatchObject({ taskId: "T005", previous: null, root: "T003", decision: "first", previousHash: null, firstDifference: null });
    const second = repeatRecord("T006", "T005", first, checks);
    expect(second).toMatchObject({ previous: "T005", root: "T003", decision: "repeat", previousHash: first.hash, firstDifference: null });
  });
});

// #2295: the check baseline (`shapedFailureSignature`, compared by the `baseline_signature` reason)
// and the check finding's failing lines (`failureSignature` of convergence.ts) read the same table
// of volatile values as the repeated-failure hash, so a new runner's pair covers all three.
describe("one table of volatile values for every failure comparison (#2295)", () => {
  test.each(pairs)("two runs of the same %s failure have one baseline signature and one finding text", (_name, a, b) => {
    expect(shapedFailureSignature(a, "/work")).toBe(shapedFailureSignature(b, "/work"));
    expect(failingLines(a)).toBe(failingLines(b));
    const input = {
      legacy: { before: ["x"], after: ["y"] },
      shaped: { before: signatureLines(shapedFailureSignature(a, "/work")), after: signatureLines(shapedFailureSignature(b, "/work")) },
      subset: false,
    };
    expect(baselineSignatureDecision(input)).toBe("shaped");
  });

  test("a changed line, test name or asserted value still differs in the baseline signature", () => {
    const lua = busted("0.015", "00000184D28BE670");
    const jvm = gradle("8s");
    const variants: [string, string][] = [
      [lua, lua.replace("parse_spec.lua:5:", "parse_spec.lua:6:")],
      [lua, lua.replace("parse rejects empty input", "parse rejects blank input")],
      [jvm, jvm.replace("ParserTest.kt:12", "ParserTest.kt:13")],
      [jvm, jvm.replace("rejectsEmpty()", "rejectsBlank()")],
      ["expected timeout 5s, got 6s", "expected timeout 6s, got 6s"],
      ["parse.ts:12:34 expected 1", "parse.ts:12:35 expected 1"],
      ["test/parse_test.dart 7:5  main", "test/parse_test.dart 8:5  main"],
      ["Expected: 12 ms", "Expected: 13 ms"],
    ];
    for (const [before, after] of variants) expect(shapedFailureSignature(before, "/work")).not.toBe(shapedFailureSignature(after, "/work"));
    // The finding text leaves line numbers out by design, but keeps names and asserted values.
    expect(failingLines("  ✕ rejects bad input (5 ms)")).not.toBe(failingLines("  ✕ rejects blank input (5 ms)"));
    expect(failingLines("Expected: 12 ms")).not.toBe(failingLines("Expected: 13 ms"));
  });

  test("a failure that lost a diagnostic and changed its duration is within the baseline", () => {
    const before = "src/a.py:1:1: F401 `os` imported but unused\nsrc/b.py:2:1: F401 `re` imported but unused\nFound 2 errors.\nFinished in 8s";
    const after = "src/a.py:1:1: F401 `os` imported but unused\nFound 1 error.\nFinished in 1m 3s";
    expect(withinBaseline(shapedFailureSignature(before, "/work"), shapedFailureSignature(after, "/work"))).toBe(true);
    const shaped = { before: signatureLines(shapedFailureSignature(before, "/work")), after: signatureLines(shapedFailureSignature(after, "/work")) };
    expect(baselineSignatureDecision({ legacy: shaped, shaped, subset: true })).toBe("both");
    expect(baselineSignatureDecision({ legacy: shaped, shaped, subset: false })).toBe("neither");
    // A diagnostic the baseline did not have is new.
    const added = { ...shaped, after: [...shaped.after, "src/c.py:1:1: F401 `io` imported but unused"] };
    expect(baselineSignatureDecision({ legacy: added, shaped: added, subset: true })).toBe("neither");
  });

  test("a finding that names CTest's, Swift's and node-tap's failure covers its next run", () => {
    for (const name of ["ctest", "swift test", "tap (node-tap)"]) {
      const [, a, b] = pairs.find(([n]) => n === name) ?? ["", "", ""];
      const signature = failingLines(a);
      expect(signature).not.toBe("");
      expect(failuresCovered(b, [{ claim: "Required check tests failed", impact: `Implementation cannot be accepted. Failing: ${signature}` }])).toBe(true);
    }
  });
});

// #2520: the block of a task that ended unfinished twice alike says a resume repeats the failure,
// so it offers no resume; R82 tinyflate deflate 82f19908 T007 was offered only that resume.
describe("unfinishedRepeatFault (#2520)", () => {
  const fault = () => new WorkflowFault("OUTPUT_INVALID", "Task T007 did not complete its implementation: ctest fails", { unfinishedTask: "T007" });
  test("from the second end alike the remedies change an input and leave resume out", () => {
    const blocked = unfinishedRepeatFault(fault(), "run-1", { taskId: "T007", ends: 2, checks: ["ctest"] });
    const advice = errorRecovery(blocked);
    expect(advice?.remedies.map((r) => r.action)).toEqual(["reroute", "revise", "replan", "cancel"]);
    expect(advice?.remedies.every((r) => r.runId === "run-1")).toBe(true);
    expect(blocked.message).toContain("Task T007 ended unfinished 2 times in a row with the same failing output of ctest.");
    expect(blocked.message).toContain("What must change is the input behind ctest");
    expect(blocked.message).toContain("baked workflow reroute run-1 --route STAGE=MODEL --resume");
    expect(blocked.details.unfinishedTask).toBe("T007");
    expect(unfinishedRepeatRemedies(3)).toEqual(["reroute", "revise", "replan", "cancel"]);
  });
  test("without a repeat the fault stays as it was", () => {
    const plain = fault();
    expect(unfinishedRepeatFault(plain, "run-1", null)).toBe(plain);
    expect(unfinishedRepeatRemedies(1)).toEqual(["resume"]);
  });
});

// #2520: the invalid-output repeat key is built from the writes the host refused, never from the
// model's wording; the diagnostic's hash keys only a stop without refusals.
describe("invalid-output repeat decision (#2520)", () => {
  const refusals = [{ code: "exists" as const, path: "lib/src/template.dart" }];
  const inputs = { routing: 1 };
  test("the same refusal under a new diagnostic repeats the last resume", () => {
    const previous = invalidOutputKey({ refusals, diagnostic: "hash-of-first-wording", inputs });
    expect(invalidOutputKey({ refusals, diagnostic: "hash-of-second-wording", inputs })).toBe(previous);
    expect(invalidOutputDecision({ refusals, diagnostic: "hash-of-second-wording", inputs, noted: false, previous })).toBe("repeat");
    expect(invalidOutputDecision({ refusals, diagnostic: "hash-of-second-wording", inputs, noted: false, previous: null })).toBe("first");
    // A reroute changes the routing revision, so the same refusal is a new situation.
    expect(invalidOutputDecision({ refusals, diagnostic: "x", inputs: { routing: 2 }, noted: false, previous })).toBe("progress");
    expect(invalidOutputDecision({ refusals: [{ code: "exists", path: "lib/src/render.dart" }], diagnostic: "x", inputs, noted: false, previous })).toBe("progress");
  });
  test("without refusals the diagnostic keys the decision, as before", () => {
    const previous = invalidOutputKey({ refusals: [], diagnostic: "d1", inputs });
    expect(invalidOutputDecision({ refusals: [], diagnostic: "d1", inputs, noted: true, previous })).toBe("repeat");
    expect(invalidOutputDecision({ refusals: [], diagnostic: "d2", inputs, noted: true, previous })).toBe("progress");
    expect(invalidOutputDecision({ refusals: [], diagnostic: "d1", inputs, noted: false, previous })).toBe("first");
  });
  // #2587: the build is an input of the key; a key from before it, which has none, differs.
  test("another build, or a key without one, is progress; the same build repeats", () => {
    const built = { routing: 1, build: "0.5.0+1c434312e0b7" };
    const previous = invalidOutputKey({ refusals: [], diagnostic: "d1", inputs: { routing: 1, build: "0.5.0+7d1e0a52c4b9" } });
    const facts = { refusals: [], diagnostic: "d1", inputs: built, noted: true, previous };
    expect(invalidOutputDecision(facts)).toBe("progress");
    expect(invalidOutputBuildChange(facts)).toEqual({ from: "0.5.0+7d1e0a52c4b9", to: built.build });
    const same = invalidOutputKey({ refusals: [], diagnostic: "d1", inputs: built });
    expect(invalidOutputDecision({ ...facts, previous: same })).toBe("repeat");
    expect(invalidOutputBuildChange({ ...facts, previous: same })).toBeNull();
    // A key from before #2587 and the pre-key fallback both have no build.
    const legacy = invalidOutputKey({ refusals, diagnostic: "d1", inputs });
    expect(invalidOutputDecision({ refusals, diagnostic: "d1", inputs: built, noted: false, previous: legacy })).toBe("progress");
    expect(invalidOutputDecision({ ...facts, previous: null })).toBe("progress");
    expect(invalidOutputBuildChange({ ...facts, previous: null })).toEqual({ from: null, to: built.build });
    // Another input changed as well: the build is not why the resume passes.
    expect(invalidOutputBuildChange({ ...facts, inputs: { ...built, routing: 2 } })).toBeNull();
    // A record from before #2587 replays as it was decided.
    expect(invalidOutputDecision({ refusals: [], diagnostic: "d1", inputs, noted: true, previous: null })).toBe("repeat");
  });
  test("a journaled refusal reads back as its code and path", () => {
    expect(writeRefusalOf("Create target already exists: lib/src/template.dart")).toEqual({ code: "exists", path: "lib/src/template.dart" });
    expect(writeRefusalOf("File changed outside this attempt: a.ts")).toEqual({ code: "changed", path: "a.ts" });
    expect(writeRefusalOf("Modify target is missing: b.ts")).toEqual({ code: "missing", path: "b.ts" });
    expect(writeRefusalOf("oldString not found in a.ts")).toBeNull();
  });
});

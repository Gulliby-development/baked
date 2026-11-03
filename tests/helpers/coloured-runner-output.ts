import type { TestRunner } from "../../src/core/verification/output-counts.js";

/**
 * A passing and a failing summary of every runner `testCount` reads, plain, with the counts the
 * parsers give them (#2615). The record is typed by `TestRunner`, so a runner added to
 * `TEST_COUNTERS` does not compile here until it has its samples, and the gate matrix's colour
 * cell runs each through `colour` to show the parsers read a coloured run the same way.
 */
export const RUNNER_SUMMARIES: Record<
  TestRunner,
  { passed: string; failed: string; total: number; ran: number; failedNames?: string[] }
> = {
  bun: {
    passed: "tests/a.test.ts:\n(pass) adds [0.10ms]\n(pass) subtracts [0.05ms]\n\n 2 pass\n 0 fail\nRan 2 tests across 1 file. [12.00ms]\n",
    failed: "tests/a.test.ts:\n(pass) adds [0.10ms]\n(fail) subtracts [0.05ms]\n\n 1 pass\n 1 fail\nRan 2 tests across 1 file. [12.00ms]\n",
    total: 2,
    ran: 2,
    failedNames: ["subtracts"],
  },
  jest: {
    passed: "PASS tests/a.test.js\nTest Suites: 1 passed, 1 total\nTests:       3 passed, 3 total\n",
    failed: "FAIL tests/a.test.js\n  ● adds\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 2 passed, 3 total\n",
    total: 3,
    ran: 3,
  },
  vitest: {
    passed: " ✓ tests/a.test.ts (15 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  15 passed (15)\n",
    failed: " ❯ tests/a.test.ts (15 tests | 1 failed) 4ms\n\n Test Files  1 failed (1)\n      Tests  1 failed | 14 passed (15)\n",
    total: 15,
    ran: 15,
  },
  pytest: {
    passed: "tests/test_a.py ...                                     [100%]\n\n============================== 3 passed in 0.12s ===============================\n",
    failed: "tests/test_a.py ..F                                     [100%]\nFAILED tests/test_a.py::test_sub - assert 1 == 2\n========================= 1 failed, 2 passed in 0.12s ==========================\n",
    total: 3,
    ran: 3,
  },
  cargo: {
    passed: "running 4 tests\ntest adds ... ok\n\ntest result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n",
    failed: "running 4 tests\ntest adds ... FAILED\n\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n",
    total: 4,
    ran: 4,
  },
  dotnet: {
    passed: "Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12, Duration: 20 ms - A.Tests.dll (net8.0)\n",
    failed: "Failed!  - Failed:     1, Passed:    11, Skipped:     0, Total:    12, Duration: 20 ms - A.Tests.dll (net8.0)\n",
    total: 12,
    ran: 12,
  },
  maven: {
    passed: "[INFO] Results:\n[INFO] \n[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n",
    failed: "[ERROR] Failures: \n[ERROR] Tests run: 12, Failures: 1, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE\n",
    total: 12,
    ran: 12,
  },
  go: {
    passed: "=== RUN   TestAdd\n--- PASS: TestAdd (0.00s)\n=== RUN   TestSub\n--- PASS: TestSub (0.00s)\nPASS\nok  \texample.com/calc\t0.002s\n",
    failed: "=== RUN   TestAdd\n--- PASS: TestAdd (0.00s)\n=== RUN   TestSub\n--- FAIL: TestSub (0.00s)\nFAIL\nFAIL\texample.com/calc\t0.002s\n",
    total: 2,
    ran: 2,
  },
  phpunit: {
    passed: "PHPUnit 11.5.0 by Sebastian Bergmann and contributors.\n\n.....                                                               5 / 5 (100%)\n\nOK (5 tests, 10 assertions)\n",
    failed: "PHPUnit 11.5.0 by Sebastian Bergmann and contributors.\n\n....F                                                               5 / 5 (100%)\n\nFAILURES!\nTests: 5, Assertions: 8, Failures: 1.\n",
    total: 5,
    ran: 5,
  },
  pest: {
    passed: "   PASS  Tests\\Unit\\SumTest\n  ✓ adds\n\n  Tests:    3 passed (6 assertions)\n  Duration: 0.10s\n",
    failed: "   FAIL  Tests\\Unit\\SumTest\n  ⨯ adds\n\n  Tests:    1 failed, 2 passed (6 assertions)\n  Duration: 0.10s\n",
    total: 3,
    ran: 3,
  },
  rspec: {
    passed: "...\n\nFinished in 0.00 seconds (files took 0.05 seconds to load)\n3 examples, 0 failures\n",
    failed: "..F\n\nFinished in 0.00 seconds (files took 0.05 seconds to load)\n3 examples, 1 failure\n",
    total: 3,
    ran: 3,
  },
  minitest: {
    passed: "Finished in 0.001s, 1000.0 runs/s.\n\n4 runs, 4 assertions, 0 failures, 0 errors, 0 skips\n",
    failed: "Finished in 0.001s, 1000.0 runs/s.\n\n4 runs, 4 assertions, 1 failures, 0 errors, 0 skips\n",
    total: 4,
    ran: 4,
  },
  busted: {
    passed: "●●●\n3 successes / 0 failures / 0 errors / 0 pending : 0.001 seconds\n",
    failed: "●●◼\n2 successes / 1 failure / 0 errors / 0 pending : 0.001 seconds\n",
    total: 3,
    ran: 3,
  },
  ctest: {
    passed: "    Start 1: SumTest.Adds\n1/3 Test #1: SumTest.Adds ......................   Passed    0.00 sec\n\n100% tests passed, 0 tests failed out of 3\n",
    failed: "    Start 1: SumTest.Adds\n1/3 Test #1: SumTest.Adds ......................***Failed    0.00 sec\n\n67% tests passed, 1 tests failed out of 3\n",
    total: 3,
    ran: 3,
  },
  gtest: {
    passed: "[==========] Running 3 tests from 1 test suite.\n[==========] 3 tests from 1 test suite ran. (0 ms total)\n[  PASSED  ] 3 tests.\n",
    failed: "[==========] Running 3 tests from 1 test suite.\n[  FAILED  ] SumTest.Commutes (0 ms)\n[==========] 3 tests from 1 test suite ran. (0 ms total)\n[  PASSED  ] 2 tests.\n[  FAILED  ] 1 test, listed below:\n[  FAILED  ] SumTest.Commutes\n",
    total: 3,
    ran: 3,
  },
  dart: {
    passed: "00:00 +3: All tests passed!\n",
    failed: "00:00 +2 -1: Some tests failed.\n",
    total: 3,
    ran: 3,
  },
  sbt: {
    passed: "[info] Passed: Total 5, Failed 0, Errors 0, Passed 5\n[success] Total time: 3 s\n",
    failed: "[error] Failed: Total 5, Failed 1, Errors 0, Passed 4\n[error] (Test / test) sbt.TestsFailedException: Tests unsuccessful\n",
    total: 5,
    ran: 5,
  },
  swift: {
    passed: "Test Suite 'All tests' passed at 2026-10-28 21:31:05.697\n\t Executed 3 tests, with 0 failures (0 unexpected) in 0.001 (0.002) seconds\n",
    failed: "Test Suite 'All tests' failed at 2026-10-28 21:31:05.697\n\t Executed 3 tests, with 1 failure (0 unexpected) in 0.001 (0.002) seconds\n",
    total: 3,
    ran: 3,
  },
  junit: {
    passed: '<?xml version="1.0"?>\n<testsuites tests="3" failures="0">\n<testsuite name="a" tests="3"></testsuite>\n</testsuites>\n',
    failed: '<?xml version="1.0"?>\n<testsuites tests="3" failures="1">\n<testsuite name="a" tests="3"></testsuite>\n</testsuites>\n',
    total: 3,
    ran: 3,
  },
  tap: {
    passed: "1..3\nok 1 adds\nok 2 subtracts\nok 3 commutes\n",
    failed: "1..3\nok 1 adds\nok 2 subtracts\nnot ok 3 commutes\n",
    total: 3,
    ran: 3,
  },
  pester: {
    passed: "Tests completed in 120ms\nTests Passed: 3, Failed: 0, Skipped: 0, Inconclusive: 0, NotRun: 0\n",
    failed: "Tests completed in 120ms\nTests Passed: 2, Failed: 1, Skipped: 0, Inconclusive: 0, NotRun: 0\n",
    total: 3,
    ran: 3,
  },
  testthat: {
    passed: "✔ | F W  S  OK | Context\n✔ |          3 | sum\n\n[ FAIL 0 | WARN 0 | SKIP 0 | PASS 3 ]\n",
    failed: "✔ | F W  S  OK | Context\n✖ | 1        2 | sum\n\n[ FAIL 1 | WARN 0 | SKIP 0 | PASS 2 ]\n",
    total: 3,
    ran: 3,
  },
  exunit: {
    passed: "...\nFinished in 0.01 seconds (0.00s async, 0.01s sync)\n3 tests, 0 failures\n",
    failed: "..F\nFinished in 0.01 seconds (0.00s async, 0.01s sync)\n3 tests, 1 failure\n",
    total: 3,
    ran: 3,
  },
};

/**
 * The output a runner prints on a colour terminal: each word in a colour or bold code, a line
 * that starts by erasing the line (`\x1b[2K`, progress redraws), an OSC 8 hyperlink round the
 * first path, and a reset at the end.
 */
export function colour(plain: string): string {
  const codes = ["\u001b[32m", "\u001b[1m", "\u001b[2m", "\u001b[31;1m", "\u001b[38;5;208m"];
  let n = 0;
  return plain
    .split("\n")
    .map((line, i) => {
      const words = line.replace(/\S+/g, (word) => `${codes[n++ % codes.length]}${word}\u001b[0m`);
      const linked = i === 0 ? words.replace(/(\S*\/\S*)/, "\u001b]8;;file:///w\u0007$1\u001b]8;;\u0007") : words;
      return line ? `\u001b[2K${linked}\u001b[0m` : line;
    })
    .join("\n");
}

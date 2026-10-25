/**
 * A failed test as each supported runner prints it, shared by every reader of check output: the
 * timeout classification, the lines the model sees, attempt progress and failure signatures.
 * Separate copies knew only bun, jest, vitest, cargo, pytest and go, so a dotnet, Maven or
 * Gradle run that failed and then hung stayed an inconclusive timeout (#1424).
 *
 * A bare `ERROR` or `Failed to ...` line is not one: it may be the application's own log.
 */
export const FAILED_TEST_LINE = new RegExp(
  [
    // pytest `FAILED`, bun `(fail)`, go `--- FAIL`, TAP and node:test `not ok`, jest, vitest, mocha.
    String.raw`^\s*(?:FAILED\b|\(fail\)|--- FAIL|not ok\b|[✗✕✘×✖]\s)`,
    // cargo `test x ... FAILED`, deno `x ... FAILED (3ms)`.
    String.raw`\.\.\. FAILED(?:\s+\(\d+(?:\.\d+)?\s?m?s\))?\s*$`,
    // dotnet `  Failed Ns.Tests.T1 [8 ms]` and its summary `Failed!  - Failed:     1`.
    String.raw`^\s*Failed\s+\S+\s+\[[<\d.\s]*m?s\]`,
    String.raw`^\s*Failed!\s+-\s+Failed:`,
    // Maven Surefire `... -- Time elapsed: 0.01 s <<< FAILURE!` (or `<<< ERROR!`).
    "<<< (?:FAILURE|ERROR)!",
    // Gradle `AppTest > testApp() FAILED`.
    String.raw`\)\s+FAILED\s*$`,
    // RSpec's rerun line `rspec ./spec/calc_spec.rb:6 # Calc adds`, Minitest `  1) Failure:` (#1493).
    String.raw`^rspec \S+:\d+ # `,
    String.raw`^\s*\d+\) (?:Failure|Error):\s*$`,
    // dart test `00:03 +4 -1: test/calc_test.dart: adds [E]` (#1494).
    String.raw`^[\d:]+ \+\d+(?: ~\d+)? -\d+: .+ \[E\]\s*$`,
  ].join("|"),
);

/** Whether a line of a check's output reports a failed test. */
export const isFailedTestLine = (line: string): boolean => FAILED_TEST_LINE.test(line);

import { describe, expect, test } from "bun:test";
import { timedOutFailure } from "../src/core/verification/check-runner.js";
import { isFailedTestLine } from "../src/core/verification/failed-test-line.js";
import { checkState } from "../src/core/workflows/attempt-progress.js";

// #1424: a dotnet, Maven or Gradle test run that failed and then hung stayed an inconclusive
// timeout, because the failure-line pattern knew only bun, jest, vitest, cargo, pytest and go.

const FAILED: Record<string, string> = {
  bun: "(fail) rejects big payloads [0.34ms]",
  jest: "  ✕ rejects big payloads (3 ms)",
  vitest: " × rejects big payloads 2ms",
  pytest: "FAILED tests/test_app.py::test_limit - AssertionError",
  go: "--- FAIL: TestLimit (0.00s)",
  cargo: "test limit ... FAILED",
  deno: "rejects big payloads ... FAILED (3ms)",
  "node:test": "not ok 1 - rejects big payloads",
  dotnet: "  Failed Dieodds.Tests.ParserTests.RejectsBigPayloads [8 ms]",
  "dotnet summary": "Failed!  - Failed:     1, Passed:     4, Skipped:     0, Total:     5",
  surefire: "[ERROR] com.example.AppTest.testApp -- Time elapsed: 0.012 s <<< FAILURE!",
  "surefire error": "[ERROR] com.example.AppTest.testApp -- Time elapsed: 0.012 s <<< ERROR!",
  gradle: "AppTest > testApp() FAILED",
};

describe("failed test lines of every runner (#1424)", () => {
  for (const [runner, line] of Object.entries(FAILED))
    test(`${runner}: a timeout after this line is a failure`, () => {
      expect(isFailedTestLine(line)).toBe(true);
      expect(timedOutFailure(`starting\n${line}\nstill running`)).toBe(true);
    });

  test("application logs are not failed tests", () => {
    for (const line of ["Failed to connect to localhost:5432", "ERROR app: connection refused, retrying", "[ERROR] app: oops", "  Passed Dieodds.Tests.ParserTests.Ok [2 ms]", "BUILD FAILED in 3s"])
      expect(isFailedTestLine(line)).toBe(false);
  });

  test("attempt progress counts the failed tests of dotnet and Maven", () => {
    expect(checkState("failed", `${FAILED.dotnet}\n  Failed Dieodds.Tests.ParserTests.Other [1 ms]`)).toMatchObject({ failed: 2 });
    expect(checkState("failed", `noise\n${FAILED.surefire}`).first).toContain("AppTest.testApp");
  });
});

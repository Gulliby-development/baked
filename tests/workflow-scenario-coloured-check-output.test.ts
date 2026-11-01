import { describe, expect, test } from "bun:test";
import { buildCheckEnv, exitStatus } from "../src/core/verification/check-runner.js";
import { noTestsCollected } from "../src/core/verification/convergence.js";
import { diagnosticCount, failedTests, testCount, testsRan } from "../src/core/verification/output-counts.js";
import type { Check } from "../src/core/workflows/schemas.js";
import { colour, RUNNER_SUMMARIES } from "./helpers/coloured-runner-output.js";

// Scenario of bench round 85 csp (#2615): the test-count parsers matched their `^`-anchored
// summary lines on the raw check output, and the check environment asked for no plain output. A
// coloured vitest summary gave `testCount` null, and a coloured `cargo test` (CARGO_TERM_COLOR
// or FORCE_COLOR set by the parent, as on CI) or `bun test` summary gave `testsRan` 0, so a
// passing `requireTests` check failed as "ran no test". The parsers now read the output without
// escape codes, and the checks run with the tools' plain-output variables.

const cargoCheck: Check = {
  id: "tests-written",
  executable: "cargo",
  args: ["test", "--test", "calc"],
  cwd: ".",
  timeoutMs: 60_000,
  required: true,
  scope: "task",
  envNames: [],
  writes: [],
  requireTests: true,
};

describe("scenario: R85 csp, coloured check output (#2615)", () => {
  test("a coloured passing cargo run does not fail requireTests, and its count is read", () => {
    const coloured = colour(RUNNER_SUMMARIES.cargo.passed);
    expect(coloured).toContain("\u001b[");
    expect(testsRan(coloured)).toEqual({ tool: "cargo", count: 4 });
    expect(exitStatus(cargoCheck, 0, coloured)).toBe("passed");
    // A coloured run of no test still fails it.
    expect(exitStatus(cargoCheck, 0, colour("running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"))).toBe("failed");
  });

  test("bun, vitest, jest and pytest read coloured runs as the plain ones", () => {
    for (const tool of ["bun", "vitest", "jest", "pytest"] as const) {
      const { passed, failed, total, ran } = RUNNER_SUMMARIES[tool];
      expect([tool, testCount(colour(passed)), testsRan(colour(passed))]).toEqual([tool, { tool, count: total }, { tool, count: ran }]);
      expect(failedTests(colour(failed))).toEqual(failedTests(failed));
    }
  });

  test("diagnostics and no-tests summaries are read through colour too", () => {
    expect(diagnosticCount(colour("Checked 12 files in 3ms. No fixes applied.\nFound 2 warnings.\n"))).toEqual({ tool: "biome", count: 2, errors: 0 });
    expect(noTestsCollected(colour("collected 0 items\n\n============ no tests ran in 0.01s ============\n"))).toBe(true);
  });

  test("checks run with plain-output variables unless the check declares one", () => {
    const saved = { FORCE_COLOR: process.env.FORCE_COLOR, CARGO_TERM_COLOR: process.env.CARGO_TERM_COLOR };
    process.env.FORCE_COLOR = "1";
    process.env.CARGO_TERM_COLOR = "always";
    try {
      const env = buildCheckEnv(cargoCheck);
      expect([env.NO_COLOR, env.FORCE_COLOR, env.CARGO_TERM_COLOR]).toEqual(["1", "0", "never"]);
      expect(buildCheckEnv({ ...cargoCheck, envNames: ["FORCE_COLOR"] }).FORCE_COLOR).toBe("1");
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });
});

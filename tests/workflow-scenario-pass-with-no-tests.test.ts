import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exitStatus, ranNoTests } from "../src/core/verification/check-runner.js";
import { noTestsCollected } from "../src/core/verification/convergence.js";
import { testCount, testsRan } from "../src/core/verification/output-counts.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import type { Check } from "../src/core/workflows/schemas.js";

// #2699: a check that must run tests (`requireTests`, every `-written` and `-affected` check)
// failed only when `testsRan` read 0. jest and vitest given `--passWithNoTests` (on the command, or
// `passWithNoTests: true` in a vitest config) print no summary when they find no test, only "No
// tests found, exiting with code 0" / "No test files found, exiting with code 0", and exit 0;
// Pest prints "INFO  No tests found.". `testsRan` read them as "does not tell", so the task's
// tests-written check passed with none of its tests run. The outputs below were recorded with jest
// 30.5 and vitest 5.1 on a project whose `roots` / `include` do not cover the written file.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-pass-with-no-tests-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const check = (id: string, executable: string, args: string[]): Check => ({
  id,
  executable,
  args,
  cwd: ".",
  timeoutMs: 120_000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
});

const VITEST_NONE =
  "\n RUN  v5.1.0 /w\n\nNo test files found, exiting with code 0\n\nfilter: src/parse.test.ts\ninclude: tests/**/*.test.ts\nexclude:  **/node_modules/**, **/.git/**\n\n";
const VITEST_RAN =
  "\n RUN  v5.1.0 /w\n\n ✓ src/parse.test.ts (1 test) 2ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Start at  10:00:00\n   Duration  210ms\n";
const JEST_NONE = "No tests found, exiting with code 0\n";
const JEST_RAN =
  "PASS src/parse.test.ts\n  ✓ parses (2 ms)\n\nTest Suites: 1 passed, 1 total\nTests:       1 passed, 1 total\nSnapshots:   0 total\nTime:        0.3 s\n";
const PEST_NONE = "\n   INFO  No tests found.\n\n";
const PEST_RAN =
  "\n   PASS  Tests\\Unit\\ParseTest\n  ✓ it parses\n\n  Tests:    1 passed (1 assertions)\n  Duration: 0.05s\n";

const JS_TEST = 'import { expect, test } from "vitest";\n\ntest("parses", () => {\n  expect(1 + 1).toBe(2);\n});\n';
const PHP_TEST = "<?php\n\ntest('it parses', function () {\n    expect(1 + 1)->toBe(2);\n});\n";

const CASES: { name: string; check: Check; file: string; text: string; args: string[]; none: string; ran: string; tool: string }[] = [
  {
    name: "vitest --passWithNoTests",
    check: check("tests", "npx", ["vitest", "run", "--passWithNoTests"]),
    file: "src/parse.test.ts",
    text: JS_TEST,
    args: ["vitest", "run", "--passWithNoTests", "./src/parse.test.ts"],
    none: VITEST_NONE,
    ran: VITEST_RAN,
    tool: "vitest",
  },
  {
    name: "jest --passWithNoTests",
    check: check("tests", "npx", ["jest", "--passWithNoTests"]),
    file: "src/parse.test.ts",
    text: JS_TEST.replace('import { expect, test } from "vitest";\n\n', ""),
    args: ["jest", "--passWithNoTests", "./src/parse.test.ts"],
    none: JEST_NONE,
    ran: JEST_RAN,
    tool: "jest",
  },
  {
    name: "Pest",
    check: check("tests", "pest", []),
    file: "tests/Unit/ParseTest.php",
    text: PHP_TEST,
    args: ["./tests/Unit/ParseTest.php"],
    none: PEST_NONE,
    ran: PEST_RAN,
    tool: "pest",
  },
];

describe("scenario: a tests-written check whose runner passes with no test found (#2699)", () => {
  for (const c of CASES) {
    test(`${c.name}: the written check fails when the runner found no test, and passes when the test ran`, () => {
      const root = project({ [c.file]: c.text });
      const written = writtenTestsCheck(root, [c.check], [{ path: c.file, action: "create" }]);
      expect(written).toMatchObject({ id: "tests-written", args: c.args, requireTests: true });
      const gate = written as Check;
      // Exit 0, no test run: the check verified nothing.
      expect(testsRan(c.none)).toEqual({ tool: c.tool, count: 0 });
      expect(ranNoTests(gate, c.none)).toBe(true);
      expect(exitStatus(gate, 0, c.none)).toBe("failed");
      // The no-test readers already take it as no test collected.
      expect(noTestsCollected(c.none)).toBe(true);
      // The line says nothing about how many tests the suite holds: no count to compare.
      expect(testCount(c.none)).toBeNull();
      // The same file run: the check passes.
      expect(testsRan(c.ran)).toEqual({ tool: c.tool, count: 1 });
      expect(exitStatus(gate, 0, c.ran)).toBe("passed");
      // A check of the project's own (`requireTests` unset) keeps passing on it.
      expect(exitStatus(c.check, 0, c.none)).toBe("passed");
    });
  }

  test("the failing runs that print the same line with exit 1 stay failed by their exit code", () => {
    const gate = { ...check("tests-written", "npx", ["jest"]), requireTests: true };
    expect(testsRan("No tests found, exiting with code 1\nRun with `--passWithNoTests` to exit with code 0\n")).toBeNull();
    expect(exitStatus(gate, 1, "No tests found, exiting with code 1\n")).toBe("failed");
  });
});

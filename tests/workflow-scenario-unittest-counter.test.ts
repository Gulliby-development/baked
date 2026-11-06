import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCheckEnv, exitStatus } from "../src/core/verification/check-runner.js";
import { baselineRegression, buildFailure, failedTests, testCount, testsRan } from "../src/core/verification/output-counts.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import type { Check } from "../src/core/workflows/schemas.js";

// #2737: `affectedTestCheck` narrows a `python -m unittest` check to a task's test files with
// `requireTests: true`, but no counter read unittest's summary, and bun's `ran` took its "Ran 3
// tests in 0.001s" line for bun's own: `testsRan` said bun ran 0, so every such check failed as
// "ran no test" with its tests run and passed, and an all-skipped run failed only by that accident.
// unittest now has its counter: its tests that ran pass the check, an all-skipped run fails it.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-unittest-counter-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const PYTHON = process.platform === "win32" ? "python" : "python3";
const check = (id: string, args: string[]): Check => ({
  id,
  executable: PYTHON,
  args,
  cwd: ".",
  timeoutMs: 120_000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
});
const hasPython = spawnSync(PYTHON, ["--version"], { stdio: "ignore" }).status === 0;

const PARSE = "def parse(text):\n    return text.split(',') if text else []\n";
const RUNS = `import unittest\n\nfrom parse import parse\n\n\nclass ParseTest(unittest.TestCase):\n    def test_empty(self):\n        self.assertEqual(parse(""), [])\n\n    def test_two(self):\n        self.assertEqual(parse("a,b"), ["a", "b"])\n\n    def test_one(self):\n        self.assertEqual(parse("a"), ["a"])\n`;
const SKIPPED = RUNS.replace("class ParseTest", '@unittest.skipUnless(False, "needs jq")\nclass ParseTest');
const FAILS = RUNS.replace('["a", "b"])', '["a", "c"])');
const BROKEN = RUNS.replace("from parse import parse", "from parse import fold");

// Recorded with Python 3.13.
const RAN = "...\n----------------------------------------------------------------------\nRan 3 tests in 0.001s\n\nOK\n";
const ALL_SKIPPED = "sss\n----------------------------------------------------------------------\nRan 3 tests in 0.000s\n\nOK (skipped=3)\n";

const run = (root: string, c: Check) => {
  const out = spawnSync(c.executable, c.args, { cwd: root, env: buildCheckEnv(c), encoding: "utf8" });
  const output = `${out.stdout}${out.stderr}`;
  return { output, exitCode: out.status ?? 1, status: exitStatus(c, out.status ?? 1, output) };
};

describe("scenario: a narrowed python -m unittest check (#2737)", () => {
  test("the written check runs the task's file with unittest and must run tests", () => {
    const root = project({ "parse.py": PARSE, "tests/__init__.py": "", "tests/test_parse.py": RUNS });
    const written = writtenTestsCheck(root, [check("tests", ["-m", "unittest", "discover", "-s", "tests"])], [{ path: "tests/test_parse.py", action: "create" }]);
    expect(written).toMatchObject({ id: "tests-written", args: ["-m", "unittest", "./tests/test_parse.py"], requireTests: true });
  });

  test("unittest's summary is read as unittest's: tests that ran pass, an all-skipped run fails", () => {
    const gate = { ...check("tests-written", ["-m", "unittest", "./tests/test_parse.py"]), requireTests: true };
    expect([testsRan(RAN), testCount(RAN)]).toEqual([{ tool: "unittest", count: 3 }, { tool: "unittest", count: 3 }]);
    expect(exitStatus(gate, 0, RAN)).toBe("passed");
    expect([testsRan(ALL_SKIPPED), testCount(ALL_SKIPPED)]).toEqual([{ tool: "unittest", count: 0 }, { tool: "unittest", count: 3 }]);
    expect(exitStatus(gate, 0, ALL_SKIPPED)).toBe("failed");
    // bun's own summary keeps its reader.
    expect(testsRan("tests/a.test.ts:\n(pass) adds\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]\n")).toEqual({ tool: "bun", count: 1 });
  });

  test("a unittest run with fewer tests than the baseline is a fall in the baseline comparison", () => {
    const baseline = { kind: "tests" as const, tool: "unittest", count: 4 };
    expect(baselineRegression(baseline, RAN)?.kind).toBe("tests");
  });

  test.skipIf(!hasPython)("with python: the check passes when its tests run, fails when every test is skipped, names a failed test and a module that did not import", () => {
    const tests = check("tests", ["-m", "unittest", "discover", "-s", "tests"]);
    const writes = [{ path: "tests/test_parse.py", action: "create" }];
    const at = (body: string) => {
      const root = project({ "parse.py": PARSE, "tests/__init__.py": "", "tests/test_parse.py": body });
      return run(root, writtenTestsCheck(root, [tests], writes) as Check);
    };
    const ran = at(RUNS);
    expect([ran.exitCode, ran.status, testsRan(ran.output)], ran.output).toEqual([0, "passed", { tool: "unittest", count: 3 }]);
    const skipped = at(SKIPPED);
    expect([skipped.exitCode, skipped.status, testsRan(skipped.output)], skipped.output).toEqual([0, "failed", { tool: "unittest", count: 0 }]);
    const fails = at(FAILS);
    expect([fails.status, failedTests(fails.output)?.names], fails.output).toEqual(["failed", [expect.stringMatching(/^test_two \(tests\.test_parse\.ParseTest(?:\.test_two)?\)$/)]]);
    const broken = at(BROKEN);
    expect([broken.status, buildFailure(broken.output), failedTests(broken.output)?.names], broken.output).toEqual(["failed", ["ImportError: Failed to import test module: test_parse"], []]);
  });
});

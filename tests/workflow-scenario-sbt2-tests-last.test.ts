import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exitStatus } from "../src/core/verification/check-runner.js";
import { noTestsCollected } from "../src/core/verification/convergence.js";
import { testsRan } from "../src/core/verification/output-counts.js";
import { affectedTestCheck } from "../src/core/workflows/affected-tests.js";
import { detectGates } from "../src/core/workflows/gates.js";

// Scenario of bench round 77, pairwick (#2440). A Scala build on sbt 2.0.11 whose plan writes the
// code first and its munit suite last. The detector's `sbt -batch test` is sbt 2's `testQuick`:
// on a cache hit it ran no test and passed ("No tests to run for Test / testQuick"). The loop's
// `testFull` got no per-task tests check, since only `test` was narrowed to `testOnly`, and its run
// on a build without a test printed no summary, so a check that must run tests passed on nothing.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "baked-sbt2-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

// The outputs the issue records from sbt 2.0.11.
const TESTQUICK_ZERO = "[info] Passed: Total 0, Failed 0, Errors 0, Passed 0\n[info] No tests to run for Test / testQuick\n[success] elapsed time: 1 s\n";
const TESTFULL_NONE = "[success] elapsed time: 1 s\n";
const TESTFULL_ONE = "pairwick.XTests:\n  + adds 0.011s\n[info] Passed: Total 1, Failed 0, Errors 0, Passed 1\n[success] elapsed time: 4 s\n";

const SUITE = "src/test/scala/pairwick/XTests.scala";
const PAIRWICK = {
  "build.sbt": 'scalaVersion := "3.7.3"\nlibraryDependencies += "org.scalameta" %% "munit" % "1.1.0" % Test\n',
  "project/build.properties": "sbt.version=2.0.11\n",
  "src/main/scala/pairwick/X.scala": "package pairwick\n\nobject X:\n  def add(a: Int, b: Int): Int = a + b\n",
};

describe("scenario: an sbt 2 Scala plan that writes its tests last (#2440)", () => {
  test("before the tests exist the gate runs every test without requireTests; after, the per-task check must run them", () => {
    const root = project(PAIRWICK);
    const gates = detectGates(root).map((s) => s.check);
    expect(gates.map((c) => [c.id, [c.executable, ...c.args].join(" "), c.requireTests ?? false])).toEqual([["sbt-test", "sbt -batch testFull", false]]);
    const gate = gates[0]!;

    // T001: no test yet. The gate passes on sbt 2's empty testFull, which is not read as a build
    // without tests, and no per-task check runs nothing.
    expect(exitStatus(gate, 0, TESTFULL_NONE)).toBe("passed");
    expect(noTestsCollected(TESTFULL_NONE)).toBe(false);
    expect(affectedTestCheck(gates, [])).toBeNull();

    // T002 writes the suite: the per-task check runs the suite's class and must run a test.
    mkdirSync(dirname(join(root, SUITE)), { recursive: true });
    writeFileSync(join(root, SUITE), 'package pairwick\n\nclass XTests extends munit.FunSuite:\n  test("adds") {\n    assertEquals(X.add(1, 2), 3)\n  }\n');
    const affected = affectedTestCheck(gates, [SUITE]);
    expect(affected).toMatchObject({ id: "sbt-test-affected", executable: "sbt", args: ["-batch", "testOnly *XTests"], requireTests: true, scope: "task" });
    expect(exitStatus(affected!, 0, TESTFULL_ONE)).toBe("passed");
    expect(testsRan(TESTFULL_ONE)).toEqual({ tool: "sbt", count: 1 });
    // A run that ran nothing, by sbt 2's testQuick or a testFull without a summary, fails it.
    expect(exitStatus(affected!, 0, TESTFULL_NONE)).toBe("failed");
    expect(exitStatus(affected!, 0, TESTQUICK_ZERO)).toBe("failed");
    // The gate itself fails a run that must run tests and ran none on testQuick's cache hit.
    expect(exitStatus({ ...gate, requireTests: true }, 0, TESTQUICK_ZERO)).toBe("failed");
    // testQuick's line is no proof that the build holds no test.
    expect(noTestsCollected(TESTQUICK_ZERO)).toBe(false);
  });

  test("an sbt 1 build keeps test, narrowed the same way", () => {
    const root = project({ ...PAIRWICK, "project/build.properties": "sbt.version=1.10.11\n" });
    const gates = detectGates(root).map((s) => s.check);
    expect(gates.map((c) => c.args.join(" "))).toEqual(["-batch test"]);
    expect(affectedTestCheck(gates, [SUITE])?.args).toEqual(["-batch", "testOnly *XTests"]);
  });
});

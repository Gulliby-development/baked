import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isTestContent, isTestFile } from "../src/core/intelligence/language-traits.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { preexistingTest, testWriteProblems } from "../src/core/workflows/test-integrity.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { Check, ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// R57 modeplan (#1848): the brief prescribes `src/Modeplan/Match/PermTest.cs`, a stub of the
// `find -perm` test. The C# name rule `Tests?\.cs$` made it a pre-existing read-only test: the
// plan that modified it was rejected (219,915 tokens for the plan stage) and the planner had to
// write a reason calling production code a justified test change.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const STUB = "// Match: the -perm test of find; implement in the match feature.\nnamespace Modeplan.Match;\n\npublic static class PermTest\n{\n}\n";

// Per language: a domain file named like a test, and a real test with the same kind of name.
const CASES: [language: string, source: [string, string], test: [string, string]][] = [
  ["csharp", ["src/Modeplan/Match/PermTest.cs", STUB], ["src/Modeplan/Match/PermTest.cs", "using Xunit;\npublic class PermTest { [Fact] public void Matches() {} }\n"]],
  ["java", ["src/main/java/app/PermTest.java", "package app;\npublic final class PermTest {}\n"], ["src/main/java/app/PermTest.java", "import org.junit.jupiter.api.Test;\nclass PermTest { @Test void matches() {} }\n"]],
  ["kotlin", ["src/main/kotlin/FeatureSpec.kt", "data class FeatureSpec(val name: String)\n"], ["src/main/kotlin/FeatureSpec.kt", "import kotlin.test.Test\nclass FeatureSpec { @Test fun works() {} }\n"]],
  ["scala", ["src/main/scala/AbSuite.scala", "final case class AbSuite(arms: Int)\n"], ["src/main/scala/AbSuite.scala", "class AbSuite extends munit.FunSuite { test(\"x\") {} }\n"]],
  ["php", ["src/PermTest.php", "<?php\nfinal class PermTest {}\n"], ["src/PermTest.php", "<?php\nuse PHPUnit\\Framework\\TestCase;\nfinal class PermTest extends TestCase {}\n"]],
  ["swift", ["Sources/App/PermTest.swift", "struct PermTest {}\n"], ["Sources/App/PermTest.swift", "import XCTest\nfinal class PermTest: XCTestCase {}\n"]],
  ["objc", ["Sources/PermTests.m", "@implementation PermTests\n@end\n"], ["Sources/PermTests.m", "#import <XCTest/XCTest.h>\n@interface PermTests : XCTestCase\n@end\n"]],
  ["rust", ["src/perm_test.rs", "pub fn perm() {}\n"], ["src/perm_test.rs", "#[test]\nfn perm() {}\n"]],
  ["python", ["app/perm_test.py", "def perm(mode):\n    return mode\n"], ["app/perm_test.py", "def test_perm():\n    assert True\n"]],
  ["c", ["src/perm_test.c", "int perm(int mode) { return mode; }\n"], ["src/perm_test.c", "#include <assert.h>\nint main(void) { assert(1); }\n"]],
  ["cpp", ["src/perm_test.cpp", "int perm(int mode) { return mode; }\n"], ["src/perm_test.cpp", "#include <gtest/gtest.h>\nTEST(Perm, Works) {}\n"]],
  ["ruby", ["lib/perm_test.rb", "class PermTest; end\n"], ["lib/perm_test.rb", "require 'minitest/autorun'\nclass PermTest < Minitest::Test; end\n"]],
  ["dart", ["lib/perm_test.dart", "int perm(int mode) => mode;\n"], ["lib/perm_test.dart", "import 'package:test/test.dart';\nvoid main() { test('x', () {}); }\n"]],
  ["zig", ["src/perm_test.zig", "pub fn perm() void {}\n"], ["src/perm_test.zig", "test \"perm\" {}\n"]],
  ["lua", ["src/perm_spec.lua", "return { perm = function() end }\n"], ["src/perm_spec.lua", "describe('perm', function() it('works', function() end) end)\n"]],
  ["elixir", ["lib/perm_test.ex", "defmodule PermTest do\nend\n"], ["lib/perm_test.ex", "defmodule PermTest do\n  use ExUnit.Case\nend\n"]],
  ["bash", ["bin/perm_test.sh", "perm() { echo \"$1\"; }\n"], ["bin/perm_test.sh", "test_perm() { assertEquals 1 1; }\n. shunit2\n"]],
  ["rescript", ["src/PermTest.res", "let perm = mode => mode\n"], ["src/PermTest.res", "open Jest\ntest(\"perm\", () => ())\n"]],
];

describe("a source file named like a test is not a test (#1848)", () => {
  test.each(CASES)("%s: the name alone, the source and the real test", (_, [sourcePath, source], [testPath, real]) => {
    expect(isTestFile(sourcePath)).toBe(true);
    expect(isTestContent(sourcePath, source)).toBe(false);
    expect(isTestContent(testPath, real)).toBe(true);
    // A file that does not exist yet keeps the name rule.
    expect(isTestContent(sourcePath, null)).toBe(true);
  });

  test("test directories, test projects and the languages whose rule is the name stay tests", () => {
    expect(isTestContent("tests/App.Tests/PermTests.cs", "public class PermTests {}\n")).toBe(true);
    expect(isTestContent("src/App.Tests/Helper.cs", "class Helper {}\n")).toBe(true);
    expect(isTestContent("src/test/java/app/Fixtures.java", "class Fixtures {}\n")).toBe(true);
    expect(isTestContent("pkg/perm_test.go", "package pkg\n")).toBe(true);
    expect(isTestContent("src/perm.test.ts", "export {};\n")).toBe(true);
    expect(isTestContent("test/Perm.t.sol", "contract X {}\n")).toBe(true);
  });

  function workspace(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "baked-1848-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }
  const task = (writes: Task["writes"]): Task => ({
    id: "T001", title: "Match", description: "Implement -perm", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [],
    profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required",
  });

  test("modeplan match: the plan that modifies the PermTest.cs stub without a reason is accepted; a real test still needs one", () => {
    const root = workspace({ "src/Modeplan/Match/PermTest.cs": STUB, "tests/Modeplan.Tests/PermTests.cs": "using Xunit;\npublic class PermTests { [Fact] public void A() {} }\n" });
    const stub = { tasks: [task([{ path: "src/Modeplan/Match/PermTest.cs", action: "modify" }])] };
    expect(preexistingTest("src/Modeplan/Match/PermTest.cs", stub.tasks, root)).toBe(false);
    expect(testWriteProblems(stub, {}, root)).toEqual([]);
    const real = { tasks: [task([{ path: "tests/Modeplan.Tests/PermTests.cs", action: "modify" }])] };
    expect(testWriteProblems(real, {}, root)).toHaveLength(1);
  });

  test("the written-tests check does not run a source file named like a test", () => {
    const root = workspace({ "src/Modeplan/Match/PermTest.cs": STUB, "tests/Modeplan.Tests/PermTests.cs": "using Xunit;\npublic class PermTests { [Fact] public void A() {} }\n", "tests/Modeplan.Tests/Modeplan.Tests.csproj": "<Project />\n" });
    const checks: Check[] = [{ id: "tests", command: { executable: "dotnet", args: ["test"] }, required: true, timeoutMs: 600_000 } as Check];
    expect(writtenTestsCheck(root, checks, [{ path: "src/Modeplan/Match/PermTest.cs", action: "modify" }])).toBeNull();
  });

  test("at run time the implementer may edit the PermTest.cs stub without a planned reason", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    mkdirSync(join(root, "src/Modeplan/Match"), { recursive: true });
    writeFileSync(join(root, "src/Modeplan/Match/PermTest.cs"), STUB);
    writeFileSync(join(root, "OldTest.cs"), "using Xunit;\npublic class OldTest { [Fact] public void A() {} }\n");
    const outcomes: string[] = [];
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "implementation" && !outcomes.length) {
        const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
        for (const path of ["src/Modeplan/Match/PermTest.cs", "OldTest.cs"]) {
          const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, task([{ path, action: "modify" }]));
          try {
            guard.validate("edit_file", { path });
            outcomes.push(`${path}: allowed`);
          } catch (error) {
            outcomes.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return original(request);
    };
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await service.drive(run.runId, signal());
    expect(outcomes[0]).toBe("src/Modeplan/Match/PermTest.cs: allowed");
    expect(outcomes[1]).toStartWith("OldTest.cs: OldTest.cs is a test that existed before this run");
  }, 60000);
});

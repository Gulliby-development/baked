import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { isNoRow, type LanguageRecord, none, rowOf, SUPPORTED_LANGUAGES } from "../src/core/intelligence/language-records.js";
import { TEST_MARKERS } from "../src/core/intelligence/language-traits.js";
import { declaresTest, TEST_DECLARATIONS } from "../src/core/intelligence/test-declarations.js";
import { detectLanguageFromPath } from "../src/core/intelligence/types.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { isWrittenTestFile, writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import { hostApplyRecords } from "../src/core/workflows/host-apply.js";
import { suppliedDrifts } from "../src/core/workflows/supplied-drift.js";
import { PESTER_RUN } from "../src/core/workflows/pester.js";
import { testthatRun } from "../src/core/workflows/r-tools.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #2439, bench round 77 trailspin (Go, run 3144f113): T005 wrote `internal/cli/fixtures_test.go`,
// which the brief gave verbatim as one `const (...)` block, and the host wrote it. Its derived
// tests-written check ran `go test ./internal/cli`, which ran no test ("[no tests to run]"), and
// `requireTests` failed it; the package's tests came in T006-T009. The implementer session that
// followed (367k tokens) added `TestFixtureCallCounts` to the verbatim file, `supplied_drift`
// recorded the drift, and a convergence task (674k) put the file back. A test-tree file that
// declares no test is now a support file: the written-tests check leaves it out.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-support-file-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const check = (executable: string, args: string[]): Check => ({ id: "tests", executable, args, cwd: ".", timeoutMs: 300_000, required: true, scope: "feature", envNames: [], writes: [] });

/**
 * One case per supported language (#2439): a test-tree file that declares no test, and one that
 * declares a test, with the project's test check where a written-tests runner takes the language's
 * files. A language whose `TEST_DECLARATIONS` or `TEST_MARKERS` row has data needs a case here.
 */
interface SupportCase {
  support: [path: string, text: string];
  test: [path: string, text: string];
  run?: Check;
}

const SUPPORT_CASES: LanguageRecord<SupportCase> = {
  typescript: {
    support: ["tests/trace.test.ts", 'export const TRACE = "call";\n'],
    test: ["tests/sum.test.ts", 'import { expect, test } from "bun:test";\n\ntest("adds", () => expect(1 + 2).toBe(3));\n'],
    run: check("bun", ["test"]),
  },
  javascript: {
    support: ["__tests__/helpers.js", "export const trace = (name) => `call ${name}`;\n"],
    test: ["__tests__/sum.test.js", 'import { expect, it } from "vitest";\n\nit("adds", () => expect(1 + 2).toBe(3));\n'],
    run: check("npx", ["vitest", "run"]),
  },
  python: {
    support: ["tests/test_fixtures.py", 'import pytest\n\n\n@pytest.fixture\ndef trace():\n    return "call"\n'],
    test: ["tests/test_sum.py", "def test_adds():\n    assert 1 + 2 == 3\n"],
    run: check("python3", ["-m", "pytest", "-q"]),
  },
  go: {
    support: ["internal/cli/fixtures_test.go", 'package cli_test\n\nconst (\n\ttraceCall = "call"\n\ttraceDone = "done"\n)\n'],
    test: ["internal/cli/cli_test.go", 'package cli_test\n\nimport "testing"\n\nfunc TestRun(t *testing.T) {}\n'],
    run: check("go", ["test", "./..."]),
  },
  rust: {
    support: ["tests/common.rs", "pub const TRACE: &str = \"call\";\n"],
    test: ["tests/sum.rs", "#[test]\nfn adds() {\n    assert_eq!(1 + 2, 3);\n}\n"],
    run: check("cargo", ["test"]),
  },
  java: {
    // A framework import alone is no test.
    support: ["src/test/java/com/ex/Fixtures.java", "package com.ex;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nfinal class Fixtures {\n    static void same(int a, int b) { assertEquals(a, b); }\n}\n"],
    test: ["src/test/java/com/ex/SumTest.java", "package com.ex;\n\nimport org.junit.jupiter.api.Test;\n\nclass SumTest {\n    @Test\n    void adds() {}\n}\n"],
    run: check("mvn", ["-B", "test"]),
  },
  kotlin: {
    support: ["src/test/kotlin/com/ex/Fixtures.kt", "package com.ex\n\nobject Fixtures {\n    const val TRACE = \"call\"\n}\n"],
    test: ["src/test/kotlin/com/ex/SumTest.kt", "package com.ex\n\nimport kotlin.test.Test\n\nclass SumTest {\n    @Test\n    fun adds() {}\n}\n"],
    run: check("gradle", ["test"]),
  },
  scala: {
    support: ["src/test/scala/Fixtures.scala", "object Fixtures {\n  val Trace = \"call\"\n}\n"],
    test: ["src/test/scala/SumSuite.scala", "class SumSuite extends munit.FunSuite {\n  test(\"adds\") { assertEquals(1 + 2, 3) }\n}\n"],
    run: check("sbt", ["test"]),
  },
  csharp: {
    support: ["Calc.Tests/Fixtures.cs", "namespace Calc.Tests;\n\npublic static class Fixtures\n{\n    public const string Trace = \"call\";\n}\n"],
    test: ["Calc.Tests/SumTests.cs", "namespace Calc.Tests;\n\npublic class SumTests\n{\n    [Fact]\n    public void Adds() { }\n}\n"],
    run: check("dotnet", ["test"]),
  },
  c: {
    support: ["tests/fixtures.c", "static const char *TRACE = \"call\";\n"],
    test: ["tests/test_sum.c", "void test_adds(void) {\n    TEST_ASSERT_EQUAL(3, 1 + 2);\n}\n"],
  },
  cpp: {
    support: ["tests/fixtures.cpp", "static const char *kTrace = \"call\";\n"],
    test: ["tests/sum_test.cpp", "#include <gtest/gtest.h>\n\nTEST(Sum, Adds) { EXPECT_EQ(1 + 2, 3); }\n"],
  },
  ruby: {
    support: ["test/test_helper.rb", 'require "minitest/autorun"\nrequire_relative "../lib/calc"\n'],
    test: ["test/sum_test.rb", "class SumTest < Minitest::Test\n  def test_adds\n    assert_equal 3, 1 + 2\n  end\nend\n"],
    run: check("bundle", ["exec", "rake", "test"]),
  },
  php: {
    support: ["tests/BaseTest.php", "<?php\n\nabstract class BaseTest extends \\PHPUnit\\Framework\\TestCase\n{\n    protected const TRACE = 'call';\n}\n"],
    test: ["tests/SumTest.php", "<?php\n\nfinal class SumTest extends BaseTest\n{\n    public function testAdds(): void\n    {\n        $this->assertSame(3, 1 + 2);\n    }\n}\n"],
    run: check("php", ["vendor/bin/phpunit", "tests"]),
  },
  swift: {
    support: ["Tests/CalcTests/Fixtures.swift", "let trace = \"call\"\n"],
    test: ["Tests/CalcTests/SumTests.swift", "import XCTest\n\nfinal class SumTests: XCTestCase {\n    func testAdds() {}\n}\n"],
  },
  lua: {
    support: ["spec/fixtures_spec.lua", "return { trace = \"call\" }\n"],
    test: ["spec/sum_spec.lua", "describe(\"sum\", function()\n  it(\"adds\", function() end)\nend)\n"],
    run: check("busted", []),
  },
  elixir: {
    support: ["test/fixtures_test.exs", "defmodule Fixtures do\n  def trace, do: \"call\"\nend\n"],
    test: ["test/sum_test.exs", "defmodule SumTest do\n  use ExUnit.Case\n\n  test \"adds\" do\n    assert 1 + 2 == 3\n  end\nend\n"],
    run: check("mix", ["test"]),
  },
  dart: {
    support: ["test/fixtures_test.dart", "const trace = 'call';\n"],
    test: ["test/sum_test.dart", "import 'package:test/test.dart';\n\nvoid main() {\n  test('adds', () => expect(1 + 2, 3));\n}\n"],
    run: check("dart", ["test"]),
  },
  zig: {
    support: ["src/fixtures_test.zig", "pub const trace = \"call\";\n"],
    test: ["src/sum_test.zig", "const std = @import(\"std\");\n\ntest \"adds\" {\n    try std.testing.expect(1 + 2 == 3);\n}\n"],
  },
  bash: {
    support: ["test/helpers.bats", "load_trace() {\n  echo call\n}\n"],
    test: ["test/sum.bats", "@test \"adds\" {\n  [ \"$((1 + 2))\" -eq 3 ]\n}\n"],
    run: check("bats", ["test"]),
  },
  ocaml: {
    support: ["test/fixtures.ml", "let trace = \"call\"\n"],
    test: ["test/test_sum.ml", "let () = Alcotest.run \"sum\" [ (\"sum\", [ Alcotest.test_case \"adds\" `Quick (fun () -> ()) ]) ]\n"],
  },
  objc: {
    support: ["Tests/Fixtures.m", "static NSString *const Trace = @\"call\";\n"],
    test: ["Tests/SumTests.m", "#import <XCTest/XCTest.h>\n\n@implementation SumTests\n- (void)testAdds {\n}\n@end\n"],
  },
  vue: none("Vue components are tested from `.spec.ts` or `.test.ts` files, which the TypeScript case covers"),
  svelte: none("Svelte components are tested from `.spec.ts` or `.test.ts` files, which the TypeScript case covers"),
  rescript: {
    support: ["__tests__/Fixtures_test.res", "let trace = \"call\"\n"],
    test: ["__tests__/Sum_test.res", "open Jest\n\ntest(\"adds\", () => Expect.expect(1 + 2)->Expect.toBe(3))\n"],
  },
  solidity: {
    support: ["test/Fixtures.t.sol", "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract Fixtures {\n    uint256 internal constant TRACE = 1;\n}\n"],
    test: ["test/Sum.t.sol", "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract SumTest {\n    function test_Adds() public {}\n}\n"],
  },
  // No declarations row: the `TEST_MARKERS` row decides.
  sql: {
    support: ["tests/fixtures.sql", "insert into trace (name) values ('call');\n"],
    test: ["tests/test_sum.sql", "select plan(1);\nselect ok(1 + 2 = 3);\n"],
  },
  powershell: {
    support: ["tests/Fixtures.Tests.ps1", "$Trace = 'call'\n"],
    test: ["tests/Sum.Tests.ps1", "Describe 'Sum' {\n    It 'adds' {\n        1 + 2 | Should -Be 3\n    }\n}\n"],
    run: check("pwsh", ["-NoProfile", "-Command", PESTER_RUN]),
  },
  r: {
    support: ["tests/testthat/test-fixtures.R", "trace <- \"call\"\n"],
    test: ["tests/testthat/test-sum.R", "test_that(\"adds\", {\n  expect_equal(1 + 2, 3)\n})\n"],
    run: check("Rscript", ["-e", testthatRun(false)]),
  },
};

describe("a test-tree file that declares no test is a support file, in every language (#2439)", () => {
  // A new language row of `TEST_DECLARATIONS` or `TEST_MARKERS` needs its support-file case.
  test("every language with a declarations or markers row has a case", () => {
    const missing = SUPPORTED_LANGUAGES.filter(
      (language) =>
        (rowOf(TEST_DECLARATIONS, language) || rowOf(TEST_MARKERS, language)) && isNoRow(SUPPORT_CASES[language]),
    );
    expect(missing).toEqual([]);
  });

  for (const language of SUPPORTED_LANGUAGES) {
    const cell = rowOf(SUPPORT_CASES, language);
    if (!cell) continue;
    test(`${language}: the support file is left out, and a file with a test keeps requireTests`, () => {
      const [supportPath, supportText] = cell.support;
      const [testPath, testText] = cell.test;
      expect(detectLanguageFromPath(supportPath)).toBe(language);
      expect(detectLanguageFromPath(testPath)).toBe(language);
      expect(declaresTest(supportPath, supportText)).toBe(false);
      expect(declaresTest(testPath, testText)).toBe(true);
      if (!cell.run) return;
      // The runner's own files: a written test file the check could run by its name.
      expect(isWrittenTestFile(supportPath)).toBe(true);
      expect(isWrittenTestFile(testPath)).toBe(true);
      const root = project({ [supportPath]: supportText, [testPath]: testText });
      const create = (path: string) => ({ path, action: "create" });
      // A task that writes only the support file gets no check that requires tests.
      expect(writtenTestsCheck(root, [cell.run], [create(supportPath)])).toBeNull();
      const written = writtenTestsCheck(root, [cell.run], [create(supportPath), create(testPath)]);
      expect(written).toMatchObject({ id: "tests-written", requireTests: true });
      // The check runs the test file, never the support file alone.
      const command = written?.args.join(" ") ?? "";
      const name = (path: string) => (path.split("/").pop() ?? "").replace(/\.\w+$/, "");
      if (language !== "go") expect(command).not.toContain(name(supportPath));
    });
  }
});

// The R77 shape through a run under `hostApply: "on"`: T001 is the brief's verbatim constants-only
// fixtures file, T002 writes the package's first test after it. T001 is settled before T002
// starts, so the run is stopped there: nothing in it needs a Go toolchain once the fixtures task
// derives no check, and without the fix its check fails whether `go` is installed or not.
const FIXTURES = 'package cli_test\n\nconst (\n\ttraceCall = "call"\n\ttraceDone = "done"\n)\n';
const DRIFTED = 'package cli_test\n\nimport (\n\t"strings"\n\t"testing"\n)\n\nconst (\n\ttraceCall = "call"\n\ttraceDone = "done"\n)\n\nfunc TestFixtureCallCounts(t *testing.T) {\n\tif !strings.HasPrefix(traceCall, "c") {\n\t\tt.Fatal(traceCall)\n\t}\n}\n';
const brief = ["Add the CLI's trace fixtures and test the CLI.", "", "Write `internal/cli/fixtures_test.go` as the whole file:", "", "```go internal/cli/fixtures_test.go", FIXTURES.trimEnd(), "```", ""].join("\n");

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "CLI", problem: "Untested CLI", outcome: "Tested CLI", inScope: ["CLI"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The CLI is tested", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the CLI", when: "its tests run", then: "they pass", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nFixtures, then tests.\n## Decisions\nDEC-001: FR-001 in internal/cli.\n## Components\ninternal/cli\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const planned = (id: string, path: string, dependsOn: string[]): Task => ({ id, title: `write ${path}`, description: `write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", "internal/cli/fixtures_test.go", []), planned("T002", "internal/cli/cli_test.go", ["T001"])];

class ScriptedExecutor implements AgentExecutor {
  attempts: string[] = [];
  /** The tree as T002's implementer found it. */
  atT002: string | null = null;
  constructor(
    private root: string,
    private stop: AbortController,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A Go CLI", facts: [], unknowns: [], constraints: [], suggestedScope: ["internal/cli"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const id = request.task?.id ?? "";
        const root = request.root ?? this.root;
        this.attempts.push(id);
        // As trailspin's T005 did when its check asked for a test: one goes into the verbatim file.
        if (request.task?.writes.some((w) => w.path.endsWith("fixtures_test.go"))) writeFileSync(join(root, "internal/cli/fixtures_test.go"), DRIFTED);
        if (id === "T002") {
          this.atT002 = root;
          this.stop.abort();
        }
        output = { schemaVersion: 1, taskId: id, outcome: "implemented", summary: "Wrote the file", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The tests pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: a host-written fixtures_test.go before the package's tests (#2439, R77 trailspin)", () => {
  test("no tests-written failure, no implementer session for the fixtures task, and supplied_drift stays quiet", async () => {
    const root = project({
      "go.mod": "module example.com/trailspin\n\ngo 1.21\n",
      "internal/cli/cli.go": 'package cli\n\n// Name is the CLI\'s first trace.\nfunc Name() string { return "call" }\n',
    });
    const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", hostApply: "on", checks: [check("go", ["test", "./..."])] };
    const stop = new AbortController();
    const executor = new ScriptedExecutor(root, stop);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: brief, ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    await service.drive(run.runId, stop.signal).catch(() => undefined);

    // The run reached T002, which starts after T001's checks.
    expect(executor.atT002).not.toBeNull();
    expect(service.store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("implemented");
    // The host wrote T001's file, and nothing ran or changed it after.
    expect(hostApplyRecords(service.store, run.runId).map((r) => [r.taskId, r.applied])).toEqual([["T001", true]]);
    expect(executor.attempts.filter((id) => id !== "T002")).toEqual([]);
    const tree = join(root, runRootPath(service.store, run.runId));
    const read = (path: string): string | null => {
      try {
        return readFileSync(join(tree, path), "utf8");
      } catch {
        return null;
      }
    };
    expect(read("internal/cli/fixtures_test.go")).toBe(FIXTURES);
    // No tests-written check ran for the fixtures file: it declares no test.
    expect(service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("checks/tests-written/"))).toEqual([]);
    const findings = service.store.findings(run.runId).map((f) => f.body_json);
    expect(findings.filter((f) => f.includes("tests-written") && f.includes("fixtures_test.go"))).toEqual([]);
    // What the checks stage's supplied_drift would-stop compares (#2380): the delivered file is the brief's.
    expect(suppliedDrifts(brief, hostApplyRecords(service.store, run.runId), { tasks }, read)).toEqual([]);
  });
});

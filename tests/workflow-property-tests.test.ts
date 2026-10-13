import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failedCheckFindings } from "../src/core/verification/convergence.js";
import {
  checkPropertyTests,
  counterexampleOf,
  hasPropertyTest,
  presetPropertyTests,
} from "../src/core/workflows/quality/properties.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

describe("property tests", () => {
  test("each ecosystem's property library is recognized in test files", () => {
    expect(hasPropertyTest("tests/a.test.ts", 'import fc from "fast-check";\nfc.assert(fc.property(fc.integer(), () => true));')).toBe(true);
    expect(hasPropertyTest("tests/test_a.py", "from hypothesis import given\n@given(st.integers())\ndef test_a(n): ...")).toBe(true);
    expect(hasPropertyTest("tests/a.rs", "proptest! { #[test] fn t(n in 0..10) {} }")).toBe(true);
    expect(hasPropertyTest("src/test/java/ATest.java", "@Property\nboolean holds(@ForAll int n) { return true; }")).toBe(true);
    expect(hasPropertyTest("a_test.go", "rapid.Check(t, func(t *rapid.T) {})")).toBe(true);
    expect(hasPropertyTest("tests/a.test.ts", 'expect(parse("1")).toBe(1);')).toBe(false);
    // The library of another language does not count.
    expect(hasPropertyTest("tests/a.test.ts", "@given(st.integers())")).toBe(false);
  });

  test("shrunk counterexamples are read from the test output", () => {
    expect(counterexampleOf("Property failed after 3 tests\n{ seed: 1 }\nCounterexample: [-0]\nShrunk 4 time(s)")).toBe("[-0]");
    expect(counterexampleOf("Falsifying example: test_parse(\n    s='-0',\n)\nAssertionError")).toBe("test_parse( s='-0', )");
    expect(counterexampleOf("thread panicked\nminimal failing input: n = -1")).toBe("n = -1");
    expect(counterexampleOf("1 fail")).toBeNull();
  });

  test("a failed check's finding carries the counterexample", () => {
    const [finding] = failedCheckFindings(
      { id: "unit" },
      "ev1",
      "1 fail\nCounterexample: [-0]\n",
      [],
      { requirementIds: ["FR-001"], criterionIds: ["AC-001"] },
      "Fix it.",
      () => "f1",
    );
    expect(finding?.impact).toContain("Property counterexample: [-0]");
  });

  test("a marked criterion needs a property in a test file of a task that covers it", () => {
    const tasks = [
      { criterionIds: ["AC-001"], writes: [{ path: "src/parse.ts", action: "create" }, { path: "tests/parse.test.ts", action: "create" }] },
      { criterionIds: ["AC-002"], writes: [{ path: "tests/other.test.ts", action: "create" }] },
    ];
    const files: Record<string, string> = {
      "tests/parse.test.ts": 'expect(parse("1")).toBe(1);',
      "tests/other.test.ts": 'import fc from "fast-check";',
    };
    const criteria = [{ id: "AC-001", property: "numbers" }, { id: "AC-002" }, { id: "AC-003", property: "strings" }];
    const result = checkPropertyTests("auto", criteria, tasks, (path) => files[path] ?? null);
    expect(result.criteria.map((c) => [c.id, c.status])).toEqual([
      ["AC-001", "missing"],
      ["AC-003", "missing"],
    ]);
    files["tests/parse.test.ts"] = 'import fc from "fast-check";\nfc.assert(fc.property(fc.double(), (n) => true));';
    expect(checkPropertyTests("auto", criteria.slice(0, 1), tasks, (path) => files[path] ?? null).criteria[0]?.status).toBe("found");
    expect([presetPropertyTests("quick"), presetPropertyTests("standard"), presetPropertyTests("full")]).toEqual(["off", "auto", "auto"]);
  });
});

describe("property tests in a run", () => {
  class ParsingExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "spec") {
        const result = await super.execute(request);
        return {
          ...result,
          output: { ...fixtureSpec, criteria: fixtureSpec.criteria.map((c) => ({ ...c, property: "numbers" })) },
        };
      }
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "tests/value.test.ts", action: "create" });
        return result;
      }
      if (request.profile.output === "implementation") {
        mkdirSync(join(this.dir, "tests"), { recursive: true });
        writeFileSync(
          join(this.dir, "tests/value.test.ts"),
          this.implementations++ === 0
            ? 'import { expect, test } from "bun:test";\ntest("value", () => expect(1).toBe(1));\n'
            : 'import fc from "fast-check";\nimport { test } from "bun:test";\ntest("value", () => fc.assert(fc.property(fc.double(), (n) => Object.is(n, n))));\n',
        );
      }
      return super.execute(request);
    }
  }

  test("a criterion marked as a property gets a property test before the run completes", async () => {
    const fixture = workflowFixture({ executor: (root) => new ParsingExecutor(root) });
    try {
      const { service, executor } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      expect(executor.prompts.spec?.[0]).toContain("Property-based tests are on");
      expect(executor.prompts.plan?.[0]).toContain("fast-check (JS/TS)");
      const findings = service.store.findings(run.runId).map((f) => ({ status: f.status, body: JSON.parse(f.body_json) }));
      const missing = findings.find((f) => String(f.body.claim).startsWith("Property test missing for AC-001: "));
      expect(missing?.body.file).toBe("tests/value.test.ts");
      expect(missing?.status).toBe("resolved");
      expect(runReport(service.store, run.runId)).toContain("Property-based tests: 1 of 1 marked criteria have one.");
    } finally {
      await fixture.dispose();
    }
  });
});

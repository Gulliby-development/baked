import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failedCheckFindings } from "../src/core/verification/convergence.js";
import {
  checkPropertyTests,
  counterexampleOf,
  hasPropertyTest,
  presetPropertyTests,
  propertyLibraries,
  propertyTestKind,
  propertyTestsNote,
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

describe("property tests without a library (#796)", () => {
  const SEEDED_PY = "import random\n\ndef test_round_trip():\n    rng = random.Random(1234)\n    for _ in range(200):\n        n = rng.randint(-10**9, 10**9)\n        assert parse(str(n)) == n\n";
  const SHIM_PY =
    "try:\n    from hypothesis import given, strategies as st\nexcept ImportError:\n    class _FallbackStrategies:\n        def integers(self):\n            return [0, 1, -1]\n    st = _FallbackStrategies()\n    def given(*a):\n        return lambda f: f\n\n@given(st.integers())\ndef test_parse(n):\n    assert parse(str(n)) == n\n";

  test("a seeded generator counts, a library behind a fallback never does", () => {
    expect(propertyTestKind("tests/test_parse.py", SEEDED_PY)).toBe("seeded");
    expect(propertyTestKind("tests/test_parse.py", SHIM_PY)).toBe("shim");
    expect(propertyTestKind("tests/test_parse.py", "from hypothesis import given\n@given(st.integers())\ndef test_a(n): ...")).toBe("library");
    expect(propertyTestKind("tests/a.test.ts", "const rng = mulberry32(42);\nfor (let i = 0; i < 500; i++) expect(f(rng())).toBe(true);")).toBe("seeded");
    expect(propertyTestKind("tests/a.test.ts", 'let fc; try { fc = require("fast-check"); } catch { fc = null; }')).toBe("shim");
    expect(propertyTestKind("tests/a.rs", "let mut rng = StdRng::seed_from_u64(7);\nfor _ in 0..200 { assert!(ok(rng.gen())); }")).toBe("seeded");
    expect(propertyTestKind("tests/a.test.ts", 'expect(parse("1")).toBe(1);')).toBeNull();
  });

  test("without a library a missing property is waived; a shim is always missing", () => {
    const tasks = [{ criterionIds: ["AC-001"], writes: [{ path: "src/parse.py", action: "create" }, { path: "tests/test_parse.py", action: "create" }] }];
    const criteria = [{ id: "AC-001", property: "numbers" }];
    const none = { "JS/TS": false, Python: false };
    const check = (content: string, libraries: Record<string, boolean>) =>
      checkPropertyTests("auto", criteria, tasks, () => content, libraries).criteria[0];
    expect(check("def test_parse():\n    assert parse('1') == 1\n", none)).toMatchObject({
      status: "waived",
      note: "no property library is installed for Python and no seeded property test was recognized",
    });
    expect(check(SEEDED_PY, none)).toMatchObject({ status: "found", tests: [{ file: "tests/test_parse.py", property: true, kind: "seeded" }] });
    expect(check(SHIM_PY, none)?.status).toBe("missing");
    expect(check(SHIM_PY, none)?.note).toContain("behind a fallback");
    expect(check("def test_parse():\n    assert parse('1') == 1\n", { Python: true })?.status).toBe("missing");
  });

  test("only installed or build-fetched libraries count, and the notes never ask for a dependency", () => {
    const files: Record<string, string> = {
      "Cargo.toml": '[dev-dependencies]\nproptest = "1"\n',
      "package.json": '{ "devDependencies": { "fast-check": "^3" } }',
      "App.Tests/App.Tests.csproj": '<PackageReference Include="FsCheck.Xunit" />',
    };
    const libraries = propertyLibraries({
      read: (path) => files[path] ?? null,
      exists: (path) => path in files,
      list: (dir) => (dir === "" ? ["Cargo.toml", "package.json", "App.Tests"] : dir === "App.Tests" ? ["App.Tests/App.Tests.csproj"] : []),
      pythonImports: () => false,
    });
    // fast-check is declared but not installed: the checks would not find it.
    expect(libraries).toEqual({ "JS/TS": false, Python: false, Rust: true, "Java/Kotlin": false, Go: true, "C#/F#": true });
    const plan = propertyTestsNote("plan", libraries) ?? "";
    expect(plan).toContain("proptest (Rust)");
    expect(plan).toContain("library-free property test");
    expect(plan).toContain("Do not add a dependency");
    expect(plan).not.toContain("development dependency");
    expect(propertyTestsNote("implementation", { "JS/TS": true }) ?? "").toContain("fast-check (JS/TS)");
  });

  test("Python is started only for a project with Python in it", () => {
    const asked: string[] = [];
    const probe = (entries: string[]) =>
      propertyLibraries({
        read: () => null,
        exists: (path) => entries.includes(path),
        list: (dir) => (dir === "" ? entries : []),
        pythonImports: (module) => {
          asked.push(module);
          return true;
        },
      }).Python;
    expect(probe(["package.json", "src"])).toBe(false);
    expect(asked).toEqual([]);
    expect(probe(["pyproject.toml"])).toBe(true);
    expect(probe(["main.py"])).toBe(true);
    expect(asked).toEqual(["hypothesis", "hypothesis"]);
  });
});

describe("property tests in a run", () => {
  const LIBRARY_TEST = 'import fc from "fast-check";\nimport { test } from "bun:test";\ntest("value", () => fc.assert(fc.property(fc.double(), (n) => Object.is(n, n))));\n';
  class ParsingExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(
      private readonly dir: string,
      private readonly corrected = LIBRARY_TEST,
    ) {
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
            : this.corrected,
        );
      }
      return super.execute(request);
    }
  }

  test("a criterion marked as a property gets a property test before the run completes", async () => {
    const fixture = workflowFixture({
      executor: (root) => {
        // The project has fast-check installed, so the property is required.
        mkdirSync(join(root, "node_modules/fast-check"), { recursive: true });
        writeFileSync(join(root, "node_modules/fast-check/package.json"), '{ "name": "fast-check" }');
        return new ParsingExecutor(root);
      },
    });
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

  test("without a property library the gate never asks for one and the run completes", async () => {
    const fixture = workflowFixture({ executor: (root) => new ParsingExecutor(root, 'import { expect, test } from "bun:test";\ntest("value", () => expect(1).toBe(1));\n') });
    try {
      const { service, executor } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      expect(executor.prompts.plan?.[0]).toContain("library-free property test");
      expect(executor.prompts.plan?.[0]).not.toContain("development dependency");
      const claims = service.store.findings(run.runId).map((f) => String(JSON.parse(f.body_json).claim));
      expect(claims.some((c) => c.startsWith("Property test missing"))).toBe(false);
      expect(runReport(service.store, run.runId)).toContain("Property-based tests: 0 of 1 marked criteria have one; 1 waived because the project has no property library.");
      expect(existsSync(join(fixture.root, "node_modules"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});

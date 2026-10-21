import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  asksPropertyTests,
  propertyRepository,
  propertyTestsNote,
  propertyTestsOf,
  QUALITY_PROPERTY_REPOSITORY,
  repositoryDeclinesPropertyTests,
} from "../src/core/workflows/quality/properties.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 58, jsonsplice-update db1f009e (#1872): property tests were on by preset, the spec
// author marked three fixed Input | Expected tables `property`, and the plan and the property
// check made the run add two seeded 100-value PRNG loops to a repository whose tests have none,
// although the brief listed the six tests it wanted.

const plain: Record<string, string> = {
  "tests/steps.test.ts": 'import { expect, test } from "bun:test";\ntest("steps", () => expect(1).toBe(1));\n',
  "tests/test_tags.py": "def test_tags():\n    assert 1 == 1\n",
  "tests/steps.rs": "#[test]\nfn steps() { assert_eq!(1, 1); }\n",
  "src/test/java/StepsTest.java": "class StepsTest { @Test void steps() { assertEquals(1, 1); } }\n",
  "steps_test.go": 'package steps\n\nimport "testing"\n\nfunc TestSteps(t *testing.T) { if 1 != 1 { t.Fatal("x") } }\n',
  "tests/StepsTests.cs": "public class StepsTests { [Fact] public void Steps() { Assert.Equal(1, 1); } }\n",
};
const property: Record<string, string> = {
  "tests/steps.test.ts": 'import fc from "fast-check";\nfc.assert(fc.property(fc.integer(), (n) => n === n));\n',
  "tests/test_tags.py": "from hypothesis import given\n\n@given(st.integers())\ndef test_tags(n):\n    assert n == n\n",
  "tests/steps.rs": "proptest! { #[test] fn steps(n in 0u32..) { prop_assert_eq!(n, n); } }\n",
  "src/test/java/StepsTest.java": "class StepsTest { @Property void steps(@ForAll int n) {} }\n",
  "steps_test.go": "package steps\n\nfunc TestSteps(t *testing.T) { rapid.Check(t, func(t *rapid.T) {}) }\n",
  "tests/StepsTests.cs": "public class StepsTests { [Property] public bool Steps(int n) => n == n; }\n",
};

describe("property tests in an existing repository (#1872)", () => {
  const repo = (files: Record<string, string>) => propertyRepository(Object.keys(files), (path) => files[path] ?? null);

  for (const path of Object.keys(plain))
    test(`${path}: tests without a property test decline the preset's mode; a property test keeps it`, () => {
      const without = repo({ [path]: plain[path] ?? "", "src/steps.ts": "export {}" });
      expect(without).toEqual({ testFiles: 1, propertyTests: [] });
      expect(repositoryDeclinesPropertyTests(without, { Go: true }, "Add negative indexes")).toBe(true);
      expect(propertyTestsOf({}, "standard", "Add negative indexes", { repository: without, libraries: { Go: true } })).toBe("off");
      const withProperty = repo({ [path]: property[path] ?? "" });
      expect(withProperty.propertyTests).toEqual([path]);
      expect(propertyTestsOf({}, "standard", "Add negative indexes", { repository: withProperty })).toBe("auto");
    });

  test("a new project, an installed library, the request and the policy keep the mode", () => {
    const tests = repo(plain);
    expect(propertyTestsOf({}, "standard", "x", { repository: { testFiles: 0, propertyTests: [] } })).toBe("auto");
    expect(propertyTestsOf({}, "standard", "x", { repository: null })).toBe("auto");
    expect(propertyTestsOf({}, "standard", "x", { repository: tests, libraries: { "JS/TS": true } })).toBe("auto");
    expect(propertyTestsOf({}, "standard", "Add property-based tests for the parser", { repository: tests })).toBe("auto");
    expect(propertyTestsOf({ propertyTests: "auto" }, "standard", "x", { repository: tests })).toBe("auto");
    expect(propertyTestsOf({}, "quick", "x", { repository: { testFiles: 0, propertyTests: [] } })).toBe("off");
    expect(asksPropertyTests("Cover the parser with a Hypothesis test")).toBe(true);
    expect(asksPropertyTests("No property-based tests, plain examples")).toBe(false);
    expect(asksPropertyTests("Tests: steps 3, read 1, info 1, write 1")).toBe(false);
  });

  test("the spec author leaves fixed tables of inputs and outputs unmarked", () => {
    expect(propertyTestsNote("spec")).toContain("a fixed table of inputs and expected outputs");
  });
});

describe("property tests in an update run (#1872)", () => {
  class MarkingExecutor extends FixtureExecutor {
    override async execute(request: ExecutionRequest) {
      const result = await super.execute(request);
      if (request.profile.output === "spec")
        return { ...result, output: { ...fixtureSpec, criteria: fixtureSpec.criteria.map((c) => ({ ...c, property: "parsing" })) } };
      return result;
    }
  }
  async function run(files: Record<string, string>) {
    const fixture = workflowFixture({
      executor: (root) => {
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), content);
        }
        return new MarkingExecutor(root);
      },
    });
    const { service, executor } = fixture;
    const started = await fixture.start();
    await service.drive(started.runId, new AbortController().signal);
    await fixture.approve(started.runId);
    const done = await service.drive(started.runId, new AbortController().signal);
    const kept = service.store.latestArtifact(started.runId, QUALITY_PROPERTY_REPOSITORY);
    const claims = service.store.findings(started.runId).map((f) => String(JSON.parse(f.body_json).claim));
    const result = {
      status: done.status,
      spec: executor.prompts.spec?.[0] ?? "",
      plan: executor.prompts.plan?.[0] ?? "",
      missing: claims.filter((c) => c.startsWith("Property test missing")),
      repository: kept ? JSON.parse(service.store.readArtifact(started.runId, kept.id)) : null,
    };
    await fixture.dispose();
    return result;
  }

  test("a repository whose tests have no property test gets no property note and no property finding", async () => {
    const result = await run({ "tests/steps.test.ts": plain["tests/steps.test.ts"] ?? "" });
    expect(result.status).toBe("completed");
    expect(result.repository).toEqual({ testFiles: 1, propertyTests: [] });
    expect(result.spec).not.toContain("Property-based tests are on");
    expect(result.plan).not.toContain("Property-based tests are on");
    expect(result.missing).toEqual([]);
  });

  test("a repository with a seeded property test keeps them on", async () => {
    const seeded = 'import { test } from "bun:test";\nlet seed = 7;\ntest("p", () => { for (let i = 0; i < 100; i++) seed = Math.imul(seed, 1664525) + 1013904223; });\n';
    const result = await run({ "tests/steps.test.ts": seeded });
    expect(result.repository).toEqual({ testFiles: 1, propertyTests: ["tests/steps.test.ts"] });
    expect(result.spec).toContain("Property-based tests are on");
    expect(result.plan).toContain("Property-based tests are on");
  });
});

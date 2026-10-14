import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bansPropertyTests, propertyTestKind } from "../src/core/workflows/quality/properties.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 21, cidrfold-update 8bd22457 (#1064). The brief says "plain tests, no
// fuzzing, no random numbers"; the spec marked criteria `property` and the tests enumerate a
// bounded domain without a random generator. The property gate saw no ban and recognized no
// property test, so three corrective tasks (693k tokens) asked for a seeded generator the brief
// forbids, and the run stopped no_progress with every check green.

const EXAMPLE_TEST = 'import { expect, test } from "bun:test";\ntest("value", () => expect(1).toBe(1));\n';
const EXHAUSTIVE_TEST =
  'import { expect, test } from "bun:test";\ntest("value holds for every mask", () => {\n  for (let mask = 0; mask < 256; mask++) expect(mask & 0xff).toBe(mask);\n});\n';

class PropertyExecutor extends FixtureExecutor {
  constructor(
    private readonly dir: string,
    private readonly testFile: string,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") {
      const result = await super.execute(request);
      // The spec author marks the criterion either way, as the claude series did.
      return { ...result, output: { ...fixtureSpec, criteria: fixtureSpec.criteria.map((c) => ({ ...c, property: "numbers" })) } };
    }
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/value.test.ts", action: "create" });
      return result;
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(this.dir, "tests"), { recursive: true });
      writeFileSync(join(this.dir, "tests/value.test.ts"), this.testFile);
    }
    return super.execute(request);
  }
}

async function run(prompt: string, testFile: string) {
  const fixture = workflowFixture({
    executor: (root) => {
      // A property library is available, as testing/quick always is for Go: the gate is on.
      mkdirSync(join(root, "node_modules/fast-check"), { recursive: true });
      writeFileSync(join(root, "node_modules/fast-check/package.json"), '{ "name": "fast-check" }');
      return new PropertyExecutor(root, testFile);
    },
  });
  const { service } = fixture;
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy: fixture.policy });
  await service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  const done = await service.drive(started.runId, new AbortController().signal);
  const claims = service.store.findings(started.runId).map((f) => String(JSON.parse(f.body_json).claim));
  const row = service.store.run(started.runId);
  await fixture.dispose();
  return { done, claims, correctives: row.corrective_tasks };
}

describe("scenario: cidrfold-update 8bd22457, a property gate against a ban on random input (#1064)", () => {
  test("a request without random numbers turns the gate off and the run completes", async () => {
    const { done, claims, correctives } = await run(
      "Create ready value. Add no test library (plain tests, no fuzzing, no random numbers).",
      EXAMPLE_TEST,
    );
    expect(done.status).toBe("completed");
    expect(claims.some((c) => c.startsWith("Property test missing"))).toBe(false);
    expect(correctives).toBe(0);
  });

  test("an exhaustive loop over a bounded domain is a property test", async () => {
    const { done, claims, correctives } = await run("Create ready value", EXHAUSTIVE_TEST);
    expect(done.status).toBe("completed");
    expect(claims.some((c) => c.startsWith("Property test missing"))).toBe(false);
    expect(correctives).toBe(0);
  });
});

describe("bans on random input (#1064)", () => {
  test("are bans on property tests", () => {
    for (const request of [
      "Add no test library (plain `testing` tests, no fuzzing, no random numbers).",
      "Tests use no random inputs.",
      "Do not use random numbers in tests.",
      "Deterministic tests only.",
      "Write only deterministic tests.",
      "No randomness in the test suite.",
    ])
      expect(bansPropertyTests(request)).toBe(true);
  });
  test("a random value of the feature is not a ban", () => {
    for (const request of [
      "Do not pick a random port; use 8080.",
      "Generate a random ID for each item.",
      "Create the ready value in value.txt.",
    ])
      expect(bansPropertyTests(request)).toBe(false);
  });
  test("a bounded loop counts, a short one does not", () => {
    expect(propertyTestKind("count_test.go", "func TestCount(t *testing.T) {\n\tfor mask := 0; mask < 256; mask++ {\n\t\tcheck(t, mask)\n\t}\n}\n")).toBe("exhaustive");
    expect(propertyTestKind("count_test.go", "func TestCount(t *testing.T) {\n\tfor i := 0; i < 3; i++ {\n\t\tcheck(t, i)\n\t}\n}\n")).toBeNull();
    expect(propertyTestKind("count_test.go", "func TestCount(t *testing.T) {\n\tfor _, c := range cases {\n\t\tcheck(t, c)\n\t}\n}\n")).toBeNull();
  });
});

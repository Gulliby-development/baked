import { afterEach, expect, test } from "bun:test";
import { clearBoundaryProperties, ownsNoTests } from "../src/core/verification/initiative-ownership.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest, RuntimeState } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 59, wheeltags (#1891): names and targets own no test path (their tests belong to a
// check-only feature, `testedBy`). Their spec authors marked literal-table criteria `property`,
// and the host refused the whole spec after it was written: three calls for names (112k tokens,
// 305 s) and two for targets, at the head of the initiative's critical path.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const bounds = (paths: string[]): NonNullable<RuntimeState["initiativeBounds"]> => ({
  featureId: "fixture",
  features: [
    { id: "fixture", scope: "The value", paths, testedBy: "checks" },
    { id: "checks", scope: "Acceptance tests", paths: ["tests/**"] },
  ],
});

class MarkingExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "spec")
      return { ...result, output: { ...fixtureSpec, criteria: fixtureSpec.criteria.map((c) => ({ ...c, property: "parsing" })) } };
    return result;
  }
}

async function run(paths: string[]) {
  const fixture = workflowFixture({ executor: (root) => new MarkingExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: fixture.policy, initiativeBounds: bounds(paths) });
  await service.drive(started.runId, new AbortController().signal);
  const spec = service.store.state(started.runId).spec;
  const diagnostic = service.store.latestArtifact(started.runId, "spec-repairs/boundary-property.json");
  return {
    specCalls: executor.prompts.spec?.length ?? 0,
    specPrompt: executor.prompts.spec?.[0] ?? "",
    properties: spec?.criteria.map((c) => c.property ?? null) ?? [],
    cleared: diagnostic ? JSON.parse(service.store.readArtifact(started.runId, diagnostic.id)).cleared : null,
  };
}

test("a feature that owns no test path keeps its spec, with the property flags cleared, in one call", async () => {
  const result = await run(["value.txt", "src/wheeltags/names.py"]);
  expect(result.specCalls).toBe(1);
  expect(result.properties).toEqual([null]);
  expect(result.cleared).toEqual(["AC-001"]);
  expect(result.specPrompt).not.toContain("Property-based tests are on");
});

test("a feature that owns a test path keeps its property criteria", async () => {
  const result = await run(["value.txt", "tests/**"]);
  expect(result.specCalls).toBe(1);
  expect(result.properties).toEqual(["parsing"]);
  expect(result.cleared).toBeNull();
});

test("clearBoundaryProperties changes only a feature without a test path", () => {
  const spec: Spec = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, property: "invariant" }] };
  expect(ownsNoTests(bounds(["src/names.py"]))).toBe(true);
  expect(ownsNoTests(bounds(["src/names.py", "tests/**"]))).toBe(false);
  expect(ownsNoTests(null)).toBe(false);
  expect(clearBoundaryProperties(spec, bounds(["src/names.py"])).spec.criteria[0]?.property).toBeUndefined();
  expect(clearBoundaryProperties(spec, bounds(["src/names.py", "tests/**"])).cleared).toEqual([]);
  expect(clearBoundaryProperties(spec, null).spec).toBe(spec);
});

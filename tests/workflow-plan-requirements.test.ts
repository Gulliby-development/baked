import { afterEach, describe, expect, test } from "bun:test";
import { withDerivedRequirements } from "../src/core/workflows/plan-consistency.js";
import { validateTaskGraph, type Spec, type Task, type TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec: Spec = {
  ...fixtureSpec,
  requirements: [2, 3, 4].map((n) => ({
    id: `FR-00${n}`, text: `Requirement ${n}`, priority: "must" as const, verification: "automated" as const, sourceRefs: [],
  })),
  criteria: [
    { id: "AC-005", requirementIds: ["FR-002", "FR-004"], given: "g", when: "w", then: "t", method: "automated" },
    { id: "AC-006", requirementIds: ["FR-003"], given: "g", when: "w", then: "t", method: "automated" },
  ],
};
const task = (overrides: Partial<Task>): Task => ({
  id: "T002", title: "t", description: "d", requirementIds: ["FR-003"], criterionIds: ["AC-005"], dependsOn: [],
  profileId: "implementer", writes: [], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "r", ...overrides,
});
const graph = (tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });

describe("requirement ids of a planned task", () => {
  test("follow from its criteria, so the planner's mismatch is no longer a rejection", () => {
    const planned = graph([task({})]);
    // R7 keeplint: "AC-005 verifies FR-002, FR-004, but T002 lists FR-003".
    expect(validateTaskGraph(spec, planned).some((e) => e.startsWith("criterion mapping mismatch"))).toBe(true);
    const derived = withDerivedRequirements(spec, planned);
    expect(derived.tasks[0]?.requirementIds).toEqual(["FR-003", "FR-002", "FR-004"]);
    expect(validateTaskGraph(spec, derived).filter((e) => e.startsWith("criterion mapping mismatch"))).toEqual([]);
  });

  test("an id the spec lacks is dropped and a task without criteria is left alone", () => {
    const derived = withDerivedRequirements(spec, graph([task({ requirementIds: ["FR-404"], criterionIds: ["AC-006"] }), task({ id: "T003", criterionIds: [], requirementIds: ["FR-404"] })]));
    expect(derived.tasks[0]?.requirementIds).toEqual(["FR-003"]);
    expect(derived.tasks[1]?.requirementIds).toEqual(["FR-404"]);
  });
});

describe("a plan whose requirement ids disagree with its criteria (scheduler)", () => {
  class MismatchedPlan extends FixtureExecutor {
    plans = 0;
    override async execute(request: ExecutionRequest) {
      const result = await super.execute(request);
      if (request.profile.output !== "plan") return result;
      this.plans++;
      const plan = result.output as { taskGraph: { tasks: { requirementIds: string[] }[] } };
      for (const t of plan.taskGraph.tasks) t.requirementIds = ["FR-404"];
      return result;
    }
  }

  test("is accepted at the first submission with the ids derived by the host", async () => {
    const fixture = workflowFixture({ executor: (root) => new MismatchedPlan(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    expect((fixture.executor as MismatchedPlan).plans).toBe(1);
    const tasks = fixture.service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as Task);
    expect(tasks[0]?.requirementIds).toEqual(["FR-001"]);
  });
});

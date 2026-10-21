import { afterEach, describe, expect, test } from "bun:test";
import { rowPlanProblems, withoutRowsWhenOff } from "../src/core/workflows/acceptance-rows.js";
import type { Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of the 2026-10-21 smoke, py-durfmt on `quick` (#1816). Rows as data was off, so the
// planner was never told about rows and rowTest, but the task schema it fills has them; it set both
// on T001. The host rejected the plan twice with 'acceptance rows require rowsAsData: "on"', a
// setting the planner cannot change, the planner resubmitted the same graph, and the run blocked
// invalid_output after 180,900 tokens.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const ROWS = { rows: ["AC-001"], rowTest: { framework: "pytest", harness: "tests/test_durfmt.py", test: "tests/test_durfmt.py", data: "tests/test_durfmt.py" } };

describe("scenario: py-durfmt quick, a plan with rows while rows as data is off (#1816)", () => {
  for (const workflowId of ["quick", "sdd"])
    test(`${workflowId}: the host drops the fields, the plan goes to approval, and the run completes`, async () => {
      const fixture = workflowFixture({ policy: fixturePolicy });
      cleanups.push(fixture.dispose);
      const { service, executor } = fixture;
      const original = executor.execute.bind(executor);
      let plans = 0;
      executor.execute = async (request: ExecutionRequest) => {
        const out = await original(request);
        if (request.profile.output === "plan") {
          plans++;
          const graph = (out.output as { taskGraph: { tasks: Record<string, unknown>[] } }).taskGraph;
          graph.tasks = graph.tasks.map((task, i) => (i === 0 ? { ...task, ...ROWS } : task));
        }
        return out;
      };
      const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt: "Create ready value", ownerLabel: "test", policy: fixturePolicy });
      let current = await service.drive(run.runId, signal());
      for (let i = 0; i < 5 && current.status !== "completed" && current.status !== "blocked"; i++) {
        const pending = service.store.requests(run.runId).find((r) => r.status === "pending");
        if (pending?.kind !== "approval") break;
        await fixture.approve(run.runId);
        current = await service.drive(run.runId, signal());
      }
      expect(plans).toBe(1);
      expect(current.status).toBe("completed");
      const graph = service.store.state(run.runId).graph as TaskGraph;
      expect(graph.tasks.every((t) => t.rows === undefined && t.rowTest === undefined)).toBe(true);
      const edits = JSON.parse(service.store.readArtifact(run.runId, service.store.latestArtifact(run.runId, "host-edits.json")!.id)) as { kind: string; field: string; before: unknown }[];
      expect(edits.filter((e) => e.kind === "acceptance-rows-off").map((e) => [e.field, e.before])).toEqual([
        ["rows", ROWS.rows],
        ["rowTest", ROWS.rowTest],
      ]);
    }, 90_000);
});

describe("rows and rowTest with rows as data off (#1816)", () => {
  const task = { id: "T001", criterionIds: ["AC-001"], writes: [], ...ROWS } as unknown as Task;
  const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "x", planHash: "y", tasks: [task] } as unknown as TaskGraph;

  test("the host drops them only when the policy has rows off", () => {
    expect(withoutRowsWhenOff(graph, fixturePolicy).tasks[0]).toMatchObject({ rows: undefined, rowTest: undefined });
    expect(withoutRowsWhenOff(graph, { ...fixturePolicy, rowsAsData: "on" })).toBe(graph);
  });

  test("a rejection, should one still be raised, says which fields to remove", () => {
    expect(rowPlanProblems(fixtureSpec, graph, fixturePolicy)).toEqual(["Task T001: remove rows and rowTest; acceptance rows are off for this run."]);
  });
});

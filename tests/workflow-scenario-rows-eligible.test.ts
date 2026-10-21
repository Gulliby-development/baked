import { afterEach, describe, expect, test } from "bun:test";
import { plannerRows, rowPlanProblems, rowsEligible, withoutRowsWhenOff } from "../src/core/workflows/acceptance-rows.js";
import type { RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 56, hdrlens with rowsAsData on (#1833). The planner was told about rows but not which
// criteria have a table the host reads; it marked rows on prose criteria in 3 of 9 features, and
// each of 4 plans was rejected with "need a complete Input | Expected table", one more planner step
// (25k to 40k tokens) to take the fields out. Those features had no JSON table at all.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
const on: RunPolicy = { ...fixturePolicy, rowsAsData: "on" };

const ROWS = { rows: ["AC-001"], rowTest: { mode: "inline", framework: "bun", test: "value.test.ts" } };

describe("scenario: hdrlens byterange, rows on a spec without a table (#1833)", () => {
  test("the planner is told nothing about rows, the host drops them, and the plan is not rejected", async () => {
    const fixture = workflowFixture({ policy: on });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const planInputs: string[] = [];
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "plan") {
        planInputs.push(request.prompt);
        const graph = (out.output as { taskGraph: { tasks: Record<string, unknown>[] } }).taskGraph;
        graph.tasks = graph.tasks.map((task, i) => (i === 0 ? { ...task, ...ROWS } : task));
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: on });
    await service.drive(run.runId, signal());
    expect(planInputs).toHaveLength(1);
    expect(planInputs[0]).not.toContain("Acceptance rows as data is enabled");
    expect(service.store.requests(run.runId).find((r) => r.status === "pending")?.kind).toBe("approval");
    const graph = service.store.state(run.runId).graph as TaskGraph;
    expect(graph.tasks.every((t) => t.rows === undefined && t.rowTest === undefined)).toBe(true);
  }, 90_000);
});

describe("criteria eligible for rows (#1833)", () => {
  const criterion = (id: string, then: string) => ({ id, requirementIds: ["FR-001"], given: "a value", when: "parse runs", then, method: "automated" as const });
  const spec: Spec = {
    ...fixtureSpec,
    criteria: [
      criterion("AC-001", 'Input | Expected\n--- | ---\n"bytes=0-9" | [0, 9]\n"bytes=5-" | [5, null]'),
      criterion("AC-002", "it rejects a range without a unit"),
      criterion("AC-003", "- bytes=-5 means the last five bytes"),
      criterion("AC-004", "Input | Expected\n--- | ---\nbytes=1 | the first byte"),
    ],
  };
  const task = (rows: string[]) =>
    ({ id: "T001", criterionIds: ["AC-001", "AC-002"], writes: [{ path: "range.test.ts", action: "create" }], rows, rowTest: { mode: "inline", framework: "bun", test: "range.test.ts" } }) as unknown as Task;
  const graph = (rows: string[]) => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "x", planHash: "y", tasks: [task(rows)] }) as unknown as TaskGraph;

  test("only criteria with a complete table of JSON cells are eligible, and the planner gets that list", () => {
    expect(rowsEligible(spec)).toEqual(["AC-001"]);
    expect(plannerRows(spec, on)).toMatchObject({ eligible: ["AC-001"] });
    expect(plannerRows(spec, on)?.note).toContain("Only the criteria in eligible (AC-001)");
    expect(plannerRows(spec, fixturePolicy)).toBeNull();
    expect(plannerRows(fixtureSpec, on)).toBeNull();
  });

  test("a plan naming a prose criterion is rejected with the eligible criteria named", () => {
    expect(rowPlanProblems(spec, graph(["AC-001"]), on)).toEqual([]);
    expect(rowPlanProblems(spec, graph(["AC-002"]), on)).toEqual([
      "Task T001: acceptance rows need a complete Input | Expected table (an optional Scenario column) of JSON cells for every criterion; only AC-001 has one, so name only those in rows or remove rows and rowTest.",
    ]);
  });

  test("the host drops rows when no criterion has a table, and keeps them when one does", () => {
    expect(withoutRowsWhenOff(graph(["AC-001"]), on, fixtureSpec).tasks[0]).toMatchObject({ rows: undefined, rowTest: undefined });
    expect(withoutRowsWhenOff(graph(["AC-002"]), on, spec)).toEqual(graph(["AC-002"]));
  });
});

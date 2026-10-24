import { afterEach, describe, expect, test } from "bun:test";
import { clearBannedProperties } from "../src/core/verification/initiative-ownership.js";
import { literalPropertyProblems, plannerRows, rowPlanProblems, rowsEligible, withoutRowsWhenOff } from "../src/core/workflows/acceptance-rows.js";
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

// Bench round 66, dirdrift-update (#2045). The brief said "no random values, no generated inputs";
// the spec author marked the 25-row Input | Expected table `"property": "strings"`, `literalRows`
// skips a property criterion, so no criterion was eligible and the planner heard nothing of rows.
describe("scenario: dirdrift-update, a property flag on a literal table (#2045)", () => {
  const TABLE = 'Input | Expected\n--- | ---\n"a/b" | "a/b"\n"a//b" | "a/b"';
  const tableSpec = (property?: "strings"): Spec => ({
    ...fixtureSpec,
    criteria: [{ ...fixtureSpec.criteria[0]!, given: "a path", when: "it is normalized", then: TABLE, ...(property ? { property } : {}) }],
  });
  // The author submits the flagged spec; the agent loop's validator (`request.validate`) either
  // takes it or sends it back, and the author then submits it without the flag.
  async function run(prompt: string) {
    const fixture = workflowFixture({ policy: on });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const specErrors: string[][] = [];
    const planPrompts: string[] = [];
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "spec") {
        // Only the property refusals: the fixture spec draws other advice (deliverables).
        const errors = (request.validate?.(tableSpec("strings")) ?? []).filter((e) => e.includes("property"));
        specErrors.push(errors);
        return { ...out, output: tableSpec(errors.length ? undefined : "strings") };
      }
      if (request.profile.output === "plan") planPrompts.push(request.prompt);
      return out;
    };
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy: on });
    await service.drive(started.runId, signal());
    const spec = service.store.state(started.runId).spec as Spec;
    const repair = service.store.latestArtifact(started.runId, "spec-repairs/banned-property.json");
    return {
      spec,
      specErrors,
      planPrompts,
      cleared: repair ? JSON.parse(service.store.readArtifact(started.runId, repair.id)).cleared : null,
    };
  }

  test("under a request that bans generated inputs the host clears the flag, records it, and the table is eligible", async () => {
    const result = await run("Create ready value. Every test is a literal example: no loops, no random values, no generated inputs.");
    expect(result.specErrors).toEqual([[]]);
    expect(result.cleared).toEqual(["AC-001"]);
    expect(result.spec.criteria[0]?.property).toBeUndefined();
    expect(rowsEligible(result.spec)).toEqual(["AC-001"]);
    expect(result.planPrompts[0]).toContain("Only the criteria in eligible (AC-001)");
  }, 90_000);

  test("without the ban a property on a literal table is refused with the change named, and the revised spec is eligible", async () => {
    const result = await run("Create ready value");
    expect(result.specErrors).toEqual([
      [
        'Criterion AC-001 marks "property": "strings" but lists a literal Input | Expected table of 2 rows: a property draws generated inputs, a table names fixed examples. Remove property or the table (keep the table when the cases are fixed examples).',
      ],
    ]);
    expect(result.spec.criteria[0]?.property).toBeUndefined();
    expect(result.cleared).toBeNull();
    expect(rowsEligible(result.spec)).toEqual(["AC-001"]);
  }, 90_000);

  test("a property criterion without a literal table keeps its flag, and one table row is not a table", () => {
    const prose = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, property: "strings" as const }] };
    expect(literalPropertyProblems(prose)).toEqual([]);
    const one = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, then: 'Input | Expected\n--- | ---\n"a" | "a"', property: "strings" as const }] };
    expect(literalPropertyProblems(one)).toEqual([]);
    expect(clearBannedProperties(prose, "Create ready value").cleared).toEqual([]);
    expect(clearBannedProperties(prose, "plain example tests only").spec.criteria[0]?.property).toBeUndefined();
  });
});

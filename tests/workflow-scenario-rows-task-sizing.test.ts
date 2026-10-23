import { describe, expect, test } from "bun:test";
import { rowPlanProblems } from "../src/core/workflows/acceptance-rows.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import {
  CAPACITY_PROBE,
  plannerSizing,
  ROWS_TASK_NOTE,
  type SizingSample,
  sizePlan,
  splitNote,
  splitTestTasks,
} from "../src/core/workflows/sizing.js";
import type { Task } from "../src/core/workflows/types.js";
import { fixtureSpec } from "./helpers/workflow-fixture.js";

// Bench round 60, wheeltags explain (Python, rowsAsData on), #1930. T002 was an inline pytest rows
// task of 40 literal cases. The project's finished test tasks cost 850k-920k tokens over their
// continuations, so sizing priced T002 above one attempt's 600k and asked for a re-plan, while the
// planner note said to keep a task of up to 64 cases whole, the host skips a rows task when it
// splits, and the rows rule refuses a sliced rows task. The plan went between the planner and the
// analyzer five times (1.03M tokens) until the assume rule took the finding. A rows task is now
// split only on its cases, and only when it has criteria without rows to move to another file.

const policy: RunPolicy = { ...defaultWorkflowPolicy, rowsAsData: "on", sizing: { maxAttemptTokens: 600_000 } };
// Capacity 16 cases; every finished test task cost more than one attempt over its continuations.
const history: SizingSample[] = [850_000, 870_000, 880_000, 896_000, 905_000, 917_000].map((tokens, index) => ({
  runId: `base-${index}`, taskId: "T005", kind: "test", action: "create", source: "project", files: 1, tokens, model: "m", criteria: 2, cases: 11 + index,
}));
const criterion = (id: string, then: string) => ({ id, requirementIds: ["FR-001"], given: "a wheel", when: "explain runs", then, method: "automated" as const });
const words = (id: string, count: number) => `input | expected\n--- | ---\n${Array.from({ length: count }, (_, i) => `${id}-tag-${i} | explained`).join("\n")}`;
/** AC-001 has a JSON table the host turns into rows; AC-002 and AC-003 hold the agent-written cases. */
const spec = (cases: number): Spec => ({
  ...fixtureSpec,
  criteria: [
    criterion("AC-001", 'Input | Expected\n--- | ---\n"py3-none-any" | ["py3", "none", "any"]\n"cp312-abi3-win_amd64" | ["cp312", "abi3", "win_amd64"]'),
    criterion("AC-002", words("AC-002", Math.ceil(cases / 2))),
    criterion("AC-003", words("AC-003", Math.floor(cases / 2))),
  ],
});

/** One inline rows test file and another test file per rows framework. */
const frameworks = [
  { framework: "bun", test: "tests/explain.test.ts", other: "tests/explain-more.test.ts" },
  { framework: "pytest", test: "tests/test_explain.py", other: "tests/test_explain_more.py" },
  { framework: "go", package: "explain", test: "explain/explain_test.go", other: "explain/more_test.go" },
  { framework: "junit", package: "app", test: "src/test/java/app/ExplainTest.java", other: "src/test/java/app/ExplainMoreTest.java" },
  { framework: "rust", test: "tests/explain.rs", other: "tests/explain_more.rs" },
  { framework: "xunit", package: "App.Tests", test: "tests/ExplainTests.cs", other: "tests/ExplainMoreTests.cs" },
] as const;
type Framework = (typeof frameworks)[number];

const task = (id: string, criterionIds: string[], path: string, extra: Partial<Task> = {}): Task => ({
  id, title: `Test ${criterionIds.join(", ")}`, description: "Tests", requirementIds: ["FR-001"], criterionIds, dependsOn: ["T001"],
  profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Tests", ...extra,
});
const graph = (...tasks: Task[]): TaskGraph => ({
  schemaVersion: 1, featureId: "explain", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64),
  tasks: [{ ...task("T001", ["AC-001", "AC-002", "AC-003"], "wheeltags/explain.py"), dependsOn: [] }, ...tasks],
});
const rowsTask = (f: Framework, criterionIds: string[]) =>
  task("T002", criterionIds, f.test, { rows: ["AC-001"], rowTest: { mode: "inline", framework: f.framework, test: f.test, ...("package" in f ? { package: f.package } : {}) } as Task["rowTest"] });
const size = (g: TaskGraph, cases: number) => sizePlan({ graph: g, policy, samples: history, spent: 0, spec: spec(cases) });

describe("scenario: wheeltags explain, a rows task priced above one attempt (#1930)", () => {
  test("the history prices a test task above one attempt at a capacity of 16 cases", () => {
    const report = size(graph(rowsTask(frameworks[1], ["AC-001", "AC-002", "AC-003"])), 40);
    expect(report.testTaskLimit?.cases).toBe(16);
    expect(report.tasks.find((t) => t.taskId === "T002")?.estimate.low).toBeGreaterThan(600_000);
  });

  for (const f of frameworks)
    test(`a 40-case rows task stays whole and the plan is not sent back: ${f.framework}`, () => {
      const g = graph(rowsTask(f, ["AC-001", "AC-002", "AC-003"]));
      expect(rowPlanProblems(spec(40), g, policy)).toEqual([]);
      const report = size(g, 40);
      const sized = report.tasks.find((t) => t.taskId === "T002")!;
      expect(sized).toMatchObject({ kind: "test", cases: 40, oversized: false, rowsTask: { movable: ["AC-002", "AC-003"] } });
      expect(report.decision).not.toBe("split-tasks");
      expect(splitTestTasks(g, report, spec(40), [], policy.checks)).toBeNull();
    });

  for (const f of frameworks)
    test(`a rows task above the probe names the criteria to move, and that plan is accepted and sized: ${f.framework}`, () => {
      const cases = CAPACITY_PROBE * 16 + 6;
      const report = size(graph(rowsTask(f, ["AC-001", "AC-002", "AC-003"])), cases);
      expect(report.decision).toBe("split-tasks");
      expect(report.reasons).toEqual([
        `T002 is a rows task covering ${cases} cases, above ${CAPACITY_PROBE} times the observed capacity of 16; a rows task is never sliced, so keep only its rows criteria in it and move AC-002, AC-003 into a test task of their own, writing another test file, that depends on it`,
      ]);
      // The plan the reason asks for: the rows criterion alone, the others in another file after it.
      const replanned = graph(rowsTask(f, ["AC-001"]), task("T003", ["AC-002", "AC-003"], f.other, { dependsOn: ["T001", "T002"] }));
      expect(rowPlanProblems(spec(cases), replanned, policy)).toEqual([]);
      const second = size(replanned, cases);
      expect(second.tasks.find((t) => t.taskId === "T002")).toMatchObject({ oversized: false, rowsTask: { movable: [] } });
      // The host splits the moved criteria itself, with no planner round.
      const split = splitTestTasks(replanned, second, spec(cases), [], policy.checks)!;
      expect(split.tasks.length).toBeGreaterThan(replanned.tasks.length);
      expect(rowPlanProblems(spec(cases), split, policy)).toEqual([]);
      expect(size(split, cases).tasks.every((t) => !t.oversized)).toBe(true);
    });

  test("the planner note, the split note and the decision say the same about a rows task", () => {
    const note = plannerSizing(policy, history).note;
    expect(note).toContain(`Keep a test task whole up to ${CAPACITY_PROBE * 16} literal cases`);
    expect(note).toContain(ROWS_TASK_NOTE);
    expect(note).toContain("the host itself splits a test task without rows whose price is above one attempt");
    const report = size(graph(rowsTask(frameworks[1], ["AC-001", "AC-002", "AC-003"])), CAPACITY_PROBE * 16 + 6);
    expect(splitNote(report, 3)).toContain(ROWS_TASK_NOTE);
    // A run without rows hears nothing about them.
    expect(plannerSizing({ ...policy, rowsAsData: "off" }, history).note).not.toContain(ROWS_TASK_NOTE);
    expect(splitNote(size(graph(task("T002", ["AC-002", "AC-003"], frameworks[1].test)), 40), 3)).not.toContain(ROWS_TASK_NOTE);
  });

  test("a test task without rows of the same price is still split by the host", () => {
    const g = graph(task("T002", ["AC-002", "AC-003"], frameworks[1].test));
    const report = size(g, 40);
    expect(report.tasks.find((t) => t.taskId === "T002")).toMatchObject({ oversized: true });
    expect(report.tasks.find((t) => t.taskId === "T002")?.rowsTask).toBeUndefined();
    expect(splitTestTasks(g, report, spec(40), [], policy.checks)).not.toBeNull();
  });
});

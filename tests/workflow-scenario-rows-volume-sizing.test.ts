import { afterEach, describe, expect, test } from "bun:test";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import {
  plannerSizing,
  ROW_TEXT_PER_CHAR,
  ROW_VOLUME_NOTE,
  rowVolumePrice,
  SLICE_PART,
  type SizingReport,
  type SizingSample,
  sizePlan,
  splitNote,
  splitTestTasks,
  suppliedBlocks,
  suppliedRows,
} from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 78 deltaglue cli (#2455): the brief gave `tests/problems.test.ts` as a fenced block of
// 63 prescribed rows (20,123 characters) headed `ProblemsTests in tests/problems.test.ts (63 rows,
// ...)`, in a notation the host does not turn into data. The criterion cited "the 63 prescribed
// ProblemsTests rows" and spelled out 3 literals, so the case walk counted 2 cases, T007 was priced
// 341k-863k and kept whole, and it cost 6.89M tokens over 7 attempts without finishing. With
// `sizing.rowVolume` the rows' characters price the task and the host splits it into row slices.

const NOTATION = 'run ARGS [FILE=VALUE] => CODE "OUT" "ERR"';
/** A row of about the deltaglue size: a file fixture with nested JSON and escaped expected output. */
const row = (i: number) =>
  `run check data/case-${i}.json [data/case-${i}.json={"id":${i},"frames":[{"t":0,"v":"a\\tb"},{"t":1,"v":"c\\nd"}],"meta":{"name":"case ${i}"}}] => ${i % 3} "data/case-${i}.json: frame ${i % 7}: value \\"c\\\\nd\\" is not a delta of \\"a\\\\tb\\"\\n" "warning: ${i} frames checked, ${i % 5} skipped\\n"`;

const rowsBlock = (path: string, count: number, header = `XTests in ${path} (${count} rows, ${NOTATION})`) =>
  ["```text", header, ...Array.from({ length: count }, (_, i) => row(i + 1)), "```"].join("\n");

const request = (path: string, count: number) =>
  [
    "Add the check command to deltaglue.",
    "",
    "The prescribed rows, one test each, exercised through `run`:",
    "",
    rowsBlock(path, count),
    "",
    "Keep the existing tests passing.",
  ].join("\n");

const criterion = (id: string, then: string) => ({
  id,
  requirementIds: ["FR-001"],
  given: "the prescribed rows",
  when: "the test suite runs",
  then,
  method: "automated" as const,
});
const spec = (count: number): Pick<Spec, "criteria"> => ({
  criteria: [
    criterion(
      "AC-008",
      `the ${count} prescribed XTests rows are exercised through run, such as \`run check a.json\` exiting 1 with "a.json: frame 1"`,
    ),
  ],
});

const planned = (id: string, path: string, extra: Partial<Task> = {}): Task => ({
  id, title: `test ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-008"], dependsOn: ["T001"], profileId: "implementer",
  writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior", ...extra,
});
const code: Task = { ...planned("T001", "src/cli.ts"), title: "cli", dependsOn: [], writes: [{ path: "src/cli.ts", action: "create" }] };
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "deltaglue", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [code, ...tasks] });

// Finished test tasks of 2-22 cases at 341k-863k, as the deltaglue history priced T007; capacity 87.
const history: SizingSample[] = Array.from({ length: 20 }, (_, i) => ({
  runId: `t${i}`, taskId: "T004", kind: "test", action: "create", source: "project", files: 1, tokens: 341_000 + i * 27_000, model: null, criteria: 2, cases: i === 19 ? 87 : 2 + i,
}));
const policy = (rowVolume?: boolean): RunPolicy => ({ ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 600_000, ...(rowVolume === undefined ? {} : { rowVolume }) } });

/** A test file of each language the round's briefs prescribed rows in. */
const LANGUAGES: [string, string][] = [
  ["typescript", "tests/x.test.ts"],
  ["go", "internal/cli/fixtures_test.go"],
  ["python", "tests/test_rows.py"],
];

const chars = (count: number) => Array.from({ length: count }, (_, i) => [...row(i + 1)].length).reduce((a, b) => a + b, 0);

describe("the rows a request prescribes for a test file (#2455)", () => {
  test("a fenced block whose first line names the file and says it holds rows is read, header excluded", () => {
    const rows = suppliedRows(request("tests/x.test.ts", 60), ["tests/x.test.ts", "src/cli.ts"]);
    expect(rows.get("tests/x.test.ts")).toEqual({ header: `XTests in tests/x.test.ts (60 rows, ${NOTATION})`, rows: 60, chars: chars(60), lines: Array.from({ length: 60 }, (_, i) => row(i + 1)) });
    expect(rows.has("src/cli.ts")).toBe(false);
  });

  test("a comment header reads the same; a block naming another file, two files or no rows does not", () => {
    const path = "tests/x.test.ts";
    expect(suppliedRows(rowsBlock(path, 4, `// ${path}: 4 rows`), [path]).get(path)?.rows).toBe(4);
    expect(suppliedRows(rowsBlock(path, 4, "YTests in tests/y.test.ts (4 rows)"), [path]).size).toBe(0);
    expect(suppliedRows(rowsBlock(path, 4, `XTests in ${path} and tests/y.test.ts (4 rows)`), [path, "tests/y.test.ts"]).size).toBe(0);
    expect(suppliedRows(rowsBlock(path, 4, `XTests in ${path}`), [path]).size).toBe(0);
    // Not a test file: rows of a fixture are not a test the task transcribes.
    expect(suppliedRows(rowsBlock("data/x.json", 4, "rows of data/x.json (4 rows)"), ["data/x.json"]).size).toBe(0);
  });

  test("the rows are not a supplied file: no reader of supplied files sees the block", () => {
    expect(suppliedBlocks(request("tests/x.test.ts", 60), ["tests/x.test.ts"]).size).toBe(0);
  });

  test("the rate brackets R78 T007: 63 rows of 20,123 characters split, priced up to what it spent", () => {
    const priced = rowVolumePrice(20_123, 63, 600_000);
    expect(priced.estimate.high).toBeGreaterThanOrEqual(6_887_546);
    expect(priced.estimate.low).toBe(20_123 * ROW_TEXT_PER_CHAR.low);
    expect(priced.slices).toBeGreaterThanOrEqual(2);
    // About the 6 to 8 rows the attempts that ended with rows written got through in one attempt.
    expect(Math.ceil(63 / priced.slices)).toBeLessThanOrEqual(10);
    expect(rowVolumePrice(1_900, 6, 600_000).slices).toBe(1);
  });
});

describe("scenario: R78 deltaglue T007, a test file of prescribed rows priced by its cases (#2455)", () => {
  for (const [language, path] of LANGUAGES) {
    test(`${language}: 60 rows price the task above one attempt and split it into row slices, only with the policy`, () => {
      const plan = graph(planned("T007", path), { ...planned("T008", "tests/later.test.ts"), dependsOn: ["T007"] });
      const req = request(path, 60);
      const shadow = sizePlan({ graph: plan, policy: policy(), samples: history, spent: 0, spec: spec(60), request: req });
      const on = sizePlan({ graph: plan, policy: policy(true), samples: history, spent: 0, spec: spec(60), request: req });
      const before = shadow.tasks.find((t) => t.taskId === "T007");
      const after = on.tasks.find((t) => t.taskId === "T007");
      // Off, the rows are recorded and change nothing: the case price, kept whole.
      expect(before?.rowVolume).toMatchObject({ path, rows: 60, chars: chars(60), mode: "shadow" });
      expect(before?.cases).toBeLessThan(5);
      expect(before?.estimate.high).toBeLessThan(1_000_000);
      expect(before?.oversized).toBe(false);
      expect(shadow.decision).not.toBe("split-tasks");
      expect(splitTestTasks(plan, shadow, spec(60) as Spec)).toBeNull();
      // On, the rows' characters price it, above one attempt, and it is split.
      expect(after?.estimate).toEqual({ low: chars(60) * ROW_TEXT_PER_CHAR.low, high: chars(60) * ROW_TEXT_PER_CHAR.high });
      expect(after?.oversized).toBe(true);
      expect(on.decision).toBe("split-tasks");
      expect(on.reasons.join(" ")).toContain(`T007 transcribes the 60 rows the request prescribes for ${path}`);
      const slices = after?.rowVolume?.slices ?? 0;
      expect(slices).toBeGreaterThanOrEqual(2);

      const split = splitTestTasks(plan, on, spec(60) as Spec);
      const parts = split?.tasks.filter((t) => t.sizingSlice?.taskId === "T007") ?? [];
      expect(parts).toHaveLength(slices);
      expect(parts[0]?.id).toBe("T007");
      expect(parts.map((t) => t.writes.map((w) => w.action))).toEqual(parts.map((_, i) => [i === 0 ? "create" : "modify"]));
      expect(parts.every((t) => t.writes.every((w) => w.path === path) && t.criterionIds.join() === "AC-008")).toBe(true);
      for (const [i, part] of parts.entries()) {
        expect(part.sizingSlice).toMatchObject({ index: i, count: slices });
        expect(part.dependsOn).toEqual(i === 0 ? ["T001"] : ["T001", parts[i - 1]?.id]);
        expect(part.description).toContain(SLICE_PART);
        expect(part.description).toContain(`the other parts of T007. Slice ${i + 1} of ${slices}.`);
      }
      // Every row is in exactly one slice, in order, and the shares add up to the whole.
      const ranges = parts.map((t) => /rows (\d+) to (\d+) of the 60/.exec(t.description)?.slice(1).map(Number));
      expect(ranges[0]?.[0]).toBe(1);
      expect(ranges.at(-1)?.[1]).toBe(60);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]?.[0]).toBe((ranges[i - 1]?.[1] ?? 0) + 1);
      expect(parts.reduce((sum, t) => sum + (t.sizingSlice?.share ?? 0), 0)).toBeCloseTo(1, 9);
      // A task that waited for T007 waits for every slice.
      expect(split?.tasks.find((t) => t.id === "T008")?.dependsOn).toEqual(parts.map((t) => t.id));

      // Priced again, as the plan's sizing does after the host split: no slice is sent back.
      const again = sizePlan({ graph: split as TaskGraph, policy: policy(true), samples: history, spent: 0, spec: spec(60), request: req });
      const sliced = again.tasks.filter((t) => parts.some((p) => p.id === t.taskId));
      expect(sliced.every((t) => !t.oversized && t.rowVolume?.slices === 1)).toBe(true);
      expect(again.decision).not.toBe("split-tasks");
      expect(Math.max(...sliced.map((t) => ((t.rowVolume?.estimate.low ?? 0) + (t.rowVolume?.estimate.high ?? 0)) / 2))).toBeLessThanOrEqual(600_000);
    });

    test(`${language}: a 6-row block stays whole`, () => {
      const plan = graph(planned("T007", path));
      const report = sizePlan({ graph: plan, policy: policy(true), samples: history, spent: 0, spec: spec(6), request: request(path, 6) });
      const task = report.tasks.find((t) => t.taskId === "T007");
      expect(task?.rowVolume).toMatchObject({ rows: 6, slices: 1, mode: "on" });
      expect(task?.oversized).toBe(false);
      expect(splitTestTasks(plan, report, spec(6) as Spec)).toBeNull();
    });
  }

  test("a test file the request supplies as its whole content keeps the supplied price, not the rows'", () => {
    const path = "tests/x.test.ts";
    const req = ["Replace `tests/x.test.ts` with the complete contents:", "", rowsBlock(path, 60), ""].join("\n");
    const report = sizePlan({ graph: graph(planned("T007", path)), policy: { ...policy(true), sizing: { maxAttemptTokens: 600_000, rowVolume: true, suppliedDiff: true } }, samples: history, spent: 0, spec: spec(60), request: req });
    const task = report.tasks.find((t) => t.taskId === "T007");
    expect(task?.basis).toBe("supplied");
    expect(task?.rowVolume).toBeUndefined();
  });

  test("a rows task (rowsAsData) is never priced or sliced by the rows", () => {
    const path = "tests/x.test.ts";
    const rows = planned("T007", path, { rows: ["AC-008"], rowTest: { framework: "bun", mode: "inline", path } } as Partial<Task>);
    const report = sizePlan({ graph: graph(rows), policy: { ...policy(true), rowsAsData: "on" }, samples: history, spent: 0, spec: spec(60), request: request(path, 60) });
    expect(report.tasks.find((t) => t.taskId === "T007")?.rowVolume).toBeUndefined();
  });

  test("the planner is told under the policy, before it plans and in a split note", () => {
    expect(plannerSizing(policy(true), history).note).toContain(ROW_VOLUME_NOTE);
    expect(plannerSizing(policy(), history).note).not.toContain(ROW_VOLUME_NOTE);
    const path = "tests/x.test.ts";
    const report = sizePlan({ graph: graph(planned("T007", path)), policy: policy(true), samples: history, spent: 0, spec: spec(60), request: request(path, 60) });
    expect(splitNote(report, 3)).toContain(ROW_VOLUME_NOTE);
  });
});

class RowsPlanner extends FixtureExecutor {
  constructor(root: string, private path: string) { super(root); }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: TaskGraph };
      const base = plan.taskGraph.tasks[0] as Task;
      plan.taskGraph.tasks.push({ ...base, id: "T002", title: "Test the rows", description: "Write the prescribed rows as tests", dependsOn: [base.id], writes: [{ path: this.path, action: "create" }] });
    }
    return result;
  }
}

describe("scenario: the run's host split reads the request's rows (#2455)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const drive = async (rowVolume: boolean) => {
    const path = "tests/x.test.ts";
    const policy: RunPolicy = { ...fixturePolicy, sizing: { maxAttemptTokens: 600_000, ...(rowVolume ? { rowVolume } : {}) } };
    const fixture = workflowFixture({ policy, executor: (root) => new RowsPlanner(root, path) });
    cleanups.push(fixture.dispose);
    const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value.\n\n${rowsBlock(path, 60)}\n`, ownerLabel: "test", policy });
    expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    return { store: fixture.service.store, runId: run.runId };
  };

  test("with the policy the planned test task reaches approval as row slices, without a replan", async () => {
    const { store, runId } = await drive(true);
    const state = store.state(runId);
    const parts = state.graph?.tasks.filter((t) => t.sizingSlice?.taskId === "T002") ?? [];
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((t) => t.writes[0]?.action)).toEqual(parts.map((_, i) => (i === 0 ? "create" : "modify")));
    expect(state.sizingReplans).toBe(0);
    expect(store.latestArtifact(runId, "sizing/split-0.json")).not.toBeNull();
    const report = JSON.parse(store.readArtifact(runId, store.latestArtifact(runId, "sizing/plan-0.json")!.id)) as SizingReport;
    expect(report.tasks.filter((t) => t.rowVolume?.mode === "on").map((t) => t.oversized)).toEqual(parts.map(() => false));
  }, 120_000);

  test("without it the task stays whole and its rows are recorded in shadow", async () => {
    const { store, runId } = await drive(false);
    expect(store.state(runId).graph?.tasks.some((t) => t.sizingSlice)).toBe(false);
    const report = JSON.parse(store.readArtifact(runId, store.latestArtifact(runId, "sizing/plan-0.json")!.id)) as SizingReport;
    expect(report.tasks.find((t) => t.taskId === "T002")?.rowVolume).toMatchObject({ rows: 60, mode: "shadow" });
  }, 120_000);
});

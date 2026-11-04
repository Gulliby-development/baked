import { afterEach, describe, expect, test } from "bun:test";
import { hashJson } from "../src/core/specs/hash.js";
import { criterionCases } from "../src/core/verification/criteria-cases.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  type RequestConflictRecord,
  sliceForeignDecision,
  sliceForeignInput,
} from "../src/core/workflows/request-conflict.js";
import type { RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import {
  ROW_TEXT_PER_CHAR,
  type SizingSample,
  sizePlan,
  splitTestTasks,
  suppliedRows,
} from "../src/core/workflows/sizing.js";
import { StopModesSchema, stopMode } from "../src/core/workflows/stop-reasons.js";
import { newId } from "../src/core/workflows/store.js";
import { replayRequestConflicts } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 79 verhop (#2466): the brief gave `tests/check.bats` as 15 prescribed rows, sizing
// split it into T004 (rows 1-7) and T007 (rows 8-15), and the task-end walk dealt AC-003's literals
// 7/15 to T004 in the criteria's order, not by the rows that hold them. T004 was refused for
// literals of rows 10 and 13 and raised `spec_conflict` three times (946k tokens, a person answered).
// A slice now owns a literal by its own rows; a literal no row holds goes to the last slice.

/** The versions of the 15 rows; rows 10 and 13 hold AC-003's reasons, row 15 AC-005's tuple. */
const VERSIONS = [
  "1.2.3",
  "0.0.0",
  "1.2.3-alpha.1",
  "10.20.30",
  "1.0.0-rc.1",
  "2.0.0-beta",
  "3.1.4",
  "01.2.3",
  "1.02.3",
  "1.2.3+",
  "1.2.3-",
  "1.2",
  "v1.2.3",
  "1.2.3.4",
  "9.9.9",
];
const code = (i: number) => (i < 7 || i === 14 ? 0 : 1);

/** One row in each language's own spelling, as the request's block gives it. */
const LANGUAGES: { language: string; path: string; row: (version: string, i: number) => string }[] = [
  {
    language: "shell (bats)",
    path: "tests/check.bats",
    row: (v, i) => `run "check" "${v}" => ${code(i)} "${code(i) ? "" : `${v} ok\\n`}" "${code(i) ? "invalid\\n" : ""}"`,
  },
  { language: "typescript", path: "tests/check.test.ts", row: (v, i) => `["${v}", ${code(i)}],` },
  { language: "python", path: "tests/test_check.py", row: (v, i) => `("${v}", ${code(i)}),` },
  { language: "go", path: "internal/check/check_test.go", row: (v, i) => `{"${v}", ${code(i)}},` },
  { language: "rust", path: "tests/check.rs", row: (v, i) => `(r"${v}", ${code(i)}),` },
  { language: "c#", path: "tests/CheckTests.cs", row: (v, i) => `[InlineData("${v}", ${code(i)})]` },
  { language: "java", path: "src/test/java/CheckTest.java", row: (v, i) => `"${v}, ${code(i)}",` },
  { language: "scala", path: "src/test/scala/CheckSuite.scala", row: (v, i) => `("${v}", ${code(i)}),` },
];

const request = (path: string, rows: string[]) =>
  [
    "Add the check command to verhop.",
    "",
    "```text",
    `CheckTests in ${path} (${rows.length} rows, VERSION => CODE)`,
    ...rows,
    "```",
  ].join("\n");

const criterion = (id: string, then: string) => ({
  id,
  requirementIds: ["FR-001"],
  given: "a version string",
  when: "check runs",
  then,
  method: "automated" as const,
});
const spec: Pick<Spec, "criteria"> = {
  criteria: [
    // `1.2.3-alpha.1` is row 3; `1.2.3-0a.01a.-.a-b.1e3` is in no row.
    criterion("AC-002", "check accepts `1.2.3-alpha.1` and `1.2.3-0a.01a.-.a-b.1e3`"),
    // Rows 10, 13 and 14, all in the second slice.
    criterion("AC-003", "check rejects `1.2.3+`, `v1.2.3` and `1.2.3.4` with exit 1"),
  ],
};

const task = (id: string, path: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `test ${path}`,
  description: `Write ${path}`,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-002", "AC-003"],
  dependsOn: ["T001"],
  profileId: "implementer",
  writes: [{ path, action: "create" }],
  readHints: [],
  checkIds: ["tests"],
  origin: "planned",
  findingIds: [],
  rationale: "Required behavior",
  ...extra,
});
const graph = (path: string): TaskGraph => ({
  schemaVersion: 1,
  featureId: "verhop",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [
    { ...task("T001", "src/check.sh"), title: "check", dependsOn: [], criterionIds: [] },
    task("T004", path),
  ],
});
const history: SizingSample[] = Array.from({ length: 20 }, (_, i) => ({
  runId: `t${i}`,
  taskId: "T004",
  kind: "test",
  action: "create",
  source: "project",
  files: 1,
  tokens: 100_000 + i * 5_000,
  model: null,
  criteria: 2,
  cases: 2 + i,
}));

/** The row slices of the file, with the cap set so the rows' expected price makes two. */
function slices(path: string, rows: string[]): { tasks: Task[]; req: string } {
  const req = request(path, rows);
  const chars = rows.reduce((sum, row) => sum + [...row].length, 0);
  const expected = (chars * (ROW_TEXT_PER_CHAR.low + ROW_TEXT_PER_CHAR.high)) / 2;
  const policy: RunPolicy = {
    ...defaultWorkflowPolicy,
    sizing: { maxAttemptTokens: Math.ceil(expected * 0.6), rowVolume: true },
  };
  const plan = graph(path);
  const report = sizePlan({ graph: plan, policy, samples: history, spent: 0, spec, request: req });
  const split = splitTestTasks(plan, report, spec as Spec, undefined, [], req);
  return { tasks: split?.tasks ?? [], req };
}

const literals = (owner: Task, plan: Task[]) =>
  criterionCases(spec, owner, { checks: [], tasks: plan }).map((c) => c.literal);

describe("row slices own the criteria literals of their rows (#2466)", () => {
  for (const { language, path, row } of LANGUAGES) {
    test(`${language}: a slice is asked only for the literals its rows hold`, () => {
      const rows = VERSIONS.map(row);
      expect(suppliedRows(request(path, rows), [path]).get(path)?.lines).toEqual(rows);
      const { tasks } = slices(path, rows);
      const parts = tasks.filter((t) => t.sizingSlice?.taskId === "T004");
      expect(parts).toHaveLength(2);
      expect(parts.map((t) => t.sizingSlice?.rows)).toEqual([rows.slice(0, 7), rows.slice(7)]);
      const [first, second] = parts as [Task, Task];
      // Rows 1-7 hold only `1.2.3-alpha.1`; the reasons of rows 10, 13 and 14 belong to slice 2,
      // and the example no row holds goes to the last slice, whose file holds every row.
      expect(literals(first, tasks)).toEqual(["1.2.3-alpha.1"]);
      expect(literals(second, tasks).sort()).toEqual(
        ["1.2.3-0a.01a.-.a-b.1e3", "1.2.3+", "v1.2.3", "1.2.3.4"].sort(),
      );
    });
  }

  test("a tuple spelling that differs from the rows' notation goes to the last slice", () => {
    const { path, row } = LANGUAGES[0] as (typeof LANGUAGES)[number];
    const rows = VERSIONS.map(row);
    const tuple = {
      criteria: [criterion("AC-005", 'check prints `(0,"1.2.3 ok\\n","")` for a valid version')],
    };
    const { tasks } = slices(path, rows);
    const parts = tasks.filter((t) => t.sizingSlice?.taskId === "T004");
    const cases = (owner: Task) =>
      criterionCases(tuple, { ...owner, criterionIds: ["AC-005"] }, {
        checks: [],
        tasks: tasks.map((t) => (t.sizingSlice ? { ...t, criterionIds: ["AC-005"] } : t)),
      }).map((c) => c.literal);
    expect(cases(parts[0] as Task)).toEqual([]);
    expect(cases(parts[1] as Task).length).toBeGreaterThan(0);
  });

  test("slices without their rows (planner-written, or before this fix) keep the share rule", () => {
    const { path, row } = LANGUAGES[0] as (typeof LANGUAGES)[number];
    const { tasks } = slices(path, VERSIONS.map(row));
    const bare = tasks.map((t) => {
      if (!t.sizingSlice) return t;
      const { rows: _rows, ...slice } = t.sizingSlice;
      return { ...t, sizingSlice: slice };
    });
    const [first, second] = bare.filter((t) => t.sizingSlice) as [Task, Task];
    const all = [...literals(first, bare), ...literals(second, bare)].sort();
    expect(all).toEqual(
      ["1.2.3-alpha.1", "1.2.3-0a.01a.-.a-b.1e3", "1.2.3+", "v1.2.3", "1.2.3.4"].sort(),
    );
  });
});

// Bench round 79 verhop T004 (#2476): rows 1-7 of `tests/check.bats` reported three spec
// conflicts about AC-003 and AC-005 literals of rows 8-15 (`conflicts/request/T004-1..3.json`,
// decision `none` each time, the request side unverified), and the third became the blocking
// clarification a person answered with "AC-003 and AC-005 are satisfied by the union of both
// slices". A report whose every missing literal another slice's rows hold is slice-foreign: the
// host records it, in shadow as a `slice_foreign_conflict` would-stop while the person is still
// asked.
describe("a row slice's spec conflict about another slice's literals (#2476)", () => {
  const { path, row } = LANGUAGES[0] as (typeof LANGUAGES)[number];
  const rows = VERSIONS.map(row);
  const whole = (ids: string[]) =>
    criterionCases(
      { criteria: spec.criteria.filter((c) => ids.includes(c.id)) },
      { criterionIds: ids },
      { checks: [] },
    );
  const heldBy = (text: string) => (c: { literal: string }) => text.includes(c.literal);

  test("every AC-003 literal slice 1 lacks is held by slice 2's rows: slice-foreign", () => {
    const { tasks } = slices(path, rows);
    const [first, second] = tasks.filter((t) => t.sizingSlice) as [Task, Task];
    // Slice 1 wrote its own rows, as T004 did.
    const slice = sliceForeignInput(
      first,
      tasks,
      whole(["AC-003"]),
      heldBy(rows.slice(0, 7).join("\n")),
    );
    expect(slice).toEqual({ taskId: "T004", missing: 3, foreign: 3, holders: [second.id] });
    const input = { slice, foreignTests: 0 };
    expect(sliceForeignDecision(input, "none")).toBe(true);
    // A report the request settles, or one about a test the run did not write, is not this rule's.
    expect(sliceForeignDecision(input, "request")).toBe(false);
    expect(sliceForeignDecision({ ...input, foreignTests: 1 }, "none")).toBe(false);
  });

  test("a missing literal no row holds, or one of the slice's own rows, keeps the report with the slice", () => {
    const { tasks } = slices(path, rows);
    const [first, second] = tasks.filter((t) => t.sizingSlice) as [Task, Task];
    // AC-002's `1.2.3-0a.01a.-.a-b.1e3` is in no row: the last slice owns it, not slice 1's report.
    const unrowed = sliceForeignInput(first, tasks, whole(["AC-002"]), heldBy(rows.join("\n")));
    expect(unrowed).toMatchObject({ missing: 1, foreign: 0 });
    expect(sliceForeignDecision({ slice: unrowed, foreignTests: 0 }, "none")).toBe(false);
    // Slice 1 has not written `1.2.3-alpha.1`, its own row 3: its own work, not another slice's.
    const own = sliceForeignInput(first, tasks, whole(["AC-002"]), heldBy(""));
    expect(own).toMatchObject({ missing: 2, foreign: 0, holders: [] });
    expect(sliceForeignDecision({ slice: own, foreignTests: 0 }, "none")).toBe(false);
    // A literal an earlier slice's rows hold is that slice's, as `partitionCases` decides.
    const later = sliceForeignInput(
      second,
      tasks,
      whole(["AC-002"]),
      heldBy("1.2.3-0a.01a.-.a-b.1e3"),
    );
    expect(later).toEqual({ taskId: "T004", missing: 1, foreign: 1, holders: [first.id] });
    // Nothing missing: nothing to settle.
    const none = sliceForeignInput(first, tasks, whole(["AC-003"]), () => true);
    expect(sliceForeignDecision({ slice: none, foreignTests: 0 }, "none")).toBe(false);
  });

  test("slices without their rows (planner-written, or a graph from before #2466) are not decided", () => {
    const { tasks } = slices(path, rows);
    const bare = tasks.map((t) => {
      if (!t.sizingSlice) return t;
      const { rows: _rows, ...slice } = t.sizingSlice;
      return { ...t, sizingSlice: slice };
    });
    const [first] = bare.filter((t) => t.sizingSlice) as [Task];
    expect(sliceForeignInput(first, bare, whole(["AC-003"]), () => false)).toBeUndefined();
    expect(sliceForeignInput(tasks[0] as Task, tasks, whole(["AC-003"]), () => false)).toBeUndefined();
  });

  test("the holder is the slice the case walk asks for the literal (the partitionCases test)", () => {
    const { tasks } = slices(path, rows);
    const [first, second] = tasks.filter((t) => t.sizingSlice) as [Task, Task];
    const slice = sliceForeignInput(first, tasks, whole(["AC-003"]), () => false);
    const walked = literals(second, tasks);
    for (const literal of ["1.2.3+", "v1.2.3", "1.2.3.4"]) expect(walked).toContain(literal);
    expect(literals(first, tasks)).not.toContain("1.2.3+");
    expect(slice?.holders).toEqual([second.id]);
  });
});

describe("scenario: R79 verhop T004 reports a conflict about slice 2's rows, in shadow (#2476)", () => {
  const { path, row } = LANGUAGES[0] as (typeof LANGUAGES)[number];
  const rows = VERSIONS.map(row);
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const drive = async (stopModes?: RunPolicy["stopModes"]) => {
    const runSpec: Spec = { ...fixtureSpec, criteria: [...fixtureSpec.criteria, ...spec.criteria] };
    const policy: RunPolicy = {
      ...fixturePolicy,
      clarification: "assume",
      ...(stopModes ? { stopModes } : {}),
    };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    let reports = 0;
    executor.execute = async (req: ExecutionRequest) => {
      if (req.profile.output === "spec") return { output: runSpec, inputTokens: 25, outputTokens: 25 };
      if (req.profile.output === "plan") {
        const out = await original(req);
        const graph = (out.output as { taskGraph: TaskGraph }).taskGraph;
        const code = graph.tasks[0] as Task;
        graph.specHash = hashJson(runSpec);
        const slice = (index: number, own: string[], extra: Partial<Task>): Task => ({
          ...code,
          id: index === 0 ? "T002" : "T003",
          title: `Test check (part ${index + 1} of 2)`,
          description: `Write check rows ${index === 0 ? "1 to 7" : "8 to 15"} of ${path}`,
          criterionIds: ["AC-002", "AC-003"],
          sizingSlice: { taskId: "T002", index, count: 2, share: own.length / rows.length, rows: own },
          ...extra,
        });
        graph.tasks = [
          code,
          slice(0, rows.slice(0, 7), { dependsOn: ["T001"], writes: [{ path, action: "create" }] }),
          slice(1, rows.slice(7), {
            dependsOn: ["T001", "T002"],
            writes: [{ path, action: "modify" }],
          }),
        ];
        return out;
      }
      if (req.profile.output !== "implementation" || req.task?.id !== "T002") return original(req);
      // T004 reported AC-003's literals of rows 10, 13 and 14 (here before writing its file, so
      // the host's own-test rule does not settle the report first).
      reports++;
      return {
        output: {
          schemaVersion: 1,
          taskId: "T002",
          outcome: "spec_conflict",
          summary:
            "AC-003 asks for `1.2.3+`, `v1.2.3` and `1.2.3.4`, which are not among the rows 1 to 7 this slice writes.",
          evidenceIds: [],
          unresolved: ["Should this slice also test rows outside its range?"],
          conflictSides: [
            {
              kind: "criterion",
              ref: "AC-003",
              quote: "check rejects `1.2.3+`, `v1.2.3` and `1.2.3.4` with exit 1",
            },
            { kind: "request", quote: "write only rows 1 to 7 of the 15 prescribed rows" },
          ],
        },
        inputTokens: 25,
        outputTokens: 25,
      };
    };
    const started = await service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: request(path, rows),
      ownerLabel: "test",
      policy,
    });
    for (let i = 0; i < 12; i++) {
      const current = await service.get(started.runId);
      if (["completed", "blocked", "failed"].includes(current.status)) break;
      const pending = service.store.requests(started.runId).find((r) => r.status === "pending");
      if (pending?.kind === "approval") await fixture.approve(started.runId);
      else if (pending?.kind === "clarification") break;
      else if (current.status === "paused" || current.status === "created")
        await fixture.resume(started.runId);
      await service.drive(started.runId, new AbortController().signal);
    }
    const store = service.store;
    return {
      reports,
      records: store
        .artifacts(started.runId)
        .filter((a) => a.logical_path.startsWith("conflicts/request/T002-"))
        .map(
          (a) => JSON.parse(store.readArtifact(started.runId, a.id)) as RequestConflictRecord,
        ),
      wouldStops: store
        .eventsOfType(started.runId, "decision.would_stop")
        .flatMap((e) =>
          e.type === "decision.would_stop" && e.payload.reason === "slice_foreign_conflict"
            ? [e.payload]
            : [],
        ),
      asked: store.requests(started.runId).filter((r) => r.kind === "clarification"),
      replay: replayRequestConflicts(store, started.runId),
    };
  };

  test("the report is recorded slice-foreign with a would-stop, and the person is still asked until promoted", async () => {
    const result = await drive();
    // Every report the slice made is recorded slice-foreign, with one would-stop each.
    expect(result.records.length).toBe(result.reports);
    expect(result.records.length).toBeGreaterThan(1);
    for (const record of result.records)
      expect(record).toMatchObject({
        decision: "none",
        sliceForeign: true,
        slice: { taskId: "T002", missing: 3, foreign: 3, holders: ["T003"] },
      });
    expect(result.wouldStops.map((w) => w.key)).toEqual(result.records.map((r) => `T002-${r.report}`));
    expect(result.wouldStops[0]).toMatchObject({
      mode: "shadow",
      inputs: { taskId: "T002", criterionIds: ["AC-003"], slice: { foreign: 3 } },
    });
    // Shadow: the decision changes nothing, so the conflict still reaches a person.
    expect(result.asked).toHaveLength(1);
    expect(result.replay.map((b) => [b.recorded, b.replayed, b.sliceForeign])).toEqual(
      result.records.map(() => ["none", "none", { recorded: true, replayed: true }]),
    );
  }, 120_000);

  test("the policy can make it advisory, never enforce yet", async () => {
    expect(StopModesSchema.safeParse({ slice_foreign_conflict: "enforce" }).success).toBe(false);
    expect(stopMode(fixturePolicy, "slice_foreign_conflict")).toBe("shadow");
    const result = await drive({ slice_foreign_conflict: "advisory" });
    expect(result.wouldStops[0]).toMatchObject({ mode: "advisory" });
    expect(result.asked).toHaveLength(1);
  }, 120_000);
});

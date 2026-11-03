import { afterEach, describe, expect, test } from "bun:test";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { hostRowFileTasks } from "../src/core/workflows/host-apply.js";
import type { RunPolicy, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { plannerSizing, ROW_FILE_NOTE, type SizingReport, sizePlan } from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 86 evalgrid (Go), feature `scoring` (#2633): 150 prescribed rows in ten row-file
// tasks T008-T017, each a test file the host wrote from its rows under `rowFileWrite: "on"` with
// no session (`host-apply/tasks/T008..T017.json`, applied). Sizing still priced each by its rows'
// characters (`rowVolume`), so the plan needed 9.95M against the 8M one run may use, the verdict
// was `split-feature` and the planner ran twice more (446k tokens) for a feature that spent 2.72M.
// Sizing now asks the host row writer's own decision (`hostRowFileTasks`) and prices those tasks
// at nothing; with the host write in shadow they keep the session price.

const ROWS_PER_FILE = 15;
const FILES = 10;
/** A row of the evalgrid scoring size: a grid, a weights map and the expected score breakdown. */
const row = (file: number, i: number) =>
  `{"grid-${file}-${i}", "[[1,0,2,0,1],[0,3,0,1,0],[2,0,1,0,3],[0,1,0,2,0],[1,0,3,0,1]]", "w={hit:3,miss:-1,near:1,edge:2,bonus:5}", "score=${file * 100 + i} hits=${i % 7} misses=${i % 5} near=${i % 3} edge=${i % 4} bonus=${i % 2} total=${file * 100 + i}"},`;
const path = (file: number, ext = "go") => `internal/score/rows_${String(file).padStart(2, "0")}_test.${ext}`;
const rowsBlock = (file: number, ext = "go") =>
  ["```text", `ScoreTests in ${path(file, ext)} (${ROWS_PER_FILE} rows, {name, grid, weights, want})`, ...Array.from({ length: ROWS_PER_FILE }, (_, i) => row(file, i + 1)), "```"].join("\n");
const request = (ext = "go") =>
  ["Add scoring to evalgrid.", "", "The prescribed rows, one test each:", "", ...Array.from({ length: FILES }, (_, f) => [rowsBlock(f + 1, ext), ""]).flat(), "Keep the existing tests passing."].join("\n");

const task = (id: string, writes: string[], extra: Partial<Task> = {}): Task => ({
  id, title: id, description: `Write ${writes.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
  writes: writes.map((p) => ({ path: p, action: "create" as const })), readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior", ...extra,
});
const rowTasks = (ext = "go") =>
  Array.from({ length: FILES }, (_, f) => task(`T${String(f + 8).padStart(3, "0")}`, [path(f + 1, ext)], { dependsOn: ["T001"], reference: "internal/score/scaffold_test.go" }));
const graph = (ext = "go"): TaskGraph => ({
  schemaVersion: 1, featureId: "scoring", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64),
  tasks: [task("T001", ["internal/score/score.go"]), task("T002", ["internal/score/grid.go"]), ...rowTasks(ext)],
});
// The evalgrid run's sizing: rows priced and split by their characters. R86 capped one run at 8M
// over a history-priced plan; with no history here the code tasks cost less, so the ceiling is
// scaled to keep the same verdict: the row tasks alone carry the plan over it.
const CEILING = 3_000_000;
const policy = (rowFileWrite: boolean): RunPolicy => ({
  ...defaultWorkflowPolicy,
  ...(rowFileWrite ? { rowFileWrite: "on" as const } : {}),
  sizing: { maxAttemptTokens: 600_000, rowVolume: true, maxRunTokens: CEILING },
});
/** Sizes the plan as the scheduler does: the host row writer's own decision names the free tasks. */
const size = (on: boolean, ext = "go"): SizingReport => {
  const plan = graph(ext);
  const req = request(ext);
  return sizePlan({ graph: plan, policy: policy(on), samples: [], spent: 0, request: req, hostRows: hostRowFileTasks(req, plan, policy(on)) });
};
const rowIds = rowTasks().map((t) => t.id);

describe("scenario: R86 evalgrid scoring, row files the host writes priced as sessions (#2633)", () => {
  test("with the host write in shadow the ten row tasks keep their row price and the plan splits the feature", () => {
    const report = size(false);
    expect(report.hostRows).toBeUndefined();
    expect(report.tasks.filter((t) => rowIds.includes(t.taskId)).map((t) => t.rowVolume?.mode)).toEqual(rowIds.map(() => "on"));
    expect(report.decision).toBe("split-feature");
    expect(report.reasons[0]).toContain(`above the ${CEILING} the policy allows one run`);
  });

  test("with the host write on the row tasks cost nothing and the plan is no longer split", () => {
    const off = size(false);
    const on = size(true);
    expect(on.hostRows).toEqual(rowIds);
    expect(on.tasks.map((t) => t.taskId)).toEqual(["T001", "T002"]);
    expect(on.decision).not.toBe("split-feature");
    expect(on.runTokens).toBeLessThan(CEILING);
    expect(on.taskTokens.expected).toBeLessThan(off.taskTokens.expected / 5);
  });

  test("a row file of a language the host writes no rows for keeps the session price", () => {
    // bash has no `ROW_FILE_SHAPES` row (a bats row is a `@test` block, #2553): the host refuses it
    // and a session writes it.
    const report = size(true, "bats");
    expect(report.hostRows).toBeUndefined();
    expect(report.decision).toBe("split-feature");
  });

  test("a row task that also writes code is not host-written and keeps its price", () => {
    const plan = graph();
    const mixed = { ...plan, tasks: plan.tasks.map((t) => (t.id === "T008" ? { ...t, writes: [...t.writes, { path: "internal/score/extra.go", action: "create" as const }] } : t)) };
    expect(hostRowFileTasks(request(), mixed, policy(true))).not.toContain("T008");
    expect(hostRowFileTasks(request(), mixed, policy(false))).toEqual([]);
  });

  test("the planner is told under the policy that such a file costs nothing", () => {
    expect(plannerSizing(policy(true), []).note).toContain(ROW_FILE_NOTE);
    expect(plannerSizing(policy(false), []).note).not.toContain(ROW_FILE_NOTE);
  });
});

/** Plans the evalgrid shape: the fixture's code task and the ten row-file tasks. */
class EvalgridPlanner extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: TaskGraph };
      const base = plan.taskGraph.tasks[0] as Task;
      plan.taskGraph.tasks.push(
        ...rowTasks().map((t) => ({ ...base, id: t.id, title: t.title, description: t.description, dependsOn: [base.id], writes: t.writes })),
      );
    }
    return result;
  }
}

describe("scenario: the run's plan-time verdict reads the host row writer (#2633)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const drive = async (on: boolean) => {
    const runPolicy: RunPolicy = { ...fixturePolicy, ...(on ? { rowFileWrite: "on" as const } : {}), sizing: { maxAttemptTokens: 600_000, rowVolume: true, maxRunTokens: CEILING } };
    const fixture = workflowFixture({ policy: runPolicy, executor: (root) => new EvalgridPlanner(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value.\n\n${request()}\n`, ownerLabel: "test", policy: runPolicy });
    await fixture.service.drive(run.runId, new AbortController().signal);
    const store = fixture.service.store;
    const plan0 = store.latestArtifact(run.runId, "sizing/plan-0.json");
    return { store, runId: run.runId, report: plan0 ? (JSON.parse(store.readArtifact(run.runId, plan0.id)) as SizingReport) : null };
  };

  test("with the host write on the first plan fits under the run ceiling and goes back to no planner", async () => {
    const { store, runId, report } = await drive(true);
    expect(report?.hostRows).toEqual(rowIds);
    expect(report?.decision).not.toBe("split-feature");
    expect(store.state(runId).sizingReplans).toBe(0);
    // The host writes each file whole: none is split into row slices.
    expect(store.state(runId).graph?.tasks.some((t) => t.sizingSlice)).toBe(false);
  });

  test("with it in shadow the same plan is above the ceiling, as R86 was", async () => {
    const { report } = await drive(false);
    expect(report?.hostRows).toBeUndefined();
    expect(report?.decision).toBe("split-feature");
  });
});

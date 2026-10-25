import { appendCorrections } from "../../src/core/verification/convergence.js";
import { WorkflowScheduler } from "../../src/core/workflows/scheduler.js";
import type { Check, Review, RunPolicy, TaskGraph } from "../../src/core/workflows/schemas.js";
import type { TaskRow, WorkflowStore } from "../../src/core/workflows/store.js";
import { readyTasks } from "../../src/core/workflows/task-graph.js";
import type { RuntimeState, Task } from "../../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec } from "./workflow-fixture.js";

/**
 * The skillcomb graph of #2094 at the moment slice 1 of a test file failed a check: T001 writes
 * the source, T002 creates the test file (slice 1, blocked), T003 modifies it (slice 2, pending)
 * and T004 is an independent test task that depends on T001 only.
 */
export function slicedPlan(testPath: string): Task[] {
  const task = (id: string, path: string, dependsOn: string[] = [], action: "create" | "modify" = "create"): Task => ({
    id, title: `Write ${path} (${id})`, description: `Write ${path}: part ${id}`, requirementIds: ["FR-001"],
    criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action }], readHints: [],
    checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
  });
  return [
    task("T001", "src/a.src"),
    task("T002", testPath, ["T001"]),
    task("T003", testPath, ["T002"], "modify"),
    task("T004", "tests/other.test", ["T001"]),
  ];
}

const rows = (): TaskRow[] =>
  Object.entries({ T001: "verified", T002: "blocked", T003: "pending", T004: "pending" }).map(
    ([id, status]) => ({ id, status, generation: 0, snapshot_id: null, definition_json: "{}" }) as unknown as TaskRow,
  );

const fakeStore = (): WorkflowStore =>
  ({
    transaction: (fn: () => unknown) => fn(),
    taskStatus: () => undefined,
    run: () => ({ repair_rounds: 0, convergence_rounds: 0, corrective_tasks: 0 }),
    artifact: () => ({ content_hash: "h".repeat(64) }),
    syncTasks: () => undefined,
    tasks: rows,
    findingStatus: () => undefined,
    addRound: () => undefined,
    addCorrectiveTasks: () => undefined,
    latestArtifact: () => undefined,
    artifacts: () => [],
    findings: () => [],
  }) as unknown as WorkflowStore;

export const slicedPolicy = (check: Check): RunPolicy => ({
  ...fixturePolicy, checks: [check], maxRepairRounds: 3, maxConvergenceRounds: 3, maxCorrectiveTasks: 20,
});

/**
 * T002's failed check as the scheduler records it (`applyTaskCheck`), the task-level corrective
 * the builder makes of it (`appendCorrections`), and the tasks `readyTasks` offers while that
 * corrective is pending.
 */
export function slicedCorrective(
  check: Check,
  testPath: string,
  output: string,
): { state: RuntimeState; added: Task; finding: Review["findings"][number]; ready: string[] } {
  const graph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: slicedPlan(testPath) };
  const state = {
    graph: structuredClone(graph), rootGraph: structuredClone(graph), spec: fixtureSpec, approvalRoot: "c".repeat(64),
    repairPredecessors: {}, repairScope: {}, correctionHashes: [], manifest: {},
    expectedFiles: { "src/a.src": "h", [testPath]: "h" }, noProgressRounds: 0, previousFindingSet: null,
    deferredChecks: {}, taskGates: {}, affectedTests: {}, waitingFor: {}, extraCorrectiveTasks: 0,
    extraConvergenceRounds: 0, reviews: {},
  } as unknown as RuntimeState;
  const scheduler = Object.create(WorkflowScheduler.prototype) as {
    store: WorkflowStore;
    applyTaskCheck(runId: string, state: RuntimeState, task: Task, check: Check, checked: { status: "failed"; evidenceId: string; output: string }, failures: Review["findings"], evidence: string[]): string | undefined;
  };
  scheduler.store = fakeStore();
  const failures: Review["findings"] = [];
  scheduler.applyTaskCheck("run", state, state.graph?.tasks[1] as Task, check, { status: "failed", evidenceId: "E1", output }, failures, []);
  const finding = failures[0];
  if (!finding) throw new Error(`No finding for ${check.id}`);
  state.repairPredecessors[finding.id] = "T002";
  appendCorrections(fakeStore(), "run", state, slicedPolicy(check), failures, "repair", "task");
  const added = state.graph?.tasks.at(-1) as Task;
  const ready = readyTasks(state.graph as TaskGraph, [...rows(), { id: added.id, status: "pending" } as TaskRow], {}, {}, state.repairPredecessors).map((t) => t.id);
  return { state, added, finding, ready };
}

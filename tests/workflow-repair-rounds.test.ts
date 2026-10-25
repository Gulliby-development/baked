import { describe, expect, test } from "bun:test";
import { appendCorrections } from "../src/core/verification/convergence.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { Review, RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { RuntimeState, Task } from "../src/core/workflows/types.js";
import { fixtureSpec } from "./helpers/workflow-fixture.js";

// cfgtrace 276e4858 (#839): two task-level corrections in the implement stage used both repair
// rounds, so the checks stage could not repair eight failing tests, and one failed pytest run
// recorded against six owning files counted as six of the twenty corrective tasks.
const task = (id: string, path: string): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: [{ path, action: "modify" }],
  readHints: [],
  checkIds: ["tests"],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const files = ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py"];
const root: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: files.map((path, index) => task(`T00${index + 1}`, path)),
};
const policy = { maxRepairRounds: 2, maxConvergenceRounds: 2, maxCorrectiveTasks: 20 } as RunPolicy;

function fakeStore() {
  const counts = { repair_rounds: 0, review_rounds: 0, convergence_rounds: 0, corrective_tasks: 0 };
  const paths: string[] = [];
  const store = {
    run: () => ({ ...counts }),
    artifact: (_run: string, _kind: string, path: string) => {
      paths.push(path);
      return { content_hash: "h".repeat(64) };
    },
    syncTasks: () => undefined,
    tasks: () => [],
    findingStatus: () => undefined,
    findings: () => [],
    addRound: (_run: string, kind: "repair" | "review" | "convergence", count: number) => {
      counts[`${kind}_rounds`]++;
      counts.corrective_tasks += count;
    },
    addCorrectiveTasks: (_run: string, count: number) => {
      counts.corrective_tasks += count;
    },
  } as unknown as WorkflowStore;
  return { store, counts, paths };
}
const stateOf = (): RuntimeState =>
  ({
    graph: structuredClone(root),
    rootGraph: structuredClone(root),
    spec: fixtureSpec,
    approvalRoot: "c".repeat(64),
    repairPredecessors: {},
    correctionHashes: [],
    manifest: {},
    expectedFiles: null,
    noProgressRounds: 0,
    previousFindingSet: null,
    extraConvergenceRounds: 0,
    extraCorrectiveTasks: 0,
  }) as unknown as RuntimeState;
const finding = (
  id: string,
  file: string,
  evidenceId: string,
  claim = "Required check tests failed",
): Review["findings"][number] => ({
  id,
  kind: "correctness",
  severity: "high",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file,
  symbol: null,
  evidenceIds: [evidenceId],
  claim,
  impact: "Implementation cannot be accepted",
  suggestedFix: "Fix it",
});
/** A task's own failed check, corrected as settleTask does it. */
function taskRepair(store: WorkflowStore, state: RuntimeState, taskId: string, id: string) {
  state.repairPredecessors[id] = taskId;
  const file = state.graph?.tasks.find((t) => t.id === taskId)?.writes[0]?.path ?? "";
  appendCorrections(store, "run", state, policy, [finding(id, file, `E-${id}`)], "repair", "task");
  return state.graph?.tasks.at(-1)?.id ?? "";
}

describe("repair rounds and task-level corrections", () => {
  test("task-level corrections leave the repair rounds to the checks stage", () => {
    const { store, counts, paths } = fakeStore();
    const state = stateOf();
    expect(taskRepair(store, state, "T003", "lint-1")).toBe("T007");
    expect(taskRepair(store, state, "T005", "integrity-1")).toBe("T008");
    expect(counts).toEqual({ repair_rounds: 0, review_rounds: 0, convergence_rounds: 0, corrective_tasks: 2 });
    expect(paths).toEqual(["corrections/task-T007.json", "corrections/task-T008.json"]);
    // The checks stage still has both rounds.
    appendCorrections(store, "run", state, policy, [finding("F1", "a.py", "E1")], "repair");
    appendCorrections(store, "run", state, policy, [finding("F2", "a.py", "E2")], "repair");
    expect(counts.repair_rounds).toBe(2);
  });

  // mdrefs 8531a4f0 (#928): the checks stage used both rounds and the review's correction was
  // refused as round 3.
  test("review passes have their own maxRepairRounds budget", () => {
    const { store, counts, paths } = fakeStore();
    const state = stateOf();
    appendCorrections(store, "run", state, policy, [finding("C1", "a.py", "E1")], "repair");
    appendCorrections(store, "run", state, policy, [finding("C2", "a.py", "E2")], "repair");
    appendCorrections(store, "run", state, policy, [finding("R1", "b.py", "E3", "Diagnostics use Debug formatting")], "repair", "review");
    appendCorrections(store, "run", state, policy, [finding("R2", "b.py", "E4", "Another reproduced defect")], "repair", "review");
    expect(counts).toEqual({ repair_rounds: 2, review_rounds: 2, convergence_rounds: 0, corrective_tasks: 4 });
    expect(paths).toEqual(["corrections/repair-1.json", "corrections/repair-2.json", "corrections/review-1.json", "corrections/review-2.json"]);
    // Each budget still refuses its next round.
    expect(() =>
      appendCorrections(store, "run", state, policy, [finding("R3", "c.py", "E5", "A third defect")], "repair", "review"),
    ).toThrow("maxRepairRounds (2)");
    // A checks failure after the review's corrections gets one round of its own (#1272), then the
    // checks stage's budget refuses again.
    appendCorrections(store, "run", state, policy, [finding("C3", "c.py", "E6")], "repair");
    expect(counts.repair_rounds).toBe(3);
    expect(() => appendCorrections(store, "run", state, policy, [finding("C4", "d.py", "E7")], "repair")).toThrow(
      "maxRepairRounds (2)",
    );
  });

  test("a chain of task-level corrections stops at maxTaskRepairs", () => {
    const { store } = fakeStore();
    const state = stateOf();
    const first = taskRepair(store, state, "T001", "x1");
    const second = taskRepair(store, state, first, "x2");
    let fault: unknown;
    try {
      taskRepair(store, state, second, "x3");
    } catch (error) {
      fault = error;
    }
    expect(fault).toBeInstanceOf(WorkflowFault);
    expect((fault as WorkflowFault).message).toContain("maxTaskRepairs (2)");
    // Another planned task has its own chain.
    expect(taskRepair(store, state, "T002", "y1")).toMatch(/^T\d+$/);
    // A policy can allow longer chains.
    const longer = { ...policy, maxTaskRepairs: 3 } as RunPolicy;
    state.repairPredecessors.x4 = second;
    appendCorrections(store, "run", state, longer, [finding("x4", "a.py", "E-x4")], "repair", "task");
  });

  test("one failed check run counts as one corrective task against the cap", () => {
    const { store, counts } = fakeStore();
    const state = stateOf();
    const tight = { ...policy, maxCorrectiveTasks: 2 } as RunPolicy;
    appendCorrections(
      store,
      "run",
      state,
      tight,
      files.map((file, index) => finding(`F${index}`, file, "pytest-run")),
      "repair",
    );
    expect(counts.corrective_tasks).toBe(1);
    expect((state.graph?.tasks ?? []).slice(files.length)).toHaveLength(1);
  });

  test("the cap still refuses more tasks than it allows, without recording predecessors", () => {
    const { store } = fakeStore();
    const state = stateOf();
    const tight = { ...policy, maxCorrectiveTasks: 1 } as RunPolicy;
    const review = (id: string, file: string) => finding(id, file, "E1", "The value is wrong");
    expect(() =>
      appendCorrections(store, "run", state, tight, [review("R1", "a.py"), review("R2", "b.py")], "repair"),
    ).toThrow("maxCorrectiveTasks (1)");
    expect(state.repairPredecessors).toEqual({});
    expect(state.graph?.tasks).toHaveLength(files.length);
  });

  // md-site 2f949017 (#1272): two early checks failures used both rounds, and a regression the
  // convergence corrective made was refused.
  test("a checks failure after a convergence correction gets one more repair round", () => {
    const { store, counts } = fakeStore();
    const state = stateOf();
    appendCorrections(store, "run", state, policy, [finding("C1", "a.py", "E1")], "repair");
    appendCorrections(store, "run", state, policy, [finding("C2", "b.py", "E2")], "repair");
    const stop = () =>
      appendCorrections(store, "run", state, policy, [finding("C4", "d.py", "E4")], "repair");
    appendCorrections(store, "run", state, policy, [finding("V1", "c.py", "E3", "Nested emphasis is wrong")], "convergence");
    appendCorrections(store, "run", state, policy, [finding("C3", "c.py", "E5")], "repair");
    expect(counts.repair_rounds).toBe(3);
    expect(state.extraRepairRounds).toBe(1);
    // The next failure without a correction before it is refused again.
    expect(stop).toThrow("maxRepairRounds (2)");
  });
});

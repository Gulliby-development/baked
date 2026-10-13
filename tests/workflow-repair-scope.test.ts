import { describe, expect, test } from "bun:test";
import { appendCorrections, correctionAuthorized } from "../src/core/verification/convergence.js";
import { WorkflowScheduler } from "../src/core/workflows/scheduler.js";
import type { Review, RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { RuntimeState, Task } from "../src/core/workflows/types.js";
import { fixtureSpec } from "./helpers/workflow-fixture.js";

const task = (id: string, path: string, profileId = "implementer", extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId,
  writes: [{ path, action: "create" }],
  readHints: [],
  checkIds: ["fmt"],
  origin: "planned",
  findingIds: [],
  rationale: id,
  ...extra,
});
const spec = {
  ...fixtureSpec,
  criteria: [
    ...fixtureSpec.criteria,
    { ...(fixtureSpec.criteria[0] as (typeof fixtureSpec.criteria)[number]), id: "AC-002" },
  ],
};
const root: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [
    task("T001", "src/lib.rs"),
    task("T002", "src/render.rs"),
    // Its criteria differ from the code tasks', so they are not "related" tasks it may correct.
    task("T003", "tests/docs.rs", "implementer", { criterionIds: ["AC-002"] }),
    task("T004", "docs/guide.md", "writer"),
  ],
};
const check = { id: "fmt", required: true } as RunPolicy["checks"][number];
const store = {
  transaction: (fn: () => unknown) => fn(),
  taskStatus: () => undefined,
  run: () => ({ repair_rounds: 0, convergence_rounds: 0, corrective_tasks: 0 }),
  artifact: () => ({ content_hash: "h".repeat(64) }),
  syncTasks: () => undefined,
  findingStatus: () => undefined,
  addRound: () => undefined,
} as unknown as WorkflowStore;
const stateOf = (): RuntimeState =>
  ({
    graph: structuredClone(root),
    rootGraph: structuredClone(root),
    spec: spec,
    approvalRoot: "c".repeat(64),
    repairPredecessors: {},
    repairScope: {},
    correctionHashes: [],
    manifest: {},
    expectedFiles: null,
    noProgressRounds: 0,
    previousFindingSet: null,
    deferredChecks: {},
    taskGates: {},
  }) as unknown as RuntimeState;
const policy = { maxRepairRounds: 3, maxConvergenceRounds: 3, maxCorrectiveTasks: 20 } as RunPolicy;

const scheduler = Object.create(WorkflowScheduler.prototype) as {
  store: WorkflowStore;
  applyTaskCheck(
    runId: string,
    state: RuntimeState,
    task: Task,
    check: RunPolicy["checks"][number],
    checked: { status: "failed"; evidenceId: string; output: string },
    failures: Review["findings"],
    evidence: string[],
  ): string | undefined;
};
scheduler.store = {
  ...store,
  tasks: () => root.tasks.map((t) => ({ id: t.id, status: "verified", generation: 0 })),
} as unknown as WorkflowStore;

const fail = (state: RuntimeState, t: Task, output: string) => {
  const failures: Review["findings"] = [];
  scheduler.applyTaskCheck("run", state, t, check, { status: "failed", evidenceId: "E1", output }, failures, []);
  return failures;
};

// Bench round 08, commitbump cd842f0f: T006 (tests/docs.rs) failed `fmt` on src/*.rs, its repair
// task could write only tests/docs.rs, changed nothing three times and blocked the run.
describe("the repair scope follows the files a failed check names", () => {
  test("a failure that also names files of other implementer tasks lets the repair write them", () => {
    const state = stateOf();
    const failures = fail(state, root.tasks[2] as Task, "Diff in tests/docs.rs\nDiff in src/lib.rs\nDiff in src/render.rs");
    expect(failures).toHaveLength(1);
    const id = failures[0]?.id ?? "";
    expect(state.repairScope[id]).toEqual(["src/lib.rs", "src/render.rs"]);
    expect(failures[0]?.suggestedFix).toContain("src/lib.rs");

    state.repairPredecessors[id] = "T003";
    appendCorrections(store, "run", state, policy, failures, "repair");
    const added = (state.graph?.tasks ?? []).at(-1) as Task;
    expect(added.writes.map((w) => w.path).sort()).toEqual(["src/lib.rs", "src/render.rs", "tests/docs.rs"]);
    expect(correctionAuthorized(added, root)).toBe(true);
  });

  test("a failure inside the task's own files keeps its scope", () => {
    const state = stateOf();
    const failures = fail(state, root.tasks[2] as Task, "Diff in tests/docs.rs");
    expect(state.repairScope[failures[0]?.id ?? ""]).toBeUndefined();
    state.repairPredecessors[failures[0]?.id ?? ""] = "T003";
    appendCorrections(store, "run", state, policy, failures, "repair");
    expect(((state.graph?.tasks ?? []).at(-1) as Task).writes.map((w) => w.path)).toEqual(["tests/docs.rs"]);
  });

  test("a failure only on files no task of the profile owns blocks at once", () => {
    const state = stateOf();
    expect(() => fail(state, root.tasks[2] as Task, "Diff in docs/guide.md")).toThrow(
      /out_of_scope_failure: check fmt fails on docs\/guide\.md/,
    );
  });
});

// Bench round 08, commitbump cd842f0f: repair task T008 changed nothing three times because fmt
// kept failing on files outside its writes, and each resume started it again (689k tokens).
describe("a repair that changes nothing on an out-of-scope failure", () => {
  const repair = task("T008", "tests/docs.rs", "implementer", {
    origin: "repair",
    findingIds: ["F1"],
    criterionIds: ["AC-002"],
  });
  const satisfied = (output: string) => {
    const s = Object.create(WorkflowScheduler.prototype) as {
      store: WorkflowStore;
      runTaskCheck: () => Promise<{ status: "failed"; evidenceId: string; output: string }>;
      correctionSatisfied(
        runId: string,
        child: string,
        policy: RunPolicy,
        task: Task,
        result: { taskId: string; outcome: string; unresolved: string[] },
        signal: AbortSignal,
        root: string,
      ): Promise<boolean>;
    };
    s.store = {
      tasks: () => [{ id: "T008", generation: 0 }],
      findings: () => [{ id: "F1", body_json: JSON.stringify({ claim: "Required check fmt failed" }) }],
      state: () => stateOf(),
    } as unknown as WorkflowStore;
    s.runTaskCheck = async () => ({ status: "failed", evidenceId: "E2", output });
    return s.correctionSatisfied(
      "run",
      "step",
      { checks: [check] } as RunPolicy,
      repair,
      { taskId: "T008", outcome: "implemented", unresolved: [] },
      new AbortController().signal,
      "/tmp",
    );
  };

  test("blocks at once, naming the files it may not write", async () => {
    await expect(satisfied("Diff in src/lib.rs\nDiff in src/render.rs")).rejects.toThrow(
      /out_of_scope_failure: T008 changed nothing and check fmt still fails on src\/lib\.rs, src\/render\.rs/,
    );
  });

  test("a failure that still names its own file is an ordinary unfinished repair", async () => {
    expect(await satisfied("Diff in tests/docs.rs\nDiff in src/lib.rs")).toBe(false);
  });
});

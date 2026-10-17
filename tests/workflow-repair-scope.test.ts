import { describe, expect, test } from "bun:test";
import { appendCorrections, correctionAuthorized, isTestOf } from "../src/core/verification/convergence.js";
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
const check = { id: "fmt", required: true, executable: "cargo", args: ["fmt", "--check"] } as RunPolicy["checks"][number];
const store = {
  transaction: (fn: () => unknown) => fn(),
  taskStatus: () => undefined,
  run: () => ({ repair_rounds: 0, convergence_rounds: 0, corrective_tasks: 0 }),
  artifact: () => ({ content_hash: "h".repeat(64) }),
  syncTasks: () => undefined,
  tasks: () => [],
  findingStatus: () => undefined,
  addRound: () => undefined,
  latestArtifact: () => undefined,
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
    affectedTests: {},
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
    // The formatter's diagnostics in the task's own file come first (#1067).
    expect(state.repairScope[id]).toEqual(["tests/docs.rs", "src/lib.rs", "src/render.rs"]);
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
    expect(state.repairScope[failures[0]?.id ?? ""]).toEqual(["tests/docs.rs"]);
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

// Bench round 08, commitbump cd842f0f: repair T008 reported `implemented` three times with no
// edit while fmt still failed on src/*.rs, which it could not write; each resume tried again.
describe("a correction that changes nothing on a failure outside its files", () => {
  const repair = task("T008", "tests/docs.rs", "implementer", {
    origin: "repair",
    findingIds: ["F1"],
    checkIds: ["fmt"],
  });
  const fmt = { id: "fmt", required: true, scope: "task", executable: "cargo", args: ["fmt"] } as RunPolicy["checks"][number];
  const satisfied = (output: string, status: "failed" | "passed" = "failed") => {
    const subject = Object.create(WorkflowScheduler.prototype) as {
      store: WorkflowStore;
      runTaskCheck: () => Promise<{ status: string; evidenceId: string; output: string }>;
      correctionSatisfied(...args: unknown[]): Promise<boolean | Error>;
    };
    subject.store = {
      tasks: () => [{ id: "T008", generation: 0 }],
      findings: () => [{ id: "F1", body_json: JSON.stringify({ claim: "Required check fmt failed" }) }],
      artifacts: () => [],
    } as unknown as WorkflowStore;
    subject.runTaskCheck = async () => ({ status, evidenceId: "E9", output });
    const state = { ...stateOf(), graph: { ...root, tasks: [...root.tasks, repair] } } as RuntimeState;
    return subject.correctionSatisfied(
      "run",
      state,
      "step",
      { checks: [fmt] } as unknown as RunPolicy,
      repair,
      { taskId: "T008", outcome: "implemented", unresolved: [] },
      new AbortController().signal,
      "/root",
    );
  };

  test("blocks at once with out_of_scope_failure naming the files", async () => {
    const outcome = await satisfied("Diff in src/lib.rs\nDiff in src/render.rs");
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/^out_of_scope_failure: T008 changed nothing and check fmt still fails on src\/lib\.rs, src\/render\.rs/);
    expect((outcome as { code?: string }).code).toBe("RECOVERY_REQUIRED");
  });

  test("a failure on its own file, or on no planned file, stays an ordinary unfinished task", async () => {
    expect(await satisfied("Diff in tests/docs.rs\nDiff in src/lib.rs")).toBe(
      "it changed none of its files and check fmt still fails on src/lib.rs, tests/docs.rs (evidence E9)",
    );
    expect(await satisfied("error: could not compile")).toBe("it changed none of its files and check fmt still fails (evidence E9)");
    expect(await satisfied("", "passed")).toBe(true);
  });
});

// Bench round 10: corrections that needed a planned file outside their write list ended
// "unresolved" (junitdigest 3e5be74b T014 and internal/cli/cli_test.go, expenses-py 1363445a and
// tests/test_cli.py) and then blocked as invalid output.
describe("a correction gets the planned files its fix needs", () => {
  const finding = (id: string, file: string, suggestedFix: string) =>
    ({
      id,
      kind: "correctness",
      severity: "high",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      file,
      symbol: null,
      evidenceIds: [],
      claim: "The parser drops the last value",
      impact: "Wrong report",
      suggestedFix,
    }) as Review["findings"][number];

  test("a planned file the finding's fix names joins the scope with its owner", () => {
    const state = stateOf();
    state.repairPredecessors.R1 = "T001";
    appendCorrections(store, "run", state, policy, [finding("R1", "src/lib.rs", "Keep the last value and update tests/docs.rs to expect it")], "repair");
    const added = (state.graph?.tasks ?? []).at(-1) as Task;
    expect(added.writes.map((w) => w.path)).toContain("tests/docs.rs");
    expect(added.writes.map((w) => w.path)).not.toContain("docs/guide.md");
    expect(correctionAuthorized(added, root)).toBe(true);
  });

  test("the planned tests of the files the correction writes join the scope", () => {
    const graph: TaskGraph = {
      ...root,
      tasks: [
        task("T001", "internal/cli/cli.go"),
        task("T002", "internal/cli/cli_test.go", "implementer", { criterionIds: ["AC-002"] }),
        task("T003", "internal/report/report_test.go", "implementer", { criterionIds: ["AC-003"] }),
      ],
    };
    // T003 covers its own criterion, so only the test of the corrected file joins.
    const withAc3 = {
      ...spec,
      criteria: [...spec.criteria, { ...(spec.criteria[0] as (typeof spec.criteria)[number]), id: "AC-003" }],
    };
    const state = {
      ...stateOf(),
      spec: withAc3,
      graph: structuredClone(graph),
      rootGraph: structuredClone(graph),
    } as RuntimeState;
    state.repairPredecessors.R1 = "T001";
    appendCorrections(store, "run", state, policy, [finding("R1", "internal/cli/cli.go", "Add a CLI regression assertion")], "repair");
    const added = (state.graph?.tasks ?? []).at(-1) as Task;
    expect(added.writes.map((w) => w.path).sort()).toEqual(["internal/cli/cli.go", "internal/cli/cli_test.go"]);
    expect(correctionAuthorized(added, graph)).toBe(true);
  });

  test("test files are matched to their source by name", () => {
    expect(isTestOf("internal/cli/cli_test.go", "internal/cli/cli.go")).toBe(true);
    expect(isTestOf("tests/test_cli.py", "src/app/cli.py")).toBe(true);
    expect(isTestOf("src/cli.test.ts", "src/cli.ts")).toBe(true);
    expect(isTestOf("src/test/java/CliTest.java", "src/main/java/Cli.java")).toBe(true);
    expect(isTestOf("tests/cli.rs", "src/cli.rs")).toBe(true);
    expect(isTestOf("tests/report.rs", "src/cli.rs")).toBe(false);
    expect(isTestOf("src/cli.ts", "src/cli.ts")).toBe(false);
    expect(isTestOf("tests/cli.test.ts", "tests/cli.test.ts")).toBe(false);
  });
});

// #765: a correction whose finding carries a repro starts by running it.
describe("a correction of a finding with a repro", () => {
  const finding = (repro?: Review["findings"][number]["repro"]) =>
    ({
      id: "R9",
      kind: "correctness",
      severity: "high",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      file: "src/lib.rs",
      symbol: null,
      evidenceIds: [],
      claim: "The parser drops the last value",
      impact: "Wrong report",
      suggestedFix: "Keep the last value",
      ...(repro ? { repro } : {}),
    }) as Review["findings"][number];
  const correct = (f: Review["findings"][number], predecessor = "T001") => {
    const state = stateOf();
    state.repairPredecessors[f.id] = predecessor;
    appendCorrections(store, "run", state, policy, [f], "repair");
    return ((state.graph?.tasks ?? []).at(-1) as Task).description;
  };

  test("is told to run the repro before editing and after the fix", () => {
    const description = correct(finding({ executable: "cargo", args: ["run", "--", "a,b"], expected: "2", actual: "1" }));
    expect(description).toContain('Reproduce first: run_repro runs "cargo" "run" "--" "a,b" as the host does before it accepts the task.');
    expect(description).toContain('print "1" where the spec needs "2"');
  });

  test("without a repro the description is unchanged", () => {
    expect(correct(finding())).not.toContain("Reproduce first");
  });

  // #1422: a document finding's repro that never reads the document is evidence; the host does
  // not run it and run_repro leaves it out (#1375), so the correction is not told to make it pass.
  test("of a document, with a repro that does not read it, is shown the repro as evidence only", () => {
    const repro = { executable: "cargo", args: ["run", "--", "a,b"], expected: "2", actual: "1" };
    const description = correct({ ...finding(repro), file: "src/lib.rs" });
    expect(description).toContain("Reproduce first");
    const doc = correct({ ...finding(repro), file: "docs/guide.md" }, "T004");
    expect(doc).not.toContain("Reproduce first");
    expect(doc).toContain('Evidence: the review ran "cargo" "run" "--" "a,b" and saw "1".');
    const reading = correct({ ...finding({ ...repro, args: ["run", "--", "docs/guide.md"] }), file: "docs/guide.md" }, "T004");
    expect(reading).toContain("Reproduce first");
  });
});

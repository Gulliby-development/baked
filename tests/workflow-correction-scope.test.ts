import { describe, expect, test } from "bun:test";
import {
  appendCorrections,
  correctionAuthorized,
  correctionBase,
  correctionChecks,
  correctionWrites,
} from "../src/core/verification/convergence.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { Review, RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { RuntimeState, Task } from "../src/core/workflows/types.js";

const task = (id: string, paths: string[], criteria: string[], extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: criteria,
  dependsOn: [],
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "modify" as const })),
  readHints: [],
  checkIds: ["tests"],
  origin: "planned",
  findingIds: [],
  rationale: id,
  ...extra,
});
const code = task("T001", ["src/parse.ts", "src/usage.ts"], ["AC-001", "AC-002"], {
  checkIds: ["typecheck", "lint"],
});
const tests = task("T002", ["tests/usage.test.ts"], ["AC-001"], { dependsOn: ["T001"] });
const other = task("T003", ["src/other.ts"], ["AC-009"]);
const root: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [code, tests, other],
};

describe("correction scope", () => {
  // Run 7c8bb5af: a review finding on the parser also needed the test that pinned the old default,
  // which belonged to the separate test task, so the correction could not finish.
  test("a correction of the code task may also write the tests of tasks with the same criteria", () => {
    const writes = correctionWrites(code, root, {}).map((w) => w.path);
    expect(writes).toEqual(["src/parse.ts", "src/usage.ts", "tests/usage.test.ts"]);
    expect(writes).not.toContain("src/other.ts");
    const correction = task("T004", writes, code.criterionIds, { origin: "repair", findingIds: ["F1"] });
    expect(correctionAuthorized(correction, root)).toBe(true);
  });

  // Run 54a7df1e: the correction could edit the test file but ran only lint and typecheck, so the
  // failing test came back unchanged and the run stopped with no_progress.
  test("a correction runs the checks of the related tasks too", () => {
    expect(correctionChecks(code, root)).toEqual(["typecheck", "lint", "tests"]);
    const correction = task("T004", correctionWrites(code, root, {}).map((w) => w.path), code.criterionIds, {
      origin: "repair",
      checkIds: correctionChecks(code, root),
    });
    expect(correctionAuthorized(correction, root)).toBe(true);
  });

  // Run 563e4f6c: a test task caught a bug in the code task's file. Its failing check is repaired
  // from the test task, and that correction may write the code file.
  test("a correction of the test task may write the code of tasks with the same criteria", () => {
    expect(correctionWrites(tests, root, {}).map((w) => w.path)).toEqual([
      "tests/usage.test.ts",
      "src/parse.ts",
      "src/usage.ts",
    ]);
  });

  test("files of unrelated tasks stay out of scope", () => {
    const widened = task("T004", ["src/parse.ts", "src/other.ts"], ["AC-001"], { origin: "repair" });
    expect(correctionAuthorized(widened, root)).toBe(false);
    const planned = task("T004", ["src/parse.ts"], ["AC-001"]);
    expect(correctionAuthorized(planned, root)).toBe(false);
  });

  test("a file the plan created is modified by the correction", () => {
    const created = task("T001", ["src/new.ts"], ["AC-001"], {
      writes: [{ path: "src/new.ts", action: "create" }],
    });
    const graph = { ...root, tasks: [created] };
    expect(correctionWrites(created, graph, { "src/new.ts": "hash" })[0]?.action).toBe("modify");
  });

  // Run 1185f909: a review finding on src/store.ts broke AC-004, which the plan gave to the CLI and
  // test tasks, while the store task covered AC-007 only; no task had both and the run blocked.
  test("a finding whose file and criterion belong to different tasks is corrected from the file's task", () => {
    const store = task("T001", ["src/store.ts"], ["AC-007"], { requirementIds: ["FR-002"] });
    const cli = task("T002", ["src/cli.ts"], ["AC-004"]);
    const suite = task("T003", ["tests/todo.test.ts"], ["AC-004", "AC-007"], {
      requirementIds: ["FR-001", "FR-002"],
    });
    const graph: TaskGraph = { ...root, tasks: [store, cli, suite] };
    const spec = {
      criteria: [
        { id: "AC-004", requirementIds: ["FR-001"] },
        { id: "AC-007", requirementIds: ["FR-002"] },
      ],
    } as unknown as Spec;
    const finding = { file: "src/store.ts", criterionIds: ["AC-004"], requirementIds: [] };
    const base = correctionBase(finding, graph, spec);
    expect(base?.id).toBe("T001");
    expect(base?.criterionIds).toEqual(["AC-007", "AC-004"]);
    expect(base?.requirementIds).toEqual(["FR-002", "FR-001"]);
    if (!base) throw new Error("no base");
    const writes = correctionWrites(base, graph, {}).map((w) => w.path);
    expect(writes).toEqual(["src/store.ts", "src/cli.ts", "tests/todo.test.ts"]);
    const correction = task("T004", writes, base.criterionIds, {
      origin: "repair",
      requirementIds: base.requirementIds,
      checkIds: correctionChecks(base, graph),
    });
    expect(correctionAuthorized(correction, graph)).toBe(true);
  });

  test("a finding on a file no planned task writes has no base", () => {
    const spec = { criteria: [] } as unknown as Spec;
    const finding = { file: "src/unknown.ts", criterionIds: ["AC-001"], requirementIds: [] };
    expect(correctionBase(finding, root, spec)).toBeUndefined();
  });

  // Run de6cf1ab stopped as budget_exhausted after its second repair round, and `extend --tokens`
  // could not help: the limit was maxRepairRounds.
  test("the reflection round limit blocks as no progress and names the setting", () => {
    const store = {
      run: () => ({ repair_rounds: 2, convergence_rounds: 0, corrective_tasks: 2 }),
    } as unknown as WorkflowStore;
    const state = {
      graph: root,
      rootGraph: root,
      spec: {},
      approvalRoot: "a".repeat(64),
    } as unknown as RuntimeState;
    const policy = { maxRepairRounds: 2, maxConvergenceRounds: 2, maxCorrectiveTasks: 20 } as RunPolicy;
    const findings = [{ id: "F1", claim: "Value is wrong", criterionIds: [], impact: "" }] as unknown as Review["findings"];
    let fault: unknown;
    try {
      appendCorrections(store, "run", state, policy, findings, "repair");
    } catch (error) {
      fault = error;
    }
    expect(fault).toBeInstanceOf(WorkflowFault);
    expect((fault as WorkflowFault).code).toBe("RECOVERY_REQUIRED");
    expect((fault as WorkflowFault).details.reason).toBe("no_progress");
    expect((fault as WorkflowFault).message).toContain("maxRepairRounds (2)");
  });
});

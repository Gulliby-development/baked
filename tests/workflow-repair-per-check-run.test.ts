import { describe, expect, test } from "bun:test";
import { appendCorrections } from "../src/core/verification/convergence.js";
import type { Review, RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { RuntimeState, Task } from "../src/core/workflows/types.js";
import { fixtureSpec } from "./helpers/workflow-fixture.js";

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
const root: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [
    task("T001", "src/frontMatter.ts"),
    task("T002", "src/site.ts"),
    task("T003", "tests/frontMatter.test.ts"),
    task("T004", "tests/site.test.ts"),
  ],
};
const policy = { maxRepairRounds: 3, maxConvergenceRounds: 3, maxCorrectiveTasks: 20 } as RunPolicy;
const store = {
  run: () => ({ repair_rounds: 0, convergence_rounds: 0, corrective_tasks: 0 }),
  artifact: () => ({ content_hash: "h".repeat(64) }),
  syncTasks: () => undefined,
  tasks: () => [],
  findingStatus: () => undefined,
  addRound: () => undefined,
} as unknown as WorkflowStore;
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
  }) as unknown as RuntimeState;
const finding = (id: string, file: string, evidenceId: string): Review["findings"][number] => ({
  id,
  kind: "correctness",
  severity: "high",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file,
  symbol: null,
  evidenceIds: [evidenceId],
  claim: "Required check tests failed",
  impact: "Implementation cannot be accepted",
  suggestedFix: "Fix it",
});

describe("repair per failing check run", () => {
  // md-site c0456d78: four findings of one failing test run (evidence 8a12ad65) became tasks
  // T008-T011, 494,656 tokens, each reading the same files.
  test("findings that cite one check run become one corrective task writing every file", () => {
    const state = stateOf();
    appendCorrections(
      store,
      "run",
      state,
      policy,
      [
        finding("3b5302f0", "src/frontMatter.ts", "8a12ad65"),
        finding("e17e4c17", "src/site.ts", "8a12ad65"),
        finding("1f8ed4c5", "tests/frontMatter.test.ts", "8a12ad65"),
        finding("888490e4", "tests/site.test.ts", "8a12ad65"),
      ],
      "repair",
    );
    const added = (state.graph?.tasks ?? []).slice(4);
    expect(added).toHaveLength(1);
    expect(added[0]?.findingIds).toEqual(["3b5302f0", "e17e4c17", "1f8ed4c5", "888490e4"]);
    expect(added[0]?.writes.map((w) => w.path).sort()).toEqual([
      "src/frontMatter.ts",
      "src/site.ts",
      "tests/frontMatter.test.ts",
      "tests/site.test.ts",
    ]);
    expect(added[0]?.checkIds).toEqual(["tests"]);
  });

  test("findings of different check runs stay separate tasks", () => {
    const state = stateOf();
    appendCorrections(
      store,
      "run",
      state,
      policy,
      [finding("F1", "src/site.ts", "E1"), finding("F2", "tests/site.test.ts", "E2")],
      "repair",
    );
    expect((state.graph?.tasks ?? []).slice(4)).toHaveLength(2);
  });

  test("review findings are not merged by evidence", () => {
    const state = stateOf();
    const review = (id: string, file: string) => ({
      ...finding(id, file, "E1"),
      claim: "The slug is wrong",
    });
    appendCorrections(
      store,
      "run",
      state,
      policy,
      [review("F1", "src/site.ts"), review("F2", "src/frontMatter.ts")],
      "repair",
    );
    expect((state.graph?.tasks ?? []).slice(4)).toHaveLength(2);
  });
});

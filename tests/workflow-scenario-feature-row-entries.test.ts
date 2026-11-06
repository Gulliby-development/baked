import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { framedFeatureRows } from "../src/core/workflows/feature-rows.js";
import { hostApplyContents, hostApplyRecords } from "../src/core/workflows/host-apply.js";
import { type InitiativeFeature, type InitiativePlan, applySplitEdit, featureRowFiles, featureRowSplit, rowOwnerProblems } from "../src/core/workflows/initiatives/plan.js";
import { featurePrompt } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeRow } from "../src/core/workflows/initiatives/store.js";
import { rowBlockDrifts } from "../src/core/workflows/row-block-drift.js";
import type { RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { suppliedRows } from "../src/core/workflows/sizing.js";
import { notPrescribedFindings, perRowReading } from "../src/core/workflows/supplied-content.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { runRoot } from "../src/core/workflows/worktree.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #2939, bench round 100 retrylane (Go): the decomposer gave tally two typed `rows` entries for
// `edges_test.go`, `[5]` and `[8]`, because breaker owns rows 6-7 between them. `featureRowSplit`
// read only the first entry, so tally's run held rows 1-7 of 8: the host wrote 7 rows, review
// found row 8 missing, `place_rows` refused it and T003 ended in a spec conflict (1.54M tokens).
// The same cut block gave a false `row_block_drift` would-stop on the real row 8 and a
// `case_not_prescribed` note with `perRow: none` on a criterion that row 8 holds.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";
const EDGES = "edges_test.go";
const SCAFFOLD = "scaffold_test.go";
const ROWS = [
  '{"retry once", "attempts 1"}',
  '{"retry twice", "attempts 2"}',
  '{"retry backoff", "waited 30ms"}',
  '{"retry give up", "gave up after 3"}',
  '{"tally counts", "tally 4"}',
  '{"breaker opens", "breaker open"}',
  '{"breaker resets", "breaker closed"}',
  '{"skipped-line tally", "skipped 1 line"}',
];
const brief = ["Build retrylane, a retry lane runner.", "", `${fence}go`, `edges in ${EDGES} (8 rows: name | output)`, ...ROWS, fence, ""].join("\n");
const goFile = (rows: readonly string[]) =>
  ["package retrylane", "", 'import "testing"', "", "var edges = []struct{ name, out string }{", ...rows.map((r) => `\t${r},`), "}", "", "func TestEdges(t *testing.T) { checkRows(t, edges) }", ""].join("\n");
const SCAFFOLD_FILE = goFile(['{"", ""}']);

const feature = (id: string, dependsOn: string[], rows: InitiativeFeature["rows"]): InitiativeFeature => ({
  id,
  title: id,
  boundary: { scope: `The ${id} lane.`, paths: [`${id}.go`, EDGES] },
  contract: `The ${id} lane of retrylane.`,
  dependsOn,
  mandatory: true,
  rows,
});
/** Plan revision 1 of R100 retrylane, cut to the shared file: tally's rows are two entries. */
const retrylane = (tally: InitiativeFeature["rows"] = [{ path: EDGES, rows: [5] }, { path: EDGES, rows: [8] }]): InitiativePlan => ({
  schemaVersion: 1,
  title: "retrylane",
  goals: ["retrylane runs retry lanes."],
  completionCriteria: ["Every prescribed row passes."],
  features: [
    feature("retry", [], [{ path: EDGES, rows: [1, 2, 3, 4] }]),
    feature("breaker", ["retry"], [{ path: EDGES, rows: [6, 7] }]),
    feature("tally", ["retry", "breaker"], tally),
  ],
});
const row = { id: "retrylane", prompt: brief } as InitiativeRow;
const promptOf = (plan: InitiativePlan, id: string, request = brief) =>
  featurePrompt({ ...row, prompt: request } as InitiativeRow, plan, plan.features.find((f) => f.id === id)!, []);

describe("a feature's typed rows for one path in several entries (#2939)", () => {
  test("Go, R100 retrylane: tally owns rows 5 and 8, with no row-split problem", () => {
    const split = featureRowSplit(retrylane(), brief).get(EDGES);
    expect(split?.total).toBe(8);
    expect(Object.fromEntries(split?.own ?? [])).toEqual({ retry: [1, 2, 3, 4], breaker: [6, 7], tally: [5, 8] });
    // On main: "edges_test.go: no feature claims row 8 of 8".
    expect(split?.problems).toEqual([]);
    expect(rowOwnerProblems(retrylane(), brief)).toEqual([]);
  });

  test("two entries read as the one entry [5, 8]", () => {
    const one = retrylane([{ path: EDGES, rows: [5, 8] }]);
    const two = retrylane();
    expect(featureRowFiles(two, brief, { id: "tally" })).toEqual(featureRowFiles(one, brief, { id: "tally" }));
    expect(promptOf(two, "tally")).toBe(promptOf(one, "tally"));
  });

  test("tally's prompt states rows 1-8, and every reader of its run sees row 8", () => {
    const prompt = promptOf(retrylane(), "tally");
    expect(prompt).toContain(`- ${EDGES}: rows 1-8 of 8 (rows 1-4, 6-7 are upstream features' and stay as delivered; this feature adds rows 5, 8)`);
    expect(framedFeatureRows(prompt)?.get(EDGES)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(suppliedRows(prompt, [EDGES]).get(EDGES)?.lines).toEqual(ROWS);
  });

  test("row_block_drift: tally's 8-row file is no drift against its block", () => {
    const graph = { tasks: [{ id: "T002", writes: [{ path: EDGES, action: "modify" }] }] } as unknown as Pick<TaskGraph, "tasks">;
    const found = rowBlockDrifts(promptOf(retrylane(), "tally"), graph, () => goFile(ROWS));
    expect(found).toHaveLength(1);
    // On main: the block prescribed 7 rows and row 8 (added line 13) was an extra.
    expect(found[0]?.record.rows).toHaveLength(8);
    expect(found.flatMap((f) => [...f.drifts, ...f.extras])).toEqual([]);
  });

  test("case walk: a criterion row 8 holds is prescribed, so no case_not_prescribed note and no perRow none", () => {
    const spec: Spec = {
      ...fixtureSpec,
      criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a lane that skips a line", when: "tally runs", then: "it prints `skipped 1 line`", method: "automated" }],
    };
    const tasks = [{ id: "T002", description: "Deliver tally's edges rows.", criterionIds: ["AC-001"], writes: [{ path: EDGES, action: "modify" }], dependsOn: [] }] as unknown as Task[];
    const prompt = promptOf(retrylane(), "tally");
    expect(notPrescribedFindings(spec, { tasks }, prompt, { checks: [] })).toEqual([]);
    expect([...perRowReading(spec, { tasks }, prompt, { checks: [] }).noted]).toEqual([]);
  });

  test("Swift, R100 verpick: entries [8] and [9, 10] give own rows 8-10 and prompt rows 1-10", () => {
    const path = "Tests/VerpickTests/EdgesRowsTests.swift";
    const rows = Array.from({ length: 10 }, (_, i) => `  ("edge ${i + 1}", ${i + 1}),`);
    const request = ["Build verpick.", "", `${fence}swift`, `EdgesRowsTests in ${path} (10 rows)`, ...rows, fence, ""].join("\n");
    const swift = (id: string, dependsOn: string[], typed: InitiativeFeature["rows"]): InitiativeFeature => ({ ...feature(id, dependsOn, typed), boundary: { scope: `The ${id} part.`, paths: [`Sources/Verpick/${id}.swift`, path] } });
    const plan: InitiativePlan = {
      schemaVersion: 1,
      title: "verpick",
      goals: ["g"],
      completionCriteria: ["c"],
      features: [swift("parse", [], [{ path, rows: [1, 2, 3, 4, 5, 6, 7] }]), swift("pick", ["parse"], [{ path, rows: [8] }, { path, rows: [9, 10] }])],
    };
    const split = featureRowSplit(plan, request).get(path);
    expect(split?.own.get("pick")).toEqual([8, 9, 10]);
    expect(split?.problems).toEqual([]);
    expect(featureRowFiles(plan, request, { id: "pick" })[0]?.rows).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(promptOf(plan, "pick", request)).toContain(`- ${path}: rows 1-10 of 10`);
  });

  test("a merge keeps the typed rows of every merged feature, one entry per path", () => {
    const docs: InitiativeFeature = { id: "docs", title: "docs", boundary: { scope: "README.", paths: ["README.md"] }, contract: "docs", dependsOn: ["tally"], mandatory: true };
    const plan = { ...retrylane(), features: [...retrylane().features, docs] };
    const merged = applySplitEdit(plan, { op: "merge", featureIds: ["breaker", "tally"], id: "counts" });
    expect(merged.features.find((f) => f.id === "counts")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
    expect(Object.fromEntries(featureRowSplit(merged, brief).get(EDGES)?.own ?? [])).toEqual({ retry: [1, 2, 3, 4], counts: [5, 6, 7, 8] });
  });
});

/** T001 writes the source; T002 is the row file the host writes from the scaffold. */
class EdgesExecutor extends FixtureExecutor {
  sessions: string[] = [];
  constructor(workspace: string, existing: string, git: boolean) {
    super(workspace);
    writeFileSync(join(workspace, SCAFFOLD), SCAFFOLD_FILE);
    writeFileSync(join(workspace, EDGES), existing);
    if (git) {
      for (const args of [["init"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["config", "core.autocrlf", "false"], ["add", "-A"], ["-c", "core.hooksPath=", "commit", "-m", "Fixture"]])
        expect(Bun.spawnSync(["git", ...args], { cwd: workspace }).exitCode).toBe(0);
    }
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push({ ...first, id: "T002", title: "Deliver tally's edges rows", dependsOn: ["T001"], writes: [{ path: EDGES, action: "modify" }], reference: SCAFFOLD, checkIds: [] });
    }
    if (request.profile.output === "implementation") {
      this.sessions.push(request.task?.id ?? "");
      if (request.task?.id === "T001" && request.root) writeFileSync(join(request.root, "value.txt"), "ready");
    }
    return result;
  }
}

/** The file retry and breaker delivered: the host's own writes of rows 1-4, then 1-4 and 6-7. */
async function deliveredBefore(plan: InitiativePlan): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "feature-row-entries-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(dirname(join(root, EDGES)), { recursive: true });
  writeFileSync(join(root, SCAFFOLD), SCAFFOLD_FILE);
  const task = { writes: [{ path: EDGES, action: "create" as const }], reference: SCAFFOLD };
  let content = "";
  for (const id of ["retry", "breaker"]) {
    const [write] = await hostApplyContents(root, promptOf(plan, id), task);
    content = write?.content ?? "";
    writeFileSync(join(root, EDGES), content);
  }
  return content;
}

describe("scenario: R100 retrylane, tally's run writes all 8 rows of edges_test.go (#2939)", () => {
  for (const writers of [1, 2]) {
    test(`writers ${writers}: on breaker's 6-row file the host adds rows 5 and 8`, async () => {
      const plan = retrylane();
      const before = await deliveredBefore(plan);
      for (const n of [1, 2, 3, 4, 6, 7]) expect(before).toContain(ROWS[n - 1]!);
      expect(before).not.toContain(ROWS[4]!);
      expect(before).not.toContain(ROWS[7]!);
      const policy: RunPolicy = { ...fixturePolicy, rowFileWrite: "on", ...(writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: writers } : {}) };
      let executor: EdgesExecutor | undefined;
      const fixture = workflowFixture({
        policy,
        executor: (root) => {
          executor = new EdgesExecutor(root, before, writers > 1);
          return executor;
        },
      });
      cleanups.push(fixture.dispose);
      const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: promptOf(plan, "tally"), ownerLabel: "test", policy, ...(writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: writers } : {}) });
      let current = await fixture.service.drive(run.runId, new AbortController().signal);
      for (let i = 0; i < 8 && current.status === "waiting"; i++) {
        if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
        await fixture.approve(run.runId);
        current = await fixture.service.drive(run.runId, new AbortController().signal);
      }
      const store = fixture.service.store;
      expect((await fixture.service.get(run.runId)).status).toBe("completed");
      expect(executor?.sessions).toEqual(["T001"]);
      const record = hostApplyRecords(store, run.runId).find((r) => r.taskId === "T002");
      expect(record).toMatchObject({ mode: "on", applied: true });
      // On main the host wrote 7 rows: row 8 had no owner.
      expect(record?.writes[0]?.rows?.count).toBe(8);
      const file = readFileSync(join(runRoot(fixture.root, store.state(run.runId)), EDGES), "utf8");
      const at = ROWS.map((r) => file.indexOf(r));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    }, 120000);
  }
});

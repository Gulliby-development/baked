import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type InitiativeFeature, type InitiativePlan, applySplitEdit, featureRowFiles, featureRowSplit, rowOwnerProblems } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// Follow-up of #2939 (#2942): the `split` edit built its parts from the original feature's
// boundary, contract and skeleton but not its typed `rows`. Every part then stated no rows of a
// shared row file, and a sharer that states none takes the rows no sharer states: the split
// feature's rows went to every silent sharer, here breaker, whose run then held rows 5-8 its code
// cannot pass, with no row-split record. Each path's rows now go to the first part whose paths
// name it, as the skeleton's files do (`partRows`).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";

/** Go (the R100 retrylane file) and a TypeScript layout of the same split. */
const layouts = [
  { language: "Go", edges: "edges_test.go", source: (id: string) => `${id}.go`, test: (id: string) => `${id}_test.go`, rows: Array.from({ length: 8 }, (_, i) => `{"edge ${i + 1}", "out ${i + 1}"},`) },
  { language: "TypeScript", edges: "tests/edges.test.ts", source: (id: string) => `src/${id}.ts`, test: (id: string) => `tests/${id}.test.ts`, rows: Array.from({ length: 8 }, (_, i) => `["edge ${i + 1}", "out ${i + 1}"],`) },
];

for (const layout of layouts) {
  const EDGES = layout.edges;
  const brief = ["Build retrylane, a retry lane runner.", "", `${fence}text`, `edges in ${EDGES} (8 rows: name | output)`, ...layout.rows, fence, ""].join("\n");
  const feature = (id: string, dependsOn: string[], rows?: InitiativeFeature["rows"]): InitiativeFeature => ({
    id, title: id, boundary: { scope: `The ${id} lane.`, paths: [layout.source(id), EDGES] }, contract: `The ${id} lane of retrylane.`, dependsOn, mandatory: true, ...(rows ? { rows } : {}),
  });
  /** retry and tally type their rows; breaker states none and so takes the rows nobody states. */
  const split = (): InitiativePlan => ({
    schemaVersion: 1, title: "retrylane", goals: ["retrylane runs retry lanes."], completionCriteria: ["Every prescribed row passes."],
    features: [
      feature("retry", [], [{ path: EDGES, rows: [1, 2, 3, 4] }]),
      feature("breaker", ["retry"]),
      feature("tally", ["retry"], [{ path: EDGES, rows: [5, 6] }, { path: EDGES, rows: [7, 8] }]),
      { id: "docs", title: "docs", boundary: { scope: "The README.", paths: ["README.md"] }, contract: "The README documents retrylane.", dependsOn: ["breaker", "tally"], mandatory: true },
    ],
  });
  const own = (plan: InitiativePlan) => Object.fromEntries(featureRowSplit(plan, brief).get(EDGES)?.own ?? []);
  const report = { id: "report", title: "report", paths: [layout.source("report"), layout.test("report")] };

  describe(`${layout.language}: the split edit keeps the split feature's typed rows (#2939 follow-up)`, () => {
    test("before the split tally owns rows 5-8 and breaker none", () => {
      expect(own(split())).toEqual({ retry: [1, 2, 3, 4], breaker: [], tally: [5, 6, 7, 8] });
    });

    test("parts that keep the paths: the first part owns rows 5-8, breaker still none", () => {
      const next = applySplitEdit(split(), { op: "split", featureId: "tally", into: [{ id: "tally", title: "tally" }, report] });
      expect(next.features.find((f) => f.id === "tally")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
      expect(next.features.find((f) => f.id === "report")?.rows).toBeUndefined();
      // On main: { breaker: [5, 6, 7, 8], tally: [5, 6, 7, 8] }, and no row-split record.
      expect(own(next)).toEqual({ retry: [1, 2, 3, 4], breaker: [], tally: [5, 6, 7, 8] });
      expect(featureRowFiles(next, brief, { id: "breaker" })).toEqual([{ path: EDGES, total: 8, rows: [1, 2, 3, 4], upstream: [1, 2, 3, 4] }]);
      expect(rowOwnerProblems(next, brief)).toEqual([]);
    });

    test("the rows go to the first part whose paths name the row file", () => {
      const into = [{ id: "count", title: "count", paths: [layout.source("count"), layout.test("count")] }, { id: "tally", title: "tally" }];
      const next = applySplitEdit(split(), { op: "split", featureId: "tally", into });
      expect(next.features.find((f) => f.id === "count")?.rows).toBeUndefined();
      expect(next.features.find((f) => f.id === "tally")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
      expect(own(next)).toEqual({ retry: [1, 2, 3, 4], breaker: [], tally: [5, 6, 7, 8] });
    });

    test("a part keeps the rows of every path it names, and only those", () => {
      const other = "tests/other_rows.txt";
      const plan = split();
      const tally = plan.features[2]!;
      const wide = { ...plan, features: plan.features.map((f) => (f.id === "tally" ? { ...tally, boundary: { ...tally.boundary, paths: [...tally.boundary.paths, other] }, rows: [...(tally.rows ?? []), { path: other, rows: [2] }] } : f)) };
      const into = [{ id: "tally", title: "tally", paths: [layout.source("tally"), EDGES] }, { id: "other", title: "other", paths: [layout.source("other"), other] }];
      const next = applySplitEdit(wide, { op: "split", featureId: "tally", into });
      expect(next.features.find((f) => f.id === "tally")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
      expect(next.features.find((f) => f.id === "other")?.rows).toEqual([{ path: other, rows: [2] }]);
    });
  });

  describe(`scenario, ${layout.language}: a person splits tally through the initiative service`, () => {
    test("the new revision keeps tally's rows and breaker's run holds none of them", async () => {
      class Decomposer implements AgentExecutor {
        async execute(request: ExecutionRequest) {
          if (request.profile.output !== "initiativePlan") throw new Error(`Unexpected profile ${request.profile.output}`);
          return { output: split(), inputTokens: 20, outputTokens: 30 };
        }
      }
      const root = mkdtempSync(join(tmpdir(), "baked-split-keeps-rows-"));
      const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: fixturePolicy } };
      const workflows = new NativeWorkflowService(root, config, new Decomposer());
      const initiatives = new InitiativeService(workflows);
      cleanups.push(() => {
        workflows.close();
        rmSync(root, { recursive: true, force: true });
      });
      const id = "retrylane";
      await initiatives.start({ commandId: newId(), initiativeId: id, prompt: brief, policy: fixturePolicy, ownerLabel: "test", keepFeatures: true });
      expect((await initiatives.drive(id, new AbortController().signal)).status).toBe("awaiting_approval");
      const command = () => ({ commandId: newId(), expectedRevision: initiatives.view(id).revision });
      await initiatives.edit(id, command(), { op: "split", featureId: "tally", into: [{ id: "tally", title: "tally" }, report] });
      const row = initiatives.store.get(id);
      const plan = initiatives.store.plan(initiatives.store.revision(id, row.plan_revision));
      expect(row.plan_revision).toBe(2);
      expect(plan.features.find((f) => f.id === "tally")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
      expect(featureRowFiles(plan, brief, { id: "breaker" })[0]?.rows).toEqual([1, 2, 3, 4]);
      expect(featureRowFiles(plan, brief, { id: "tally" })[0]?.rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }, 60000);
  });
}

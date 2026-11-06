import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type InitiativeFeature, type InitiativePlan, applySplitEdit, featureRowFiles, featureRowSplit, mergeSmallSiblings, rowOwnerProblems } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// Follow-up of #2939 (#2942): a merge joins the parts' typed `rows`, and a typed entry hides the
// merged scope's words. When one part owned rows of a shared row file in typed rows and another
// owned rows of the same file only in its scope's words ("edges rows 5-6"), or took the rows no
// sharer states, the merged feature kept only the typed rows: nobody owned the other part's rows,
// no feature's run wrote them, and the initiative recorded an `initiative-row-owner` would-stop of
// shape `row-split` ("no feature claims rows 5-6 of 8"). The merged feature now owns every row
// its parts owned (`mergedPartRows`), from the small-sibling merge and from the `merge` edit.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";

/** Go (the R100 retrylane file) and a TypeScript layout of the same split. */
const layouts = [
  { language: "Go", edges: "edges_test.go", source: (id: string) => `${id}.go`, rows: Array.from({ length: 8 }, (_, i) => `{"edge ${i + 1}", "out ${i + 1}"},`) },
  { language: "TypeScript", edges: "tests/edges.test.ts", source: (id: string) => `src/${id}.ts`, rows: Array.from({ length: 8 }, (_, i) => `["edge ${i + 1}", "out ${i + 1}"],`) },
];

for (const layout of layouts) {
  const EDGES = layout.edges;
  const brief = ["Build retrylane, a retry lane runner.", "", `${fence}text`, `edges in ${EDGES} (8 rows: name | output)`, ...layout.rows, fence, ""].join("\n");
  const feature = (id: string, dependsOn: string[], extra: Partial<InitiativeFeature> = {}): InitiativeFeature => ({
    id, title: id, boundary: { scope: `The ${id} lane.`, paths: [layout.source(id), EDGES] }, contract: `The ${id} lane of retrylane.`, dependsOn, mandatory: true, ...extra,
  });
  const docs: InitiativeFeature = { id: "docs", title: "docs", boundary: { scope: "The README.", paths: ["README.md"] }, contract: "The README documents retrylane.", dependsOn: ["breaker", "tally"], mandatory: true };
  /** retry and tally type their rows; breaker says its rows in words, or (`silent`) none. */
  const split = (breaker: "words" | "silent" = "words"): InitiativePlan => ({
    schemaVersion: 1, title: "retrylane", goals: ["retrylane runs retry lanes."], completionCriteria: ["Every prescribed row passes."],
    features: [
      { ...feature("retry", [], { rows: [{ path: EDGES, rows: [1, 2, 3, 4] }] }), boundary: { scope: "The retry lane.", paths: [layout.source("retry"), layout.source("backoff"), EDGES] } },
      feature("breaker", ["retry"], breaker === "words" ? { boundary: { scope: "The breaker lane: edges rows 5-6.", paths: [layout.source("breaker"), EDGES] } } : {}),
      feature("tally", ["retry"], { rows: [{ path: EDGES, rows: [7, 8] }] }),
      docs,
    ],
  });

  describe(`${layout.language}: a merge of typed rows with rows in words or untyped (#2939 follow-up)`, () => {
    test("before the merge every row of edges has one owner", () => {
      for (const kind of ["words", "silent"] as const) {
        expect(Object.fromEntries(featureRowSplit(split(kind), brief).get(EDGES)?.own ?? [])).toEqual({ retry: [1, 2, 3, 4], breaker: [5, 6], tally: [7, 8] });
        expect(rowOwnerProblems(split(kind), brief)).toEqual([]);
      }
    });

    for (const kind of ["words", "silent"] as const) {
      test(`small-sibling merge, breaker ${kind}: counts owns rows 5-8 and no row is unclaimed`, () => {
        const { plan, merged } = mergeSmallSiblings(split(kind), { request: brief });
        expect(merged).toEqual([{ featureId: "breaker", from: ["breaker", "tally"] }]);
        expect(plan.features.find((f) => f.id === "breaker")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
        expect(Object.fromEntries(featureRowSplit(plan, brief).get(EDGES)?.own ?? [])).toEqual({ retry: [1, 2, 3, 4], breaker: [5, 6, 7, 8] });
        // On main: "edges: no feature claims rows 5-6 of 8".
        expect(rowOwnerProblems(plan, brief)).toEqual([]);
        expect(featureRowFiles(plan, brief, { id: "breaker" })).toEqual([{ path: EDGES, total: 8, rows: [1, 2, 3, 4, 5, 6, 7, 8], upstream: [1, 2, 3, 4] }]);
      });
    }

    test("merge edit: the merged feature owns breaker's rows in words and tally's typed rows", () => {
      const merged = applySplitEdit(split(), { op: "merge", featureIds: ["breaker", "tally"], id: "counts" }, brief);
      expect(merged.features.find((f) => f.id === "counts")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
      expect(rowOwnerProblems(merged, brief)).toEqual([]);
    });

    test("a silent part leaves its rows untyped while a sharer outside the merge is silent too", () => {
      const plan = split("silent");
      const withLog = { ...plan, features: [...plan.features.slice(0, 3), feature("log", ["retry"]), { ...docs, dependsOn: ["breaker", "tally", "log"] }] };
      const merged = applySplitEdit(withLog, { op: "merge", featureIds: ["breaker", "tally"], id: "counts" }, brief);
      expect(merged.features.find((f) => f.id === "counts")?.rows).toEqual([{ path: EDGES, rows: [7, 8] }]);
      expect(featureRowSplit(merged, brief).get(EDGES)?.own.get("log")).toEqual([5, 6]);
      expect(rowOwnerProblems(merged, brief)).toEqual([]);
    });

    test("parts that all state no rows stay untyped", () => {
      const plain = { ...split("silent"), features: split("silent").features.map(({ rows: _rows, ...f }) => f) };
      const merged = applySplitEdit(plain, { op: "merge", featureIds: ["breaker", "tally"], id: "counts" }, brief);
      expect(merged.features.find((f) => f.id === "counts")?.rows).toBeUndefined();
    });
  });

  describe(`scenario, ${layout.language}: the decomposer's split through the initiative service`, () => {
    const launch = async (initiativeId: string, keepFeatures: boolean) => {
      class Decomposer implements AgentExecutor {
        async execute(request: ExecutionRequest) {
          if (request.profile.output !== "initiativePlan") throw new Error(`Unexpected profile ${request.profile.output}`);
          return { output: split(), inputTokens: 20, outputTokens: 30 };
        }
      }
      const root = mkdtempSync(join(tmpdir(), "baked-merge-word-rows-"));
      const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: fixturePolicy } };
      const workflows = new NativeWorkflowService(root, config, new Decomposer());
      const initiatives = new InitiativeService(workflows);
      cleanups.push(() => {
        workflows.close();
        rmSync(root, { recursive: true, force: true });
      });
      await initiatives.start({ commandId: newId(), initiativeId, prompt: brief, policy: fixturePolicy, ownerLabel: "test", keepFeatures });
      const view = await initiatives.drive(initiativeId, new AbortController().signal);
      const wouldStops = () =>
        initiatives
          .events(initiativeId)
          .filter((e) => e.type === "decision.would_stop" && (e.payload as { reason?: string }).reason === "initiative-row-owner")
          .map((e) => e.payload);
      const plan = (): InitiativePlan => {
        const row = initiatives.store.get(initiativeId);
        return initiatives.store.plan(initiatives.store.revision(initiativeId, row.plan_revision));
      };
      return { initiatives, view, wouldStops, plan };
    };

    test("the host's sibling merge records no row-split would-stop and the merged run holds rows 5-8", async () => {
      const { view, wouldStops, plan: latest } = await launch("retrylane", false);
      expect(view.status).toBe("awaiting_approval");
      expect(view.features.map((f) => f.id)).toEqual(["retry", "breaker", "docs"]);
      // On main: a `row-split` would-stop, "no feature claims rows 5-6 of 8".
      expect(wouldStops()).toEqual([]);
      expect(featureRowSplit(latest(), brief).get(EDGES)?.own.get("breaker")).toEqual([5, 6, 7, 8]);
    }, 60000);

    test("a person's merge edit keeps breaker's rows in the merged feature", async () => {
      const { initiatives, plan: latest } = await launch("retrylane-edit", true);
      const id = () => ({ commandId: newId(), expectedRevision: initiatives.view("retrylane-edit").revision });
      await initiatives.edit("retrylane-edit", id(), { op: "merge", featureIds: ["breaker", "tally"], id: "counts" });
      const plan = latest();
      expect(plan.features.find((f) => f.id === "counts")?.rows).toEqual([{ path: EDGES, rows: [5, 6, 7, 8] }]);
      expect(rowOwnerProblems(plan, brief)).toEqual([]);
    }, 60000);
  });
}

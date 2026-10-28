import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type SizingReport, type SizingSample, samplesFrom, testCaseRate } from "../src/core/workflows/sizing.js";
import { openTrace, replayInitiativeStarts } from "../src/core/workflows/trace.js";
import { ROOT } from "./helpers/replay-corpus.js";

// Part of the bench-trace replay corpus (tests/forecast-replay-corpus.test.ts), in a file of its own
// because it replays every initiative start of the corpus and takes minutes on a CI runner.

/** Finished test tasks of a trace's initiative feature runs, with the cases their sizing reports recorded. */
function featureTestTasks(path: string): Map<string, SizingSample[]> {
  const { store, workspace, dispose } = openTrace(path);
  try {
    const cases = new Map<string, number>();
    for (const { runId, id } of store.connection
      .query("SELECT run_id AS runId, id FROM artifacts WHERE logical_path LIKE 'sizing/plan-%' ORDER BY created_at, id")
      .all() as { runId: string; id: string }[])
      for (const task of (JSON.parse(store.readArtifact(runId, id)) as Partial<SizingReport>).tasks ?? [])
        if (task.kind === "test" && (task.cases ?? 0) > 0) cases.set(`${runId}/${task.taskId}`, task.cases ?? 0);
    const features = new Map(
      (store.connection.query("SELECT run_id AS runId, feature_id AS featureId FROM initiative_runs").all() as {
        runId: string;
        featureId: string;
      }[]).map((r) => [r.runId, r.featureId]),
    );
    const byFeature = new Map<string, SizingSample[]>();
    for (const sample of samplesFrom(join(workspace, ".baked", "workflows.sqlite"), "project")) {
      const feature = features.get(sample.runId);
      const count = cases.get(`${sample.runId}/${sample.taskId}`);
      if (sample.kind !== "test" || !feature || !count) continue;
      byFeature.set(feature, [...(byFeature.get(feature) ?? []), { ...sample, cases: count }]);
    }
    return byFeature;
  } finally {
    dispose();
  }
}

describe("a brief's test volume replays on recorded test tasks (#2055)", () => {
  // The traces' briefs are anonymized, so the cases each feature's sizing reports recorded stand in
  // for the volume a brief demands. Each finished feature is priced from its initiative's other
  // finished features (this project's runs, the rate's first basis): its test tasks' cases times
  // the cheapest of their rates is a floor of its need, and a floor above what the feature's test
  // tasks alone used is an overprice. A rate of single tasks would be no floor: they ran from 1,354
  // tokens a case, so 509 cases of nodepluck floored at 0.69M of its 15.24M test tokens. Per run the
  // floor binds: nodepluck's readcmd, 110 cases at 21,124 a case, is floored at 2.32M of the 4.04M
  // its test tasks used and the 6.24M the feature used. Above its test tokens: 20 of 162 features.
  test("a feature's test-volume floor stays under what its test tasks used, nodepluck's binds", () => {
    let features = 0;
    let above = 0;
    let readcmd: { floor: number; tokens: number } | null = null;
    for (const path of readdirSync(ROOT, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".sqlite.gz"))
      .map((p) => join(ROOT, p))) {
      if (!replayInitiativeStarts(path).length) continue;
      const tasks = featureTestTasks(path);
      for (const [featureId, own] of tasks) {
        const rate = testCaseRate([...tasks].filter(([id]) => id !== featureId).flatMap(([, s]) => s));
        if (rate.basis !== "project") continue;
        const cases = own.reduce((n, s) => n + (s.cases ?? 0), 0);
        const tokens = own.reduce((n, s) => n + s.tokens, 0);
        const floor = cases * rate.perCase.low;
        features++;
        if (floor > tokens) above++;
        if (path.endsWith("nodepluck.sqlite.gz") && featureId === "readcmd") readcmd = { floor, tokens };
      }
    }
    expect(features).toBeGreaterThanOrEqual(150);
    expect(above / features).toBeLessThanOrEqual(0.25 + 2 * Math.sqrt((0.25 * 0.75) / features));
    expect(readcmd).toEqual({ floor: 110 * 21_124, tokens: 4_044_583 });
  }, 600000);
});

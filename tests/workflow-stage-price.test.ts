import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costStageOf, forecastSamples, stepTree } from "../src/core/workflows/stage-price.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Kills the mutants the hot-module mutation run left alive in stage-price.ts (#1723).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function emptyStore(): WorkflowStore {
  const root = mkdtempSync(join(tmpdir(), "baked-stage-price-"));
  const store = new WorkflowStore(root);
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

describe("owning stage", () => {
  test("a step whose parent is not in the run's tree is priced at its own stage", () => {
    const steps = new Map([
      ["review", { stage_id: "review", parent_step_id: null }],
      ["dimension", { stage_id: "dimension-security", parent_step_id: "review" }],
      ["orphan", { stage_id: "task-T001", parent_step_id: "gone" }],
    ]);
    const store = emptyStore();
    expect(costStageOf(store, "r", "dimension", steps)).toBe("review");
    expect(costStageOf(store, "r", "orphan", steps)).toBe("implement");
    expect(costStageOf(store, "r", "missing", steps)).toBe("");
  });
});

describe("forecast samples", () => {
  test("a step tree known for one run is not used to price another run's attempts", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const runs = [await fixture.start(), await fixture.start()].map((run) => run.runId);
    for (const runId of runs) {
      store.transaction(() => store.transition(runId, "running"));
      const review = store.beginStep(runId, "review");
      const dimension = store.beginStep(runId, "dimension-security", review);
      store.reserve(runId, dimension, "fixture/model", 100, fixture.policy);
    }
    const [first, second] = runs as [string, string];
    const rows = forecastSamples(store, [first, second], stepTree(store, first));
    expect(rows.map((row) => row.stage)).toEqual(["review", "review"]);
  });

  test("a store keeps the samples of its 256 most recently read runs", () => {
    const store = emptyStore();
    const read = store.attempts.bind(store);
    const reads: string[] = [];
    store.attempts = (runId: string) => {
      reads.push(runId);
      return read(runId);
    };
    const reread = (runId: string) => {
      reads.length = 0;
      forecastSamples(store, [runId]);
      return reads.includes(runId);
    };
    for (let i = 0; i < 256; i++) forecastSamples(store, [`run-${i}`]);
    // All 256 fit; reading run-0 again also makes it the most recent.
    expect(reread("run-0")).toBe(false);
    // The 257th run drops the least recently read one, run-1, and keeps run-0.
    expect(reread("run-256")).toBe(true);
    expect(reread("run-1")).toBe(true);
    expect(reread("run-0")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import type { SizingReport } from "../src/core/workflows/sizing.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { replayTestSplits } from "../src/core/workflows/trace.js";

// #2932, bench round 99 stv (Go update): `sizing/plan-0.json` priced test task T004 from the 170
// lines the request's diffs supply (`basis: "supplied"`, 60 cases, 5 files) and kept it whole; the
// host applied the five files at 0 tokens. The replay decided it by the case capacity and reported
// a split the current code would not make.
type Task = SizingReport["tasks"][number];
const t004: Task = {
  taskId: "T004",
  kind: "test",
  files: 5,
  estimate: { low: 42_500, high: 170_000 },
  attemptTokens: 600_000,
  attemptSteps: null,
  oversized: false,
  basis: "supplied",
  suppliedLines: 170,
  cases: 60,
  sliceCount: 1,
};

/** A recorded run holding one sizing report, read the way `replayTestSplits` reads a trace. */
const recorded = (tasks: Task[]): WorkflowStore => {
  const report = { maxAttemptTokens: 600_000, testTaskLimit: { tokens: 300_000, cases: 10, criteria: 3 }, tasks };
  return {
    connection: { query: () => ({ all: () => [{ id: "a1", path: "sizing/plan-0.json" }] }) },
    readArtifact: () => JSON.stringify(report),
  } as unknown as WorkflowStore;
};

describe("replayTestSplits on a task priced from supplied lines (#2932)", () => {
  test("a supplied test task above the case capacity replays whole, as sizing keeps it", () => {
    expect(replayTestSplits(recorded([t004]), "run")).toEqual([
      { report: "sizing/plan-0.json", taskId: "T004", cases: 60, recorded: "whole", replayed: "whole" },
    ]);
  });

  test("the same task priced by default still splits on its cases", () => {
    const { suppliedLines: _, ...rest } = t004;
    const [boundary] = replayTestSplits(recorded([{ ...rest, basis: "default" }]), "run");
    expect(boundary).toMatchObject({ taskId: "T004", recorded: "whole", replayed: "split" });
  });

  test("a supplied task whose lines need more than one attempt replays split", () => {
    const [boundary] = replayTestSplits(recorded([{ ...t004, suppliedLines: 900, oversized: true }]), "run");
    expect(boundary).toMatchObject({ recorded: "split", replayed: "split" });
  });
});

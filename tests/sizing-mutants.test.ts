// Kills the survivors of the weekly hot-module mutation run of the sizing module (Refs #1723):
// each test pins a boundary or a tie that a surviving mutant moved without failing a test.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PastRun, pricesFrom, rangeOf, rangeText, tokenText } from "../src/core/workflows/estimate.js";
import { estimateInitiative, type FeatureToEstimate } from "../src/core/workflows/initiatives/estimate.js";
import {
  DEFAULT_PER_FILE,
  perFileRates,
  repairReserveShare,
  type SizingSample,
  samplesFrom,
  taskKind,
  testTaskRates,
} from "../src/core/workflows/sizing.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const sample = (kind: SizingSample["kind"], tokens: number, more: Partial<SizingSample> = {}): SizingSample => ({
  runId: `r-${tokens}`,
  taskId: "T001",
  kind,
  action: "modify",
  source: "shared",
  files: 1,
  tokens,
  model: null,
  ...more,
});
const task = (id: string, paths: string[], origin: "planned" | "repair" = "planned") => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "modify" as const })),
  readHints: [],
  checkIds: [],
  origin,
  findingIds: [],
  rationale: id,
});
const store = (attempts: string, tasks: [string, ReturnType<typeof task>][]): string => {
  const dir = mkdtempSync(join(tmpdir(), "baked-sizing-mutants-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workflows.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
    CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
    CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
    CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
    INSERT INTO runs VALUES ('done','completed');
    INSERT INTO steps VALUES ('done','s1','task-T001'),('done','s2','task-T002');
    ${attempts}`);
  const insert = db.query("INSERT INTO tasks VALUES (?,?,?,?)");
  for (const [status, definition] of tasks) insert.run("done", definition.id, JSON.stringify(definition), status);
  db.close();
  return path;
};

describe("sizing.ts", () => {
  test("six shared samples of a kind set their own upper bound; five keep the default's", () => {
    const tokens = [10_000, 11_000, 12_000, 13_000, 14_000, 15_000];
    const six = perFileRates(tokens.map((t) => sample("code", t))).code.modify;
    expect(six).toMatchObject({ basis: "history", samples: 6 });
    expect(six.perFile.high).toBe(rangeOf(tokens)?.high ?? -1);
    expect(six.perFile.high).toBeLessThan(DEFAULT_PER_FILE.code.modify.high);
    const five = perFileRates(tokens.slice(0, 5).map((t) => sample("code", t))).code.modify;
    expect(five.perFile.high).toBe(DEFAULT_PER_FILE.code.modify.high);
  });

  test("a case bucket opens with exactly two finished test tasks", () => {
    const two = [sample("test", 100_000, { cases: 3 }), sample("test", 200_000, { cases: 4 })];
    expect(testTaskRates(two).buckets.small).toMatchObject({ samples: 2, perTask: { low: 150_000, high: 200_000 } });
    expect(testTaskRates(two.slice(0, 1)).buckets.small).toBeUndefined();
  });

  test("the calibrated repair reserve tops out at three times the priced work", () => {
    expect(repairReserveShare([5, 5, 5])).toEqual({ share: 3, basis: "history", runs: 3 });
    expect(repairReserveShare([2.5, 2.5, 2.5]).share).toBe(2.5);
  });

  test("host-generated row files are left out only when the task has both rows and a row test", () => {
    const rowTest = { framework: "bun" as const, harness: "tests/rows.harness.ts", test: "tests/rows.test.ts", data: "tests/rows.data.json" };
    const writes = [{ path: "tests/rows.test.ts", action: "modify" as const }];
    expect(taskKind({ writes, rowTest })).toBe("test");
    expect(taskKind({ writes, rows: ["AC-001"] })).toBe("test");
    expect(taskKind({ writes, rows: ["AC-001"], rowTest })).toBe("mixed");
  });

  test("a verified planned task without attempts is no sample", () => {
    const path = store("INSERT INTO attempts VALUES ('done','s1','m',40000);", [
      ["verified", task("T001", ["src/a.ts"])],
      ["verified", task("T002", ["src/b.ts"])],
    ]);
    expect(samplesFrom(path)).toMatchObject([{ taskId: "T001", tokens: 40_000 }]);
    expect(samplesFrom(path)).toHaveLength(1);
  });
});

describe("estimate.ts", () => {
  test("a zero value counts as a sample in rangeOf", () => {
    expect(rangeOf([0])).toEqual({ low: 0, high: 0 });
    expect(rangeOf([0, 10_000])).toEqual({ low: 0, high: 10_000 });
  });

  test("rangeOf takes the middle half from exactly four values", () => {
    expect(rangeOf([0, 100, 200, 300])).toEqual({ low: 75, high: 225 });
    expect(rangeOf([0, 100, 300])).toEqual({ low: 0, high: 300 });
  });

  test("a finished run with no tasks does not count toward the planned task count", () => {
    const run = (runId: string, taskCount: number): PastRun => ({
      runId,
      status: "completed",
      tokens: 100_000,
      calls: 1,
      activeMs: 1000,
      taskCount,
      stageTokens: {},
      taskTokens: 0,
    });
    expect(pricesFrom([run("a", 4), run("b", 0)]).taskCount).toEqual({ low: 3, high: 6 });
  });

  test("one million tokens reads 1.0M, just under reads in thousands", () => {
    expect(tokenText(1_000_000)).toBe("1.0M");
    expect(tokenText(999_499)).toBe("999k");
    expect(rangeText({ low: 500_000, high: 1_000_000 })).toBe("500k–1.0M");
  });
});

describe("initiatives/estimate.ts", () => {
  test("a feature's task count comes from finished runs of its own workflow first", () => {
    const run = (runId: string, workflowId: string, taskCount: number): PastRun => ({
      runId,
      workflowId,
      status: "completed",
      tokens: 400_000,
      calls: 10,
      activeMs: 1000,
      taskCount,
      stageTokens: { implement: 330_000 },
      taskTokens: 330_000,
    });
    const feature: FeatureToEstimate = {
      id: "a",
      title: "a",
      workflowId: "quick",
      size: "medium",
      stages: [{ id: "implement", type: "tasks", models: [] }],
    };
    const estimate = estimateInitiative({
      features: [feature],
      history: [run("q1", "quick", 2), run("q2", "quick", 3), run("s1", "sdd", 10), run("s2", "sdd", 12)],
      samples: [],
      maxTotalTokens: 100_000_000,
    });
    expect(estimate.features[0]?.tasks).toEqual({ low: 2, high: 3 });
  });
});

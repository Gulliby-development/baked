import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import {
  DEFAULT_TOKENS_PER_KB,
  plannerSizing,
  samplesFrom,
  sizePlan,
  tokensPerKb,
} from "../src/core/workflows/sizing.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-sizing-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const task = (id: string, paths: string[]) => ({
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
  origin: "planned" as const,
  findingIds: [],
  rationale: id,
});
const graph = (...tasks: ReturnType<typeof task>[]): TaskGraph => ({
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks,
});
const policy = (sizing: RunPolicy["sizing"], maxTotalTokens = 800_000): RunPolicy => ({
  ...defaultWorkflowPolicy,
  maxTotalTokens,
  sizing,
});

describe("plan-time sizing", () => {
  test("without enough history the default price per KiB applies", () => {
    expect(tokensPerKb([]).basis).toBe("defaults");
    expect(tokensPerKb([{ runId: "a", taskTokens: 100_000, writeBytes: 10_240 }]).rate).toEqual(
      DEFAULT_TOKENS_PER_KB,
    );
    const priced = tokensPerKb([
      { runId: "a", taskTokens: 100_000, writeBytes: 10_240 },
      { runId: "b", taskTokens: 300_000, writeBytes: 10_240 },
    ]);
    expect(priced.basis).toBe("history");
    expect(priced.rate).toEqual({ low: 10_000, high: 30_000 });
  });

  test("a small plan keeps the default attempt cap and fits", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.ts"), "x".repeat(2048));
    const report = sizePlan({
      graph: graph(task("T001", ["a.ts"])),
      root,
      policy: policy({ maxRunTokens: 2_000_000 }),
      samples: [],
      spent: 100_000,
    });
    expect(report.decision).toBe("fits");
    expect(report.tasks[0]?.attemptTokens).toBe(250_000);
    expect(report.budgetAfter).toBe(800_000);
  });

  test("a large plan raises the run budget up to the ceiling and caps each task by its price", () => {
    const root = tempDir();
    writeFileSync(join(root, "big.ts"), "x".repeat(60 * 1024));
    const report = sizePlan({
      graph: graph(task("T001", ["big.ts"])),
      root,
      policy: policy({ maxRunTokens: 3_000_000 }),
      samples: [],
      spent: 300_000,
    });
    // 60 KiB at 6k/KiB with the repair factor: 540k, above the default 250k attempt cap.
    expect(report.tasks[0]?.estimate.high).toBe(540_000);
    expect(report.tasks[0]?.attemptTokens).toBe(540_000);
    expect(report.decision).toBe("raise-budget");
    expect(report.budgetAfter).toBe(report.runTokens);
    expect(report.budgetAfter).toBeGreaterThan(800_000);
  });

  test("a task above one attempt asks for a split; a plan above the ceiling asks to split the feature", () => {
    const root = tempDir();
    writeFileSync(join(root, "huge.ts"), "x".repeat(100 * 1024));
    const tasks = sizePlan({
      graph: graph(task("T001", ["huge.ts"])),
      root,
      policy: policy({ maxRunTokens: 5_000_000 }),
      samples: [],
      spent: 0,
    });
    expect(tasks.decision).toBe("split-tasks");
    expect(tasks.tasks[0]?.oversized).toBe(true);
    expect(tasks.tasks[0]?.attemptTokens).toBe(600_000);
    const feature = sizePlan({
      graph: graph(task("T001", ["huge.ts"]), task("T002", ["huge.ts"])),
      root,
      policy: policy({ maxRunTokens: 1_000_000 }),
      samples: [],
      spent: 0,
    });
    expect(feature.decision).toBe("split-feature");
    expect(feature.budgetAfter).toBe(1_000_000);
  });

  test("the planner is told a file size per task that one attempt covers", () => {
    const sizing = plannerSizing(policy({ maxAttemptTokens: 600_000 }), []);
    expect(sizing.maxTaskKb).toBe(66);
    expect(sizing.note).toContain("disjoint writes");
  });

  test("history samples come from finished runs: task tokens over the size of planned writes", () => {
    const root = tempDir();
    mkdirSync(join(root, ".baked"));
    writeFileSync(join(root, "a.ts"), "x".repeat(10 * 1024));
    const path = join(root, ".baked", "workflows.sqlite");
    const db = new Database(path);
    db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
      CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
      CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
      CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
      INSERT INTO runs VALUES ('done','completed'),('open','blocked');
      INSERT INTO steps VALUES ('done','s1','task-T001'),('done','s2','task-T002'),('done','s3','review'),('open','s4','task-T001');
      INSERT INTO attempts VALUES ('done','s1','m',120000),('done','s2','m',30000),('done','s3','m',50000),('open','s4','m',999999);`);
    db.query("INSERT INTO tasks VALUES (?,?,?,?)").run(
      "done",
      "T001",
      JSON.stringify(task("T001", ["a.ts"])),
      "verified",
    );
    db.query("INSERT INTO tasks VALUES (?,?,?,?)").run(
      "done",
      "T002",
      JSON.stringify({ ...task("T002", ["a.ts"]), origin: "repair" }),
      "verified",
    );
    db.close();
    expect(samplesFrom(path)).toEqual([{ runId: "done", taskTokens: 150_000, writeBytes: 10_240 }]);
  });
});

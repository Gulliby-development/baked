import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import {
  codeTaskCheckProblems,
  DEFAULT_PER_FILE,
  fileKind,
  perFileRates,
  plannerSizing,
  type SizingSample,
  samplesFrom,
  sizePlan,
  splitTestTasks,
  withTestDependencies,
} from "../src/core/workflows/sizing.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
const sample = (kind: SizingSample["kind"], tokens: number, files = 1): SizingSample => ({
  runId: `r-${tokens}`,
  taskId: "T001",
  kind,
  files,
  tokens,
});

describe("plan-time sizing", () => {
  test("a test task gets the test step cap; code tasks keep the profile's", () => {
    const report = sizePlan({
      graph: graph(task("T001", ["src/a.ts"]), task("T002", ["tests/a.test.ts"])),
      policy: policy({}),
      samples: [],
      spent: 0,
    });
    expect(report.tasks.map((t) => t.attemptSteps)).toEqual([null, 32]);
    const custom = sizePlan({
      graph: graph(task("T002", ["tests/a.test.ts"])),
      policy: policy({ testTaskSteps: 40 }),
      samples: [],
      spent: 0,
    });
    expect(custom.tasks[0]?.attemptSteps).toBe(40);
  });

  test("with sizing on, a task that writes source code must name the policy's typecheck check", () => {
    const withTypecheck = {
      ...policy({}),
      checks: [
        { id: "typecheck", executable: "bun", args: ["run", "typecheck"], cwd: ".", timeoutMs: 1000, required: true, scope: "task" as const, envNames: [], writes: [] },
      ],
    };
    const plan = graph(
      task("T001", ["src/a.ts"]),
      { ...task("T002", ["src/b.ts"]), checkIds: ["typecheck"] },
      task("T003", ["tests/a.test.ts"]),
      task("T004", ["docs/notes.md"]),
    );
    const problems = codeTaskCheckProblems(plan, withTypecheck);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T001");
    expect(codeTaskCheckProblems(plan, { ...withTypecheck, sizing: undefined })).toEqual([]);
    expect(codeTaskCheckProblems(plan, policy({}))).toEqual([]);
    const featureOnly = { ...withTypecheck, checks: withTypecheck.checks.map((c) => ({ ...c, scope: "feature" as const })) };
    expect(codeTaskCheckProblems(plan, featureOnly)).toEqual([]);
  });

  test("files are tests or code by path", () => {
    expect(fileKind("tests/workflow-usage.test.ts")).toBe("test");
    expect(fileKind("src/a.spec.tsx")).toBe("test");
    expect(fileKind("src/core/workflows/store.ts")).toBe("code");
  });

  test("each kind is priced per file from tasks of that kind only, or from defaults", () => {
    const rates = perFileRates([
      sample("code", 28_000),
      sample("code", 82_000),
      sample("test", 471_000),
      sample("mixed", 900_000, 5),
    ]);
    expect(rates.code).toEqual({ perFile: { low: 28_000, high: 82_000 }, samples: 2, basis: "history" });
    expect(rates.test.samples).toBe(1);
    expect(perFileRates([]).test).toEqual({ perFile: DEFAULT_PER_FILE.test, samples: 0, basis: "defaults" });
  });

  test("a big code file is not priced by its size; a test task gets the larger cap", () => {
    const report = sizePlan({
      graph: graph(task("T001", ["src/core/workflows/store.ts"]), task("T002", ["tests/a.test.ts"])),
      policy: policy({ maxRunTokens: 3_000_000 }),
      samples: [sample("code", 30_000), sample("code", 80_000), sample("test", 400_000), sample("test", 480_000)],
      spent: 300_000,
    });
    const [code, tests] = report.tasks;
    expect(code?.estimate).toEqual({ low: 30_000, high: 80_000 });
    expect(code?.attemptTokens).toBe(250_000);
    expect(tests?.estimate).toEqual({ low: 400_000, high: 480_000 });
    expect(tests?.attemptTokens).toBe(480_000);
    expect(report.decision).toBe("raise-budget");
    expect(report.budgetAfter).toBe(300_000 + 80_000 + 480_000 + 210_000);
  });

  test("only a task with several files is split; a plan above the ceiling asks to split the feature", () => {
    const samples = [sample("test", 500_000), sample("test", 500_000)];
    const one = sizePlan({
      graph: graph(task("T001", ["tests/a.test.ts"])),
      policy: policy({ maxAttemptTokens: 400_000, maxRunTokens: 5_000_000 }),
      samples,
      spent: 0,
    });
    expect(one.tasks[0]?.oversized).toBe(false);
    expect(one.tasks[0]?.attemptTokens).toBe(400_000);
    const two = sizePlan({
      graph: graph(task("T001", ["tests/a.test.ts", "tests/b.test.ts"])),
      policy: policy({ maxAttemptTokens: 400_000, maxRunTokens: 5_000_000 }),
      samples,
      spent: 0,
    });
    expect(two.decision).toBe("split-tasks");
    const feature = sizePlan({
      graph: graph(task("T001", ["tests/a.test.ts"]), task("T002", ["tests/b.test.ts"])),
      policy: policy({ maxRunTokens: 1_000_000 }),
      samples,
      spent: 0,
    });
    expect(feature.decision).toBe("split-feature");
    expect(feature.budgetAfter).toBe(1_000_000);
  });

  test("the planner is told the per-file prices and how many code files one attempt covers", () => {
    const sizing = plannerSizing(policy({ maxAttemptTokens: 600_000 }), [
      sample("code", 50_000),
      sample("code", 60_000),
    ]);
    expect(sizing.maxCodeFilesPerTask).toBe(10);
    expect(sizing.note).toContain("Put tests in tasks of their own");
  });

  test("history samples are verified planned tasks of finished runs, with their corrections", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-sizing-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "workflows.sqlite");
    const db = new Database(path);
    db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
      CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
      CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
      CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
      INSERT INTO runs VALUES ('done','completed'),('open','blocked');
      INSERT INTO steps VALUES ('done','s1','task-T001'),('done','s2','task-T002'),('done','s3','task-T003'),('done','s4','review'),('open','s5','task-T001');
      INSERT INTO attempts VALUES ('done','s1','m',28000),('done','s2','m',240000),('done','s3','m',231000),('done','s4','m',50000),('open','s5','m',999999);`);
    const insert = db.query("INSERT INTO tasks VALUES (?,?,?,?)");
    insert.run("done", "T001", JSON.stringify(task("T001", ["src/store.ts"])), "verified");
    insert.run("done", "T002", JSON.stringify(task("T002", ["tests/u.test.ts"])), "verified");
    insert.run("done", "T003", JSON.stringify(task("T003", ["tests/u.test.ts"], "repair")), "verified");
    insert.run("open", "T001", JSON.stringify(task("T001", ["src/store.ts"])), "verified");
    db.close();
    expect(samplesFrom(path)).toEqual([
      { runId: "done", taskId: "T001", kind: "code", files: 1, tokens: 28_000 },
      { runId: "done", taskId: "T002", kind: "test", files: 1, tokens: 471_000 },
    ]);
  });
});

describe("test task dependencies", () => {
  const deps = (g: TaskGraph) => Object.fromEntries(g.tasks.map((t) => [t.id, t.dependsOn]));
  test("a test task waits for the code tasks that share its criteria", () => {
    const other = { ...task("T003", ["src/other.ts"]), criterionIds: ["AC-002"] };
    const g = graph(task("T001", ["src/site.ts"]), task("T002", ["tests/build.test.ts"]), other);
    expect(deps(withTestDependencies(g))).toEqual({ T001: [], T002: ["T001"], T003: [] });
  });
  test("existing order is kept and no cycle is added", () => {
    const after = { ...task("T002", ["tests/a.test.ts"]), dependsOn: ["T001"] };
    const before = { ...task("T003", ["src/b.ts"]), dependsOn: ["T002"] };
    const g = graph(task("T001", ["src/a.ts"]), after, before);
    expect(deps(withTestDependencies(g))).toEqual({ T001: [], T002: ["T001"], T003: ["T002"] });
  });
});

describe("runtime split of test tasks", () => {
  const samples = [sample("test", 500_000), sample("test", 500_000)];
  const sized = (g: TaskGraph) =>
    sizePlan({ graph: g, policy: policy({ maxAttemptTokens: 600_000 }), samples, spent: 0 });
  test("an oversized test task becomes one task per file and its dependents wait for every part", () => {
    const tests = { ...task("T002", ["tests/test_parser.py", "tests/test_report.py"]), dependsOn: ["T001"] };
    const docs = { ...task("T009", ["README.md"]), dependsOn: ["T002"] };
    const g = graph(task("T001", ["src/report.py"]), tests, docs);
    const split = splitTestTasks(g, sized(g));
    expect(split?.tasks.map((t) => [t.id, t.writes.map((w) => w.path), t.dependsOn])).toEqual([
      ["T001", ["src/report.py"], []],
      ["T002", ["tests/test_parser.py"], ["T001"]],
      ["T010", ["tests/test_report.py"], ["T001"]],
      ["T009", ["README.md"], ["T002", "T010"]],
    ]);
    expect(split?.tasks[2]?.criterionIds).toEqual(["AC-001"]);
    expect(split?.tasks[2]?.description).toContain("write only tests/test_report.py");
    expect(split && sized(split).decision).not.toBe("split-tasks");
  });
  test("code tasks and test tasks within one attempt are left to the planner", () => {
    const g = graph(task("T001", ["src/a.ts", "src/b.ts"]), task("T002", ["tests/a.test.ts"]));
    expect(splitTestTasks(g, sized(g))).toBeNull();
  });
});

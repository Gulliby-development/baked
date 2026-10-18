import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostSplitParts, isHostSplitNit } from "../src/core/workflows/analysis-notes.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { MAX_EXTENDED_MS } from "../src/core/workflows/budget.js";
import {
  activeTimeText,
  codeTaskCheckProblems,
  DEFAULT_TOKENS_PER_MINUTE,
  DEFAULT_PER_FILE,
  MIN_HISTORY_SAMPLES,
  fileKind,
  partCriteria,
  perFileRates,
  plannerSizing,
  REPAIR_RESERVE,
  RESERVE_BOUNDS,
  repairReserveShare,
  type SizingSample,
  criterionRate,
  priceTask,
  samplesFrom,
  sizePlan,
  splitTestTasks,
  taskTotal,
  tokenRatesFrom,
  tokensPerMinute,
  withTestDependencies,
} from "../src/core/workflows/sizing.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const task = (
  id: string,
  paths: string[],
  origin: "planned" | "repair" = "planned",
  action: "create" | "modify" = "modify",
) => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action })),
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
const sample = (
  kind: SizingSample["kind"],
  tokens: number,
  files = 1,
  more: Partial<SizingSample> = {},
): SizingSample => ({
  runId: `r-${tokens}`,
  taskId: "T001",
  kind,
  action: "modify",
  source: "project",
  files,
  tokens,
  model: null,
  ...more,
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

  test("files are docs, tests or code by path", () => {
    expect(fileKind("tests/workflow-usage.test.ts")).toBe("test");
    expect(fileKind("src/a.spec.tsx")).toBe("test");
    expect(fileKind("src/core/workflows/store.ts")).toBe("code");
    expect(fileKind("README.md")).toBe("docs");
    expect(fileKind("docs/workflows/runtime.md")).toBe("docs");
    expect(fileKind("docs/diagram.svg")).toBe("docs");
    expect(fileKind("docs/.vitepress/config.ts")).toBe("code");
    expect(fileKind("requirements.txt")).toBe("manifest");
    expect(fileKind("src/Core/Core.csproj")).toBe("manifest");
    expect(fileKind("RateSim.slnx")).toBe("manifest");
    expect(fileKind("package.json")).toBe("manifest");
    expect(fileKind("crates/cli/Cargo.toml")).toBe("manifest");
    expect(fileKind("src/package.ts")).toBe("code");
  });

  // #1132: a skeleton task of manifests, a solution file and an entry point was priced as four
  // code files and split.
  test("project manifests and solution files are priced as their own cheap kind", () => {
    const history = Array.from({ length: MIN_HISTORY_SAMPLES }, () => sample("code", 250_000));
    const skeleton = task(
      "T001",
      ["src/Core/Core.csproj", "RateSim.slnx", "src/Console/Console.csproj", "src/Console/Program.cs"],
      "planned",
      "create",
    );
    const report = sizePlan({ graph: graph(skeleton), policy: policy({}), samples: history, spent: 0 });
    const manifest = DEFAULT_PER_FILE.manifest.create;
    expect(report.tasks[0]).toMatchObject({
      kind: "mixed",
      estimate: { low: 250_000 + 3 * manifest.low, high: 250_000 + 3 * manifest.high },
      oversized: false,
    });
    expect(report.decision).not.toBe("split-tasks");
    expect(perFileRates(history).manifest.create).toMatchObject({ basis: "defaults", samples: 0 });
  });

  test("each kind and action is priced per file from tasks of that kind only, or from defaults", () => {
    const rates = perFileRates([
      sample("code", 28_000),
      sample("code", 82_000),
      sample("test", 471_000),
      sample("mixed", 900_000, 5),
    ]);
    expect(rates.code.modify).toEqual({ perFile: { low: 28_000, high: 82_000 }, samples: 2, basis: "project", model: null });
    expect(rates.test.modify.samples).toBe(1);
    // Created code files have no sample of their own: modified ones stand in, with the default's room.
    expect(rates.code.create).toEqual({
      perFile: { low: 28_000, high: DEFAULT_PER_FILE.code.create.high },
      samples: 2,
      basis: "history",
      model: null,
    });
    expect(perFileRates([]).docs.modify).toEqual({ perFile: DEFAULT_PER_FILE.docs.modify, samples: 0, basis: "defaults", model: null });
  });

  test("this project's history decides alone once it has enough tasks; other projects only widen", () => {
    const shared = [sample("test", 400_000, 1, { source: "shared" }), sample("test", 450_000, 1, { source: "shared" })];
    const own = [sample("test", 55_000), sample("test", 59_000)];
    expect(perFileRates([...shared, ...own]).test.modify).toEqual({
      perFile: { low: 55_000, high: 59_000 },
      samples: 2,
      basis: "project",
      model: null,
    });
    const oneOwn = perFileRates([...shared, sample("test", 55_000)]).test.modify;
    expect(oneOwn.basis).toBe("history");
    expect(oneOwn.samples).toBe(3);
    const low = perFileRates([sample("code", 20_000, 1, { source: "shared" })]).code.modify;
    expect(low.perFile.high).toBe(DEFAULT_PER_FILE.code.modify.high);
  });

  test("the planned model's own tasks set the rate once it ran enough of the kind; else every model's", () => {
    const codex = [sample("test", 300_000, 1, { model: "codex" }), sample("test", 320_000, 1, { model: "codex" })];
    const claude = [sample("test", 450_000, 1, { model: "sonnet" }), sample("test", 480_000, 1, { model: "sonnet" })];
    const mixed = [...codex, ...claude];
    expect(perFileRates(mixed, "sonnet").test.modify).toEqual({
      perFile: { low: 450_000, high: 480_000 },
      samples: 2,
      basis: "project",
      model: "sonnet",
    });
    expect(perFileRates(mixed, "codex").test.modify.perFile).toEqual({ low: 300_000, high: 320_000 });
    // One sample of the model is too few: every model's tasks price it, and the rate says so.
    const few = perFileRates([...codex, claude[0]!], "sonnet").test.modify;
    expect(few.model).toBeNull();
    expect(few.samples).toBe(3);
    // Without a model, all of history counts as before.
    expect(perFileRates(mixed).test.modify.samples).toBe(4);
    const report = sizePlan({ graph: graph(task("T001", ["tests/a.test.ts"])), policy: policy(), samples: mixed, spent: 0, model: "sonnet" });
    expect(report.model).toBe("sonnet");
    expect(report.tasks[0]?.estimate.high).toBe(480_000);
  });

  test("a task is priced per file by its kind and by whether it creates or modifies it", () => {
    const report = sizePlan({
      graph: graph(
        task("T001", ["README.md"]),
        task("T002", ["src/new.ts"], "planned", "create"),
        task("T003", ["src/old.ts"]),
      ),
      policy: policy({}),
      samples: [
        sample("code", 20_000, 1, { action: "create" }),
        sample("code", 30_000, 1, { action: "create" }),
        sample("code", 80_000),
        sample("code", 90_000),
      ],
      spent: 0,
    });
    expect(report.schemaVersion).toBe(3);
    expect(report.tasks.map((t) => [t.kind, t.estimate])).toEqual([
      ["docs", DEFAULT_PER_FILE.docs.modify],
      ["code", { low: 20_000, high: 30_000 }],
      ["code", { low: 80_000, high: 90_000 }],
    ]);
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
    // Midpoints 55k + 440k, plus the root of 25k^2 + 40k^2 (47,170), not the sum of the highs.
    expect(report.taskTokens).toEqual({ low: 430_000, expected: 495_000, high: 560_000 });
    expect(report.runTokens).toBe(300_000 + 542_170 + 210_000);
    expect(report.repairReserve).toBe(225_651);
    expect(report.budgetAfter).toBe(300_000 + 542_170 + 210_000 + 225_651);
  });

  test("a budget already at the ceiling is not reported as growing to itself (#747)", () => {
    const report = sizePlan({
      graph: graph(task("T001", ["src/core/workflows/store.ts"])),
      policy: policy({ maxRunTokens: 4_000_000 }, 4_000_000),
      samples: [],
      spent: 3_900_000,
    });
    expect(report.budgetAfter).toBe(4_000_000);
    expect(report.reasons.join(" ")).not.toContain("grows from 4000000 to 4000000");
    expect(report.reasons.join(" ")).toContain("stays at 4000000 tokens, the policy's ceiling");
  });

  test("the repair reserve follows the median loop of finished runs once there are enough (#747)", () => {
    expect(repairReserveShare([2.6])).toEqual({ share: REPAIR_RESERVE, basis: "default", runs: 1 });
    expect(repairReserveShare([0.4, 2.6, 0.9])).toEqual({ share: 0.9, basis: "history", runs: 3 });
    expect(repairReserveShare([0.05, 0.1, 0.1]).share).toBe(RESERVE_BOUNDS.min);
    expect(repairReserveShare([5, 6, 7]).share).toBe(RESERVE_BOUNDS.max);
    const sized = (loopShares: number[]) =>
      sizePlan({ graph: graph(task("T001", ["src/a.ts"])), policy: policy({ maxRunTokens: 9_000_000 }), samples: [], spent: 0, loopShares });
    const flat = sized([]);
    const calibrated = sized([1, 2, 3]);
    expect(calibrated.reserve).toEqual({ share: 2, basis: "history", runs: 3 });
    expect(calibrated.repairReserve).toBeGreaterThan(flat.repairReserve * 6);
    expect(calibrated.reasons.join(" ")).toContain("the median loop of 3 finished runs");
  });

  // cfgtrace 2ad7c3e4 spent 81-104k tokens a minute; sizing raised its budget but its one-hour
  // active-time cap stopped it at 61% of the sized tokens (#933).
  test("the active-time cap grows with the budget to the time it needs at the observed rate", () => {
    const tests = Array.from({ length: 8 }, (_, i) => task(`T00${i}`, [`src/m${i}.ts`, `tests/m${i}.test.ts`]));
    const sized = (sizing: RunPolicy["sizing"], tokenRates?: number[], maxActiveMs = 3_600_000) =>
      sizePlan({
        graph: graph(...tests),
        policy: { ...policy(sizing, 800_000), maxActiveMs },
        samples: [],
        spent: 1_000_000,
        tokenRates,
      });
    const flat = sized({ maxRunTokens: 9_000_000 });
    expect(flat.activeTime.basis).toBe("default");
    expect(flat.activeTime.tokensPerMinute).toBe(DEFAULT_TOKENS_PER_MINUTE);
    const needed = Math.min(flat.runTokens + flat.repairReserve, flat.budgetAfter);
    expect(flat.activeTime.estimatedMs).toBe(Math.round((needed / DEFAULT_TOKENS_PER_MINUTE) * 60_000));
    expect(flat.activeTime.estimatedMs).toBeGreaterThan(3_600_000);
    expect(flat.activeTime.after).toBeGreaterThanOrEqual(flat.activeTime.estimatedMs * 1.25);
    expect(flat.decision).toBe("raise-budget");
    expect(flat.reasons.join(" ")).toContain("against maxActiveMs 60 min; the active-time cap grows to");
    // A faster observed pace needs less time for the same tokens.
    const fast = sized({ maxRunTokens: 9_000_000 }, [90_000, 104_000, 81_000]);
    expect(fast.activeTime).toMatchObject({ basis: "history", runs: 3, tokensPerMinute: 90_000 });
    expect(fast.activeTime.after).toBeLessThan(flat.activeTime.after);
    // No ceiling: neither tokens nor time grow, and the estimate still says the cap is short.
    const open = sized({}, undefined, 600_000);
    expect(open.activeTime.estimatedMs).toBe(800_000);
    expect(open.activeTime.after).toBe(600_000);
    expect(open.reasons.join(" ")).toContain("the cap stays, as the policy sets no maxRunTokens ceiling");
    // A cap that already covers the estimate stays, and the plan still fits.
    const roomy = sized({ maxRunTokens: 9_000_000 }, undefined, 20 * 3_600_000);
    expect(roomy.activeTime.after).toBe(20 * 3_600_000);
    // Never past the extension ceiling.
    expect(sized({ maxRunTokens: 9_000_000 }, [1_000, 1_000, 1_000]).activeTime.after).toBe(MAX_EXTENDED_MS);
    expect(activeTimeText(flat.activeTime)).toMatch(
      /^Estimated active time at the observed rate \(60k tokens per minute, the default rate\): \d+ min against maxActiveMs 60 min; sizing raised the cap to \d+ min$/,
    );
  });

  test("the token rate is the median of runs long enough to show a pace", () => {
    expect(tokensPerMinute([90_000, 80_000])).toEqual({
      tokensPerMinute: DEFAULT_TOKENS_PER_MINUTE,
      basis: "default",
      runs: 2,
    });
    expect(tokensPerMinute([90_000, 80_000, 100_000, 70_000])).toEqual({
      tokensPerMinute: 85_000,
      basis: "history",
      runs: 4,
    });
    const dir = mkdtempSync(join(tmpdir(), "baked-sizing-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "workflows.sqlite");
    const db = new Database(path);
    db.exec(`CREATE TABLE runs (id TEXT, status TEXT, token_usage INTEGER, active_ms INTEGER);
      INSERT INTO runs VALUES ('long','blocked',5400000,3600000),('done','completed',1200000,600000),
        ('short','completed',500000,60000),('small','completed',50000,900000),('live','running',9000000,600000);`);
    db.close();
    expect(tokenRatesFrom(path)).toEqual([90_000, 120_000]);
    expect(tokenRatesFrom(join(dir, "missing.sqlite"))).toEqual([]);
  });

  // cronsay 15eb3204: eight tasks were priced at the sum of their upper bounds, 4.0M of tasks for a
  // run that comparable apps finished with 0.6-1.0M, so the plan went above the 4M ceiling.
  test("many tasks are priced near their midpoints, and one task at its upper bound", () => {
    const tests = Array.from({ length: 8 }, (_, i) => task(`T00${i + 1}`, [`tests/t${i}.test.ts`]));
    const report = sizePlan({ graph: graph(...tests), policy: policy({ maxRunTokens: 4_000_000 }), samples: [], spent: 0 });
    const { low, high } = DEFAULT_PER_FILE.test.modify;
    expect(report.taskTokens.high).toBe(8 * high);
    expect(report.runTokens - 210_000).toBe(Math.round(8 * ((low + high) / 2) + Math.sqrt(8) * ((high - low) / 2)));
    expect(report.runTokens - 210_000).toBeLessThan(0.85 * 8 * high);
    expect(taskTotal([{ low: 100, high: 300 }]).price).toBe(300);
  });

  test("with enough samples of a kind, history's own upper bound replaces the default's", () => {
    const few = Array.from({ length: MIN_HISTORY_SAMPLES - 1 }, (_, i) => sample("test", 60_000 + i * 1000, 1, { source: "shared" }));
    expect(perFileRates(few).test.modify.perFile.high).toBe(DEFAULT_PER_FILE.test.modify.high);
    const enough = [...few, sample("test", 70_000, 1, { source: "shared" })];
    const rate = perFileRates(enough).test.modify;
    expect(rate.basis).toBe("history");
    expect(rate.perFile.high).toBeLessThan(80_000);
  });

  test("an oversized single test file is flagged; a plan above the ceiling asks to split the feature", () => {
    const samples = [sample("test", 500_000), sample("test", 500_000)];
    const one = sizePlan({
      graph: graph(task("T001", ["tests/a.test.ts"])),
      policy: policy({ maxAttemptTokens: 400_000, maxRunTokens: 5_000_000 }),
      samples,
      spent: 0,
    });
    expect(one.tasks[0]?.oversized).toBe(true);
    expect(one.decision).toBe("split-tasks");
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
      sample("code", 40_000, 1, { action: "create" }),
      sample("code", 45_000, 1, { action: "create" }),
    ]);
    expect(sizing.maxCodeFilesPerTask).toBe(10);
    expect(sizing.note).toContain("Put tests in tasks of their own");
    expect(sizing.note).toContain(`a documentation file about ${DEFAULT_PER_FILE.docs.modify.high / 1000}k`);
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
      INSERT INTO attempts VALUES ('done','s1','m',28000),('done','s2','m',140000),('done','s2','n',100000),('done','s2','o',90000),('done','s3','m',231000),('done','s4','m',50000),('open','s5','m',999999);`);
    const insert = db.query("INSERT INTO tasks VALUES (?,?,?,?)");
    insert.run("done", "T001", JSON.stringify(task("T001", ["src/store.ts"])), "verified");
    insert.run("done", "T002", JSON.stringify(task("T002", ["tests/u.test.ts"])), "verified");
    insert.run("done", "T003", JSON.stringify(task("T003", ["tests/u.test.ts"], "repair")), "verified");
    insert.run("open", "T001", JSON.stringify(task("T001", ["src/store.ts"])), "verified");
    db.close();
    expect(samplesFrom(path)).toEqual([
      { runId: "done", taskId: "T001", kind: "code", action: "modify", source: "project", files: 1, tokens: 28_000, model: "m", criteria: 1 },
      // The model that spent most of the task's own tokens names the sample.
      { runId: "done", taskId: "T002", kind: "test", action: "modify", source: "project", files: 1, tokens: 561_000, model: "m", criteria: 1 },
    ]);
    expect(samplesFrom(path, "shared").every((s) => s.source === "shared")).toBe(true);
  });
});

// cfgtrace b4427c85: one-file test parts priced at the per-file test rate (high 180k) used 547k on
// average, 7.65M tokens in all, because each covered several criteria (#1265).
describe("test tasks priced from their criteria", () => {
  const withCriteria = (tokens: number, criteria: number, more: Partial<SizingSample> = {}) =>
    sample("test", tokens, 1, { criteria, ...more });
  const covering = (id: string, paths: string[], criterionIds: string[]) => ({ ...task(id, paths), criterionIds });

  test("the rate per criterion is measured from finished test tasks, never a constant", () => {
    expect(criterionRate([])).toBeNull();
    // One task is not enough, and samples without criteria (older history) do not count.
    expect(criterionRate([withCriteria(400_000, 4), sample("test", 300_000)])).toBeNull();
    expect(criterionRate([withCriteria(400_000, 4), withCriteria(600_000, 4)])).toEqual({
      perCriterion: { low: 100_000, high: 150_000 },
      samples: 2,
      basis: "project",
      model: null,
    });
    // The planned model's own tasks decide once it ran enough of them.
    const mixed = [
      withCriteria(400_000, 4, { model: "a" }),
      withCriteria(400_000, 4, { model: "a" }),
      withCriteria(800_000, 4, { model: "b" }),
      withCriteria(800_000, 4, { model: "b" }),
    ];
    expect(criterionRate(mixed, "b")?.perCriterion).toEqual({ low: 200_000, high: 200_000 });
  });

  test("a test task costs at least its criteria at that rate; code tasks keep the per-file price", () => {
    const rates = perFileRates([sample("test", 150_000), sample("test", 180_000), sample("code", 50_000), sample("code", 60_000)]);
    const rate = criterionRate([withCriteria(400_000, 4), withCriteria(600_000, 4)]);
    const five = covering("T002", ["tests/test_schema.py"], ["AC-001", "AC-002", "AC-003", "AC-004", "AC-005"]);
    expect(priceTask(five, rates)).toEqual({ low: 150_000, high: 180_000 });
    expect(priceTask(five, rates, rate)).toEqual({ low: 500_000, high: 750_000 });
    // A test task of one criterion is still priced per file when that is higher.
    expect(priceTask(covering("T003", ["tests/test_cli.py"], ["AC-001"]), rates, rate)).toEqual({ low: 150_000, high: 180_000 });
    const code = covering("T001", ["src/schema.py"], ["AC-001", "AC-002", "AC-003", "AC-004", "AC-005"]);
    expect(priceTask(code, rates, rate)).toEqual(priceTask(code, rates));
  });

  test("the plan's sizing prices its test tasks by criteria and records the rate", () => {
    const samples = [sample("test", 150_000), sample("test", 180_000), withCriteria(400_000, 4), withCriteria(600_000, 4)];
    const report = sizePlan({
      graph: graph(covering("T001", ["tests/test_schema.py"], ["AC-001", "AC-002", "AC-003"])),
      policy: policy({ maxAttemptTokens: 600_000 }),
      samples,
      spent: 0,
    });
    expect(report.criterionRate?.samples).toBe(2);
    expect(report.tasks[0]?.estimate.high).toBe(3 * (report.criterionRate?.perCriterion.high ?? 0));
    expect(report.tasks[0]?.attemptTokens).toBe(report.tasks[0]?.estimate.high);
  });

  test("the planner is told the price per criterion when history has one", () => {
    const note = (samples: SizingSample[]) => plannerSizing(policy({ maxAttemptTokens: 600_000 }), samples).note;
    expect(note([])).not.toContain("per criterion");
    expect(note([withCriteria(400_000, 4), withCriteria(600_000, 4)])).toContain("A test task costs at least about 150k per criterion it covers.");
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
  // cronsay 15eb3204: analysis read the added part as missing from plan.md and as a duplicate of
  // its sibling, and sent the run back to plan four times.
  test("analysis findings about the added parts are notes", () => {
    const tests = { ...task("T002", ["tests/test_parser.py", "tests/test_report.py"]), dependsOn: ["T001"] };
    const g = graph(task("T001", ["src/report.py"]), tests);
    const split = splitTestTasks(g, sized(g));
    const parts = hostSplitParts(split as TaskGraph);
    expect(parts).toEqual({ T002: ["T002", "T003"] });
    expect(isHostSplitNit({ refs: ["tasks.json"], description: "T003 is not listed in plan.md" }, parts)).toBe(true);
    expect(isHostSplitNit({ refs: ["T002", "T003"], description: "T002 and T003 check the same thing" }, parts)).toBe(true);
    expect(isHostSplitNit({ refs: ["T001", "T003"], description: "T003 tests code T001 never writes" }, parts)).toBe(false);
    expect(isHostSplitNit({ refs: ["T002"], description: "T002 has no test file" }, parts)).toBe(false);
    expect(hostSplitParts(g)).toEqual({});
  });
  test("a part keeps the criteria of its tested module; an unmatched part keeps the rest (#1245, #1563)", () => {
    const code = (id: string, path: string, criterionIds: string[]) => ({ ...task(id, [path]), criterionIds });
    const tests = { ...task("T003", ["tests/test_a.py", "tests/test_b.py", "tests/test_misc.py"]), criterionIds: ["AC-001", "AC-002", "AC-003"] };
    const g = graph(code("T001", "src/a.py", ["AC-001"]), code("T002", "src/b.py", ["AC-002"]), tests);
    const files = tests.writes.map((w) => w.path);
    expect(partCriteria(g, tests, files)).toEqual([["AC-001"], ["AC-002"], ["AC-003"]]);
    // Every part matched: the criterion none of them covers stays with the first part.
    expect(partCriteria(g, tests, files.slice(0, 2))).toEqual([["AC-001", "AC-003"], ["AC-002"]]);
  });
  test("new test parts wait for existing-test updates while new-only parts stay parallel (#1563)", () => {
    const tests = { ...task("T002", ["tests/new.test.ts", "tests/old.test.ts"]), writes: [{ path: "tests/new.test.ts", action: "create" as const }, { path: "tests/old.test.ts", action: "modify" as const, reason: "Update the old assertion" }], dependsOn: ["T001"], checkIds: ["typecheck", "lint", "tests"] };
    const g = graph(task("T001", ["src/new.ts"]), tests);
    const split = splitTestTasks(g, sized(g));
    expect(split?.tasks[1]?.dependsOn).toEqual(["T001", "T003"]);
    expect(split?.tasks[2]?.dependsOn).toEqual(["T001"]);
    expect(split?.tasks[1]?.checkIds).toEqual(tests.checkIds);
    expect(split?.tasks[1]?.description).toContain("T003 (tests/old.test.ts)");
    expect(split?.tasks[2]?.description).toContain("updates existing assertions");
    const created = { ...tests, writes: tests.writes.map((w) => ({ ...w, action: "create" as const })) };
    expect(splitTestTasks(graph(g.tasks[0]!, created), sized(graph(g.tasks[0]!, created)))?.tasks.slice(1).map((t) => t.dependsOn)).toEqual([["T001"], ["T001"]]);
  });
  test("code tasks and test tasks within one attempt are left to the planner", () => {
    const g = graph(task("T001", ["src/a.ts", "src/b.ts"]), task("T002", ["tests/a.test.ts"]));
    expect(splitTestTasks(g, sized(g))).toBeNull();
  });
});

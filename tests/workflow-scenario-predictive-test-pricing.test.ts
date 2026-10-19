import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { SizingReport } from "../src/core/workflows/sizing.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const specFor = (cases: number, second = false): Spec => ({
  ...fixtureSpec,
  criteria: Array.from({ length: cases * (second ? 2 : 1) }, (_, index) => ({
    ...fixtureSpec.criteria[0]!, id: `AC-${String(index + 1).padStart(3, "0")}`,
    given: `input "case-${index}"`, when: "it is handled", then: "the value is ready",
  })),
});
const task = (id: string, path: string, ids: string[], dependsOn: string[] = []): Task => ({
  id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"],
  criterionIds: ids, dependsOn, profileId: "implementer", writes: [{ path, action: "create" }],
  readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
});

/** Synthetic history with equal counts and a 0.1x-5x task-cost spread, not a bench database. */
function history(cases: number): string {
  const root = mkdtempSync(join(tmpdir(), "baked-task-distribution-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "workflows.sqlite");
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
      CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
      CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
      CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
      CREATE TABLE artifacts (run_id TEXT, logical_path TEXT, revision INTEGER, inline_content TEXT, blob_path TEXT);`);
    for (const [i, tokens] of [100_000, ...Array<number>(8).fill(1_000_000), 5_000_000].entries()) {
      const run = `h${i}`;
      const spec = specFor(cases);
      db.query("INSERT INTO runs VALUES (?, 'completed')").run(run);
      db.query("INSERT INTO tasks VALUES (?, 'T001', ?, 'verified')").run(run, JSON.stringify(task("T001", "tests/value.test.ts", spec.criteria.map((c) => c.id))));
      db.query("INSERT INTO steps VALUES (?, 's1', 'task-T001')").run(run);
      db.query("INSERT INTO attempts VALUES (?, 's1', 'm', ?)").run(run, tokens);
      db.query("INSERT INTO artifacts VALUES (?, 'spec.json', 1, ?, NULL)").run(run, JSON.stringify(spec));
    }
  } finally { db.close(); }
  return path;
}

class ScriptedExecutor extends FixtureExecutor {
  plans = 0;
  caps: number[] = [];
  constructor(private workspace: string, private spec: Spec, private second = false) { super(workspace); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: this.spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      this.plans++;
      const result = await super.execute(request);
      const plan = result.output as { markdown: string; taskGraph: TaskGraph };
      plan.markdown += "\nTests in tests/value.test.ts and tests/second.test.ts.";
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      plan.taskGraph.specHash = hashJson(this.spec);
      const ids = this.spec.criteria.map((c) => c.id);
      const half = this.second ? ids.length / 2 : ids.length;
      plan.taskGraph.tasks = [task("T001", "value.txt", ids), task("T002", "tests/value.test.ts", ids.slice(0, half), ["T001"])];
      if (this.second) plan.taskGraph.tasks.push(task("T003", "tests/second.test.ts", ids.slice(half), ["T002"]));
      return result;
    }
    if (request.profile.output === "implementation" && request.task?.id === "T001") {
      writeFileSync(join(request.root ?? this.workspace, "value.txt"), "ready");
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation" && request.task?.id !== "T001") {
      const own = request.task!;
      this.caps.push(request.attemptTokens ?? 0);
      const path = join(request.root!, own.writes[0]!.path);
      mkdirSync(dirname(path), { recursive: true });
      const values = own.criterionIds.map((id) => `case-${Number(id.slice(3)) - 1}`);
      writeFileSync(path, `import { expect, test } from "bun:test";\ntest("assigned cases", () => {\n${values.map((v) => `expect(${JSON.stringify(v)}).toBe(${JSON.stringify(v)});`).join("\n")}\n});\n`);
      return { output: { schemaVersion: 1, taskId: own.id, outcome: "implemented", summary: "Wrote assigned cases", evidenceIds: [], unresolved: [] }, inputTokens: 700_000, outputTokens: 100_000 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const output = result.output as { coverage: { criterionId: string }[] };
      output.coverage = this.spec.criteria.map((c) => ({ ...output.coverage[0]!, criterionId: c.id }));
    }
    return result;
  }
}

for (const cases of [10, 18]) {
  test(`scenario: ${cases} cases use whole-task quantiles without false splits (#1595)`, async () => {
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, sizing: { maxAttemptTokens: 600_000, maxRunTokens: 8_000_000, historyStores: [history(18)] } },
      executor: (root) => new ScriptedExecutor(root, specFor(cases)),
    });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const store = fixture.service.store;
    const report = JSON.parse(store.readArtifact(run.runId, store.latestArtifact(run.runId, "sizing/plan-0.json")!.id)) as SizingReport;
    expect(report.tasks.find((t) => t.taskId === "T002")).toMatchObject({ estimate: { low: 1_000_000, high: 1_000_000 }, attemptTokens: 600_000, oversized: false, cases });
    expect(report.testTaskRates.all).toMatchObject({ samples: 10, perTask: { low: 1_000_000, high: 1_000_000 } });
    expect(store.state(run.runId).graph!.tasks).toHaveLength(2);
    expect(store.state(run.runId).sizingReplans).toBe(0);
    expect(fixture.executor.plans).toBe(1);
    expect(report.budgetAfter).toBeLessThan(4_000_000);
  }, 120_000);
}

for (const executionMode of ["inline", "worktree"] as const) {
 test(`scenario: cold 20-case files learn from this run in ${executionMode} dispatch (#1595)`, async () => {
  const fixture = workflowFixture({
    policy: { ...fixturePolicy, clarification: "assume", maxTotalTokens: 8_000_000, sizing: { maxAttemptTokens: 2_000_000 } },
    executor: (root) => new ScriptedExecutor(root, specFor(20, true), true),
  });
  cleanups.push(fixture.dispose);
  if (executionMode === "worktree") {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(fixture.root, ".gitignore"), ".baked/\n");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "Initial fixture");
  }
  const run = await fixture.service.start({ commandId: crypto.randomUUID(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: fixture.policy, executionMode, maxConcurrentWriters: executionMode === "worktree" ? 2 : 1 });
  expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
  const store = fixture.service.store;
  const report = JSON.parse(store.readArtifact(run.runId, store.latestArtifact(run.runId, "sizing/plan-0.json")!.id)) as SizingReport;
  expect(report.tasks.find((t) => t.taskId === "T002")).toMatchObject({ cases: 20, estimate: { high: 1_500_000 } });
  await fixture.approve(run.runId);
  expect((await fixture.service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
  expect(fixture.executor.caps).toEqual([1_500_000, 800_000]);
  const updates = store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("sizing/progress-"));
  expect(updates).toHaveLength(1);
  const updated = JSON.parse(store.readArtifact(run.runId, updates[0]!.id)) as SizingReport;
  expect(updated.testTaskRates.all).toMatchObject({ basis: "run", samples: 1, perTask: { low: 800_000, high: 800_000 } });
  expect(store.state(run.runId).graph!.tasks).toHaveLength(3);
}, 120_000);
}

test("scenario: tasks above measured case capacity get distinct ordered part titles (#1595)", async () => {
  const fixture = workflowFixture({
    policy: { ...fixturePolicy, sizing: { maxAttemptTokens: 600_000, maxRunTokens: 8_000_000, historyStores: [history(6)] } },
    executor: (root) => new ScriptedExecutor(root, specFor(12)),
  });
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
  const parts = fixture.service.store.state(run.runId).graph!.tasks.filter((t) => t.sizingSlice);
  expect(parts.map((t) => t.title)).toEqual(["Write tests/value.test.ts (part 1 of 2)", "Write tests/value.test.ts (part 2 of 2)"]);
  expect(parts.map((t) => t.criterionIds.length)).toEqual([6, 6]);
  expect(parts[1]!.dependsOn).toContain(parts[0]!.id);
}, 120_000);

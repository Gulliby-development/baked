import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { SizingReport } from "../src/core/workflows/sizing.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #1581: fixed task overhead in three one/two-case samples became a per-case maximum.
// The real scheduler then split even two-case files before analysis and approval.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const specFor = (cases: number): Spec => ({
  ...fixtureSpec,
  criteria: Array.from({ length: cases }, (_, index) => ({
    ...fixtureSpec.criteria[0]!, id: `AC-${String(index + 1).padStart(3, "0")}`,
    given: `input "case-${index}"`, when: "it is handled", then: "the value is ready",
  })),
});
const task = (id: string, path: string, spec: Spec): Task => ({
  id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"],
  criterionIds: spec.criteria.map((c) => c.id), dependsOn: [], profileId: "implementer",
  writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned",
  findingIds: [], rationale: "Required behavior",
});

function history(samples: { cases: number; tokens: number }[]): string {
  const root = mkdtempSync(join(tmpdir(), "baked-sparse-case-history-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "workflows.sqlite");
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
      CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
      CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
      CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
      CREATE TABLE artifacts (run_id TEXT, logical_path TEXT, revision INTEGER, inline_content TEXT, blob_path TEXT);`);
    for (const [index, sample] of samples.entries()) {
      const run = `h${index}`;
      const spec = specFor(sample.cases);
      db.query("INSERT INTO runs VALUES (?, 'completed')").run(run);
      db.query("INSERT INTO tasks VALUES (?, 'T001', ?, 'verified')").run(run, JSON.stringify(task("T001", "tests/value.test.ts", spec)));
      db.query("INSERT INTO steps VALUES (?, 's1', 'task-T001')").run(run);
      db.query("INSERT INTO attempts VALUES (?, 's1', 'm', ?)").run(run, sample.tokens);
      db.query("INSERT INTO artifacts VALUES (?, 'spec.json', 1, ?, NULL)").run(run, JSON.stringify(spec));
    }
  } finally { db.close(); }
  return path;
}

class ScriptedExecutor extends FixtureExecutor {
  plans = 0;
  constructor(root: string, private spec: Spec) { super(root); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: this.spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      this.plans += 1;
      const result = await super.execute(request);
      const plan = result.output as { markdown: string; taskGraph: TaskGraph };
      plan.markdown += "\nTests in tests/value.test.ts.";
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      plan.taskGraph.specHash = hashJson(this.spec);
      plan.taskGraph.tasks = [task("T001", "value.txt", this.spec), { ...task("T002", "tests/value.test.ts", this.spec), dependsOn: ["T001"] }];
      return result;
    }
    return super.execute(request);
  }
}

const controls = [{ cases: 1, tokens: 323_000 }, { cases: 2, tokens: 214_000 }, { cases: 1, tokens: 350_000 }];
// A deterministic larger history with the case-count/cost spread reported for crossmill.
// These are synthetic samples, not the unavailable bench database.
const crossmillShape = Array.from({ length: 70 }, (_, index) => ({
  cases: [1, 2, 9, 17, 18][index % 5]!, tokens: [400_000, 374_000, 100_000, 636_000, 99_000][index % 5]!,
}));
for (const [label, samples] of [["three-sample controls", controls], ["crossmill-shaped history", crossmillShape]] as const) {
  for (const cases of [2, 5]) {
    test(`scenario: ${label} keeps a ${cases}-case file in one task (#1581)`, async () => {
      const fixture = workflowFixture({
        policy: { ...fixturePolicy, sizing: { maxAttemptTokens: 600_000, maxRunTokens: 5_000_000, historyStores: [history([...samples])] } },
        executor: (root) => new ScriptedExecutor(root, specFor(cases)),
      });
      cleanups.push(fixture.dispose);
      const run = await fixture.start();
      expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      const store = fixture.service.store;
      const graph = store.state(run.runId).graph!;
      expect(graph.tasks.filter((t) => t.writes.some((w) => w.path === "tests/value.test.ts"))).toHaveLength(1);
      expect(graph.tasks.some((t) => t.sizingSlice || t.description.includes("small batches"))).toBe(false);
      expect(fixture.executor.plans).toBe(1);
      const report = JSON.parse(store.readArtifact(run.runId, store.latestArtifact(run.runId, "sizing/plan-0.json")!.id)) as SizingReport;
      expect(report.tasks.find((t) => t.taskId === "T002")!.oversized).toBe(false);
      if (cases === 2) expect(report.tasks.find((t) => t.taskId === "T002")!.estimate.high).toBeLessThanOrEqual(Math.max(...samples.map((s) => s.tokens)));
      expect(report.testTaskRates.all?.samples).toBe(samples.length);
      expect(store.state(run.runId).sizingReplans).toBe(0);
    }, 120_000);
  }
}

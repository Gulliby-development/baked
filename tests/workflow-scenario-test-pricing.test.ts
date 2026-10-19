import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { SizingReport } from "../src/core/workflows/sizing.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #1265 exposed the per-file underestimate for test tasks. #1595 replaces its criterion
// multiplier with whole-task history, so file count and criterion count do not multiply overhead.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Config tracer", problem: "Layered config is opaque", outcome: "Layers are validated",
  inScope: ["Validate layers"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-001", text: "A layer is validated against the schema", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [
    { id: "AC-001", requirementIds: ["FR-001"], given: "a layer with an unknown key", when: "it is validated", then: "E201 is reported", method: "automated" },
    { id: "AC-002", requirementIds: ["FR-001"], given: "a layer with a wrong type", when: "it is validated", then: "E202 is reported", method: "automated" },
    { id: "AC-003", requirementIds: ["FR-001"], given: "a layer with a missing key", when: "it is validated", then: "E203 is reported", method: "automated" },
  ],
  dependencies: [],
};
const markdown = "# Plan\n## Context\nSchema.\n## Decisions\nDEC-001: FR-001 in schema.\n## Components\ncfgtrace/schema.py\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const task = (id: string, paths: string[], criterionIds: string[], dependsOn: string[] = []): Task => ({
  id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds, dependsOn, profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
});

/** A store of another project with two finished test tasks: 4 files and 2 criteria, 800k each. */
function history(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-test-pricing-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workflows.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
    CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
    CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
    CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
    CREATE TABLE artifacts (run_id TEXT, logical_path TEXT, revision INTEGER, inline_content TEXT, blob_path TEXT);
    INSERT INTO runs VALUES ('h1','completed'),('h2','completed');
    INSERT INTO steps VALUES ('h1','s1','task-T001'),('h2','s1','task-T001');
    INSERT INTO attempts VALUES ('h1','s1','m',800000),('h2','s1','m',800000);`);
  const files = ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py", "tests/test_d.py"];
  const insert = db.query("INSERT INTO tasks VALUES (?,?,?,?)");
  for (const run of ["h1", "h2"]) insert.run(run, "T001", JSON.stringify(task("T001", files, ["AC-001", "AC-002"])), "verified");
  for (const run of ["h1", "h2"]) db.query("INSERT INTO artifacts VALUES (?, 'spec.json', 1, ?, NULL)").run(run, JSON.stringify({ ...spec, criteria: spec.criteria.slice(0, 2).map((c, i) => ({ ...c, given: `input "case-${i}"` })) }));
  db.close();
  return path;
}

test("a one-file test task uses the whole-task cost of history instead of a criterion multiplier", async () => {
  const policy: RunPolicy = {
    ...fixturePolicy,
    clarification: "assume",
    sizing: { maxAttemptTokens: 2_000_000, historyStores: [history()] },
  };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const taskGraph: TaskGraph = {
        schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
        tasks: [
          task("T001", ["cfgtrace/schema.py"], ["AC-001", "AC-002", "AC-003"]),
          task("T002", ["tests/test_schema.py"], ["AC-001", "AC-002", "AC-003"], ["T001"]),
        ],
      };
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    return original(request);
  };
  const run = await fixture.start();
  const waiting = await service.drive(run.runId, new AbortController().signal);
  expect(waiting.reason).toBe("approval");
  const store = service.store;
  const plan = store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("sizing/plan-")).at(-1);
  if (!plan) throw new Error("no sizing");
  const report = JSON.parse(store.readArtifact(run.runId, plan.id)) as SizingReport;
  const tests = report.tasks.find((t) => t.taskId === "T002");
  expect(tests?.estimate).toEqual({ low: 800_000, high: 800_000 });
  expect(store.state(run.runId).taskBudgets.T002).toBe(800_000);
  // 800k over 2 criteria is 400k a criterion; the per-file rate is only 200k a file.
  expect(report.testTaskRates.all).toMatchObject({ perTask: { low: 800_000, high: 800_000 }, samples: 2 });
  expect(report.rates.test.create.perFile.high).toBeLessThan(400_000);
});

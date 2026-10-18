import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { SizingReport } from "../src/core/workflows/sizing.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #1562: youngkit's one-file test task was priced at 1.39M with a 600k cap, but was
// neither marked oversized nor split. Exercise the real scheduler through approval and execution.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const spec: Spec = {
  ...fixtureSpec,
  criteria: Array.from({ length: 6 }, (_, index) => ({
    ...fixtureSpec.criteria[0]!,
    id: `AC-${String(index + 1).padStart(3, "0")}`,
    given: `the input "case-${index + 1}"`,
    when: "the CLI handles the input",
    then: "the result equals the input",
  })),
};
const ids = spec.criteria.map((c) => c.id);
const task = (id: string, path: string, dependsOn: string[] = []): Task => ({
  id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"],
  criterionIds: ids, dependsOn, profileId: "implementer", writes: [{ path, action: "create" }],
  readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
});

function history(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-test-slices-history-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".baked"));
  const path = join(root, ".baked", "workflows.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
    CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
    CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
    CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
    CREATE TABLE artifacts (run_id TEXT, logical_path TEXT, revision INTEGER, inline_content TEXT, blob_path TEXT);
    INSERT INTO runs VALUES ('h1','completed'),('h2','completed');
    INSERT INTO steps VALUES ('h1','s1','task-T001'),('h2','s1','task-T001');
    INSERT INTO attempts VALUES ('h1','s1','m',1390000),('h2','s1','m',1390000);`);
  for (const run of ["h1", "h2"]) {
    db.query("INSERT INTO tasks VALUES (?,?,?,?)").run(run, "T001", JSON.stringify(task("T001", "tests/cli.test.ts")), "verified");
    if (run === "h1") db.query("INSERT INTO artifacts VALUES (?, 'spec.json', 1, ?, NULL)").run(run, JSON.stringify(spec));
    else {
      const blob = ".baked/workflow-runs/h2/blobs/spec";
      mkdirSync(dirname(join(root, blob)), { recursive: true });
      writeFileSync(join(root, blob), JSON.stringify(spec));
      db.query("INSERT INTO artifacts VALUES (?, 'spec.json', 1, NULL, ?)").run(run, blob);
    }
  }
  db.close();
  return path;
}

class ScriptedExecutor extends FixtureExecutor {
  attempts: { task: Task; cap?: number; paths?: string[]; cases: boolean }[] = [];
  constructor(private workspace: string, private testPath: string, private existing = false) { super(workspace); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const markdown = `# Plan\n## Context\nCLI\n## Decisions\nDEC-001: FR-001 in src/cli.ts.\n## Components\nsrc/cli.ts, ${this.testPath}, README.md\n## Data\nInputs\n## Verification\nTests\n## Risks\nNone for fixture`;
      const taskGraph: TaskGraph = {
        schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
        tasks: [task("T001", "src/cli.ts"), task("T002", this.testPath, ["T001"]), task("T003", "README.md", ["T002"])],
      };
      if (this.existing) taskGraph.tasks[1]!.writes.push({ path: "tests/old.test.ts", action: "modify", reason: "Update legacy expectations" });
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation") {
      const own = request.task!;
      const extra = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}").extra;
      this.attempts.push({ task: own, cap: request.attemptTokens, paths: extra.writtenTestsCheck?.paths, cases: !!request.caseCheck });
      const write = own.writes[0]!;
      const target = join(request.root ?? this.workspace, write.path);
      mkdirSync(dirname(target), { recursive: true });
      if (write.path === "src/cli.ts") writeFileSync(target, "export const cli = (v: string) => v;\n");
      else if (write.path === "README.md") writeFileSync(target, "# CLI\nReturns each input.\n");
      else if (write.path === "tests/old.test.ts") appendFileSync(target, `// Updated ${own.criterionIds.join(", ")}.\n`);
      else {
        if (write.action === "create") writeFileSync(target, 'import { expect, test } from "bun:test";\nimport { cli } from "../src/cli.ts";\n');
        for (const id of own.criterionIds) {
          const value = `case-${Number(id.slice(3))}`;
          appendFileSync(target, `test("${id}", () => expect(cli("${value}")).toBe("${value}"));\n`);
        }
      }
      return { output: { schemaVersion: 1, taskId: own.id, outcome: "implemented", summary: "Wrote assigned criteria", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const output = result.output as { coverage: { criterionId: string }[] };
      output.coverage = ids.map((criterionId) => ({ ...output.coverage[0]!, criterionId }));
    }
    return result;
  }
}

for (const [path, existing] of [["internal/cli/cli_test.go", false], ["tests/cli.test.ts", false], ["tests/test_cli.py", false], ["tests/cli.test.ts", true]] as const) {
  test(`scenario: an oversized ${path} becomes ordered criterion slices with their own caps, existing updates=${existing}`, async () => {
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, clarification: "assume", checks: [{ ...fixturePolicy.checks[0]!, id: "tests", args: ["test"] }], sizing: { maxAttemptTokens: 600_000, historyStores: [history()] } },
      executor: (root) => new ScriptedExecutor(root, path, existing),
    });
    cleanups.push(fixture.dispose);
    if (existing) {
      mkdirSync(join(fixture.root, "tests"), { recursive: true });
      writeFileSync(join(fixture.root, "tests/old.test.ts"), 'import { expect, test } from "bun:test";\ntest("legacy", () => expect(true).toBe(true));\n');
    }
    const run = await fixture.start();
    expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const store = fixture.service.store;
    const graph = store.state(run.runId).graph!;
    const parts = graph.tasks.filter((t) => t.writes.some((w) => w.path === path));
    expect(parts).toHaveLength(3);
    expect(parts.map((t) => t.criterionIds)).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
    expect(parts.map((t) => t.writes)).toEqual([
      [{ path, action: "create" }], [{ path, action: "modify" }], [{ path, action: "modify" }],
    ]);
    expect(parts[1]!.dependsOn).toContain(parts[0]!.id);
    expect(parts[2]!.dependsOn).toContain(parts[1]!.id);
    const updates = graph.tasks.filter((t) => t.writes[0]?.path === "tests/old.test.ts");
    expect(graph.tasks.find((t) => t.id === "T003")!.dependsOn).toEqual([...parts, ...updates].map((t) => t.id));
    if (existing) {
      expect(updates).toHaveLength(3);
      for (const part of parts) for (const update of updates) expect(part.dependsOn).toContain(update.id);
    }
    const artifact = store.latestArtifact(run.runId, "sizing/plan-0.json")!;
    const report = JSON.parse(store.readArtifact(run.runId, artifact.id)) as SizingReport;
    expect(report.caseRate?.samples).toBe(2);
    for (const part of parts) {
      const size = report.tasks.find((t) => t.taskId === part.id)!;
      expect(size).toMatchObject({ cases: 2, sliceCount: 3, oversized: false });
      expect(size.estimate.high).toBeLessThanOrEqual(600_000);
      expect(store.state(run.runId).taskBudgets[part.id]).toBe(size.estimate.high);
    }
    if (path.endsWith(".ts")) {
      await fixture.approve(run.runId);
      expect((await fixture.service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
      const attempts = fixture.executor.attempts.filter((a) => a.task.writes[0]!.path === path);
      expect(attempts.map((a) => a.task.id)).toEqual(parts.map((t) => t.id));
      expect(attempts.map((a) => a.paths)).toEqual([[path], [path], [path]]);
      expect(attempts.every((a) => a.cap === 463_333)).toBe(true);
      if (existing) {
        const old = fixture.executor.attempts.filter((a) => a.task.writes[0]?.path === "tests/old.test.ts");
        expect(attempts.every((a) => a.cases)).toBe(true);
        expect(old).toHaveLength(3);
        expect(old.every((a) => !a.cases)).toBe(true);
        expect(fixture.executor.attempts.indexOf(old.at(-1)!)).toBeLessThan(fixture.executor.attempts.indexOf(attempts[0]!));
      }
      const text = readFileSync(join(fixture.root, path), "utf8");
      for (const id of ids) expect(text.match(new RegExp(id, "g"))).toHaveLength(1);
    }
  }, 120000);
}

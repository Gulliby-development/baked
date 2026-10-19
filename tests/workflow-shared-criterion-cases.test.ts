import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criterionCases } from "../src/core/verification/criteria-cases.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import { samplesFrom, sizePlan, splitTestTasks, type SizingSample } from "../src/core/workflows/sizing.js";
import type { Task } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec } from "./helpers/workflow-fixture.js";

const rows = ["--ascending", "--descending", "--stdin"];
const spec = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, given: "CLI input", when: "it runs",
  then: rows.map((row) => `input "${row}"`).join("; ") }] };
const tasks: Task[] = rows.map((row, index) => ({
  id: `T00${index + 1}`, title: `Test ${row}`, description: `Test ${row}`, requirementIds: ["FR-001"],
  criterionIds: ["AC-001"], dependsOn: index ? [`T00${index}`] : [], profileId: "implementer",
  writes: [{ path: "tests/cli.test.ts", action: index ? "modify" : "create" }], readHints: [],
  checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
}));
const graph = (tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1,
  specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
const literals = (task: Task, plan = tasks) => criterionCases(spec, task, { tasks: plan, includeBroad: true }).map((c) => c.literal);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("shared criterion ownership (#1597)", () => {
  test("a broad criterion with only one test carrier keeps its gate exemption", () => {
    const plan = [tasks[0]!, ...["src/cli.ts", "README.md"].map((path, i) => ({
      ...tasks[i + 1]!, writes: [{ path, action: "create" as const }],
    }))];
    expect(criterionCases(spec, plan[0]!, { tasks: plan })).toEqual([]);
    expect(criterionCases(spec, plan[0]!).map((c) => c.literal)).toEqual(rows);
  });

  test("single carriers and callers without a plan retain every case", () => {
    expect(literals(tasks[0]!, [tasks[0]!])).toEqual(rows);
    expect(criterionCases(spec, tasks[0]!).map((c) => c.literal)).toEqual(rows);
    expect(literals({ ...tasks[0]!, id: "T099", origin: "corrective" })).toEqual(rows);
  });

  test("the final carrier receives unnamed cases in dependency order", () => {
    const plan = tasks.map((t, i) => ({ ...t, description: i ? "Complete remaining cases" : t.description }));
    const reversed = [...plan].reverse();
    expect(plan.map((t) => literals(t, reversed))).toEqual([[rows[0]!], [], rows.slice(1)]);
    expect(plan.flatMap((t) => literals(t, reversed))).toEqual(rows);
  });

  test("code tasks cannot claim rows and duplicate claims have one owner", () => {
    const code = { ...tasks[0]!, id: "T000", dependsOn: [], description: rows.join(" "), writes: [{ path: "src/cli.ts", action: "create" as const }] };
    const plan = [code, ...tasks.map((t) => ({ ...t, description: rows.join(" ") }))];
    expect(plan.slice(1).map((t) => literals(t, plan))).toEqual([rows, [], []]);
  });

  test("slice shares partition unnamed rows without losing the remainder", () => {
    const plan = tasks.map((t, index) => ({ ...t, description: "Add the assigned slice", sizingSlice: {
      taskId: "T001", index, count: 3, share: [0.5, 0.25, 0.25][index]!,
    } }));
    expect(plan.map((t) => literals(t, plan))).toEqual([[rows[0]!], [rows[1]!], [rows[2]!]]);
    expect(plan.flatMap((t) => literals(t, plan))).toEqual(rows);
  });

  test("history counts the same owned rows as live pricing", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-shared-case-history-"));
    roots.push(root);
    const path = join(root, "workflows.sqlite");
    const db = new Database(path);
    try {
      db.exec(`CREATE TABLE runs (id TEXT, status TEXT);
        CREATE TABLE tasks (run_id TEXT, id TEXT, definition_json TEXT, status TEXT);
        CREATE TABLE steps (run_id TEXT, id TEXT, stage_id TEXT);
        CREATE TABLE attempts (run_id TEXT, step_id TEXT, model_id TEXT, used_tokens INTEGER);
        CREATE TABLE artifacts (run_id TEXT, logical_path TEXT, revision INTEGER, inline_content TEXT, blob_path TEXT);
        INSERT INTO runs VALUES ('h1', 'completed');`);
      db.query("INSERT INTO artifacts VALUES ('h1', 'spec.json', 1, ?, NULL)").run(JSON.stringify(spec));
      for (const task of tasks) {
        db.query("INSERT INTO tasks VALUES ('h1', ?, ?, 'verified')").run(task.id, JSON.stringify(task));
        db.query("INSERT INTO steps VALUES ('h1', ?, ?)").run(task.id, `task-${task.id}`);
        db.query("INSERT INTO attempts VALUES ('h1', ?, 'm', 100000)").run(task.id);
      }
    } finally { db.close(); }
    expect(samplesFrom(path).map((s) => s.cases)).toEqual([1, 1, 1]);
    expect(sizePlan({ graph: graph(tasks), policy: fixturePolicy, samples: [], spent: 0, spec }).tasks.map((t) => t.cases)).toEqual([1, 1, 1]);
  });

  test("host split shares use the original task's owned cases", () => {
    const largeSpec = { ...spec, criteria: [...spec.criteria, { ...spec.criteria[0]!, id: "AC-002",
      then: Array.from({ length: 40 }, (_, i) => `input "value-${i}"`).join("; ") }] };
    const first = { ...tasks[0]!, criterionIds: ["AC-001", "AC-002"] };
    const plan = graph([first, tasks[1]!, tasks[2]!]);
    const sample: SizingSample = { runId: "h", taskId: "T001", kind: "test", action: "create", source: "project",
      files: 1, tokens: 1_400_000, model: null };
    const policy = { ...fixturePolicy, sizing: { maxAttemptTokens: 600_000 } };
    const report = sizePlan({ graph: plan, policy, samples: [sample, sample], spent: 0, spec: largeSpec });
    const split = splitTestTasks(plan, report, largeSpec)!;
    const parts = split.tasks.filter((t) => t.sizingSlice?.taskId === first.id);
    expect(parts).toHaveLength(2);
    expect(parts.map((t) => t.sizingSlice!.share)).toEqual([1 / 41, 40 / 41]);
    const resized = sizePlan({ graph: split, policy, samples: [sample, sample], spent: 0, spec: largeSpec });
    expect(parts.map((p) => resized.tasks.find((t) => t.taskId === p.id)!.cases)).toEqual([1, 40]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StartBody } from "../src/core/api/schemas.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { literalRows, rowAuditProblems, rowFiles, rowPlanProblems, rowsArtifact } from "../src/core/workflows/acceptance-rows.js";
import type { Analysis, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { prepareStart } from "../src/core/workflows/start.js";
import { sizePlan } from "../src/core/workflows/sizing.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const spec = (table: string): Spec => ({ ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, given: "a JSON value", when: "the function is called", then: table }] });
const task: Task = {
  id: "T001", title: "Test", description: "Write a harness", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [],
  profileId: "implementer", readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Test",
  rows: ["AC-001"], rowTest: { framework: "bun", harness: "tests/harness.ts", test: "tests/rows.test.ts", data: "tests/rows.json" },
  writes: ["tests/harness.ts", "tests/rows.test.ts", "tests/rows.json"].map((path) => ({ path, action: "create" })),
};
const graph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task] };
const analysis = (rows: string[], matches = true): Analysis => ({ schemaVersion: 1, inputHash: "a".repeat(64), verdict: "pass", findings: [],
  derivations: rows.map((row) => ({ criterionId: "AC-001", row, recomputed: row.split("|")[1] ?? "", matches, derivation: "Recomputed from the requirement" })) });

describe("acceptance rows", () => {
  test("keeps typed JSON values, row identity, whitespace and backticks inside strings", () => {
    const rows = literalRows(spec('| Input | Expected |\n| --- | --- |\n| `{"a":[true,null,-2]}` | `[1,2]` |\n| "a  `b" | "c" |'), ["AC-001"]);
    expect(rows.map((row) => [row.id, row.input, row.expected])).toEqual([
      ["AC-001:1", { a: [true, null, -2] }, [1, 2]], ["AC-001:2", "a  `b", "c"],
    ]);
  });

  test("refuses expressions, incomplete tables, unsafe numeric values and manual/property criteria", () => {
    for (const table of ['Input | Expected\n12 | 24\nfoo() | 2', 'Input | Expected\n{"n":1e999} | null', 'Input | Expected\n9007199254740993 | 1', 'value | result\n1 | 2'])
      expect(literalRows(spec(table), ["AC-001"])).toEqual([]);
    const manual = spec("Input | Expected\n1 | 2");
    manual.criteria[0]!.method = "manual";
    expect(literalRows(manual, ["AC-001"])).toEqual([]);
    manual.criteria[0]!.method = "automated";
    manual.criteria[0]!.property = "numbers";
    expect(literalRows(manual, ["AC-001"])).toEqual([]);
  });

  test("requires a successful audit for every exact row, not just its criterion", () => {
    const s = spec('Input | Expected\n12 | 24\n-3 | -6');
    expect(rowAuditProblems(s, graph, analysis(["12 | 24"]))).toHaveLength(1);
    expect(rowAuditProblems(s, graph, analysis(["12 | 24", "-3 | -6"]))).toEqual([]);
    expect(rowAuditProblems(s, graph, analysis(["12 | 24", "12 | 24", "-3 | -6"]))).toHaveLength(1);
    expect(rowAuditProblems(s, graph, analysis(["12 | 24", "-3 | -6"], false))).toHaveLength(2);
    // A mismatch is a valid submission so the derivation audit can send it back to specify.
    expect(rowAuditProblems(s, graph, analysis(["12 | 24", "-3 | -6"], false), false)).toEqual([]);
    expect(rowAuditProblems(spec('Input | Expected\n"a  b" | 2'), graph, analysis(['"a b" | 2']))).toHaveLength(1);
  });

  test("rejects disabled, partial, overlapping and existing-file declarations", () => {
    const s = spec("Input | Expected\n12 | 24");
    expect(rowPlanProblems(s, graph, fixturePolicy).join()).toContain('rowsAsData: "on"');
    const enabled = { ...fixturePolicy, rowsAsData: "on" as const };
    expect(rowPlanProblems(s, graph, enabled)).toEqual([]);
    for (const broken of [
      { ...task, rowTest: undefined },
      { ...task, rows: ["AC-999"] },
      { ...task, rows: ["AC-001", "AC-001"] },
      { ...task, writes: task.writes.map((w) => ({ ...w, action: "modify" as const })) },
      { ...task, rowTest: { ...task.rowTest!, framework: "pytest" as const } },
    ]) expect(rowPlanProblems(s, { ...graph, tasks: [broken] }, enabled).length).toBeGreaterThan(0);
    expect(rowPlanProblems(s, { ...graph, tasks: [task, { ...task, id: "T002" }] }, enabled).length).toBeGreaterThan(0);
  });

  test("sizing prices the harness and leaves host files and row cases out", () => {
    const s = spec("Input | Expected\n12 | 24\n34 | 68");
    const report = sizePlan({ graph, policy: { ...fixturePolicy, rowsAsData: "on", sizing: {} }, samples: [], spent: 0, spec: s });
    expect(report.tasks[0]).toMatchObject({ taskId: "T001", files: 1, cases: 0, oversized: false });
    const ordinary = sizePlan({ graph: { ...graph, tasks: [{ ...task, rows: undefined, rowTest: undefined }] }, policy: fixturePolicy, samples: [], spent: 0, spec: s });
    expect(ordinary.tasks[0]?.files).toBe(3);
    expect(ordinary.tasks[0]?.cases).toBe(2);
    const mixed = spec('Input | Expected\n12 | 24\n34 | 68\n\nIt also prints "ordinary_case_19" for input "extra_case_42".');
    const mixedReport = sizePlan({ graph, policy: fixturePolicy, samples: [], spent: 0, spec: mixed });
    expect(mixedReport.tasks[0]).toMatchObject({ files: 1, cases: 2 });
  });

  test("Bun loads literal data without executing it, and a wrong harness fails", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-row-emitter-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const s = spec('Input | Expected\n"process.exit(99)" | "process.exit(99)"\n{"b":true,"n":null} | {"b":true,"n":null}');
    for (const file of rowFiles(task, rowsArtifact(s, graph, analysis([])))) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.content);
    }
    writeFileSync(join(root, task.rowTest!.harness), 'export const actual = (input: unknown) => input;\n');
    expect(Bun.spawnSync([process.execPath, "test", "./tests/rows.test.ts"], { cwd: root }).exitCode).toBe(0);
    writeFileSync(join(root, task.rowTest!.harness), 'export const actual = () => null;\n');
    expect(Bun.spawnSync([process.execPath, "test", "./tests/rows.test.ts"], { cwd: root }).exitCode).not.toBe(0);
  });

  test("file tools refuse generated data and tests even when a corrective claims them", async () => {
    const fixture = workflowFixture(); cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const state = fixture.service.store.state(run.runId);
    state.rootGraph = graph;
    state.graph = graph;
    fixture.service.store.saveState(run.runId, state);
    fixture.service.store.transition(run.runId, "running");
    const profile = builtinProfiles.find((p) => p.id === "implementer")!;
    const guard = new WorkflowToolPolicy(fixture.service.store, fixture.service.leases, run.runId, "attempt", profile,
      { ...fixturePolicy, rowsAsData: "on" }, { ...task, id: "T002", origin: "repair", rows: undefined, rowTest: undefined });
    for (const name of ["edit_file", "multi_edit"])
      for (const path of [task.rowTest!.test, task.rowTest!.data])
        expect(() => guard.validate(name, { path, oldString: "before", newString: "after" })).toThrow("Host-written acceptance file is read-only");
    expect(fixture.service.store.effects(run.runId)).toHaveLength(0);
  });
});

describe("rows setting across run entry points", () => {
  test("CLI and API accept on/off and reject other modes", () => {
    const body = { commandId: "rows", feature: "fixture", prompt: "test rows" };
    for (const mode of ["off", "on"] as const) {
      for (const command of ["run", "quick"])
        expect(parseWorkflowArgs([command, ...(command === "run" ? ["--feature", "fixture", "--prompt", "p"] : ["do work"]), "--rows-as-data", mode]).flags["rows-as-data"]).toBe(mode);
      expect(StartBody.parse({ ...body, rowsAsData: mode }).rowsAsData).toBe(mode);
    }
    expect(() => parseWorkflowArgs(["run", "--feature", "fixture", "--prompt", "p", "--rows-as-data", "maybe"])).toThrow("--rows-as-data accepts off or on");
    expect(StartBody.safeParse({ ...body, rowsAsData: true }).success).toBe(false);
  });

  test("the flag overrides the policy, and default/off leave the frozen policy unchanged", async () => {
    const fixture = workflowFixture(); cleanups.push(fixture.dispose);
    const base = { workflowId: "sdd", policy: fixturePolicy };
    const original = await prepareStart(fixture.root, fixture.config, base);
    const off = await prepareStart(fixture.root, fixture.config, { ...base, rowsAsData: "off" });
    expect(off.policy).toEqual(original.policy);
    const on = await prepareStart(fixture.root, fixture.config, { ...base, rowsAsData: "on" });
    expect(on.policy.rowsAsData).toBe("on");
    expect((await prepareStart(fixture.root, fixture.config, { ...base, policy: on.policy, rowsAsData: "off" })).policy).toEqual(original.policy);
    await expect(prepareStart(fixture.root, fixture.config, { ...base, workflowId: "quick", rowsAsData: "on" })).rejects.toThrow("requires an analyze stage");
  });
});

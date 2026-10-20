import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StartBody } from "../src/core/api/schemas.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { hostRowPaths, literalRows, ROWS_NOTE, rowAuditProblems, rowDataPaths, rowFiles, rowPlanProblems, rowsArtifact } from "../src/core/workflows/acceptance-rows.js";
import { hasInlineRows, INLINE_HARNESS, type InlineRowTest, inlineRowFile, withInlineRows } from "../src/core/workflows/acceptance-rows-inline.js";
import { type Analysis, type Spec, type Task, type TaskGraph, TaskSchema } from "../src/core/workflows/schemas.js";
import { prepareStart } from "../src/core/workflows/start.js";
import { sizePlan } from "../src/core/workflows/sizing.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import { builtinPresets, instantiatePreset } from "../src/core/workflows/v2/definitions.js";
import { stageKind } from "../src/core/workflows/v2/runtime.js";
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
    const quick = await prepareStart(fixture.root, fixture.config, { ...base, workflowId: "quick", rowsAsData: "on" });
    expect(quick.policy.rowsAsData).toBeUndefined();
    expect(quick.routing.warnings?.[0]).toContain("rowsAsData is ignored for workflow quick");
  });

  test("every preset normalizes requested and inherited rows according to its analyze stage", async () => {
    const fixture = workflowFixture(); cleanups.push(fixture.dispose);
    for (const args of [["init"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "Fixture"]])
      expect(Bun.spawnSync(["git", ...args], { cwd: fixture.root }).exitCode).toBe(0);
    for (const [workflowId, definition] of builtinPresets) {
      const analyzes = definition.stages.some((stage) => stageKind(stage) === "analyze");
      for (const inherited of [false, true]) {
        const prepared = await prepareStart(fixture.root, fixture.config, {
          workflowId, policy: { ...fixturePolicy, ...(inherited ? { rowsAsData: "on" as const } : {}) },
          ...(!inherited ? { rowsAsData: "on" as const } : {}),
        });
        expect(prepared.policy.rowsAsData).toBe(analyzes ? "on" : undefined);
        expect(prepared.routing.warnings?.some((warning) => warning.includes("rowsAsData is ignored")) ?? false).toBe(!analyzes);
      }
    }
  });

  test("custom definitions and explicit off preserve analyze-stage semantics", async () => {
    const fixture = workflowFixture(); cleanups.push(fixture.dispose);
    const directory = join(fixture.root, "baked", "workflows");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "custom-analysis.json"), JSON.stringify({ ...sddWorkflow, id: "custom-analysis",
      stages: sddWorkflow.stages.map((stage) => stage.kind === "analyze" ? { ...stage, id: "audit" } : stage),
    }));
    writeFileSync(join(directory, "custom-quick.json"), JSON.stringify({
      ...instantiatePreset(builtinPresets.get("quick")!, fixturePolicy), id: "custom-quick",
    }));
    const policy = { ...fixturePolicy, rowsAsData: "on" as const };
    for (const workflowId of ["custom-analysis", "custom-quick", "quick"]) {
      const analyzes = workflowId === "custom-analysis";
      const prepared = await prepareStart(fixture.root, fixture.config, { workflowId, policy });
      expect(prepared.policy.rowsAsData).toBe(analyzes ? "on" : undefined);
      expect(prepared.routing.warnings?.some((warning) => warning.includes("rowsAsData is ignored")) ?? false).toBe(!analyzes);
      const off = await prepareStart(fixture.root, fixture.config, { workflowId, policy, rowsAsData: "off" });
      expect(off.policy.rowsAsData).toBeUndefined();
      expect(off.routing.warnings?.some((warning) => warning.includes("rowsAsData is ignored")) ?? false).toBe(false);
    }
  });
});

describe("acceptance rows in every supported language (#1660)", () => {
  const enabled = { ...fixturePolicy, rowsAsData: "on" as const };
  const labelled = spec('Input | Scenario | Expected\n--- | --- | ---\n`[2, 3]` | two "small" numbers | `6`\n`"a\\u2028b\\u0001"` | odd text | `"a\\u2028b\\u0001"`\n`[null]` | null element | `{"k":[1.5,null]}`');
  const withTest = (rowTest: NonNullable<Task["rowTest"]>): Task => ({
    ...task, rowTest, writes: [rowTest.harness, rowTest.test, rowTest.data].map((path) => ({ path, action: "create" as const })),
  });
  const layouts: Record<string, NonNullable<Task["rowTest"]>> = {
    go: { framework: "go", package: "calc", harness: "calc/harness.go", test: "calc/rows_test.go", data: "calc/testdata/rows.json" },
    junit: { framework: "junit", package: "com.ex.calc", harness: "src/main/java/com/ex/calc/Harness.java", test: "src/test/java/com/ex/calc/RowsTest.java", data: "src/test/resources/rows.json" },
    rust: { framework: "rust", harness: "tests/support/harness.rs", test: "tests/rows.rs", data: "tests/data/rows.json" },
    xunit: { framework: "xunit", package: "Calc.Tests", harness: "Calc.Tests/Harness.cs", test: "Calc.Tests/RowsTest.cs", data: "Calc.Tests/rows.json" },
  };

  test("a Scenario column is a label the reader skips, and an audit may leave it out", () => {
    const rows = literalRows(labelled, ["AC-001"]);
    expect(rows.map((row) => [row.id, row.label, row.input, row.expected])).toEqual([
      ["AC-001:1", 'two "small" numbers', [2, 3], 6],
      ["AC-001:2", "odd text", "a b\u0001", "a b\u0001"],
      ["AC-001:3", "null element", [null], { k: [1.5, null] }],
    ]);
    expect(literalRows(spec("Expected | Input\n2 | 1"), ["AC-001"]).map((row) => row.input)).toEqual([1]);
    for (const table of ["Input | Notes | Expected\n1 | a | 2", "Input | Scenario | Expected\n1 | a | 2\n3 | 4"])
      expect(literalRows(spec(table), ["AC-001"])).toEqual([]);
    const s = spec("Input | Scenario | Expected\n12 | doubles | 24\n-3 | negative | -6");
    expect(rowAuditProblems(s, graph, analysis(["12 | 24", "-3 | negative | -6"]))).toEqual([]);
    expect(rowAuditProblems(s, graph, analysis(["12 | 24", "-3 | -7"]))).toHaveLength(1);
  });

  test("each framework accepts its layout and refuses a test its harness cannot reach", () => {
    const s = spec("Input | Expected\n12 | 24");
    for (const rowTest of Object.values(layouts))
      expect(rowPlanProblems(s, { ...graph, tasks: [withTest(rowTest)] }, enabled)).toEqual([]);
    for (const rowTest of [
      { ...layouts.go!, package: undefined },
      { ...layouts.go!, harness: "other/harness.go" },
      { ...layouts.go!, harness: "calc/harness_test.go" },
      { ...layouts.junit!, package: "com.ex.other" },
      { ...layouts.junit!, test: "src/test/java/com/ex/calc/RowsCheck.java" },
      { ...layouts.rust!, test: "src/rows.rs" },
      { ...layouts.xunit!, package: undefined },
      { ...layouts.xunit!, harness: "Calc.Tests/my-harness.cs" },
    ]) expect(rowPlanProblems(s, { ...graph, tasks: [withTest(rowTest)] }, enabled)).toHaveLength(1);
    const second = withTest({ ...layouts.go!, test: "calc/more_test.go", data: "calc/testdata/more.json" });
    expect(rowPlanProblems(s, { ...graph, tasks: [withTest(layouts.go!), { ...second, id: "T002" }] }, enabled).join()).toContain("one Go harness per package");
  });

  test("Java and C# hold the rows as escaped literals, and Rust includes the data file", () => {
    const files = (name: string) => {
      const t = withTest(layouts[name]!);
      return rowFiles(t, rowsArtifact(labelled, { ...graph, tasks: [t] }, analysis([])));
    };
    const java = files("junit")[1]!.content;
    expect(java).toContain("package com.ex.calc;");
    expect(java).toContain("class RowsTest {");
    expect(java).toContain('row("AC-001:1", list(2L, 3L), 6L)');
    // \u is unescaped before Java lexes a literal, so control characters are octal escapes.
    expect(java).toContain('"a b\\001"');
    expect(java).toContain('row("AC-001:3", list((Object) null), map("k", list(1.5d, (Object) null)))');
    expect(java).toContain("Harness.actual(input)");
    const csharp = files("xunit")[1]!.content;
    expect(csharp).toContain("namespace Calc.Tests");
    expect(csharp).toContain("public class RowsTest");
    expect(csharp).toContain("Harness.Actual(JsonNode.Parse(input))");
    expect(csharp).not.toContain(" ");
    expect(csharp).toContain("a\\u2028b");
    const rust = files("rust")[1]!.content;
    expect(rust).toContain('#[path = "support/harness.rs"]');
    expect(rust).toContain('include_str!("data/rows.json")');
  });

  // Bun.spawnSync throws when the executable is missing (macOS runners have no Go).
  const go = Bun.which("go") !== null && Bun.which("gofmt") !== null;
  test.skipIf(!go)("Go runs every row through Actual, and a wrong harness fails", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-row-go-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const t = withTest(layouts.go!);
    for (const file of rowFiles(t, rowsArtifact(labelled, { ...graph, tasks: [t] }, analysis([])))) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.content);
    }
    writeFileSync(join(root, "go.mod"), "module example.com/fixture\n\ngo 1.21\n");
    const harness = (body: string) => writeFileSync(join(root, "calc/harness.go"), `package calc\n\nfunc Actual(input any) (any, error) {\n${body}\n}\n`);
    harness('\tif xs, ok := input.([]any); ok && len(xs) == 2 {\n\t\treturn xs[0].(float64) * xs[1].(float64), nil\n\t}\n\tif xs, ok := input.([]any); ok && len(xs) == 1 {\n\t\treturn map[string][]any{"k": {1.5, nil}}, nil\n\t}\n\treturn input, nil');
    const run = () => Bun.spawnSync(["go", "test", "./..."], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const passing = run();
    expect(passing.exitCode, passing.stdout.toString() + passing.stderr.toString()).toBe(0);
    expect(Bun.spawnSync(["gofmt", "-l", "."], { cwd: root }).stdout.toString()).toBe("");
    harness("\treturn input, nil");
    expect(run().exitCode).not.toBe(0);
  }, 120000);
});

describe("inline acceptance rows (#1763)", () => {
  const enabled = { ...fixturePolicy, rowsAsData: "on" as const };
  const s = spec("Input | Expected\n12 | 24\n-3 | -6");
  const inline: Record<string, NonNullable<Task["rowTest"]>> = {
    bun: { mode: "inline", framework: "bun", test: "tests/text.test.ts" },
    pytest: { mode: "inline", framework: "pytest", test: "tests/test_text.py" },
    go: { mode: "inline", framework: "go", package: "calc", test: "calc/calc_test.go" },
    junit: { mode: "inline", framework: "junit", package: "com.ex.calc", test: "src/test/java/com/ex/calc/CalcTest.java" },
    rust: { mode: "inline", framework: "rust", test: "tests/calc.rs" },
    xunit: { mode: "inline", framework: "xunit", package: "Calc.Tests", test: "Calc.Tests/CalcTest.cs" },
  };
  // The brief's one test file, already there: the plan names it and nothing else.
  const withInline = (rowTest: NonNullable<Task["rowTest"]>, action: "create" | "modify" = "modify"): Task => ({
    ...task, rowTest, writes: [{ path: rowTest.test, action }],
  });

  test("a plan that names only the test file the brief allows is accepted in every framework", () => {
    for (const rowTest of Object.values(inline)) {
      expect(rowPlanProblems(s, { ...graph, tasks: [withInline(rowTest)] }, enabled)).toEqual([]);
      expect(rowPlanProblems(s, { ...graph, tasks: [withInline(rowTest, "create")] }, enabled)).toEqual([]);
    }
  });

  test("refuses a test file the task does not write, another writer, a wrong name or package, and two Go files in one package", () => {
    const refused = (tasks: Task[]) => rowPlanProblems(s, { ...graph, tasks }, enabled);
    expect(refused([{ ...withInline(inline.pytest!), writes: [{ path: "src/text.py", action: "modify" }] }]).join()).toContain("in the task's writes");
    expect(refused([{ ...withInline(inline.pytest!), writes: [{ path: "tests/test_text.py", action: "modify", content: "x" }] }])).toHaveLength(1);
    expect(refused([withInline(inline.pytest!), { ...task, id: "T002", rows: undefined, rowTest: undefined, writes: [{ path: "tests/test_text.py", action: "modify" }] }]).join()).toContain("no other task writes");
    for (const rowTest of [
      { ...inline.bun!, test: "tests/text.ts" },
      { ...inline.pytest!, test: "tests/text.py" },
      { ...inline.go!, package: undefined },
      { ...inline.junit!, package: "com.ex.other" },
      { ...inline.rust!, test: "src/calc.rs" },
      { ...inline.xunit!, package: undefined },
    ] as NonNullable<Task["rowTest"]>[]) expect(refused([withInline(rowTest)])).toHaveLength(1);
    const second = { ...withInline({ ...inline.go!, test: "calc/more_test.go" } as NonNullable<Task["rowTest"]>), id: "T002" };
    expect(refused([withInline(inline.go!), second]).join()).toContain("one Go test file per package");
    // An inline rowTest takes no harness or data path.
    expect(TaskSchema.safeParse({ ...withInline(inline.bun!), rowTest: { ...inline.bun!, data: "tests/rows.json" } }).success).toBe(false);
  });

  test("the host's block is appended, replaced in place, put back when dropped, and never doubled", () => {
    const rows = literalRows(s, ["AC-001"]);
    const file = inlineRowFile(inline.pytest as InlineRowTest, rows);
    const own = "def acceptance_actual(input):\n    return input * 2\n";
    const once = withInlineRows(own, file);
    expect(once.startsWith(own)).toBe(true);
    expect(once).toContain("AC-001:2");
    expect(withInlineRows(once, file)).toBe(once);
    expect(withInlineRows(`${once}\ndef test_more():\n    pass\n`, file)).toBe(`${once}\ndef test_more():\n    pass\n`);
    const changed = inlineRowFile(inline.pytest as InlineRowTest, rows.slice(0, 1));
    expect(withInlineRows(once, changed)).toBe(withInlineRows(own, changed));
    expect(hasInlineRows(once.replace("== row", "!= row"), file)).toBe(false);
    // Go: the imports follow the package clause, even in a file the host starts.
    const go = inlineRowFile(inline.go as InlineRowTest, rows);
    const started = withInlineRows(null, go);
    expect(started.startsWith("package calc\n\n// BEGIN acceptance rows imports")).toBe(true);
    const edited = withInlineRows('package calc\n\nimport "testing"\n\nfunc TestOwn(t *testing.T) {}\n', go);
    expect(edited.indexOf("acceptancetesting \"testing\"")).toBeLessThan(edited.indexOf('import "testing"'));
    expect(withInlineRows(edited, go)).toBe(edited);
  });

  test("a corrective that carries the rows task's rows and test gets the same block", () => {
    const t = withInline(inline.bun!);
    const artifact = rowsArtifact(s, { ...graph, tasks: [t] }, analysis([]));
    expect(rowFiles({ ...t, id: "T009", origin: "repair" }, artifact)).toEqual(rowFiles(t, artifact));
    expect(() => rowFiles({ ...t, rows: ["AC-002"] }, artifact)).toThrow("earlier plan");
  });

  test("sizing and file tools leave the inline test file to the agent", () => {
    expect(hostRowPaths(withInline(inline.bun!))).toEqual([]);
    expect(rowDataPaths(withInline(inline.bun!))).toEqual([]);
    expect(hostRowPaths(task)).toEqual(["tests/rows.test.ts", "tests/rows.json"]);
  });

  test("the planner and the implementer are told the inline harness of every framework", () => {
    for (const name of Object.values(INLINE_HARNESS)) expect(ROWS_NOTE).toContain(name);
    expect(ROWS_NOTE).toContain('mode: "inline"');
  });
});

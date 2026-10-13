import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_BASELINE_PATH, commandKey } from "../src/core/verification/output-counts.js";
import {
  baselineKeys,
  diagnosticKey,
  diagnostics,
  taskErrors,
} from "../src/core/verification/task-end-check.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { pendingCodePaths } from "../src/core/workflows/task-graph.js";
import type { Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TSC = [
  "src/app.ts(3,7): error TS2322: Type 'number' is not assignable to type 'string'.",
  "src/main.ts(1,21): error TS2307: Cannot find module './parse' or its corresponding type declarations.",
  "src/other.ts(9,1): error TS2322: Type 'boolean' is not assignable to type 'number'.",
  "Found 3 errors in 3 files.",
].join("\n");

const CARGO = [
  "error[E0583]: file not found for module `parse`",
  " --> src/main.rs:1:1",
  "  |",
  "1 | mod parse;",
  "  | ^^^^^^^^^^",
  "error[E0308]: mismatched types",
  "  --> src\\main.rs:7:18",
  "   |",
  "note: expected due to this",
  "error: could not compile `app` (bin \"app\") due to 2 previous errors",
].join("\r\n");

describe("task-end check attribution", () => {
  test("reads located diagnostics of tsc, rustc, mypy, pyright and go vet", () => {
    expect(diagnostics(TSC).map((d) => d.path)).toEqual(["src/app.ts", "src/main.ts", "src/other.ts"]);
    expect(diagnostics(CARGO)).toEqual([
      { path: "src/main.rs", text: "error[E0583]: file not found for module `parse`" },
      { path: "src/main.rs", text: "error[E0308]: mismatched types" },
    ]);
    expect(diagnostics('app/core.py:12: error: Incompatible return value type (got "int", expected "str")')).toEqual([
      { path: "app/core.py", text: 'error: Incompatible return value type (got "int", expected "str")' },
    ]);
    expect(diagnostics("  /work/app/core.py:3:5 - error: \"x\" is not defined")[0]?.path).toBe("/work/app/core.py");
    expect(diagnostics("./cmd/main.go:8:2: fmt.Printf format %d has arg s of wrong type string")[0]?.path).toBe(
      "cmd/main.go",
    );
    expect(diagnostics("app/core.py:4: note: See https://mypy.readthedocs.io")).toEqual([]);
  });

  test("a task gets the type error in its own file", () => {
    expect(taskErrors(TSC, { written: ["src/app.ts"], pending: [], baseline: [] })).toEqual([
      "src/app.ts: error TS2322: Type 'number' is not assignable to type 'string'.",
    ]);
    expect(taskErrors(CARGO, { written: ["src/main.rs"], pending: [], baseline: [] })).toHaveLength(2);
  });

  test("errors a pending sibling task explains, or that the run started with, are not fed back", () => {
    // The missing module is written by a sibling that has not run yet; the mismatch is the task's own.
    expect(taskErrors(CARGO, { written: ["src/main.rs"], pending: ["src/parse.rs"], baseline: [] })).toEqual([
      "src/main.rs: error[E0308]: mismatched types",
    ]);
    expect(taskErrors(TSC, { written: ["src/main.ts"], pending: ["src/parse.ts"], baseline: [] })).toEqual([]);
    const before = baselineKeys("/work/src/app.ts(9,7): error TS2322: Type 'number' is not assignable to type 'string'.", "/work");
    expect(before).toEqual([diagnosticKey({ path: "src/app.ts", text: "error TS2322: Type 'number' is not assignable to type 'string'." })]);
    expect(taskErrors(TSC, { written: ["src/app.ts"], pending: [], baseline: before })).toEqual([]);
  });

  test("an absolute path in the output matches the task's relative path", () => {
    const output = "/home/ci/work/src/app.ts:3:7 - error TS2322: Type 'number' is not assignable to type 'string'.";
    expect(taskErrors(output, { written: ["src/app.ts"], pending: [], baseline: [] })).toHaveLength(1);
    expect(taskErrors(output, { written: ["app.ts"], pending: [], baseline: [] })).toHaveLength(1);
    expect(taskErrors(output, { written: ["src/other.ts"], pending: [], baseline: [] })).toEqual([]);
  });
});

describe("pending code paths", () => {
  const task = (id: string, path: string): Task => ({
    id,
    title: id,
    description: id,
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn: [],
    profileId: "implementer",
    writes: [{ path, action: "create" }],
    readHints: [],
    checkIds: [],
    origin: "planned",
    findingIds: [],
    rationale: id,
  });
  const row = (id: string, status: TaskRow["status"]): TaskRow => ({
    id,
    definition_json: "{}",
    status,
    generation: 0,
    snapshot_id: null,
  });

  test("lists the code files of siblings that are not done", () => {
    const graph: TaskGraph = {
      schemaVersion: 1,
      featureId: "fixture",
      revision: 1,
      specHash: "a".repeat(64),
      planHash: "b".repeat(64),
      tasks: [task("T001", "src/main.rs"), task("T002", "src/parse.rs"), task("T003", "src/fmt.rs"), task("T004", "README.md")],
    };
    const rows = [row("T001", "running"), row("T002", "pending"), row("T003", "verified"), row("T004", "pending")];
    expect(pendingCodePaths(graph, rows, {}, graph.tasks[0] as Task)).toEqual(["src/parse.rs"]);
  });
});

describe("whole-unit baseline", () => {
  test("the run's baseline keeps the errors a type check already reports", async () => {
    const typecheck = {
      id: "typecheck",
      executable: "bun",
      args: ["-e", "console.log(\"src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\"); process.exit(2)"],
      cwd: ".",
      timeoutMs: 10000,
      required: false,
      scope: "feature" as const,
      envNames: [],
      writes: [],
    };
    const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, typecheck] };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    mkdirSync(join(fixture.root, "src"));
    writeFileSync(join(fixture.root, "src", "a.ts"), "export const a: string = 1;\n");
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal);
    const artifact = fixture.service.store.latestArtifact(run.runId, CHECK_BASELINE_PATH);
    const stored = JSON.parse(fixture.service.store.readArtifact(run.runId, artifact?.id ?? "")) as {
      diagnostics: Record<string, string[]>;
    };
    expect(stored.diagnostics[commandKey(typecheck)]).toEqual([
      diagnosticKey({ path: "src/a.ts", text: "error TS2322: Type 'number' is not assignable to type 'string'." }),
    ]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { scopeRecord, scopeRecords } from "../src/core/workflows/corrective-scope.js";
import { WorkflowScheduler } from "../src/core/workflows/scheduler.js";
import type { Check, Review, RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId, type TaskRow, type WorkflowStore } from "../src/core/workflows/store.js";
import { failureOwner, missingArtifactOwners } from "../src/core/workflows/task-graph.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest, RuntimeState, Task } from "../src/core/workflows/types.js";
import { slicedCorrective, slicedPlan, slicedPolicy } from "./helpers/sliced-corrective-scenario.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 67, skillcomb 3fc5ebf4 (#2094): the sizing split cut tests/test_fields.py into T010
// (create) and T017 (modify, after T010). T010 left seven ruff ISC004 hits in the file. Its
// corrective T024 could not write the file, since a task-level repair may not take over a test
// file whose later slice is pending (#1612), and got the three source files of T010's related
// tasks instead: 1.89M tokens of edits to code it was told not to change, eight independent test
// tasks held back by `readyTasks`, and an `out_of_scope_failure` block after the sessions. Here a
// lint failure on slice 1 of tests/test_a.py, with slice 2 pending and an independent test task
// that depends on the source the old corrective would have written.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const task = (id: string, path: string, dependsOn: string[] = [], action: "create" | "modify" = "create"): Task => ({
  id, title: `Write ${path} (${id})`, description: `Write ${path}: part ${id}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"],
  dependsOn, profileId: "implementer", writes: [{ path, action }], readHints: [], checkIds: [], origin: "planned",
  findingIds: [], rationale: "Required behavior",
});
const PLAN = [
  task("T001", "src/a.py"),
  task("T002", "tests/test_a.py", ["T001"]),
  task("T003", "tests/test_a.py", ["T002"], "modify"),
  task("T004", "tests/test_b.py", ["T001"]),
];
const DIAGNOSTIC = "tests/test_a.py:3:5: ISC004 Implicit string concatenation in a collection\nFound 1 error.";
// ruff names the file and line of each diagnostic; the implicit concatenation is the BAD marker.
const lint: Check = {
  id: "lint", executable: "bun", cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [],
  // The command spells neither the path nor the output in words, so it routes as a linter, not as
  // a test check (`isTestCheck` reads the command line).
  args: ["-e", `const f = Bun.file('tes' + 'ts/test_a.py'); if ((await f.exists()) && (await f.text()).includes('BAD')) { console.log(atob('${btoa(DIAGNOSTIC)}')); process.exit(1) } console.log('All checks passed!')`],
};

class SlicedExecutor extends FixtureExecutor {
  attempts: Task[] = [];
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nA module and its tests.\n## Decisions\nDEC-001: FR-001 in src/a.py.\n## Components\nsrc/a.py, tests\n## Data\nText\n## Verification\nLint\n## Risks\nNone for fixture";
      const taskGraph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks: PLAN };
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    const own = request.task as Task;
    this.attempts.push(own);
    const root = request.root ?? this.dir;
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const path = own.writes[0]?.path ?? "";
    if (own.origin !== "planned") {
      // The corrective fixes the diagnostic only where it may write: the old one could not.
      const target = join(root, "tests/test_a.py");
      if (own.writes.some((w) => w.path === "tests/test_a.py")) put("tests/test_a.py", readFileSync(target, "utf8").replace('"BAD" "x"', '"okx"'));
    } else if (path === "src/a.py") put(path, "def a():\n    return 1\n");
    else if (own.id === "T002") put(path, 'from src.a import a\n\nCASES = ["BAD" "x"]\n\ndef test_a():\n    assert a() == 1\n');
    else if (own.id === "T003") put(path, `${readFileSync(join(root, path), "utf8")}\ndef test_a_again():\n    assert a() == 1\n`);
    else put(path, "def test_b():\n    assert True\n");
    return {
      output: { schemaVersion: 1, taskId: own.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

describe("scenario: a lint failure in a sliced test file (#2094)", () => {
  test("the corrective writes the diagnosed file only, the independent task is not held, and the run completes", async () => {
    const fx = workflowFixture({
      policy: { ...fixturePolicy, checks: [lint] },
      executor: (root) => new SlicedExecutor(root),
    });
    cleanups.push(fx.dispose);
    const started = await fx.start();
    const planned = await fx.service.drive(started.runId, signal());
    if (planned.reason !== "approval") throw new Error(JSON.stringify({ planned, errors: fx.service.store.artifacts(started.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => fx.service.store.readArtifact(started.runId, a.id)) }));
    await fx.approve(started.runId);
    const final = await fx.service.drive(started.runId, signal());
    const errors = fx.service.store.artifacts(started.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => fx.service.store.readArtifact(started.runId, a.id));
    expect({ status: final.status, errors }).toEqual({ status: "completed", errors: [] });

    const order = fx.executor.attempts.map((t) => t.id);
    const corrective = fx.executor.attempts.find((t) => t.origin !== "planned");
    // Only the file the diagnostics name: no source file of T002's related tasks (T001).
    expect(corrective?.writes.map((w) => w.path)).toEqual(["tests/test_a.py"]);
    expect(corrective?.description).toContain("T003 runs after this correction and adds the rest of tests/test_a.py: change only what the failure needs in it.");
    // T004 depends on T001 only; the old corrective wrote src/a.py and held it until it was done.
    expect(order).toEqual(["T001", "T002", "T004", corrective?.id ?? "", "T003"]);
    expect(readFileSync(join(fx.root, "tests/test_a.py"), "utf8")).toContain("def test_a_again");
    const state = fx.service.store.state(started.runId);
    expect(state.waitingFor[corrective?.id ?? ""]).toBeUndefined();

    // The precondition is recorded at creation and before the session, and fits.
    const records = scopeRecords(fx.service.store, started.runId);
    expect(records.map((r) => [r.taskId, r.at, r.decision, r.diagnosed, r.missing])).toEqual([
      [corrective?.id, "create", "fits", ["tests/test_a.py"], []],
      [corrective?.id, "start", "fits", ["tests/test_a.py"], []],
    ]);
    expect(fx.service.store.eventsOfType(started.runId, "decision.would_stop")).toEqual([]);

    // The replay hook decides each record again from the bench trace; the old builder, which
    // left the file out of the corrective's writes, is a new would-stop there.
    const dir = mkdtempSync(join(tmpdir(), "corrective-scope-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(fx.root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === started.runId);
    expect(replayed?.correctiveScopes.map((b) => [b.at, b.recorded, b.replayed])).toEqual([["create", "fits", "fits"], ["start", "fits", "fits"]]);
    expect(replayed?.newScopeStops).toBe(0);
    const old = replayTrace(out, { scopeRule: (diagnosed) => diagnosed.filter((path) => path.startsWith("tests/")) }).runs.find((r) => r.runId === started.runId);
    expect(old?.newScopeStops).toBe(2);
  }, 120000);
});

// #2108: the test-check copy. T002's own case in slice 1 of tests/test_a.py fails an assertion
// (the BAD marker), with no source in the output; slice 2 (T003) is pending. The corrective may
// write the test file, and the run completes. A failure located in a source keeps #1612 (the
// shared-file case of workflow-scenario-repair-priority.test.ts).
const ASSERTION = "FAILED tests/test_a.py::test_a - AssertionError: assert 'BAD' == 'ok'\n1 failed in 0.01s";
const pytest: Check = {
  ...lint, id: "tests", scope: "task",
  args: ["-e", `const f = Bun.file('tes' + 'ts/test_a.py'); if ((await f.exists()) && (await f.text()).includes('BAD')) { console.log(atob('${btoa(ASSERTION)}')); process.exit(1) } console.log('1 passed')`],
};

class TestCheckSlicedExecutor extends SlicedExecutor {
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const output = result.output as { taskGraph: TaskGraph };
      output.taskGraph = { ...output.taskGraph, tasks: PLAN.map((t) => (t.id === "T002" ? { ...t, checkIds: ["tests"] } : t)) };
    }
    return result;
  }
}

describe("scenario: a test-check failure in slice 1's own case of a sliced test file (#2108)", () => {
  test("the corrective writes the test file and the run completes", async () => {
    const fx = workflowFixture({
      policy: { ...fixturePolicy, checks: [pytest] },
      executor: (root) => new TestCheckSlicedExecutor(root),
    });
    cleanups.push(fx.dispose);
    const started = await fx.start();
    const planned = await fx.service.drive(started.runId, signal());
    expect(planned.reason).toBe("approval");
    await fx.approve(started.runId);
    const final = await fx.service.drive(started.runId, signal());
    const errors = fx.service.store.artifacts(started.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => fx.service.store.readArtifact(started.runId, a.id));
    expect({ status: final.status, errors }).toEqual({ status: "completed", errors: [] });
    const corrective = fx.executor.attempts.find((t) => t.origin !== "planned");
    expect(corrective?.writes.map((w) => w.path)).toContain("tests/test_a.py");
    expect(corrective?.description).toContain("T003 runs after this correction and adds the rest of tests/test_a.py: change only what the failure needs in it.");
    const order = fx.executor.attempts.map((t) => t.id);
    expect(order.indexOf("T003")).toBeGreaterThan(order.indexOf(corrective?.id ?? ""));
    expect(readFileSync(join(fx.root, "tests/test_a.py"), "utf8")).toContain("def test_a_again");
    expect(readFileSync(join(fx.root, "tests/test_a.py"), "utf8")).not.toContain("BAD");
    // The precondition records the test file as one the corrective must write, and it fits.
    const records = scopeRecords(fx.service.store, started.runId).filter((r) => r.taskId === corrective?.id);
    expect(records.map((r) => [r.at, r.decision, r.diagnosed])).toContainEqual(["create", "fits", ["tests/test_a.py"]]);
  }, 120000);
});

describe("scenario: the same lint failure in a batch run, two writers (#2138)", () => {
  test("the corrective's session in the batch worker records its start scope too", async () => {
    const fx = workflowFixture({
      policy: { ...fixturePolicy, checks: [lint] },
      executor: (root) => new SlicedExecutor(root),
    });
    cleanups.push(fx.dispose);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: fx.root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(fx.root, ".gitignore"), ".baked/\n");
    writeFileSync(join(fx.root, "README.md"), "# Fixture\n");
    git("add", ".");
    git("commit", "-q", "-m", "Initial");
    const started = await fx.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: fx.policy, executionMode: "worktree", maxConcurrentWriters: 2 });
    const planned = await fx.service.drive(started.runId, signal());
    expect(planned.reason).toBe("approval");
    await fx.approve(started.runId);
    const final = await fx.service.drive(started.runId, signal());
    expect(final.status).toBe("completed");
    const corrective = fx.executor.attempts.find((t) => t.origin !== "planned");
    expect(corrective?.writes.map((w) => w.path)).toEqual(["tests/test_a.py"]);
    // Before #2138 the batch worker skipped the pre-session hook: only the `create` record.
    expect(scopeRecords(fx.service.store, started.runId).map((r) => [r.taskId, r.at, r.decision])).toEqual([
      [corrective?.id, "create", "fits"],
      [corrective?.id, "start", "fits"],
    ]);
  }, 120000);
});

// Every linter, formatter and type checker a supported toolchain runs per task (`isStaticCheck`),
// with the line it prints for a diagnostic in a test file; the decision is by check kind, and the
// path extraction (`failingFilesInOutput`) is shared.
const TOOLCHAINS: { language: string; id: string; executable: string; args: string[]; test: string; line: string }[] = [
  { language: "python", id: "ruff", executable: "ruff", args: ["check", "."], test: "tests/test_a.py", line: "tests/test_a.py:3:5: ISC004 Implicit string concatenation" },
  { language: "python", id: "mypy", executable: "mypy", args: ["."], test: "tests/test_a.py", line: "tests/test_a.py:3: error: Incompatible types in assignment" },
  { language: "typescript", id: "lint", executable: "biome", args: ["check", "."], test: "tests/a.test.ts", line: "tests/a.test.ts:3:5 lint/style/useTemplate FIXABLE" },
  { language: "typescript", id: "typecheck", executable: "tsc", args: ["--noEmit"], test: "tests/a.test.ts", line: "tests/a.test.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'." },
  { language: "javascript", id: "lint", executable: "eslint", args: ["."], test: "tests/a.test.js", line: "tests/a.test.js\n  3:5  error  'x' is assigned a value but never used  no-unused-vars" },
  { language: "go", id: "gofmt", executable: "gofmt", args: ["-l", "."], test: "a_test.go", line: "a_test.go" },
  { language: "go", id: "go-vet", executable: "go", args: ["vet", "./..."], test: "a_test.go", line: "./a_test.go:3:5: unreachable code" },
  { language: "rust", id: "cargo-fmt", executable: "cargo", args: ["fmt", "--check"], test: "tests/a.rs", line: "Diff in tests/a.rs at line 3:" },
  { language: "rust", id: "cargo-clippy", executable: "cargo", args: ["clippy", "--", "-D", "warnings"], test: "tests/a.rs", line: "  --> tests/a.rs:3:5" },
  { language: "csharp", id: "dotnet-format", executable: "dotnet", args: ["format", "--verify-no-changes"], test: "tests/ATests.cs", line: "tests/ATests.cs(3,5): error WHITESPACE: Fix whitespace formatting." },
  { language: "java", id: "lint", executable: "gradle", args: ["checkstyleTest"], test: "src/test/java/ATest.java", line: "[ant:checkstyle] [ERROR] src/test/java/ATest.java:3:5: Line is longer than 100 characters." },
  { language: "kotlin", id: "lint", executable: "ktlint", args: [], test: "src/test/kotlin/ATest.kt", line: "src/test/kotlin/ATest.kt:3:5: Unexpected blank line(s)" },
  { language: "scala", id: "format", executable: "scalafmt", args: ["--list"], test: "src/test/scala/ATest.scala", line: "src/test/scala/ATest.scala is not formatted" },
  { language: "ruby", id: "lint", executable: "rubocop", args: [], test: "spec/a_spec.rb", line: "spec/a_spec.rb:3:5: C: Style/StringLiterals: Prefer single-quoted strings" },
  { language: "php", id: "lint", executable: "phpcs", args: [], test: "tests/ATest.php", line: "FILE: tests/ATest.php\n 3 | ERROR | Line indented incorrectly" },
  { language: "swift", id: "lint", executable: "swiftlint", args: [], test: "Tests/ATests/ATests.swift", line: "Tests/ATests/ATests.swift:3:5: warning: Line Length Violation" },
  { language: "lua", id: "lint", executable: "luacheck", args: ["."], test: "spec/a_spec.lua", line: "    spec/a_spec.lua:3:5: unused variable x" },
  { language: "elixir", id: "mix-format", executable: "mix", args: ["format", "--check-formatted"], test: "test/a_test.exs", line: "** (Mix) mix format failed due to --check-formatted.\nThe following files are not formatted:\n\n  * test/a_test.exs" },
  { language: "dart", id: "analyze", executable: "dart", args: ["analyze"], test: "test/a_test.dart", line: "  info - test/a_test.dart:3:5 - Unused import. - unused_import" },
  { language: "zig", id: "zig-fmt", executable: "zig", args: ["fmt", "--check", "."], test: "tests/a_test.zig", line: "tests/a_test.zig" },
  { language: "bash", id: "lint", executable: "shellcheck", args: [], test: "tests/a_test.sh", line: "In tests/a_test.sh line 3:" },
  { language: "ocaml", id: "format", executable: "dune", args: ["fmt"], test: "test/test_a.ml", line: "File \"test/test_a.ml\", line 1, characters 0-0:" },
  { language: "c", id: "lint", executable: "clang-tidy", args: [], test: "tests/test_a.c", line: "tests/test_a.c:3:5: warning: variable 'x' is not initialized" },
  { language: "cpp", id: "lint", executable: "clang-tidy", args: [], test: "tests/a_test.cpp", line: "tests/a_test.cpp:3:5: warning: use nullptr" },
  { language: "objc", id: "lint", executable: "clang-tidy", args: [], test: "Tests/ATests.m", line: "Tests/ATests.m:3:5: warning: unused variable" },
  { language: "vue", id: "lint", executable: "eslint", args: ["."], test: "tests/a.spec.ts", line: "tests/a.spec.ts:3:5: error  Unexpected var" },
  { language: "svelte", id: "check", executable: "svelte-check", args: [], test: "tests/a.test.ts", line: "tests/a.test.ts:3:5 Error: Type 'string' is not assignable" },
  { language: "rescript", id: "format", executable: "rescript", args: ["format", "-check"], test: "tests/A_test.res", line: "tests/A_test.res" },
  { language: "solidity", id: "lint", executable: "solhint", args: ["**/*.sol"], test: "test/A.t.sol", line: "test/A.t.sol\n  3:5  error  Line length must be no more than 120" },
];

describe("a corrective of a failed static check writes its sliced test file, per toolchain (#2094)", () => {
  for (const tool of TOOLCHAINS)
    test(`${tool.language} ${tool.executable} ${tool.id}`, () => {
      const check: Check = { id: tool.id, executable: tool.executable, args: tool.args, cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
      const { state, added, finding, ready } = slicedCorrective(check, tool.test, `${tool.line}\nFound 1 error.`);
      // The invariant: the diagnosed files the failing task owns are in the corrective's writes.
      expect(state.repairScope[finding.id]).toEqual([tool.test]);
      expect(added.writes.map((w) => w.path)).toEqual([tool.test]);
      expect(scopeRecord(state, slicedPolicy(check), added, [finding], "create")?.decision).toBe("fits");
      // The corrective holds the later slice, not the independent test task.
      expect(ready).toEqual(["T004", added.id]);
    });

  test("a failing test check keeps the shared file to its later slice (#1612)", () => {
    const tests: Check = { id: "tests", executable: "python", args: ["-m", "pytest"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
    const { added } = slicedCorrective(tests, "tests/test_a.py", "FAILED tests/test_a.py::test_a - assert 2 == 1\n    src/a.src:2: in a");
    expect(added.writes.map((w) => w.path)).not.toContain("tests/test_a.py");
  });
});

describe("the corrective's precondition and waits (#2094)", () => {
  test("a corrective without its diagnosed file records a would-stop at creation and before each session", () => {
    const { state, added, finding } = slicedCorrective(lint, "tests/test_a.py", DIAGNOSTIC);
    const broken = { ...added, writes: [{ path: "src/a.src", action: "modify" as const }] };
    expect(scopeRecord(state, slicedPolicy(lint), broken, [finding], "create")).toMatchObject({ decision: "refuse", missing: ["tests/test_a.py"], failing: ["T002"], checks: ["lint"] });
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const written: string[] = [];
    let steps = 0;
    const scheduler = Object.create(WorkflowScheduler.prototype) as {
      store: WorkflowStore;
      recordCorrectiveScope(runId: string, state: RuntimeState, policy: RunPolicy, task: Task, at: "create" | "start"): void;
    };
    scheduler.store = {
      findings: () => [{ id: finding.id, body_json: JSON.stringify(finding) }],
      steps: () => Array.from({ length: steps }, () => ({ stage_id: `task-${added.id}` })),
      latestArtifact: () => undefined,
      artifact: (_run: string, kind: string, path: string) => written.push(`${kind}:${path}`),
      eventsOfType: () => events,
      emit: (_run: string, event: { type: string; payload: Record<string, unknown> }) => events.push(event),
    } as unknown as WorkflowStore;
    scheduler.recordCorrectiveScope("run", state, slicedPolicy(lint), broken, "create");
    steps = 1;
    scheduler.recordCorrectiveScope("run", state, slicedPolicy(lint), broken, "start");
    // A resume opens another session of the same corrective: it is recorded again.
    steps = 2;
    scheduler.recordCorrectiveScope("run", state, slicedPolicy(lint), broken, "start");
    expect(written).toEqual([`corrective-scope:scope/tasks/${added.id}.json`, `corrective-scope:scope/tasks/${added.id}.json`, `corrective-scope:scope/tasks/${added.id}.json`]);
    expect(events.map((e) => [e.payload.reason, e.payload.mode, e.payload.key])).toEqual([
      ["corrective_scope", "shadow", `${added.id}-create-0`],
      ["corrective_scope", "shadow", `${added.id}-start-1`],
      ["corrective_scope", "shadow", `${added.id}-start-2`],
    ]);
    expect(String(events[0]?.payload.summary)).toContain("cannot write tests/test_a.py");
  });

  test("a corrective never waits for a later slice of the task it corrects", () => {
    const plan = slicedPlan("tests/test_a.py");
    const repair: Task = { ...(plan[1] as Task), id: "T005", origin: "repair", findingIds: ["F1"], dependsOn: [], writes: [{ path: "src/a.src", action: "modify" }] };
    const full: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [...plan, repair] };
    const taskRows = Object.entries({ T001: "verified", T002: "blocked", T003: "pending", T004: "pending", T005: "running" }).map(([id, status]) => ({ id, status }) as TaskRow);
    const predecessors = { F1: "T002" };
    // The corrective reports it cannot write tests/test_a.py, which pending T003 also writes.
    const account = { summary: "Blocked: tests/test_a.py is outside my write scope", unresolved: ["tests/test_a.py"] };
    expect(missingArtifactOwners(full, taskRows, repair, account, {}, predecessors)).toEqual([]);
    // Without the predecessors (as before #2094) the corrective waited for T003, which waits for it.
    expect(missingArtifactOwners(full, taskRows, repair, account, {}, {})).toEqual(["T003"]);
    const missing = "tests/test_a.py:0:1: E902 No such file or directory (os error 2)";
    expect(failureOwner(full, taskRows, {}, repair, missing, { predecessors }).kind).toBe("creates");
    expect(failureOwner(full, taskRows, {}, repair, missing, {}).kind).toBe("pending");
  });
});

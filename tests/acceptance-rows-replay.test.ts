import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getProvider } from "../src/core/llm/providers/index.js";
import { testthatOn, testthatRun } from "../src/core/workflows/r-tools.js";
import { withInlineRows } from "../src/core/workflows/acceptance-rows-inline.js";
import type { AcceptanceRow } from "../src/core/workflows/acceptance-rows-model.js";
import { type ReplayResult, replayNote, replayProblems, replayResult, rowReplay } from "../src/core/workflows/acceptance-rows-replay.js";
import { isWrittenTestFile, plannedWrittenTests, writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema, type Task } from "../src/core/workflows/schemas.js";
import type { Check } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// #1617: a source task replays the audited rows of its criteria on its own code before it is
// accepted, so a source defect an audited row names is fixed at its task (bench round 53: four of
// six correctives, 1.80M tokens, were such defects found by later test tasks or the review).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const rows: AcceptanceRow[] = [
  { id: "AC-003:1", criterionId: "AC-003", source: '`""` | `"invalid path"`', input: "", expected: "invalid path" },
  { id: "AC-003:2", criterionId: "AC-003", source: '`"a.b"` | `["a","b"]`', input: "a.b", expected: ["a", "b"] },
];
const base = { requirementIds: ["FR-001"], profileId: "implementer", readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "Required" };
const source: Task = { ...base, id: "T001", title: "Parse paths", description: "Write parseSteps", criterionIds: ["AC-003"], dependsOn: [], writes: [{ path: "src/paths.ts", action: "create" }] };
const rowTask = (framework: NonNullable<Task["rowTest"]>["framework"], test: string, pkg?: string): Task => ({
  ...base, id: "T003", title: "Test paths", description: "Test parseSteps", criterionIds: ["AC-003"], dependsOn: ["T001"],
  writes: [{ path: test, action: "create" }], rows: ["AC-003"], rowTest: { mode: "inline", framework, test, ...(pkg ? { package: pkg } : {}) },
});
const artifact = (task: Task) => ({ tasks: [{ id: task.id, rows: task.rows, rowTest: task.rowTest }], rows });
const check = (executable: string, args: string[]): Check =>
  ({ id: "tests", executable, args, cwd: ".", envNames: [], timeoutMs: 300_000, required: true, scope: "feature", writes: [] }) as unknown as Check;

describe("which task replays which rows (#1617)", () => {
  test("a source task replays the rows of its criteria that a later row task tests", () => {
    const later = rowTask("bun", "tests/paths.test.ts");
    const replay = rowReplay({ tasks: [source, later] }, artifact(later), source);
    expect(replay).toMatchObject({ rowTaskId: "T003", criteria: ["AC-003"], file: { path: "tests/baked-replay-t001.test.ts" } });
    expect(replay?.rows.map((r) => r.id)).toEqual(["AC-003:1", "AC-003:2"]);
    expect(replayNote(replay as NonNullable<typeof replay>)).toContain('AC-003:1 "" -> "invalid path"');
  });

  test("no replay for the row task itself, a test task, a task after the row task, or other criteria", () => {
    const later = rowTask("bun", "tests/paths.test.ts");
    expect(rowReplay({ tasks: [source, later] }, artifact(later), later)).toBeNull();
    const testOnly: Task = { ...source, id: "T002", writes: [{ path: "tests/other.test.ts", action: "create" }] };
    expect(rowReplay({ tasks: [source, later, testOnly] }, artifact(later), testOnly)).toBeNull();
    const after: Task = { ...source, id: "T004", dependsOn: ["T003"] };
    expect(rowReplay({ tasks: [source, later, after] }, artifact(later), after)).toBeNull();
    const elsewhere: Task = { ...source, id: "T005", criterionIds: ["AC-009"] };
    expect(rowReplay({ tasks: [source, later, elsewhere] }, artifact(later), elsewhere)).toBeNull();
    const docs: Task = { ...source, id: "T006", writes: [{ path: "README.md", action: "create" }] };
    expect(rowReplay({ tasks: [source, later, docs] }, artifact(later), docs)).toBeNull();
  });

  // Every framework of the rows modes: the one-shot file is a test file the project's own test
  // command runs on its own, and a JUnit or xUnit run names the block's class too.
  const FRAMEWORKS = [
    { framework: "bun", test: "tests/paths.test.ts", run: check("bun", ["test"]), file: "tests/baked-replay-t001.test.ts", args: ["test", "./tests/baked-replay-t001.test.ts"] },
    { framework: "pytest", test: "tests/test_paths.py", run: check("python3", ["-m", "pytest", "-q"]), file: "tests/test_baked_replay_t001.py", args: ["-m", "pytest", "-q", "./tests/test_baked_replay_t001.py"] },
    { framework: "go", package: "paths", test: "paths/paths_test.go", run: check("go", ["test", "./..."]), file: "paths/baked_replay_t001_test.go", args: ["test", "./paths"] },
    { framework: "rust", test: "tests/paths.rs", run: check("cargo", ["test", "--quiet"]), file: "tests/baked_replay_t001.rs", args: ["test", "--quiet", "--test", "baked_replay_t001"] },
    { framework: "junit", package: "com.ex.paths", test: "src/test/java/com/ex/paths/PathsTest.java", run: check("mvn", ["-q", "test"]), file: "src/test/java/com/ex/paths/BakedReplayT001Test.java",
      args: ["-q", "test", "-Dtest=com.ex.paths.BakedReplayT001Test,com.ex.paths.BakedReplayT001Test$AcceptanceRows", "-Dsurefire.failIfNoSpecifiedTests=false"] },
    { framework: "xunit", package: "Paths.Tests", test: "Paths.Tests/PathsTests.cs", run: check("dotnet", ["test"]), file: "Paths.Tests/BakedReplayT001Tests.cs",
      args: ["test", "--filter", "FullyQualifiedName~BakedReplayT001Tests.|FullyQualifiedName~BakedReplayT001Tests+AcceptanceRows."] },
    // #2335: the spec file, and the PHPUnit test class that holds the block as its own methods.
    { framework: "rspec", test: "spec/paths_spec.rb", run: check("bundle", ["exec", "rspec"]), file: "spec/baked_replay_t001_spec.rb", args: ["exec", "rspec", "./spec/baked_replay_t001_spec.rb"] },
    { framework: "phpunit", package: "App.Tests", test: "tests/PathsTest.php", run: check("php", ["vendor/bin/phpunit", "tests"]), file: "tests/BakedReplayT001Test.php", args: ["vendor/bin/phpunit", "./tests/BakedReplayT001Test.php"] },
    // #2348: testthat selects the one file by its filter on the name.
    { framework: "testthat", test: "tests/testthat/test-paths.R", run: check("Rscript", ["-e", testthatRun(false)]), file: "tests/testthat/test-baked-replay-t001.R",
      args: ["-e", testthatOn(["tests/testthat/test-baked-replay-t001.R"], false)] },
    { framework: "busted", test: "spec/paths_spec.lua", run: check("busted", []), file: "spec/baked_replay_t001_spec.lua", args: ["./spec/baked_replay_t001_spec.lua"] },
  ] as const;
  test.each(FRAMEWORKS.map((f) => [f.framework, f]))("%s: the replay file runs on its own with the project's test command", (_name, f) => {
    const later = rowTask(f.framework, f.test, "package" in f ? f.package : undefined);
    const replay = rowReplay({ tasks: [source, later] }, artifact(later), source);
    expect(replay?.file.path).toBe(f.file);
    expect(isWrittenTestFile(f.file)).toBe(true);
    expect(plannedWrittenTests([f.run], [{ path: f.file, action: "create" }])).not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), "baked-row-replay-unit-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(dirname(join(root, f.file)), { recursive: true });
    writeFileSync(join(root, f.file), withInlineRows(f.framework === "go" ? "package paths\n" : "", replay?.file as NonNullable<typeof replay>["file"]));
    expect(writtenTestsCheck(root, [f.run], [{ path: f.file, action: "create" }])?.args).toEqual([...f.args]);
  });
});

describe("reading a replay run (#1617)", () => {
  test("rows on failure lines fail; a run that names no row is an error with its output", () => {
    expect(replayResult("passed", "(pass) AC-003:1\n(pass) AC-003:2", rows)).toEqual({ status: "passed", failed: [], output: "" });
    // bun prints passing rows too: only the failure lines count.
    expect(replayResult("failed", "(pass) AC-003:2 [0.1ms]\n(fail) AC-003:1 [0.2ms]", rows)).toMatchObject({ status: "failed", failed: ["AC-003:1"] });
    expect(replayResult("failed", "FAILED tests/test_baked_replay_t001.py::test_acceptance_row[AC-003:2] - assert", rows).failed).toEqual(["AC-003:2"]);
    expect(replayResult("failed", "--- FAIL: TestAcceptanceRowsBakedReplayT001/AC-003:1 (0.00s)", rows).failed).toEqual(["AC-003:1"]);
    expect(replayResult("failed", 'AC-003:2: got Array([]), want Array([String("a"), String("b")])', rows).failed).toEqual(["AC-003:2"]);
    // #2348: testthat names the failing test, which is the row's id.
    expect(replayResult("failed", "-- Failure ('test-baked-replay-t001.R:44:5'): AC-003:2 -------", rows).failed).toEqual(["AC-003:2"]);
    expect(replayResult("failed", "Failure -> spec/baked_replay_t001_spec.lua @ 24\nacceptance rows AC-003:1\nspec/baked_replay_t001_spec.lua:31: AC-003:1: got [3]", rows).failed).toEqual(["AC-003:1"]);
    expect(replayResult("failed", "src/paths.ts(3,1): error TS1005: ';' expected.", rows)).toMatchObject({ status: "error", failed: [] });
    expect(replayResult("inconclusive", "", rows).status).toBe("error");
  });

  test("the refusal names each failing row with its input and expected value", () => {
    const later = rowTask("bun", "tests/paths.test.ts");
    const replay = rowReplay({ tasks: [source, later] }, artifact(later), source);
    if (!replay) throw new Error("no replay");
    expect(replayProblems(replay, null)[0]).toContain("call replay_rows");
    expect(replayProblems(replay, { status: "passed", failed: [], output: "" })).toEqual([]);
    expect(replayProblems(replay, { status: "failed", failed: ["AC-003:1"], output: "" })).toEqual(['Row AC-003:1 fails: "" should give "invalid path" (`""` | `"invalid path"`).']);
    expect(replayProblems(replay, { status: "error", failed: [], output: "boom\n" })[0]).toContain("did not run: boom");
  });
});

describe("replay_rows in a source task's attempt (#1617)", () => {
  const step = (call: { name: string; input: unknown }): LanguageModelV3GenerateResult => ({
    content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  });

  test("the tool runs the agent's harness, a failing row refuses the submission once, and the same list is then accepted", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const submit = { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote parseSteps", evidenceIds: [], unresolved: [] };
    const script = [step({ name: "replay_rows", input: { harness: "import { parseSteps } from '../src/paths';\nfunction acceptanceActual(input: unknown) { return parseSteps(input as string); }\n" } }), step({ name: "submit_result", input: submit }), step({ name: "submit_result", input: submit })];
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    let index = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        const next = script[index++];
        if (!next) throw new Error("script exhausted");
        return next;
      },
    });
    provider.createModel = () => model as LanguageModelV3;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const fixture = workflowFixture({ policy: fixturePolicy });
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.output === "implementation");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const attemptId = store.reserve(run.runId, store.beginStep(run.runId, "fixture"), profile.model, 2000, fixturePolicy);
    const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    const later = rowTask("bun", "tests/paths.test.ts");
    const replay = rowReplay({ tasks: [source, later] }, artifact(later), source);
    if (!replay) throw new Error("no replay");
    const harnesses: string[] = [];
    const result = await executor.execute({
      runId: run.runId, attemptId, profile, prompt: "Write parseSteps", task: source, signal: new AbortController().signal, maxSteps: 6,
      rowReplay: {
        replay,
        run: async (_root, harness): Promise<ReplayResult> => {
          harnesses.push(harness);
          return { status: "failed", failed: ["AC-003:1"], output: "(fail) AC-003:1" };
        },
      },
    });
    expect(result.output).toMatchObject({ outcome: "implemented" });
    // The tool ran once; the submission reused its result, since no file changed since.
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0]).toContain("parseSteps(input as string)");
    expect(JSON.stringify(prompts[1])).toContain("AC-003:1");
    const refusal = JSON.stringify(prompts[2]);
    expect(refusal).toContain("Row AC-003:1 fails:");
    expect(refusal).toContain("should give");
    expect(refusal).toContain("the same list is not refused twice");
  });
});

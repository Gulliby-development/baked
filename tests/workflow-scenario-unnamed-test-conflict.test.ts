import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { failingFilesInOutput } from "../src/core/verification/convergence.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check, RunPolicy, Task } from "../src/core/workflows/schemas.js";
import { criterionAgainstRequirement } from "../src/core/workflows/spec-amendment.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 40, tonemath 241fc475 T006 (#1459). Under clarification assume, a test task
// reported spec_conflict naming the failing test function and the FR/AC ids but no file path, and
// its conflict was between AC-008 and FR-002/003/006 of the same spec. No branch matched, so the
// run asked a person and waited 35 minutes. The failing check output names the test file
// (`panicked at tests/chord_tests.rs:90:5`), and a requirement wins over a criterion that
// contradicts it.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

/** Fails with the toolchain's output while the test file still asserts the wrong value. */
const unit = (test: string, output: string): Check => ({
  id: "unit",
  executable: "bun",
  args: ["-e", `if ((await Bun.file(${JSON.stringify(test)}).text()).includes("wrong")) { console.log(${JSON.stringify(output)}); process.exit(1) }`],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task",
  envNames: [],
  writes: [],
});

interface Scenario {
  /** The test file the task writes. */
  test: string;
  /** Whether the task writes value.txt too, so it is not a test-only task. */
  mixed: boolean;
  /** What the failing check prints; null runs no check. */
  output: string | null;
  report: string;
  /** A test file that existed before the run. */
  existing?: boolean;
}

async function conflict(scenario: Scenario) {
  const { test: TEST } = scenario;
  const check = { ...fixturePolicy.checks[0]!, args: ["-e", "const f = Bun.file('value.txt'); if ((await f.exists()) && (await f.text()) !== 'ready') process.exit(1)"] };
  const tests = unit(TEST, scenario.output ?? "");
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", checks: [check, tests] };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  if (scenario.existing) {
    mkdirSync(join(root, dirname(TEST)), { recursive: true });
    writeFileSync(join(root, TEST), "wrong\n");
  }
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  let conflicts = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      const testWrite = { path: TEST, action: scenario.existing ? "modify" : "create" };
      graph.tasks = [{ ...code, id: "T001", checkIds: ["unit"], writes: scenario.mixed ? [...code.writes, testWrite] : [testWrite] }];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    const work = request.root ?? root;
    const prompt = JSON.stringify(request);
    prompts.push(prompt);
    mkdirSync(join(work, dirname(TEST)), { recursive: true });
    if (!/which this run wrote|win over the criteria/.test(prompt)) {
      conflicts++;
      writeFileSync(join(work, TEST), "wrong\n");
      if (scenario.output !== null) {
        const scope = new ProcessScope();
        try {
          await new CheckRunner(service.store, scope).run(request.runId, request.attemptId, tests, signal(), work);
        } finally {
          await scope.stop();
        }
      }
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary: scenario.report, evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    writeFileSync(join(work, TEST), "ready\n");
    if (scenario.mixed) writeFileSync(join(work, "value.txt"), "ready");
    return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Corrected the assertion", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
  };
  const run = await fixture.start();
  for (let i = 0; i < 8; i++) {
    const current = await service.get(run.runId);
    if (["completed", "blocked", "failed"].includes(current.status)) break;
    if (current.status === "waiting" && !service.store.requests(run.runId).some((r) => r.kind === "approval" && r.status === "pending")) break;
    if (current.pendingRequestIds.length) await fixture.approve(run.runId);
    else if (current.status === "paused" || current.status === "created") await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(run.runId, path);
    return artifact ? JSON.parse(service.store.readArtifact(run.runId, artifact.id)) : null;
  };
  return {
    status: (await service.get(run.runId)).status,
    asked: service.store.requests(run.runId).filter((r) => r.kind === "clarification"),
    conflicts,
    prompts,
    content: () => readFileSync(join(root, TEST), "utf8"),
    assumption: read("assumptions/conflicts/T001.json"),
    amendment: read("amendments/conflict-T001.json"),
  };
}

const FUNCTION_ONLY = "parse_greedy_double_sharp_root_and_enharmonic_bass_before_spelling asserts that the value is wrong, but the approved spec says the value is ready.";

describe("scenario: tonemath 241fc475, a conflict report that names no test file (#1459)", () => {
  // The failing output of each toolchain locates the test file the report does not name.
  const outputs: [string, string, string][] = [
    ["cargo test", "tests/chord_tests.rs", "thread 'parse_greedy' panicked at tests/chord_tests.rs:90:5:\nassertion `left == right` failed\ntest result: FAILED. 0 passed; 1 failed"],
    ["pytest", "tests/test_chords.py", "FAILED tests/test_chords.py::test_parse_greedy - AssertionError: assert 'wrong' == 'ready'\n1 failed in 0.02s"],
    ["go test", "chords/chords_test.go", "--- FAIL: TestParseGreedy (0.00s)\n    chords_test.go:42: got wrong, want ready\nFAIL\tgithub.com/acme/tonemath/chords\t0.01s"],
    ["bun test", "tests/chords.test.ts", "tests/chords.test.ts:\n(fail) parse greedy [0.20ms]\n\n 0 pass\n 1 fail"],
  ];
  for (const [toolchain, path, output] of outputs)
    test(`the ${toolchain} output of the task's failing check names the test, and the spec wins over it`, async () => {
      const result = await conflict({ test: path, mixed: true, output, report: FUNCTION_ONLY });
      expect(result.asked).toEqual([]);
      expect(result.conflicts).toBe(1);
      expect(result.assumption).toMatchObject({ tests: [path] });
      expect(result.content()).toBe("ready\n");
      expect(result.status).toBe("completed");
    }, 90_000);

  test("a test task whose report and checks name no file conflicts with the tests it wrote", async () => {
    const result = await conflict({ test: "tests/chord_tests.rs", mixed: false, output: null, report: FUNCTION_ONLY });
    expect(result.asked).toEqual([]);
    expect(result.assumption).toMatchObject({ tests: ["tests/chord_tests.rs"] });
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a criterion against a requirement of the same spec is settled for the requirement and recorded as an amendment", async () => {
    const report = "AC-001 lists `notes of G##/Db | cannot spell G## up by 3`, but FR-001 allows the double sharp, so parse_greedy cannot satisfy both.";
    const result = await conflict({ test: "tests/chord_tests.rs", mixed: true, output: null, report });
    expect(result.asked).toEqual([]);
    expect(result.assumption?.assumed).toBe("The requirements FR-001 win over the criteria AC-001 that contradict them");
    expect(result.amendment).toMatchObject({ authority: "requirement", criterionIds: ["AC-001"], requirementIds: ["FR-001"] });
    expect(result.prompts.at(-1)).toContain("The requirements are authoritative over the criteria");
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a conflict that involves a test that existed before the run still asks a person", async () => {
    const report = "AC-001 says the value is wrong, but FR-001 says it is ready.";
    const result = await conflict({ test: "tests/chord_tests.rs", mixed: true, output: "thread 'parse_greedy' panicked at tests/chord_tests.rs:90:5:", report, existing: true });
    expect(result.asked.map((r) => r.body_json).join("")).toContain("SPEC-CONFLICT-T001");
    expect(result.assumption).toBeNull();
    expect(result.amendment).toBeNull();
  }, 90_000);
});

describe("a conflict report between two parts of the spec", () => {
  const spec = {
    criteria: [{ id: "AC-008" }, { id: "AC-010" }],
    requirements: [{ id: "FR-003" }, { id: "FR-0031" }],
  } as Parameters<typeof criterionAgainstRequirement>[0];
  test("names a criterion and a requirement by their exact ids", () => {
    expect(criterionAgainstRequirement(spec, "AC-008 contradicts FR-003")).toEqual({ criterionIds: ["AC-008"], requirementIds: ["FR-003"] });
    expect(criterionAgainstRequirement(spec, "AC-0080 contradicts FR-0031")).toBeNull();
    expect(criterionAgainstRequirement(spec, "tests/x.rs contradicts FR-003")).toBeNull();
  });
});

describe("the failing output of other toolchains locates the conflicting test (#1459)", () => {
  const writing = (path: string) => [{ id: "T001", writes: [{ path, action: "create" }] }] as Task[];
  const cases: [string, string, string][] = [
    ["vitest", "tests/chords.test.ts", " FAIL  tests/chords.test.ts > parse greedy\nAssertionError: expected 'wrong' to be 'ready'\n Test Files  1 failed (1)"],
    ["jest", "tests/chords.test.ts", "FAIL tests/chords.test.ts\n  \u25cf parse greedy\n      at Object.<anonymous> (tests/chords.test.ts:12:20)"],
    ["node:test", "test/chords.test.js", "not ok 1 - parse greedy\n  ---\n  location: '/repo/test/chords.test.js:12:3'\n  failureType: 'testCodeFailure'"],
    ["dotnet test", "tests/Chords.Tests/ChordTests.cs", "  Failed Chords.Tests.ChordTests.ParseGreedy [12 ms]\n  Stack Trace:\n     at Chords.Tests.ChordTests.ParseGreedy() in /repo/tests/Chords.Tests/ChordTests.cs:line 42"],
    ["Gradle", "src/test/java/com/acme/ChordTest.java", "ChordTest > parseGreedy() FAILED\n        at app//com.acme.ChordTest.parseGreedy(ChordTest.java:42)"],
    ["Maven", "src/test/java/com/acme/ChordTest.java", "[ERROR]   ChordTest.parseGreedy:42 expected: <ready> but was: <wrong>\n[ERROR] Tests run: 1, Failures: 1"],
  ];
  for (const [toolchain, path, output] of cases)
    test(toolchain, () => expect(failingFilesInOutput(output, writing(path))).toEqual([path]));
});

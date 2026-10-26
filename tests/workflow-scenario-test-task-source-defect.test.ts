import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import {
  criterionExpected,
  expectedValues,
  SOURCE_DEFECT_DIR,
  type SourceDefectRecord,
  sourceDefectDecision,
} from "../src/core/workflows/source-defect.js";
import { newId } from "../src/core/workflows/store.js";
import { replaySourceDefects } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// namesound soundex e2fb8e9c (bench round 70, #2220): the shared spec T003 expected the
// criterion's "B1905" and `RefinedSoundex.key` of the finished T002 returned another string. The
// wrong-value failure named only the spec file, so the test task kept it for two sessions (545k
// tokens) before the corrective that may write the source opened.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec: Spec = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  title: "Refined soundex",
  problem: "Names need phonetic keys",
  outcome: "Keys match the reference",
  inScope: ["Compute and test refined soundex keys"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  requirements: [
    { id: "FR-001", text: "Compute refined soundex keys", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    { id: "AC-001", requirementIds: ["FR-001"], given: "the name `Braz`", when: "the key is computed", then: 'the key is "B1905"', method: "automated" },
  ],
  dependencies: [],
};
const markdown =
  "# Plan\n## Context\nCode and tests.\n## Decisions\nDEC-001: FR-001 needs a source and tests.\n## Components\nSource and tests\n## Data\nText\n## Verification\nRequired checks\n## Risks\nSource defects";
const task = (id: string, paths: string[], dependsOn: string[] = [], checkIds: string[] = []): Task => ({
  id,
  title: `Write ${paths.join(", ")}`,
  description: `Write ${paths.join(", ")}`,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn,
  profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" })),
  readHints: [],
  checkIds,
  origin: "planned",
  findingIds: [],
  rationale: "Required behavior",
});
const graph: TaskGraph = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: hashJson(spec),
  planHash: hashBytes(markdown),
  tasks: [task("T001", ["src/key.ts"]), task("T002", ["tests/key.test.ts"], ["T001"], ["tests-written"])],
};
/** bun test's wrong-value failure: it names the test file and its line, never the source. */
const failure = (expected: string) =>
  `tests/key.test.ts:\n3 | expect(key("Braz")).toBe("${expected}");\nerror: expect(received).toBe(expected)\n\nExpected: "${expected}"\nReceived: "Bai\`e"\n\n      at <anonymous> (tests/key.test.ts:3:21)\n(fail) key > Braz`;

class ScriptedExecutor implements AgentExecutor {
  attempts: string[] = [];
  correctionWrites: string[][] = [];
  checksBeforeCorrection: number[] = [];
  service?: NativeWorkflowService;
  constructor(private root: string) {}
  write(path: string, content: string) {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), content);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      inputHash: string;
      snapshotHash: string;
      extra: { evidence?: { id: string }[] };
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "A fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/key.ts", "tests/key.test.ts"] };
        break;
      case "spec":
        output = spec;
        break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: graph };
        break;
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      case "implementation": {
        const t = request.task as Task;
        this.attempts.push(t.id);
        if (t.origin !== "planned") {
          this.correctionWrites.push(t.writes.map((w) => w.path).sort());
          this.checksBeforeCorrection.push(
            this.service?.store.taskCheckRuns(request.runId, "T002").filter((c) => c.check_id === "tests-written" && c.status === "failed").length ?? 0,
          );
          this.write("src/key.ts", 'export const key = (_name: string): string => "B1905";\n');
        } else if (t.id === "T001") this.write("src/key.ts", 'export const key = (_name: string): string => "Bai`e";\n');
        else this.write("tests/key.test.ts", 'import { key } from "../src/key";\ntest("Braz", () => {\nexpect(key("Braz")).toBe("B1905");\n});\n');
        await request.caseCheck?.(this.root);
        output = { schemaVersion: 1, taskId: t.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = {
          schemaVersion: 1,
          snapshotHash: data.snapshotHash,
          verdict: "pass",
          coverage: spec.criteria.map((c) => ({ criterionId: c.id, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })),
          findings: [],
        };
        break;
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(options: { route: boolean; expected: string }) {
  const root = mkdtempSync(join(tmpdir(), "baked-source-defect-"));
  cleanups.push(() => removeTempDir(root));
  const script = `if (await Bun.file('tests/key.test.ts').exists() && (await Bun.file('src/key.ts').text()).includes('Bai')) { console.log(${JSON.stringify(failure(options.expected))}); process.exit(1) }`;
  const written: Check = { id: "tests-written", executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
  const policy: RunPolicy = {
    ...defaultWorkflowPolicy,
    checks: [written, { ...written, id: "tests", scope: "feature" }],
    ...(options.route ? { sourceDefectRoute: "on" as const } : {}),
  };
  const executor = new ScriptedExecutor(root);
  const service = new NativeWorkflowService(
    root,
    { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } },
    executor,
  );
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Compute refined soundex keys and test them", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval: ${waiting.status} ${waiting.reason}`);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const records = service.store
    .artifacts(run.runId)
    .filter((a) => a.logical_path.startsWith(SOURCE_DEFECT_DIR))
    .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as SourceDefectRecord);
  return { service, runId: run.runId, done, executor, root, records };
}

describe("scenario: a test task's wrong-value failure in a finished sibling's source (#2220)", () => {
  test("with sourceDefectRoute on, the corrective writes the source after the first failed check", async () => {
    const { service, runId, done, executor, root, records } = await runScenario({ route: true, expected: "B1905" });
    expect(done.status).toBe("completed");
    // No second session of the test task: the failure is the source's.
    expect(executor.attempts.filter((id) => id === "T002")).toHaveLength(1);
    expect(service.store.state(runId).taskContinuations).toEqual({});
    expect(executor.correctionWrites).toEqual([["src/key.ts", "tests/key.test.ts"]]);
    expect(executor.checksBeforeCorrection).toEqual([1]);
    expect(readFileSync(join(root, "src/key.ts"), "utf8")).toContain("B1905");
    expect(records[0]).toMatchObject({ taskId: "T002", mode: "on", route: true, expected: 1, matched: 1, owners: ["T001"], files: ["src/key.ts"], criterionIds: ["AC-001"] });
    expect(replaySourceDefects(service.store, runId)).toEqual([{ taskId: "T002", mode: "on", owners: ["T001"], recorded: true, replayed: true }]);
  }, 60000);

  test("without the field the decision is shadow: recorded, and the test task continues as before", async () => {
    const { service, runId, done, executor, records } = await runScenario({ route: false, expected: "B1905" });
    expect(done.status).toBe("completed");
    expect(executor.attempts.filter((id) => id === "T002")).toHaveLength(2);
    expect(service.store.state(runId).taskContinuations).toEqual({ T002: 1 });
    expect(records[0]).toMatchObject({ taskId: "T002", mode: "shadow", route: true, owners: ["T001"], files: ["src/key.ts"] });
  }, 60000);

  test("an expected value that is not the criterion's literal keeps the current path", async () => {
    const { service, runId, done, executor, records } = await runScenario({ route: true, expected: "B-1905" });
    expect(done.status).toBe("completed");
    expect(executor.attempts.filter((id) => id === "T002")).toHaveLength(2);
    expect(service.store.state(runId).taskContinuations).toEqual({ T002: 1 });
    expect(records[0]).toMatchObject({ taskId: "T002", mode: "on", route: false, expected: 1, matched: 0 });
  }, 60000);
});

describe("expected values across test frameworks (#2220)", () => {
  const cases: [string, string][] = [
    ["rspec", '     Failure/Error: expect(RefinedSoundex.key("Braz")).to eq("B1905")\n\n       expected: "B1905"\n            got: "Bai`e"\n\n       (compared using ==)'],
    ["bun/jest", 'error: expect(received).toBe(expected)\n\nExpected: "B1905"\nReceived: "Bai"'],
    ["testify", 'Error:      Not equal:\n            expected: "B1905"\n            actual  : "Bai"'],
    ["go", 'key_test.go:9: Key("Braz") = "Bai", want "B1905"'],
    ["pytest", "E       AssertionError: assert 'Bai' == 'B1905'"],
    ["junit", "org.opentest4j.AssertionFailedError: expected: <B1905> but was: <Bai>"],
    ["xunit", "Assert.Equal() Failure: Strings differ\nExpected: \"B1905\"\nActual:   \"Bai\""],
    ["rust", "assertion `left == right` failed\n  left: \"Bai\"\n right: \"B1905\""],
    ["exunit", 'Assertion with == failed\ncode:  assert key("Braz") == "B1905"\nleft:  "Bai"\nright: "B1905"'],
    ["xctest", 'XCTAssertEqual failed: ("Bai") is not equal to ("B1905")'],
    ["phpunit", "Failed asserting that two strings are identical.\n--- Expected\n+++ Actual\n@@ @@\n-'B1905'\n+'Bai'"],
    ["minitest", 'Expected: "B1905"\n  Actual: "Bai"'],
    ["busted", "Expected objects to be the same.\nPassed in:\n(string) 'Bai'\nExpected:\n(string) 'B1905'"],
    ["zig", "expected B1905, found Bai"],
  ];
  for (const [name, output] of cases)
    test(name, () => {
      expect(expectedValues(output)).toContain("B1905");
      expect(criterionExpected(output, [{ criterionId: "AC-001", literal: "B1905" }])).toMatchObject({ matched: 1, criterionIds: ["AC-001"] });
    });

  test("the rule needs every expected value to be a criterion literal and a finished owner", () => {
    const base = { testTask: true, self: true, expected: 2, matched: 2, owners: ["T001"], files: ["src/key.ts"] };
    expect(sourceDefectDecision(base)).toBe(true);
    expect(sourceDefectDecision({ ...base, matched: 1 })).toBe(false);
    expect(sourceDefectDecision({ ...base, owners: [], files: [] })).toBe(false);
    expect(sourceDefectDecision({ ...base, self: false })).toBe(false);
  });
});

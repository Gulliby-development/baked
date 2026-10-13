import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import {
  isTestTask,
  redProblem,
  testsFirstProblems,
  withTestsFirstOrder,
} from "../src/core/workflows/tests-first.js";
import type { ExecutionRequest, Task, TaskGraph } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const task = (id: string, writes: Task["writes"], extra: Partial<Task> = {}): Task => ({
  id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [],
  profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required", ...extra,
});
const graphOf = (tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "0".repeat(64), planHash: "0".repeat(64), tasks });

// The task check fails, naming the test file, until value.txt holds "ready".
const unit = { id: "unit", executable: "bun", args: ["-e", "const ok = await Bun.file('value.txt').exists() && (await Bun.file('value.txt').text()) === 'ready'; if (!ok) { console.log('FAIL value.test.ts > value is ready'); process.exit(1); }"], cwd: ".", timeoutMs: 10000, required: true, scope: "task" as const, envNames: [], writes: [] };
const policy: RunPolicy = { ...fixturePolicy, testsFirst: "criteria", checks: [...fixturePolicy.checks, unit] };

test("a plan under tests first needs a test task with a task check for every automated criterion", () => {
  const code = task("T001", [{ path: "value.txt", action: "create" }]);
  expect(testsFirstProblems(fixtureSpec, graphOf([code]), policy)).toEqual([
    "Criterion AC-001 has no test task: tests come first, so plan a task that writes only test files for it.",
  ]);
  const tests = task("T002", [{ path: "value.test.ts", action: "create" }]);
  expect(testsFirstProblems(fixtureSpec, graphOf([code, tests]), policy)[0]).toContain("Test task T002 names no task-scope check");
  expect(testsFirstProblems(fixtureSpec, graphOf([code, { ...tests, checkIds: ["unit"] }]), policy)).toEqual([]);
  expect(testsFirstProblems(fixtureSpec, graphOf([code]), fixturePolicy)).toEqual([]);
});

test("under tests first the test tasks run before the code that shares their criteria", () => {
  const code = task("T001", [{ path: "src/value.ts", action: "create" }]);
  const tests = task("T002", [{ path: "tests/value.test.ts", action: "create" }], { dependsOn: ["T001"] });
  const other = task("T003", [{ path: "src/other.ts", action: "create" }], { criterionIds: ["AC-002"] });
  const ordered = withTestsFirstOrder(graphOf([code, tests, other]));
  expect(ordered.tasks.map((t) => [t.id, t.dependsOn])).toEqual([["T001", ["T002"]], ["T002", []], ["T003", []]]);
  expect(isTestTask(tests)).toBe(true);
  expect(isTestTask(code)).toBe(false);
});

test("a new test must fail, on these tests, and not on a broken file", () => {
  const tests = task("T002", [{ path: "tests/value.test.ts", action: "create" }]);
  expect(redProblem(tests, [{ checkId: "unit", status: "passed" }])).toContain("already pass before the change");
  expect(redProblem(tests, [{ checkId: "unit", status: "failed", output: "1 failed in other.test.ts" }])).toContain("names none of its test files");
  expect(redProblem(tests, [{ checkId: "unit", status: "failed", output: "tests/value.test.ts:3 SyntaxError: Unexpected token" }])).toContain("does not load");
  expect(redProblem(tests, [{ checkId: "unit", status: "failed", output: "value.test.ts > adds: expected 3, received undefined" }])).toBeNull();
  expect(redProblem(tests, [])).toContain("no task check");
});

/** Plans a test task and a code task; the test task writes a test, the code task the value. */
class TestsFirstExecutor extends FixtureExecutor {
  implemented: string[] = [];
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nTests first.\n## Decisions\nDEC-001: FR-001 test first.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nunit\n## Risks\nNone";
      const tasks = [
        task("T001", [{ path: "value.test.ts", action: "create" }], { checkIds: ["unit"], title: "Test value" }),
        task("T002", [{ path: "value.txt", action: "create" }], { checkIds: ["unit"], title: "Write value" }),
      ];
      return { output: { schemaVersion: 1, markdown, taskGraph: { ...graphOf(tasks), specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown) } }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    const id = request.task?.id ?? "";
    this.implemented.push(id);
    (this.prompts.implementation ??= []).push(request.prompt);
    if (id === "T001") {
      const extra = request.prompt.includes("empty value") ? 'it("value is not empty", () => expect(read()).not.toBe(""));\n' : "";
      writeFileSync(join(this.dir, "value.test.ts"), `it("value is ready", () => expect(read()).toBe("ready"));\n${extra}`);
    }
    else writeFileSync(join(this.dir, "value.txt"), "ready");
    return { output: { schemaVersion: 1, taskId: id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
  }
}

test("tests first: the test fails first, a person approves it, then the code makes it pass", async () => {
  const fixture = workflowFixture({ policy, executor: (root) => new TestsFirstExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());

  // The test task ran, its check failed on value.test.ts, and the code waits for the approval.
  expect(executor.implemented).toEqual(["T001"]);
  expect(existsSync(join(root, "value.txt"))).toBe(false);
  expect(service.store.run(run.runId).status).toBe("waiting");
  const red = service.store.latestArtifact(run.runId, "tests-first/T001.json");
  expect(service.store.readArtifact(run.runId, red?.id ?? "")).toContain('"red":true');
  const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  const body = JSON.parse(request?.body_json ?? "{}") as { testsFirst: { tests: { taskId: string; files: { path: string; content: string }[] }[]; criteria: { id: string }[] } };
  expect(body.testsFirst.tests[0]?.files[0]?.path).toBe("value.test.ts");
  expect(body.testsFirst.tests[0]?.files[0]?.content).toContain("value is ready");
  expect(body.testsFirst.criteria.map((c) => c.id)).toEqual(["AC-001"]);

  // Code tasks cannot change the approved test.
  let current = await service.get(run.runId);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "approve", requestId: request?.id ?? "", digest: request?.digest ?? "" });
  expect(service.store.state(run.runId).testsFirst?.approved).toBe(true);
  const denied: string[] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (req: ExecutionRequest) => {
    if (req.profile.output === "implementation" && req.task?.id === "T002") {
      const runPolicy = JSON.parse(service.store.run(req.runId).policy_json) as RunPolicy;
      const scoped = { ...req.task, writes: [...req.task.writes, { path: "value.test.ts", action: "modify" as const }] };
      const guard = new WorkflowToolPolicy(service.store, service.leases, req.runId, req.attemptId, req.profile, runPolicy, scoped);
      try {
        guard.validate("edit_file", { path: "value.test.ts" });
      } catch (error) {
        denied.push(error instanceof Error ? error.message : String(error));
      }
    }
    return original(req);
  };
  current = await service.get(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(executor.implemented).toEqual(["T001", "T002"]);
  expect(denied[0]).toContain("holds tests written first");
  expect((await service.get(run.runId)).status).toBe("completed");
});

test("rejecting the tests writes them again with the note", async () => {
  const fixture = workflowFixture({ policy, executor: (root) => new TestsFirstExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());
  const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  const current = await service.get(run.runId);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "reject", requestId: request?.id ?? "", explanation: "Also test an empty value" });
  expect(service.store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("invalidated");
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(executor.implemented).toEqual(["T001", "T001"]);
  expect(executor.prompts.implementation?.at(-1)).toContain("Also test an empty value");
  expect(service.store.run(run.runId).status).toBe("waiting");
});

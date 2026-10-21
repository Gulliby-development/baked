import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import {
  isTestPath,
  preexistingTest,
  scanTestIntegrity,
  testIntegrityOf,
  testWriteProblems,
} from "../src/core/workflows/test-integrity.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const task = (writes: Task["writes"], id = "T001"): Task => ({
  id, title: "Task", description: "Task", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [],
  profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required",
});

test("test paths follow the conventions of the supported languages", () => {
  for (const path of ["src/a.test.ts", "web/b.spec.tsx", "pkg/x_test.go", "tests/test_cli.py", "app/test_app.py", "tests/cli.rs", "src/test/java/AppTest.java", "Calc.Tests/CalcTests.cs", "src/__tests__/a.js", "spec/models/user_spec.rb"])
    expect(isTestPath(path)).toBe(true);
  for (const path of ["src/index.ts", "specs/feature/spec.json", "src/testing.ts", "docs/tests.md", "contest.py"])
    expect(isTestPath(path)).toBe(false);
});

test("the scan reports deleted, skipped and weakened tests, suppressions and test special cases", () => {
  const before = 'import { expect, it } from "bun:test";\nit("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\nit("subtracts", () => {\n  expect(sub(3, 1)).toBe(2);\n});\n';
  const findings = scanTestIntegrity(
    [
      { path: "tests/old.test.ts", before, after: null },
      { path: "tests/count.test.ts", before, after: 'it("adds", () => {\n  // expect(add(1, 2)).toBe(3);\n});\n' },
      { path: "tests/skip.test.ts", before, after: before.replace('it("subtracts"', 'it.skip("subtracts"') },
      { path: "src/add.ts", before: "export const add = (a: number, b: number) => a + b;\n", after: "// @ts-ignore\nexport const add = (a: any, b: number) => (process.env.NODE_ENV === \"test\" ? 3 : a + b);\n" },
      { path: "src/parse.ts", before: "export const parse = (s: string) => s.trim();\n", after: 'export const parse = (s: string) => (s === "  hello world  " ? "hello world" : s);\n' },
      { path: "package.json", before: '{"scripts":{"test":"bun test"}}', after: '{"scripts":{"test":"jest --passWithNoTests"}}' },
    ],
    { testSources: ['it("trims", () => expect(parse("  hello world  ")).toBe("hello world"));'] },
  );
  const rules = findings.map((f) => `${f.rule} ${f.path}`);
  expect(rules).toEqual([
    "test-deleted tests/old.test.ts",
    "test-count tests/count.test.ts",
    "assertions tests/count.test.ts",
    "skip tests/skip.test.ts",
    "test-hook src/add.ts",
    "suppression src/add.ts",
    "literal-branch src/parse.ts",
    "verification-bypass package.json",
  ]);
});

test("the scan leaves planned changes, existing code and spec literals alone", () => {
  const before = 'it("a", () => { expect(1).toBe(1); });\nit("b", () => { expect(2).toBe(2); });\n';
  expect(
    scanTestIntegrity(
      [
        // The plan gave a reason to remove a test.
        { path: "tests/a.test.ts", before, after: 'it("a", () => { expect(1).toBe(1); });\n' },
        // Suppressions and comparisons that were already there.
        { path: "src/a.ts", before: "// @ts-ignore\nconst x: any = 1;\n", after: "// @ts-ignore\nconst x: any = 2;\n" },
        // A literal the spec names is a requirement, and a command name is not test data.
        { path: "src/b.ts", before: "", after: 'if (s === "hello world") run();\nif (cmd === "add-item") add();\n' },
        { path: "tests/b.test.ts", before: null, after: 'it("b", () => { expect(f("hello world", "add-item")).toBe(1); });\n' },
        // An earlier version the run did not keep cannot be compared, so its counts are not reported.
        { path: "src/c.ts", before: undefined, after: "// eslint-disable-next-line no-console\nexport const c = 1;\n" },
        // Documentation may name a suppression.
        { path: "docs/lint.md", before: "", after: "Use `// eslint-disable-next-line` sparingly.\n" },
      ],
      { reasoned: new Set(["tests/a.test.ts"]), specText: 'Greets "hello world".' },
    ),
  ).toEqual([]);
});

test("existing tests need a reason in the plan to be changed, unless the guard only warns", () => {
  const graph = { tasks: [task([{ path: "tests/old.test.ts", action: "modify" }]), task([{ path: "tests/new.test.ts", action: "create" }], "T002"), task([{ path: "tests/new.test.ts", action: "modify" }], "T003")] };
  expect(preexistingTest("tests/old.test.ts", graph.tasks, "/nonexistent")).toBe(true);
  expect(preexistingTest("tests/new.test.ts", graph.tasks, "/nonexistent")).toBe(false);
  const problems = testWriteProblems(graph, {}, "/nonexistent");
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("T001 would modify the existing test tests/old.test.ts without a reason");
  expect(testWriteProblems({ tasks: [task([{ path: "tests/old.test.ts", action: "modify", reason: "The request removes subtraction" }])] }, {}, "/nonexistent")).toEqual([]);
  expect(testWriteProblems(graph, { testIntegrity: "warn" }, "/nonexistent")).toEqual([]);
  expect(testIntegrityOf({})).toBe("block");
});

/** An executor whose plan creates a test file, and whose first implementation skips a test. */
class SkippingExecutor extends FixtureExecutor {
  implementations = 0;
  constructor(
    private dir: string,
    private always = false,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      const output = result.output as { taskGraph: { tasks: Task[] } };
      output.taskGraph.tasks[0]?.writes.push({ path: "value.test.ts", action: "create" });
      return result;
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    this.implementations++;
    const first = this.always || this.implementations === 1;
    writeFileSync(join(this.dir, "value.txt"), "ready");
    writeFileSync(join(this.dir, "value.test.ts"), `it${first ? ".skip" : ""}("is ready", () => { expect(read()).toBe("ready"); });\n`);
    return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
  }
}

test("a task that skips a test gets a finding naming the test, and a repair removes the skip", async () => {
  const fixture = workflowFixture({ executor: (root) => new SkippingExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());

  const findings = service.store.findings(run.runId).map((f) => JSON.parse(f.body_json) as { claim: string; file: string | null });
  const finding = findings.find((f) => f.claim.startsWith("Test integrity (skip)"));
  expect(finding?.claim).toContain("value.test.ts");
  expect(finding?.file).toBe("value.test.ts");
  const record = service.store.latestArtifact(run.runId, "tasks/T001/integrity.json");
  expect(service.store.readArtifact(run.runId, record?.id ?? "")).toContain('"rule":"skip"');
  // The repair wrote the test without the skip, and the run went on.
  expect(executor.implementations).toBe(2);
  expect((await service.get(run.runId)).status).toBe("completed");
});

test("a skip that a repair leaves in place is found again at feature scope, and the run does not pass", async () => {
  const fixture = workflowFixture({ executor: (root) => new SkippingExecutor(root, true) });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());

  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  expect(claims).toContain("Test integrity (skip): the run added 1 skip, only, todo or ignore marker(s) in value.test.ts");
  expect(service.store.latestArtifact(run.runId, "integrity/run.json")).not.toBeNull();
  expect((await service.get(run.runId)).status).not.toBe("completed");
});

test("under testIntegrity warn the finding is only recorded", async () => {
  const policy: RunPolicy = { ...fixturePolicy, testIntegrity: "warn" };
  const fixture = workflowFixture({ policy, executor: (root) => new SkippingExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());

  expect(executor.implementations).toBe(1);
  expect(service.store.findings(run.runId).some((f) => f.body_json.includes("Test integrity"))).toBe(false);
  const record = service.store.latestArtifact(run.runId, "tasks/T001/integrity.json");
  expect(service.store.readArtifact(run.runId, record?.id ?? "")).toContain('"mode":"warn"');
  expect((await service.get(run.runId)).status).toBe("completed");
});

test("an implementer cannot edit a test that existed before the run without a planned reason", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  writeFileSync(join(root, "old.test.ts"), 'it("works", () => { expect(1).toBe(1); });\n');
  const denied: string[] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "implementation") {
      const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
      for (const reason of [undefined, "The request changes the expected value"]) {
        const scoped = task([{ path: "old.test.ts", action: "modify", ...(reason ? { reason } : {}) }]);
        const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, scoped);
        try {
          guard.validate("edit_file", { path: "old.test.ts" });
        } catch (error) {
          denied.push(`${reason ? "reason" : "none"}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return original(request);
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());
  expect(denied).toHaveLength(1);
  expect(denied[0]).toStartWith("none: old.test.ts is a test that existed before this run");
});

test("a spec conflict stops the task and asks a person; the answer reaches the next attempt", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const prompts: string[] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "implementation") {
      prompts.push(request.prompt);
      if (prompts.length === 1)
        return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "spec_conflict", summary: "AC-001 wants ready, value.test.ts expects done.", evidenceIds: [], unresolved: ["value.test.ts line 1 contradicts FR-001"] }, inputTokens: 25, outputTokens: 25 };
    }
    return original(request);
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());

  expect(service.store.run(run.runId).status).toBe("waiting");
  const request = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
  const body = JSON.parse(request?.body_json ?? "{}") as { questions: { id: string; question: string; blocking: boolean }[] };
  expect(body.questions[0]?.id).toBe("SPEC-CONFLICT-T001");
  expect(body.questions[0]?.question).toContain("value.test.ts expects done");
  expect(service.store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("interrupted");

  const current = await service.get(run.runId);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: request?.id ?? "", answers: { "SPEC-CONFLICT-T001": "The spec is right: ready" } });
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("The spec is right: ready");
  expect((await service.get(run.runId)).status).toBe("completed");
});

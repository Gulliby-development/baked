import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #1579: the host appended tests-written to tasks even though executionContract.checks lacked it.
// The analyzer then sent the plan back for wording the planner could not remove.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const legacyBatch = "This criterion alone exceeds one attempt. Write its cases in small batches inside this attempt, run tests-written after each batch, and preserve earlier batches.";
const policy = {
  ...fixturePolicy,
  checks: ["typecheck", "lint", "tests"].map((id) => ({
    ...fixturePolicy.checks[0]!, id,
    args: id === "tests" ? ["test"] : ["-e", "process.exit(0)"],
  })),
  sizing: { maxAttemptTokens: 200_000 },
};

class ScriptedExecutor extends FixtureExecutor {
  analyses = 0;
  plans = 0;
  invalidWordings = 0;
  constructor(private workspace: string, private path: string, private legacy: boolean) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      this.plans += 1;
      const result = await super.execute(request);
      const plan = result.output as { markdown: string; taskGraph: TaskGraph };
      plan.markdown += `\nTest value.txt in ${this.path}.`;
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      plan.taskGraph.specHash = hashJson(fixtureSpec);
      const base = plan.taskGraph.tasks[0]!;
      const task: Task = {
        ...base, id: "T002", title: "Test the ready value", description: "Write tests for the ready value",
        writes: [{ path: this.path, action: "create" }], dependsOn: [base.id], checkIds: ["lint"],
      };
      // A stored graph from before the fix, as encountered after resuming a run.
      if (this.legacy) task.description += `\nSizing split this task by file: write only ${this.path};  belong to the other parts of T002. ${legacyBatch}`;
      plan.taskGraph.tasks.push(task);
      return result;
    }
    if (request.profile.output === "analysis") {
      this.analyses += 1;
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
        inputHash: string;
        extra: { verifiedByRuntime: string[]; executionContract: { checks: { id: string }[] } };
      };
      const checks = data.extra.executionContract.checks.map((check) => check.id);
      expect(checks).toEqual(["typecheck", "lint", "tests"]);
      const graph = (JSON.parse(request.prompt.split("\n").at(-2) ?? "{}") as { graph: TaskGraph }).graph;
      const bad = graph.tasks.filter((task) => task.description.includes("run tests-written after each batch"));
      this.invalidWordings += bad.length;
      const findings = bad.map((task) => ({
        id: `F-${task.id}`, kind: "inconsistency", refs: ["tasks.json", task.id], blocking: true,
        description: `${task.id}'s appended batching wording requires tests-written, but the policy checks only define ${checks.join(", ")}.`,
      }));
      return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: findings.length ? "needs_revision" : "pass", findings }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation" && request.task?.id === "T002") {
      const target = join(request.root ?? this.workspace, this.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'import { expect, test } from "bun:test";\ntest("ready value", async () => expect(await Bun.file("value.txt").text()).toBe("ready"));\n');
      return { output: { schemaVersion: 1, taskId: "T002", outcome: "implemented", summary: "Wrote test", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

for (const path of ["tests/value.test.ts", "tests/test_value.py", "internal/value/value_test.go"]) {
  test(`scenario: oversized ${path} adds batching guidance without an undeclared check`, async () => {
    const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, path, false) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const waiting = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(waiting.reason).toBe("approval");
    const task = fixture.service.store.state(run.runId).graph!.tasks.find((task) => task.id === "T002")!;
    expect(task.description).toContain("small batches inside this attempt");
    expect(task.description).not.toContain("tests-written");
    expect(task.checkIds).toEqual(["lint"]);
    expect(fixture.executor.invalidWordings).toBe(0);
    expect(fixture.executor.plans).toBeLessThanOrEqual(2);
    expect(fixture.service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
    if (path.endsWith(".ts")) {
      await fixture.approve(run.runId);
      expect((await fixture.service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    }
  }, 120_000);
}

test("scenario: a legacy host batching check inconsistency stays a note through approval", async () => {
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, "tests/value.test.ts", true) });
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
  expect(fixture.executor.invalidWordings).toBeGreaterThan(0);
  const state = fixture.service.store.state(run.runId);
  expect(state.analysisPassed).toBe(true);
  expect(state.analysisReplans).toBe(0);
  expect(state.analysisRaised).toEqual([]);
  expect(fixture.service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
}, 120_000);

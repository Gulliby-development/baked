import { afterEach, expect, test } from "bun:test";
import type { HostEdit } from "../src/core/workflows/host-edits.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ScriptedExecutor extends FixtureExecutor {
  analyses = 0;
  plannerAdditions: unknown;
  analysisEdits: HostEdit[] = [];
  constructor(root: string, private path: string, private mixed = false) { super(root); }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}");
    if (request.profile.output === "plan") {
      this.plannerAdditions = data.extra.hostAdditions;
      const result = await super.execute(request);
      const plan = result.output as { taskGraph: TaskGraph };
      const base = plan.taskGraph.tasks[0]!;
      plan.taskGraph.tasks.push({ ...base, id: "T002", title: "Test the value", description: "Verify the ready value", dependsOn: [base.id], writes: [{ path: this.path, action: "create" }] });
      return result;
    }
    if (request.profile.output === "analysis") {
      this.analyses++;
      this.analysisEdits = data.extra.hostEdits ?? [];
      const graph = JSON.parse(request.prompt.split("\n").at(-2) ?? "{}").graph as TaskGraph;
      const task = graph.tasks.find((task) => task.id === "T002")!;
      expect(task.description).toContain("preserve earlier batches");
      return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [{
        id: "HOST-TEXT", kind: "inconsistency", blocking: true,
        refs: this.mixed ? ["tasks.json", "T002", "AC-001"] : ["tasks.json", "T002"],
        description: 'T002 adds the instruction "preserve earlier batches" which changes the verification narrative.' + (this.mixed ? " This violates AC-001." : ""),
      }] }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

for (const path of ["tests/value.test.ts", "tests/test_value.py", "internal/value/value_test.go"]) {
  test(`scenario: host text in ${path} is a note with a durable ledger, without replanning (#1583)`, async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, sizing: { maxAttemptTokens: 200_000 } }, executor: (root) => new ScriptedExecutor(root, path) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const store = fixture.service.store;
    const state = store.state(run.runId);
    expect(state.analysisPassed).toBe(true);
    expect(state.analysisReplans).toBe(0);
    expect(state.analysisRaised).toEqual([]);
    expect(fixture.executor.plannerAdditions).toBeArray();
    const artifact = store.artifacts(run.runId).find((artifact) => artifact.logical_path === "host-edits.json");
    expect(artifact).toBeDefined();
    const edits = JSON.parse(store.readArtifact(run.runId, artifact!.id)) as HostEdit[];
    expect(edits).toEqual(state.hostEdits);
    expect(edits).toEqual(fixture.executor.analysisEdits);
    expect(readWorkflowView(fixture.service, run.runId).details.hostEdits).toEqual(edits);
    const listed = await executeWorkflowCommand(fixture.service, parseWorkflowArgs(["artifacts", run.runId]), new AbortController().signal);
    expect(JSON.stringify(listed)).toContain("host-edits.json");
    expect(runReport(store, run.runId)).toContain("## Host edits");
    const description = edits.find((edit) => edit.task === "T002" && edit.field === "description");
    expect(description).toMatchObject({ kind: "sizing-split", before: "Verify the ready value" });
    expect(description?.text).toContain("preserve earlier batches");
    const notes = store.latestArtifact(run.runId, "analysis/host-notes.json")!;
    expect(JSON.parse(store.readArtifact(run.runId, notes.id)).notes[0].hostEdits).toContainEqual(description);
    expect(store.requests(run.runId).some((request) => request.kind === "clarification")).toBe(false);
  }, 120_000);
}

test("scenario: a spec conflict quoting host text remains blocking (#1583)", async () => {
  const fixture = workflowFixture({ policy: { ...fixturePolicy, sizing: { maxAttemptTokens: 200_000 } }, executor: (root) => new ScriptedExecutor(root, "tests/value.test.ts", true) });
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  expect((await fixture.service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
  expect(fixture.service.store.state(run.runId).analysisPassed).toBe(false);
  expect(fixture.service.store.latestArtifact(run.runId, "analysis/host-notes.json")).toBeNull();
}, 120_000);

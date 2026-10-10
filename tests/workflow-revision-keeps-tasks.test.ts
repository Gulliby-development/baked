import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId, type TaskRow } from "../src/core/workflows/store.js";
import { reusableImplementations } from "../src/core/workflows/task-graph.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, RuntimeState, Task } from "../src/core/workflows/types.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const signal = () => new AbortController().signal;

const taskCheck = (script: string) => ({
  id: "task-check",
  executable: "bun",
  args: ["-e", script],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task" as const,
  envNames: [],
  writes: [],
});
const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [
    ...fixturePolicy.checks,
    taskCheck("if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"),
  ],
};
/** The same policy with only the task check's command changed. */
const revisedPolicy: RunPolicy = {
  ...policy,
  checks: [
    ...fixturePolicy.checks,
    taskCheck("if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"),
  ],
};

/**
 * T001 names the task check; the first review fails, so the run stops with T001 implemented and
 * its checks passed, as a run does before an operator revises it.
 */
async function implementedThenBlocked() {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  let reviews = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "review" && reviews++ === 0) {
      executor.calls.push("review");
      throw new WorkflowFault("OUTPUT_INVALID", "Reviewer unavailable");
    }
    if (request.profile.output === "implementation") {
      // The edit goes through the workflow tool policy, so it is journaled as the run's own.
      executor.calls.push("implementation");
      const current = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
      const guard = new WorkflowToolPolicy(
        service.store,
        service.leases,
        request.runId,
        request.attemptId,
        request.profile,
        current,
        request.task,
      );
      await guard.execute("edit_file", { path: "value.txt" }, async () =>
        writeFileSync(join(root, "value.txt"), "ready"),
      );
      return {
        output: {
          schemaVersion: 1,
          taskId: request.task?.id,
          outcome: "implemented",
          summary: "Wrote value",
          evidenceIds: [],
          unresolved: [],
        },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as { taskGraph: { tasks: { checkIds: string[] }[] } };
      for (const task of plan.taskGraph.tasks) task.checkIds = ["task-check"];
    }
    return out;
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  expect(await service.drive(run.runId, signal())).toMatchObject({ status: "blocked" });
  expect(service.store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("implemented");
  expect(executor.calls.filter((c) => c === "implementation")).toHaveLength(1);
  return { ...fixture, runId: run.runId };
}

const runs = (checks: { check_id: string }[], id: string) =>
  checks.filter((c) => c.check_id === id).length;

describe("revision of an implemented run", () => {
  test("a policy-only revision keeps T001's implementation and runs every check again", async () => {
    const fixture = await implementedThenBlocked();
    const { service, executor, runId, root } = fixture;
    const before = service.store.checks(runId);
    const row = service.store.tasks(runId).find((t) => t.id === "T001");
    const candidate = await new WorkflowArtifacts(service).stageRevision(runId, {
      commandId: newId(),
      expectedInputHash: (await service.get(runId)).inputHash,
      policy: revisedPolicy,
    });
    // revise --resume applies the revision and drives the run in one command.
    const resumed = await executeWorkflowCommand(
      service,
      parseWorkflowArgs([
        "revise",
        runId,
        "--candidate",
        candidate.candidateHash,
        "--expected-revision",
        String((await service.get(runId)).revision),
        "--resume",
      ]),
      signal(),
    );
    // The changed policy is approved again; nothing is implemented before that.
    expect(resumed).toMatchObject({ status: "waiting", reason: "approval" });
    const kept = service.store.tasks(runId).find((t) => t.id === "T001");
    expect(kept).toMatchObject({ status: "implemented", generation: row?.generation });
    // The evidence of the previous snapshot no longer counts.
    expect(service.store.checks(runId).every((c) => c.validity !== "current")).toBe(true);

    await fixture.approve(runId);
    await fixture.resume(runId);
    expect(await service.drive(runId, signal())).toMatchObject({ status: "completed" });
    expect(executor.calls.filter((c) => c === "implementation")).toHaveLength(1);
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
    // The task check and the feature check ran again on the final snapshot and passed.
    const after = service.store.checks(runId);
    expect(runs(after, "task-check")).toBeGreaterThan(runs(before, "task-check"));
    expect(runs(after, "check")).toBeGreaterThan(runs(before, "check"));
    const snapshotId = service.store.state(runId).snapshotId;
    for (const id of ["task-check", "check"])
      expect(
        after.filter((c) => c.check_id === id && c.snapshot_id === snapshotId).at(-1)?.status,
      ).toBe("passed");
  });

  test("a revision that changes T001's definition implements it again", async () => {
    const fixture = await implementedThenBlocked();
    const { service, executor, runId } = fixture;
    const graph = service.store.state(runId).graph;
    if (!graph) throw new Error("No task graph");
    const candidate = await new WorkflowArtifacts(service).stageRevision(runId, {
      commandId: newId(),
      expectedInputHash: (await service.get(runId)).inputHash,
      policy: revisedPolicy,
      graph: {
        ...graph,
        tasks: graph.tasks.map((t) => ({ ...t, description: "Write ready, trimmed" })),
      },
    });
    await service.revise(
      runId,
      { commandId: newId(), expectedRevision: (await service.get(runId)).revision },
      candidate.candidateHash,
    );
    expect(service.store.run(runId).status).toBe("paused");
    expect(service.store.tasks(runId).find((t) => t.id === "T001")?.status).toBe("invalidated");
    await fixture.resume(runId);
    expect(await service.drive(runId, signal())).toMatchObject({ reason: "approval" });
    await fixture.approve(runId);
    await fixture.resume(runId);
    expect(await service.drive(runId, signal())).toMatchObject({ status: "completed" });
    expect(executor.calls.filter((c) => c === "implementation")).toHaveLength(2);
  });
});

describe("reusableImplementations", () => {
  const task = (id: string, dependsOn: string[], path: string): Task => ({
    id,
    title: id,
    description: `Write ${path}`,
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn,
    profileId: "implementer",
    writes: [{ path, action: "create" }],
    readHints: [],
    checkIds: [],
    origin: "planned",
    findingIds: [],
    rationale: "Fixture",
  });
  const state = (tasks: Task[], plan = "plan") =>
    ({
      spec: { id: "spec" },
      plan,
      graph: { tasks },
    }) as unknown as RuntimeState;
  const rows = (tasks: Task[], status: TaskRow["status"] = "implemented"): TaskRow[] =>
    tasks.map((t) => ({
      id: t.id,
      definition_json: JSON.stringify(t),
      status,
      generation: 1,
      snapshot_id: "snapshot",
    }));
  const tasks = [task("T001", [], "a.txt"), task("T002", ["T001"], "b.txt"), task("T003", [], "c.txt")];

  test("keeps every unchanged implemented task", () => {
    expect([...reusableImplementations(state(tasks), state(tasks), rows(tasks))]).toEqual([
      "T001",
      "T002",
      "T003",
    ]);
  });
  test("a changed task and the tasks that depend on it are implemented again", () => {
    const changed = tasks.map((t) => (t.id === "T001" ? { ...t, description: "Changed" } : t));
    expect([...reusableImplementations(state(tasks), state(changed), rows(tasks))]).toEqual([
      "T003",
    ]);
  });
  test("a changed plan, write scope or unimplemented task keeps nothing of it", () => {
    expect(reusableImplementations(state(tasks), state(tasks, "other"), rows(tasks)).size).toBe(0);
    const widened = tasks.map((t) =>
      t.id === "T003" ? { ...t, writes: [...t.writes, { path: "d.txt", action: "create" as const }] } : t,
    );
    expect(reusableImplementations(state(tasks), state(widened), rows(tasks)).size).toBe(0);
    expect(reusableImplementations(state(tasks), state(tasks), rows(tasks, "blocked")).size).toBe(0);
  });
});

test("revise takes --resume, and --events only with it", () => {
  const base = ["revise", "run", "--candidate", "hash", "--expected-revision", "1"];
  expect(parseWorkflowArgs([...base, "--resume", "--events"]).flags).toMatchObject({
    resume: true,
    events: true,
  });
  expect(parseWorkflowArgs(base).flags.resume).toBeUndefined();
  expect(() => parseWorkflowArgs([...base, "--events"])).toThrow("--events and --after need --resume");
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FORK_SEED_ARTIFACT, FORK_SEEDED_ARTIFACT } from "../src/core/workflows/fork-stage.js";
import { capturePreImage } from "../src/core/workflows/rollback.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest, RunSnapshot } from "../src/core/workflows/types.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Writes the task's file through the edit journal, the way an implementer's edit tool does. */
class JournaledRun extends FixtureExecutor {
  service: ReturnType<typeof workflowFixture>["service"] | null = null;
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation" && this.service) {
      const service = this.service;
      const before = service.store.transaction(() =>
        capturePreImage(service.store, request.runId, join(this.dir, "value.txt")),
      );
      service.scheduler.journal.publish(request.runId, request.attemptId, "value.txt", "ready", before, "file_patch");
      return {
        output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    return super.execute(request);
  }
}

async function finishedRun() {
  const fixture = workflowFixture({ executor: (root) => new JournaledRun(root) });
  cleanups.push(fixture.dispose);
  fixture.executor.service = fixture.service;
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  expect((await fixture.service.get(run.runId)).status).toBe("completed");
  return { fixture, parentId: run.runId };
}

describe("fork from a stage (#855)", () => {
  test("starts at the review with the parent's change and runs no implementation", async () => {
    const { fixture, parentId } = await finishedRun();
    const service = fixture.service;
    expect(service.forkStages(parentId)).toEqual(expect.arrayContaining(["review"]));
    const parent = await service.get(parentId);
    const fork = await service.fork(
      parentId,
      { commandId: newId(), expectedRevision: parent.revision },
      { fromStage: "review" },
    );
    expect(fork.runId).not.toBe(parentId);
    const calls = fixture.executor.calls.length;
    await service.drive(fork.runId, new AbortController().signal);
    const after = await service.get(fork.runId);
    expect(after.status).toBe("completed");
    const forkCalls = fixture.executor.calls.slice(calls);
    expect(forkCalls).not.toContain("implementation");
    expect(forkCalls).not.toContain("plan");
    expect(forkCalls).toContain("review");
    // The parent's change is the fork's own journaled edit, so its review bundle shows it.
    const patches = service.store
      .effects(fork.runId)
      .filter((e) => e.kind === "file_patch" && e.status === "applied");
    expect(patches.map((e) => (JSON.parse(e.intent_json) as { path: string }).path)).toEqual(["value.txt"]);
    const bundle = service.store
      .artifacts(fork.runId)
      .find((a) => a.logical_path.startsWith("review/bundle-"));
    expect(bundle && service.store.readArtifact(fork.runId, bundle.id)).toContain("+ready");
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
    // The sources are the parent's snapshot, so its passing checks count for the fork's acceptance.
    const seeded = service.store.latestArtifact(fork.runId, FORK_SEEDED_ARTIFACT);
    expect(seeded && JSON.parse(service.store.readArtifact(fork.runId, seeded.id)).carriedEvidence).toBe(true);
    expect(service.store.tasks(fork.runId).every((t) => t.status !== "pending")).toBe(true);
  });

  test("refuses a stage before the implementation", async () => {
    const { fixture, parentId } = await finishedRun();
    const parent = await fixture.service.get(parentId);
    await expect(
      fixture.service.fork(parentId, { commandId: newId(), expectedRevision: parent.revision }, { fromStage: "plan" }),
    ).rejects.toThrow("after the implementation");
    expect(existsSync(join(fixture.root, "value.txt"))).toBe(true);
  });

  test("the CLI lists the stages and forks from one", async () => {
    const { fixture, parentId } = await finishedRun();
    const signal = new AbortController().signal;
    const status = (await executeWorkflowCommand(
      fixture.service,
      parseWorkflowArgs(["status", parentId]),
      signal,
    )) as RunSnapshot & { forkStages: string[] };
    expect(status.forkStages).toContain("review");
    const fork = (await executeWorkflowCommand(
      fixture.service,
      parseWorkflowArgs([
        "fork",
        parentId,
        "--expected-revision",
        String(status.revision),
        "--from-stage",
        "review",
      ]),
      signal,
    )) as RunSnapshot;
    expect(fork.runId).not.toBe(parentId);
    expect(fixture.service.store.latestArtifact(fork.runId, FORK_SEED_ARTIFACT)).toBeTruthy();
  });
});

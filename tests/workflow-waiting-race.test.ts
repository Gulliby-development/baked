import { afterEach, describe, expect, test } from "bun:test";
import { approvalDigest } from "../src/core/workflows/approval.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Fixture = ReturnType<typeof workflowFixture>;
type AssertWorkspace = (...args: unknown[]) => Promise<void>;

/** Makes the end-of-step workspace check slow, or fail, so a decision can land in the gap. */
function hookAssertWorkspace(
  fixture: Fixture,
  hook: (stageId: string | null) => Promise<void>,
): void {
  const scheduler = fixture.service.scheduler as unknown as { assertWorkspace: AssertWorkspace };
  const original = scheduler.assertWorkspace.bind(fixture.service.scheduler);
  scheduler.assertWorkspace = async (...args) => {
    await original(...args);
    await hook(fixture.service.store.run(args[0] as string).stage_id);
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Plays a person who acts the moment a request is visible, while the run is still being driven.
 * Returns the outcome of each attempt.
 */
function watchRequests(
  fixture: Fixture,
  runId: string,
  act: (request: ReturnType<Fixture["service"]["store"]["requests"]>[number]) => Promise<unknown>,
): { stop: () => Promise<string[]> } {
  const outcomes: string[] = [];
  let running = true;
  const seen = new Set<string>();
  const loop = (async () => {
    while (running) {
      const request = fixture.service.store
        .requests(runId)
        .find((r) => r.status === "pending" && !seen.has(r.id));
      if (request) {
        seen.add(request.id);
        try {
          await act(request);
          outcomes.push(`${request.kind}:accepted`);
        } catch (error) {
          outcomes.push(
            `${request.kind}:${error instanceof WorkflowFault ? error.code : String(error)}`,
          );
        }
      }
      await delay(2);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return outcomes;
    },
  };
}

async function driveUntil(fixture: Fixture, runId: string, statuses: string[]) {
  for (let i = 0; i < 12; i++) {
    const run = await fixture.service.get(runId);
    if (statuses.includes(run.status)) return run;
    if (["paused", "created"].includes(run.status)) await fixture.resume(runId);
    await fixture.service.drive(runId, new AbortController().signal);
  }
  return fixture.service.get(runId);
}

/** Research that asks one blocking question the first time and none after it is answered. */
class AskingExecutor extends FixtureExecutor {
  asked = false;
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output !== "research" || this.asked) return result;
    this.asked = true;
    return {
      ...result,
      output: {
        ...(result.output as Record<string, unknown>),
        unknowns: [{ question: "Which value should the file hold?", blocking: true }],
      },
    };
  }
}

describe("a run that starts waiting", () => {
  test("an approval issued while the workspace check is slow is accepted", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    hookAssertWorkspace(fixture, () => delay(40));
    const { runId } = await fixture.start();
    const digests: boolean[] = [];
    const watcher = watchRequests(fixture, runId, async (request) => {
      // The state the approval digest covers is durable as soon as the request is visible.
      digests.push(approvalDigest(fixture.service.store.state(runId)) === request.digest);
      const run = await fixture.service.get(runId);
      return fixture.service.decide(
        runId,
        { commandId: newId(), expectedRevision: run.revision },
        { kind: "approve", requestId: request.id, digest: request.digest },
      );
    });
    await driveUntil(fixture, runId, ["waiting"]);
    // Let the person act on the request the drive just raised.
    await delay(30);
    expect(await watcher.stop()).toEqual(["approval:accepted"]);
    expect(digests).toEqual([true]);
    const approved = await fixture.service.get(runId);
    expect(approved.status).toBe("paused");
    expect(fixture.service.store.state(runId).approvalRoot).toBeTruthy();
  });

  test("when the run reaches waiting, the saved state matches the approval request", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const observed: { status: string; matches: boolean }[] = [];
    hookAssertWorkspace(fixture, async () => {
      // Anything visible in the gap must already be consistent.
      const pending = fixture.service.store
        .requests(runId)
        .find((r) => r.kind === "approval" && r.status === "pending");
      if (pending)
        observed.push({
          status: fixture.service.store.run(runId).status,
          matches: approvalDigest(fixture.service.store.state(runId)) === pending.digest,
        });
    });
    const { runId } = await fixture.start();
    const run = await driveUntil(fixture, runId, ["waiting"]);
    expect(run.status).toBe("waiting");
    expect(run.reason).toBe("approval");
    expect(observed).toEqual([]);
    const request = fixture.service.store
      .requests(runId)
      .find((r) => r.kind === "approval" && r.status === "pending");
    expect(request).toBeDefined();
    expect(approvalDigest(fixture.service.store.state(runId))).toBe(request?.digest ?? "");
    expect(fixture.service.store.state(runId).manifest.baselineSnapshotId).toBeTruthy();
    await fixture.approve(runId);
  });

  test("an answer given while the workspace check is slow is not overwritten", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const executor = new AskingExecutor(fixture.root);
    (fixture.service.scheduler as unknown as { executor: FixtureExecutor }).executor = executor;
    hookAssertWorkspace(fixture, () => delay(40));
    const { runId } = await fixture.start();
    const answer = "The file holds the word ready";
    const watcher = watchRequests(fixture, runId, async (request) => {
      const run = await fixture.service.get(runId);
      return fixture.service.decide(
        runId,
        { commandId: newId(), expectedRevision: run.revision },
        { kind: "answer", requestId: request.id, answers: { "0": answer } },
      );
    });
    const first = await driveUntil(fixture, runId, ["waiting"]);
    expect(first.reason).toBe("clarification");
    await delay(30);
    expect(await watcher.stop()).toEqual(["clarification:accepted"]);
    expect(executor.asked).toBe(true);
    const state = fixture.service.store.state(runId);
    expect(state.prompt).toContain(answer);
    expect(state.stageIndex).toBe(1);
    expect((await fixture.service.get(runId)).status).toBe("paused");
  });

  test("a workspace change found at the end of the approval step raises no request", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    let fail = true;
    hookAssertWorkspace(fixture, async (stageId) => {
      if (stageId === "approve" && fail) {
        fail = false;
        throw new WorkflowFault("INPUT_CHANGED", "Sources changed outside the active task");
      }
    });
    const { runId } = await fixture.start();
    const blocked = await driveUntil(fixture, runId, ["waiting", "blocked"]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toBe("input_changed");
    expect(fixture.service.store.requests(runId).filter((r) => r.kind === "approval")).toEqual([]);
    expect(fixture.service.store.state(runId).approvalRoot).toBeNull();
  });
});

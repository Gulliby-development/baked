import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { settleInterruptedEdits } from "../src/core/workflows/recovery.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import {
  DEFAULT_STALL_SETTINGS,
  providerResumeWaitMs,
  stalledFault,
  stallSettings,
  ToolDeadlineError,
  toolDeadlineMs,
  withDeadline,
} from "../src/core/workflows/stall.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Script = (request: ExecutionRequest, calls: number) => Promise<void> | void;

/** A fixture whose implementer runs `script` first; the rest of the flow is the fixture's. */
function stallFixture(script: Script, stall?: Record<string, number>) {
  let calls = 0;
  const fixture = workflowFixture({
    executor: (root) =>
      new (class extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output === "implementation") await script(request, calls++);
          return super.execute(request);
        }
      })(root),
  });
  if (stall) (fixture.config.workflows as { stall?: Record<string, number> }).stall = stall;
  cleanups.push(() => fixture.dispose());
  return fixture;
}

type Fixture = ReturnType<typeof stallFixture>;

const signal = () => new AbortController().signal;

async function completed(fixture: Fixture) {
  const run = await fixture.start();
  await fixture.service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  return { runId: run.runId, snapshot: await fixture.service.drive(run.runId, signal()) };
}

/** The tool guard an implementer attempt gets, with a short deadline for file tools. */
function guardOf(fixture: Fixture, request: ExecutionRequest, toolTimeoutMs: number) {
  const policy = JSON.parse(fixture.service.store.run(request.runId).policy_json) as RunPolicy;
  return new WorkflowToolPolicy(
    fixture.service.store,
    fixture.service.leases,
    request.runId,
    request.attemptId,
    request.profile,
    policy,
    request.task,
    fixture.root,
    { ...DEFAULT_STALL_SETTINGS, toolTimeoutMs },
  );
}

describe("tool deadlines", () => {
  test("withDeadline abandons a call that never settles", async () => {
    await expect(withDeadline("edit_file", 30, () => new Promise(() => {}))).rejects.toBeInstanceOf(
      ToolDeadlineError,
    );
    expect(await withDeadline("read", 1000, async () => 7)).toBe(7);
  });

  test("file tools get the short deadline and commands the long one", () => {
    const settings = stallSettings({ workflows: { stall: { toolTimeoutMs: 5000 } } });
    expect(toolDeadlineMs(settings, "edit_file")).toBe(5000);
    expect(toolDeadlineMs(settings, "multi_edit")).toBe(5000);
    expect(toolDeadlineMs(settings, "shell")).toBe(DEFAULT_STALL_SETTINGS.commandToolMs);
    // A review step took 569 s: the default step limit must not cut legitimate long steps.
    expect(DEFAULT_STALL_SETTINGS.stepStallMs).toBeGreaterThan(569_000 * 2);
  });

  test("an edit whose follow-up work hangs is recorded as applied and journaled with its deadline", async () => {
    const fixture = stallFixture(async (request) => {
      const result = await guardOf(fixture, request, 100).execute(
        "edit_file",
        { path: "value.txt" },
        async () => {
          writeFileSync(join(fixture.root, "value.txt"), "ready");
          // The formatter child that never closes its pipe.
          await new Promise(() => {});
        },
      );
      expect(result).toMatchObject({ success: true });
    });
    const { runId, snapshot } = await completed(fixture);
    expect(snapshot.status).toBe("completed");
    const events = fixture.service.store.events(runId, 0, 5000);
    const finished = events.filter((e) => e.type === "tool.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({ tool: "edit_file", status: "deadline" });
    expect(events.filter((e) => e.type === "tool.started")).toHaveLength(1);
    const effect = fixture.service.store.effects(runId).find((e) => e.kind === "file_patch");
    expect(effect?.status).toBe("applied");
    expect(effect?.after_hash).not.toBeNull();
  });

  test("a call that wrote nothing before its deadline fails the effect and reports the deadline", async () => {
    let thrown: unknown;
    const fixture = stallFixture(async (request) => {
      thrown = await guardOf(fixture, request, 100)
        .execute("edit_file", { path: "value.txt" }, () => new Promise(() => {}))
        .catch((error: unknown) => error);
    });
    const { runId } = await completed(fixture);
    expect(thrown).toBeInstanceOf(ToolDeadlineError);
    const effect = fixture.service.store.effects(runId).find((e) => e.kind === "file_patch");
    expect(effect?.status).toBe("failed");
  });
});

describe("a provider outage", () => {
  const outage = () =>
    new WorkflowFault("OUTPUT_INVALID", "fetch failed: socket hang up", {
      reason: "provider_unavailable",
    });

  test("waits 1, 3 and 9 minutes by default", () => {
    const settings = stallSettings({});
    expect([1, 2, 3].map((n) => providerResumeWaitMs(settings, n))).toEqual([
      60_000, 180_000, 540_000,
    ]);
  });

  test("blocks the run with provider_unavailable and the service resumes it by itself", async () => {
    const fixture = stallFixture(
      (_, calls) => {
        if (calls === 0) throw outage();
      },
      { providerWaitMs: 0 },
    );
    const { runId, snapshot } = await completed(fixture);
    expect(snapshot.status).toBe("completed");
    expect(fixture.service.store.state(runId).providerResumes).toBe(1);
    const resume = fixture.service.store.latestArtifact(runId, "provider/resume-1.json");
    expect(JSON.parse(fixture.service.store.readArtifact(runId, resume?.id ?? ""))).toMatchObject({
      attempt: 1,
      of: 3,
      waitMs: 0,
    });
  });

  test("stays blocked once the automatic resumes are spent", async () => {
    const fixture = stallFixture(
      () => {
        throw outage();
      },
      { providerWaitMs: 0, providerResumes: 2 },
    );
    const { runId, snapshot } = await completed(fixture);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.reason).toBe("provider_unavailable");
    expect(snapshot.autoRetry).toBeUndefined();
    expect(fixture.service.store.state(runId).providerResumes).toBe(2);
  });

  test("shows the pending retry in the snapshot and stops waiting when the drive is aborted", async () => {
    const fixture = stallFixture(
      () => {
        throw outage();
      },
      { providerWaitMs: 600_000 },
    );
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    const controller = new AbortController();
    const driving = fixture.service.drive(run.runId, controller.signal);
    let snapshot = await fixture.service.get(run.runId);
    for (let i = 0; i < 200 && !snapshot.autoRetry; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = await fixture.service.get(run.runId);
    }
    expect(snapshot.reason).toBe("provider_unavailable");
    expect(snapshot.autoRetry).toMatchObject({ attempt: 1, of: 3 });
    expect(Date.parse(snapshot.autoRetry?.at ?? "")).toBeGreaterThan(Date.now() + 500_000);
    controller.abort();
    const stopped = await driving;
    expect(stopped.status).toBe("blocked");
  });

  test("does not resume when providerResumes is 0", async () => {
    const fixture = stallFixture(
      () => {
        throw outage();
      },
      { providerResumes: 0 },
    );
    const { runId, snapshot } = await completed(fixture);
    expect(snapshot.reason).toBe("provider_unavailable");
    expect(fixture.service.store.state(runId).providerResumes).toBe(0);
  });
});

describe("a stalled attempt", () => {
  test("blocks the run with step_stalled and the service resumes it by itself", async () => {
    const fixture = stallFixture((_, calls) => {
      if (calls === 0)
        throw stalledFault("Attempt made no progress for 20 min (last tool: edit_file)");
    });
    const { runId, snapshot } = await completed(fixture);
    expect(snapshot.status).toBe("completed");
    expect(fixture.service.store.state(runId).stallResumes).toBe(1);
    expect(
      fixture.service.store
        .artifacts(runId)
        .some((a) => a.logical_path === "stalled/resume-1.json"),
    ).toBe(true);
  });

  test("stays blocked once the automatic resumes are spent", async () => {
    const fixture = stallFixture(
      () => {
        throw stalledFault("Attempt made no progress");
      },
      { autoResumes: 1 },
    );
    const { runId, snapshot } = await completed(fixture);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.reason).toBe("step_stalled");
    expect(fixture.service.store.state(runId).stallResumes).toBe(1);
  });

  test("does not resume when autoResumes is 0", async () => {
    const fixture = stallFixture(
      () => {
        throw stalledFault("Attempt made no progress");
      },
      { autoResumes: 0 },
    );
    const { runId, snapshot } = await completed(fixture);
    expect(snapshot.reason).toBe("step_stalled");
    expect(fixture.service.store.state(runId).stallResumes).toBe(0);
  });

  test("settleInterruptedEdits decides prepared edits from the file hashes", async () => {
    const fixture = stallFixture(async (request) => {
      // An edit that wrote its file and never returned.
      let release: () => void = () => {};
      // The call is settled before the fixture goes, so no deadline timer outlives the test.
      cleanups.push(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      void guardOf(fixture, request, 60_000).execute("edit_file", { path: "value.txt" }, async () => {
        writeFileSync(join(fixture.root, "value.txt"), "ready");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const store = fixture.service.store;
      const own = () => store.effects(request.runId).filter((e) => e.attempt_id === request.attemptId);
      expect(own().map((e) => e.status)).toEqual(["prepared"]);
      const settled = store.transaction(() =>
        settleInterruptedEdits(store, request.runId, request.attemptId),
      );
      expect(settled).toHaveLength(1);
      expect(own()[0]?.status).toBe("applied");
      expect(
        store.transaction(() => settleInterruptedEdits(store, request.runId, request.attemptId)),
      ).toEqual([]);
    });
    const { snapshot } = await completed(fixture);
    expect(snapshot.status).toBe("completed");
  });
});

describe("progress-based lease", () => {
  test("a stalled owner stops renewing and another owner takes the lease over once it expired", async () => {
    const fixture = stallFixture(() => {});
    const store = fixture.service.store;
    const { runId } = await fixture.start();
    const stalled = new WorkspaceLeases(store);
    // No progress for longer than the window: the owner marks itself stalled and stops renewing.
    stalled.progressWindowMs = -1;
    stalled.acquire("mutation", runId);
    cleanups.push(() => stalled.release());
    (stalled as unknown as { heartbeat(): void }).heartbeat();
    const row = store.lease("mutation");
    expect(row?.process_identity_json).toContain("stalledSince");

    const other = new WorkspaceLeases(store);
    // Alive and not yet expired: still refused.
    expect(() => other.acquire("mutation", runId)).toThrow(WorkflowFault);
    // Expired beyond the grace: taken over, and the old owner is fenced out.
    if (row) store.putLease({ ...row, expires_at: Date.now() - 120_000 });
    other.acquire("mutation", runId);
    cleanups.push(() => other.release());
    expect(() => stalled.assert("mutation")).toThrow(WorkflowFault);
  });

  test("an owner that makes progress keeps renewing and is never taken over", async () => {
    const fixture = stallFixture(() => {});
    const store = fixture.service.store;
    const { runId } = await fixture.start();
    const healthy = new WorkspaceLeases(store);
    healthy.acquire("mutation", runId);
    cleanups.push(() => healthy.release());
    (healthy as unknown as { heartbeat(): void }).heartbeat();
    const row = store.lease("mutation");
    expect(row?.process_identity_json).not.toContain("stalledSince");
    if (row) store.putLease({ ...row, expires_at: Date.now() - 120_000 });
    expect(() => new WorkspaceLeases(store).acquire("mutation", runId)).toThrow(
      WorkflowFault,
    );
  });
});

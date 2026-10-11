import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { runs } = await import("../src/renderer/client/runs.ts");
const { effectSummary, RESOLUTIONS } = await import("../src/renderer/screens/runs/Decision.tsx");
delete scope.window;

describe("recovering an interrupted effect", () => {
  test("records the outcome and leaves the run ready to resume", async () => {
    const run = await runs.status("baked", "run-cache-warmup");
    expect(run.status).toBe("waiting");
    const request = run.requests.find((r) => r.kind === "recovery");
    expect(request).toBeDefined();
    const after = await runs.recover("baked", run, {
      requestId: request?.id ?? "",
      effectId: "eff-cache-migrate",
      resolution: "record-not-applied",
      evidence: "The migration table has no new row.",
    });
    expect(after.status).toBe("paused");
    expect(after.pendingRequestIds).toEqual([]);
  });

  test("offers the four outcomes of `baked workflow recover`", () => {
    expect(RESOLUTIONS.map((r) => r.value)).toEqual([
      "record-applied",
      "record-not-applied",
      "retry",
      "cancel",
    ]);
  });

  test("summarizes what the effect meant to do in one bounded line", () => {
    expect(effectSummary({ effectId: "e" })).toBe("");
    expect(effectSummary({ intent: { command: "bun run db:migrate" } })).toBe(
      '{"command":"bun run db:migrate"}',
    );
    expect(effectSummary({ intent: { text: "x".repeat(1000) } })).toHaveLength(400);
  });
});

describe("forking a run", () => {
  test("returns a new run that waits to start", async () => {
    const parent = await runs.status("baked", "run-export-csv");
    const fork = await runs.fork("baked", parent);
    expect(fork.runId).not.toBe(parent.runId);
    expect(fork.status).toBe("created");
    expect((await runs.status("baked", parent.runId)).status).toBe("failed");
  });

  test("is refused while the run executes", async () => {
    const run = await runs.status("baked", "run-headless-json");
    await expect(runs.fork("baked", run)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("discarding a worktree", () => {
  test("is refused before the run ends", async () => {
    const run = await runs.status("baked", "run-cache-warmup");
    expect(run.worktree?.present).toBe(true);
    await expect(runs.discardWorktree("baked", run)).rejects.toBeInstanceOf(ApiError);
  });

  test("removes the worktree of an ended run once", async () => {
    const run = await runs.status("baked", "run-export-csv");
    expect(run.worktree).toMatchObject({ branch: "baked/wf/run-export-csv", present: true });
    await runs.discardWorktree("baked", run);
    const after = await runs.status("baked", run.runId);
    expect(after.worktree?.present).toBe(false);
    await expect(runs.discardWorktree("baked", after)).rejects.toBeInstanceOf(ApiError);
  });
});

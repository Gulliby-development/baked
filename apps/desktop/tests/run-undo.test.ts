import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { runs, undoRun } = await import("../src/renderer/client/runs.ts");
const { restoreLabel, undoSummary } = await import("../src/renderer/screens/runs/UndoReport.tsx");
delete scope.window;

describe("undoRun", () => {
  test("returns the rollback report the undo wrote, then null when nothing is left", async () => {
    const run = await runs.status("baked", "run-settings-dark-mode");
    const report = await undoRun("baked", run);
    expect(report?.restored.map((r) => r.path)).toContain("src/core/workflows/usage.ts");
    expect(report?.kept).toHaveLength(1);
    expect(await undoRun("baked", await runs.status("baked", run.runId))).toBeNull();
  });

  test("is refused while the run executes", async () => {
    const run = await runs.status("baked", "run-headless-json");
    expect(run.status).toBe("running");
    await expect(undoRun("baked", run)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("undo report text", () => {
  test("labels each restore by what it did to the file", () => {
    expect(restoreLabel({ path: "a", from: "h1", to: null, keptAs: null })).toBe("removed");
    expect(restoreLabel({ path: "a", from: null, to: "h2", keptAs: null })).toBe("recreated");
    expect(restoreLabel({ path: "a", from: "h1", to: "h2", keptAs: null })).toBe("restored");
  });

  test("counts restored and kept files", () => {
    const restored = [{ path: "a", from: "h1", to: "h2", keptAs: null }];
    expect(undoSummary({ reason: "undo", restored, kept: [] })).toBe("1 file restored");
    expect(undoSummary({ reason: "undo", restored: [], kept: [{ path: "b", reason: "changed" }] })).toBe(
      "0 files restored, 1 left in place",
    );
  });
});

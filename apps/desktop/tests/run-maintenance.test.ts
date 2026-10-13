import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { runMaintenance, runs, runWorktrees } = await import("../src/renderer/client/runs.ts");
const { defaultCutoff, redactable } = await import("../src/renderer/screens/runs/Maintenance.tsx");
const { worktreeLine } = await import("../src/renderer/screens/runs/Worktrees.tsx");
delete scope.window;

const RUN = "run-settings-dark-mode";

describe("run maintenance client", () => {
  test("exports a run into a new folder under .baked/exports", async () => {
    const result = await runMaintenance.exportRun("baked", RUN);
    expect(result.path).toContain(`.baked\\exports\\${RUN}-`);
  });

  test("redacts an artifact once and refuses an empty reason", async () => {
    const before = redactable(await runs.artifacts("baked", RUN));
    const target = before[0];
    if (!target) throw new Error("No artifact to redact");
    await expect(runMaintenance.redact("baked", RUN, target.id, " ")).rejects.toBeInstanceOf(ApiError);
    expect(await runMaintenance.redact("baked", RUN, target.id, "Remove a pasted key")).toEqual({
      redacted: true,
    });
    const after = redactable(await runs.artifacts("baked", RUN));
    expect(after.map((a) => a.id)).not.toContain(target.id);
    expect(after).toHaveLength(before.length - 1);
  });

  test("cleanup keeps recent runs and checks the date", async () => {
    expect(await runMaintenance.gc("baked", new Date().toISOString(), true)).toEqual({
      runIds: [],
      bytes: 0,
    });
    await expect(runMaintenance.gc("baked", "soon", true)).rejects.toBeInstanceOf(ApiError);
  });

  test("imports a folder as a candidate with the importer's warnings", async () => {
    const result = await runMaintenance.importCandidate("baked", {
      source: "spec-kit",
      path: "specs/feature",
      featureId: "imported",
    });
    expect(result.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.warnings[0]).toContain("draft");
  });
});

describe("run worktrees client", () => {
  test("lists worktrees by size and cleans only those of ended runs", async () => {
    const before = await runWorktrees.list("baked");
    expect(before.worktrees.length).toBeGreaterThan(0);
    const sizes = before.worktrees.map((w) => w.bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    const ended = before.worktrees.filter((w) => w.cleanable).map((w) => w.runId);
    const cleaned = await runWorktrees.clean("baked");
    expect(cleaned.removed.sort()).toEqual(ended.sort());
    expect(cleaned.removedBytes).toBe(before.cleanableBytes);
    expect(cleaned.worktrees.every((w) => !w.cleanable)).toBe(true);
    expect(cleaned.cleanableBytes).toBe(0);
  });

  test("a row names the owning run, its task worktrees and why it is kept", () => {
    const row = {
      runId: "r1",
      featureId: "dark-mode",
      status: "running" as const,
      branch: "baked/wf/r1",
      directories: [
        { path: ".baked/worktrees/r1/main", task: null, bytes: 10 },
        { path: ".baked/worktrees/r1/T2", task: "T2", bytes: 5 },
      ],
      bytes: 15,
      cleanable: false,
      kept: "run is running",
    };
    expect(worktreeLine(row)).toBe("dark-mode · running · 1 task worktree · kept: run is running");
    expect(worktreeLine({ ...row, featureId: null, status: null, kept: null })).toBe(
      "run removed by cleanup · 1 task worktree",
    );
  });
});

describe("maintenance helpers", () => {
  const entry = (id: string, kind: string, path = `${id}.json`) => ({
    id,
    kind,
    path,
    revision: 1,
    hash: "h",
    bytes: 10,
  });

  test("redaction targets content that is not state or already redacted", () => {
    const list = [
      entry("spec-1", "spec"),
      entry("state-1", "state"),
      entry("plan-1", "plan"),
      entry("red-1", "redaction", "redactions/plan-1.json"),
    ];
    expect(redactable(list).map((a) => a.id)).toEqual(["spec-1"]);
  });

  test("the cleanup cutoff defaults to 90 days ago", () => {
    expect(defaultCutoff(Date.parse("2026-10-12T12:00:00Z"))).toBe("2026-07-14");
  });
});

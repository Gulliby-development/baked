import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { runMaintenance, runs } = await import("../src/renderer/client/runs.ts");
const { defaultCutoff, redactable } = await import("../src/renderer/screens/runs/Maintenance.tsx");
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

import { describe, expect, test } from "bun:test";
import { runActions } from "../src/components/workflow/format.js";
import { initiativeActions } from "../src/core/workflows/initiatives/view-model.js";
import { canRepairRun, repairText, type RepairBlock } from "../src/core/workflows/repairable.js";
import type { RunSnapshot } from "../src/core/workflows/schemas.js";
import { featureView, initiativeView } from "./helpers/initiative-views.js";

const block: RepairBlock = { limit: "maxTaskRepairs", scope: "task", required: 1, taskIds: ["T001"] };
const run: RunSnapshot = {
  runId: "run", featureId: "fixture", status: "blocked", reason: "no_progress", revision: 7, eventSeq: 12,
  stageId: "implement", approvalDigest: "approved", inputHash: "hash", workspaceHash: "workspace", tokenUsage: 2400000,
  activeMs: 1000, estimatedCostUsd: null, verificationState: "stale", limitations: { count: 0, ids: [] }, reviewNotes: { count: 0, ids: [] }, pendingRequestIds: [], repairBlock: block,
};

describe("repair controls use the shared core predicate", () => {
  test("TUI run and initiative controls use O and the run revision", () => {
    expect(runActions(run).find((a) => a.key === "O")?.action).toBe("repair");
    expect(runActions(run).some((a) => a.action === "resume")).toBe(false);
    const feature = featureView("core", { state: "blocked", runId: run.runId, runStatus: run.status, repairRun: run });
    const action = initiativeActions(initiativeView({ features: [feature] }), false, feature).find((a) => a.key === "O");
    expect(action?.action).toEqual({ kind: "repair", runId: run.runId, expectedRevision: 7 });
    expect(action?.confirm).toContain("2400000 tokens spent");
  });
  test("baseline and out-of-scope failures have no eligible repair block", () => {
    for (const diagnostic of ["baseline_failure", "out_of_scope_failure"]) {
      const stopped = { ...run, repairBlock: undefined, stopDetail: diagnostic };
      expect(canRepairRun(stopped)).toBe(false);
      expect(runActions(stopped).some((a) => a.action === "repair")).toBe(false);
    }
  });
  test("a stale or pending run never offers a grant", () => {
    for (const status of ["running", "paused", "completed", "waiting"]) expect(canRepairRun({ ...run, status })).toBe(false);
    expect(canRepairRun({ ...run, pendingRequestIds: ["approval"] })).toBe(false);
    expect(canRepairRun({ ...run, reason: "input_changed" })).toBe(false);
    expect(repairText({ ...block, limit: "freshRestart" })).toContain("may repeat");
  });
});

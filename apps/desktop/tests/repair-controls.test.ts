import { expect, test } from "bun:test";
import { canRepairRun, repairText, type RepairBlock } from "../../../src/core/workflows/repairable.js";

test("desktop run and initiative buttons share eligibility and show the refused limit", () => {
  const repairBlock: RepairBlock = { limit: "maxRepairRounds", scope: "review", required: 1, taskIds: [] };
  const run = { status: "blocked", reason: "no_progress", repairBlock };
  expect(canRepairRun(run)).toBe(true);
  expect(repairText(repairBlock)).toContain("maxRepairRounds (review)");
  expect(canRepairRun({ ...run, status: "completed" })).toBe(false);
  expect(canRepairRun({ ...run, repairBlock: undefined })).toBe(false);
});

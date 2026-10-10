import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { runActions } from "../src/components/workflow/format.js";
import { UndoReport } from "../src/components/workflow/UndoReport.js";
import type { RollbackReport } from "../src/core/workflows/rollback.js";
import type { RunSnapshot } from "../src/core/workflows/schemas.js";

async function frame(report: RollbackReport | null): Promise<string> {
  let view!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    view = await testRender(<UndoReport report={report} />, { width: 110, height: 12 });
  });
  try {
    for (let i = 0; i < 2; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
    return view.captureCharFrame();
  } finally {
    act(() => view.renderer.destroy());
  }
}

test("undo report lists restored files and files left in place", async () => {
  const text = await frame({
    reason: "undo",
    effectIds: ["e1", "e2", "e3", "e4"],
    restored: [
      { path: "src/app.ts", from: "h2", to: "h1", keptAs: "art-1" },
      { path: "src/new.ts", from: "h3", to: null, keptAs: "art-2" },
      { path: "src/gone.ts", from: null, to: "h4", keptAs: null },
    ],
    kept: [{ path: "README.md", reason: "changed outside the run after its last edit; left as is" }],
  });
  expect(text).toContain("Undo: 3 files restored, 1 left in place");
  expect(text).toContain("✓ src/app.ts · restored · run's version kept as art-1");
  expect(text).toContain("✓ src/new.ts · removed");
  expect(text).toContain("✓ src/gone.ts · recreated");
  expect(text).toContain("! README.md · changed outside the run after its last edit; left as is");
  expect(text).toContain("Esc hides this report.");
});

test("undo with nothing to restore says so", async () => {
  expect(await frame(null)).toContain("Nothing to undo: the run has no uncommitted task edits.");
});

test("the run screen offers undo only while nothing executes the run", () => {
  const snapshot = (status: RunSnapshot["status"]) =>
    ({ status, reason: "none", pendingRequestIds: [] }) as unknown as RunSnapshot;
  const offers = (status: RunSnapshot["status"]) =>
    runActions(snapshot(status)).some((a) => a.action === "undo" && a.key === "U");
  expect(offers("running")).toBe(false);
  expect(offers("created")).toBe(false);
  for (const status of ["paused", "blocked", "completed", "failed", "cancelled"] as const)
    expect(offers(status)).toBe(true);
});

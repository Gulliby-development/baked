import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { queuedText, type RunQueued } from "../src/renderer/client/runs.ts";
import { QueuedNote } from "../src/renderer/screens/runs/RunScreen.tsx";

// #2421: a run resumed at the workspace's parallel-run cap stays paused; the run header says it
// waits for a free slot and what starts it.
const queued = (over: Partial<RunQueued> = {}): RunQueued => ({
  reason: "parallel_cap",
  message: "The resume is recorded; the run is paused and continues when a slot is free",
  maxParallelRuns: 2,
  executing: ["run-a", "run-b"],
  initiativeId: null,
  ...over,
});

describe("a run waiting for a free slot", () => {
  test("names the executing runs and the cap, and the Resume button as the way on", () => {
    expect(queuedText(queued())).toEqual({
      title: "Waiting for a free slot: 2 runs execute (maxParallelRuns 2).",
      next: "Resume this run once one of them stops.",
    });
  });

  test("a feature run of an initiative is started by the initiative's drive", () => {
    const text = queuedText(queued({ executing: ["run-a"], maxParallelRuns: 1, initiativeId: "billing" }));
    expect(text.title).toBe("Waiting for a free slot: 1 run executes (maxParallelRuns 1).");
    expect(text.next).toContain("Initiative billing starts this run");
  });

  test("the header note renders as a status with the run ids", () => {
    const html = renderToStaticMarkup(createElement(QueuedNote, { queued: queued() }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Waiting for a free slot");
    expect(html).toContain("run-a, run-b");
  });
});

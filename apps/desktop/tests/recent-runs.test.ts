import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../src/shared/api.ts";
import { recentRunsVersion, runDot, runWait } from "../src/renderer/screens/runs/recent.ts";

function item(runId: string, kind: string, projectKey = "p"): AttentionItem {
  return {
    runId,
    featureId: "f",
    status: "waiting",
    requestId: "q",
    kind,
    blocking: true,
    createdAt: 0,
    projectKey,
    projectName: "P",
  };
}

describe("recent runs in the sidebar", () => {
  test("a run waiting for a person gets a badge named by what it waits for", () => {
    const attention = [item("a", "approval"), item("b", "manual_evidence"), item("c", "approval", "other")];
    expect(runWait("p", { runId: "a", status: "waiting" }, attention)).toBe("approve");
    expect(runWait("p", { runId: "b", status: "waiting" }, attention)).toBe("accept");
    expect(runWait("p", { runId: "c", status: "waiting" }, attention)).toBe("you");
    expect(runWait("p", { runId: "c", status: "running" }, attention)).toBeNull();
    expect(runWait("p", { runId: "d", status: "completed" }, [item("d", "something-new")])).toBe("you");
  });

  test("status dots use the sidebar tones", () => {
    expect(runDot("running")).toBe("busy");
    expect(runDot("failed")).toBe("err");
    expect(runDot("completed")).toBe("ok");
    expect(runDot("cancelled")).toBe("");
  });

  test("the list reloads when a run starts, ends or starts waiting", () => {
    const before = recentRunsVersion("p", 1, []);
    expect(recentRunsVersion("p", 2, [])).not.toBe(before);
    expect(recentRunsVersion("p", 1, [item("a", "approval")])).not.toBe(before);
    expect(recentRunsVersion("p", 1, [item("a", "approval", "other")])).toBe(before);
  });
});

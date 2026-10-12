import { describe, expect, test } from "bun:test";
import type { RunPolicy } from "../src/renderer/client/start.ts";
import {
  doctorLine,
  featureSlug,
  fitOf,
  isFeatureId,
  orderChecks,
  preRunQuery,
  presetText,
  presetTokens,
  quickBlocker,
  rangeText,
  uniqueFeatureId,
  usdRange,
} from "../src/renderer/screens/start/logic.ts";

const base: RunPolicy = {
  maxTotalTokens: 800_000,
  maxAgentCalls: 200,
  maxActiveMs: 7_200_000,
  checkpointTokens: null,
};

describe("budget presets", () => {
  test("display limits and text", () => {
    expect(presetTokens(800_000, "quick")).toEqual({ cap: 400_000, checkpoint: null });
    expect(presetTokens(800_000, "checkpoints")).toEqual({ cap: null, checkpoint: 400_000 });
    expect(presetText("extended", base)).toBe("1.60M tokens, double the standard limits");
    expect(presetText("checkpoints", base)).toBe(
      "no token cap, pauses every 400k for your go-ahead",
    );
  });
});

describe("quick task", () => {
  test("says why it cannot start", () => {
    const ok = { prompt: "Fix the header", feature: "fix-the-header", hasWorkflow: true };
    expect(quickBlocker(ok)).toBeNull();
    expect(quickBlocker({ ...ok, prompt: "  " })).toBe("Describe the change first.");
    expect(quickBlocker({ ...ok, feature: "-bad" })).toMatch(/^Fix the feature ID/);
    expect(quickBlocker({ ...ok, hasWorkflow: false })).toBe("This project has no quick workflow.");
    expect(quickBlocker({ ...ok, hasWorkflow: null })).toBeNull();
  });
});

describe("estimate", () => {
  test("fit follows the core rule", () => {
    expect(fitOf({ low: 100, high: 200 }, 200)).toBe("yes");
    expect(fitOf({ low: 100, high: 300 }, 200)).toBe("maybe");
    expect(fitOf({ low: 300, high: 400 }, 200)).toBe("no");
    expect(fitOf({ low: 300, high: 400 }, null)).toBe("yes");
  });

  test("ranges", () => {
    expect(rangeText({ low: 90_000, high: 170_000 })).toBe("90k–170k");
    expect(rangeText({ low: 0, high: 0 })).toBe("0");
    expect(usdRange({ low: 0.234, high: 0.44 })).toBe("$0.23–0.44");
    expect(usdRange(null)).toBe("–");
  });

  test("pre-run query leaves defaults out", () => {
    expect(preRunQuery({})).toBe("");
    expect(preRunQuery({ workflow: "sdd", worktree: false, writers: 1 })).toBe("?workflow=sdd");
    expect(preRunQuery({ workflow: "sdd", model: "a/b", worktree: true, writers: 3 })).toBe(
      "?workflow=sdd&model=a%2Fb&worktree=true&writers=3",
    );
  });
});

describe("feature ids", () => {
  test("slug of free text", () => {
    expect(featureSlug("Fix the off-by-one in the usage table header")).toBe(
      "fix-the-off-by-one",
    );
    expect(featureSlug("привет world")).toBe("privet-world");
    expect(featureSlug("  !! ")).toBe("");
  });

  test("unique against existing runs", () => {
    const taken = new Set(["add-json", "add-json-2"]);
    expect(uniqueFeatureId("Add JSON", (id) => taken.has(id))).toBe("add-json-3");
    expect(uniqueFeatureId("", () => false)).toBe("");
  });

  test("validity", () => {
    expect(isFeatureId("usage-totals")).toBe(true);
    expect(isFeatureId("-bad")).toBe(false);
    expect(isFeatureId("")).toBe(false);
  });
});

describe("doctor", () => {
  const checks = [
    { id: "a", status: "ok" as const, title: "A" },
    { id: "b", status: "warn" as const, title: "B" },
    { id: "c", status: "fail" as const, title: "C" },
    { id: "d", status: "warn" as const, title: "D" },
  ];

  test("problems come first, in order", () => {
    expect(orderChecks(checks).map((c) => c.id)).toEqual(["c", "b", "d", "a"]);
  });

  test("summary line", () => {
    const report = { workflowId: "sdd", runModel: null, estimate: null };
    expect(doctorLine({ ...report, ready: false, checks })).toBe("Doctor: 1 problem, 2 warnings");
    expect(doctorLine({ ...report, ready: true, checks: checks.slice(0, 2) })).toBe(
      "Doctor: ready, 1 warning",
    );
  });
});

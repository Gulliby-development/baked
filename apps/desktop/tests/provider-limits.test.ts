import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { setup } = await import("../src/renderer/client/setup.ts");
const { freshness, headlineWindow, leftPercent, planLabel, providerTone, resetsIn, windowTone } =
  await import("../src/renderer/screens/setup/limits-model.ts");
delete scope.window;

const NOW = Date.parse("2026-10-27T12:00:00Z");

describe("subscription limits (#2300)", () => {
  test("the mock backend answers every provider with its windows", async () => {
    const { limits } = await setup.limits("baked");
    expect(limits.map((l) => l.provider)).toEqual(["codex", "claude-code", "copilot"]);
    const codex = limits[0];
    if (!codex) throw new Error("no codex");
    expect(headlineWindow(codex)?.label).toBe("Weekly");
    expect(providerTone(codex)).toBe("warn");
    const copilot = limits[2];
    if (!copilot) throw new Error("no copilot");
    expect(providerTone(copilot)).toBe("err");
  });

  test("what is left, its colour and the countdown", () => {
    const base = { id: "w", label: "W", resetsAt: null, windowMinutes: null };
    expect(leftPercent({ ...base, usedPercent: 38, status: "ok" })).toBe(62);
    expect(leftPercent({ ...base, usedPercent: 130, status: "limited" })).toBe(0);
    expect(leftPercent({ ...base, usedPercent: null, status: "ok" })).toBeNull();
    expect(leftPercent({ ...base, usedPercent: 0, status: "ok", unlimited: true })).toBe(100);
    expect(windowTone({ ...base, usedPercent: 85, status: "warning" })).toBe("warn");
    expect(windowTone({ ...base, usedPercent: null, status: "ok" })).toBe("plain");
    expect(resetsIn("2026-10-27T15:10:00Z", NOW)).toBe("3 h 10 min");
    expect(resetsIn("2026-10-30T13:00:00Z", NOW)).toBe("3 d 1 h");
    expect(resetsIn(null, NOW)).toBeNull();
  });

  test("freshness and plan names", () => {
    const p = {
      provider: "claude-code" as const,
      name: "Claude Code",
      state: "ok" as const,
      plan: null,
      windows: [],
      credits: null,
      message: "",
    };
    expect(freshness({ ...p, source: "live", observedAt: null }, NOW)).toBe("live");
    expect(freshness({ ...p, source: "last-seen", observedAt: "2026-10-27T11:18:00Z" }, NOW)).toBe(
      "seen 42 min ago",
    );
    expect(freshness({ ...p, source: null, observedAt: null }, NOW)).toBeNull();
    expect(planLabel("individual_pro")).toBe("Individual pro");
    expect(planLabel(null)).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ageWindows,
  LIMIT_READERS,
  loadLimits,
  parseClaudeRateLimit,
  parseCodexRateLimits,
  parseCopilotUser,
  recordClaudeRateLimit,
  recordCodexRateLimits,
  resetsIn,
  windowLabel,
} from "../src/core/llm/usage-limits.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-limits-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "usage-limits.json");
}

const NOW = new Date("2026-10-27T12:00:00Z");
const secs = (iso: string) => Date.parse(iso) / 1000;

describe("subscription usage limits (#2300)", () => {
  test("every provider with a subscription limit has a reader", () => {
    expect(LIMIT_READERS.map((r) => r.provider)).toEqual(["codex", "claude-code", "copilot"]);
  });

  test("Codex: the 5-hour and weekly windows, credits and other limits by id", () => {
    const limits = parseCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: secs("2026-10-27T14:00:00Z") },
          secondary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: secs("2026-10-30T00:00:00Z") },
          credits: { hasCredits: true, unlimited: false, balance: "12.50" },
          planType: "pro",
        },
        rateLimitsByLimitId: {
          codex: { limitId: "codex" },
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            limitName: "GPT-6 Luna",
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
            secondary: null,
          },
        },
      },
      NOW,
    );
    expect(limits).toMatchObject({ provider: "codex", state: "ok", source: "live", plan: "pro" });
    expect(limits?.credits).toEqual({ balance: "12.50", unlimited: false });
    expect(limits?.windows.map((w) => [w.label, w.usedPercent, w.status])).toEqual([
      ["5-hour", 38, "ok"],
      ["Weekly", 91, "warning"],
      ["GPT-6 Luna · 5-hour", 100, "limited"],
    ]);
    expect(limits?.windows[0]?.resetsAt).toBe("2026-10-27T14:00:00.000Z");
    expect(parseCodexRateLimits({})).toBeNull();
  });

  test("Codex: a rate-limit update during a turn is recorded as last seen", () => {
    const file = storeFile();
    recordCodexRateLimits({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } } }, file);
    expect(loadLimits("codex", file)).toMatchObject({ source: "last-seen", windows: [{ usedPercent: 5 }] });
  });

  test("Claude Code: unified windows from a rate_limit_event, merged with earlier ones", () => {
    const first = parseClaudeRateLimit(
      {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.42,
        resetsAt: secs("2026-10-27T15:00:00Z"),
        unifiedWindows: {
          five_hour: { utilization: 0.42, resetsAt: secs("2026-10-27T15:00:00Z") },
          seven_day: { utilization: 0.85, resetsAt: secs("2026-10-31T00:00:00Z"), status: "allowed_warning" },
        },
      },
      null,
      NOW,
    );
    expect(first?.windows.map((w) => [w.id, w.usedPercent, w.status])).toEqual([
      ["five_hour", 42, "ok"],
      ["seven_day", 85, "warning"],
    ]);
    // An older CLI names only the limiting window; the weekly one from before stays.
    const next = parseClaudeRateLimit(
      { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: secs("2026-10-27T15:00:00Z") },
      first,
      NOW,
    );
    expect(next?.windows.map((w) => [w.id, w.usedPercent, w.status])).toEqual([
      ["five_hour", 100, "limited"],
      ["seven_day", 85, "warning"],
    ]);
    expect(parseClaudeRateLimit({ status: "allowed" }, null)).toBeNull();
  });

  test("Claude Code: the rate_limit_info a 2.1 CLI sends on a subscription", () => {
    // Recorded from `claude -p --output-format stream-json --verbose` (Claude Code 2.1.311).
    const info = {
      status: "allowed",
      resetsAt: 1793120400,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.03, resetsAt: 1793120400, status: "allowed" },
        seven_day: { utilization: 0.01, resetsAt: 1793707200, status: "allowed" },
      },
    };
    const limits = parseClaudeRateLimit(info, null, NOW);
    expect(limits?.windows).toEqual([
      { id: "five_hour", label: "5-hour session", usedPercent: 3, resetsAt: "2026-10-27T17:00:00.000Z", windowMinutes: 300, status: "ok" },
      { id: "seven_day", label: "Weekly", usedPercent: 1, resetsAt: "2026-11-03T12:00:00.000Z", windowMinutes: 10080, status: "ok" },
    ]);
  });

  test("Claude Code: recorded events survive in the store", () => {
    const file = storeFile();
    recordClaudeRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 } } }, file);
    recordClaudeRateLimit({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: 2 } } }, file);
    expect(loadLimits("claude-code", file)?.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day"]);
  });

  test("Copilot: premium requests count down to the reset date; unlimited quotas stay full", () => {
    const limits = parseCopilotUser(
      {
        copilot_plan: "individual_pro",
        quota_reset_date: "2026-11-01",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            remaining: 45,
            percent_remaining: 15,
            unlimited: false,
            overage_permitted: true,
          },
          chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
        },
      },
      NOW,
    );
    expect(limits).toMatchObject({ provider: "copilot", state: "ok", plan: "individual_pro" });
    expect(limits?.windows[0]).toMatchObject({
      id: "premium_interactions",
      usedPercent: 85,
      remaining: 45,
      entitlement: 300,
      status: "warning",
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    expect(limits?.windows[1]).toMatchObject({ id: "chat", unlimited: true, status: "ok", resetsAt: null });
  });

  test("Copilot: the reader asks GitHub with the saved token and falls back to the last report", async () => {
    const file = storeFile();
    const reader = LIMIT_READERS.find((r) => r.provider === "copilot");
    process.env.COPILOT_API_KEY = "gho_test";
    cleanups.push(() => delete process.env.COPILOT_API_KEY);
    let auth = "";
    const ok = (async (_url: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 60, entitlement: 300, remaining: 180 } } });
    }) as typeof fetch;
    const live = await reader?.read({ file, now: NOW, fetch: ok });
    expect(auth).toBe("token gho_test");
    expect(live).toMatchObject({ source: "live", windows: [{ usedPercent: 40 }] });
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const seen = await reader?.read({ file, now: NOW, fetch: down });
    expect(seen).toMatchObject({ source: "last-seen", windows: [{ usedPercent: 40 }] });
    expect(seen?.message).toContain("503");
  });

  test("a window whose reset passed since the report shows no stale percentage", () => {
    const limits = parseCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: secs("2026-10-27T11:00:00Z") } } },
      NOW,
    );
    if (!limits) throw new Error("no limits");
    expect(ageWindows(limits, NOW).windows[0]).toMatchObject({ usedPercent: null, resetsAt: null, status: "ok" });
  });

  test("labels and countdowns", () => {
    expect(windowLabel(300, "x")).toBe("5-hour");
    expect(windowLabel(10_080, "x")).toBe("Weekly");
    expect(windowLabel(43_200, "x")).toBe("30-day");
    expect(windowLabel(null, "Short window")).toBe("Short window");
    expect(resetsIn("2026-10-27T12:30:00Z", NOW)).toBe("in 30 min");
    expect(resetsIn("2026-10-27T15:10:00Z", NOW)).toBe("in 3 h 10 min");
    expect(resetsIn("2026-10-29T14:00:00Z", NOW)).toBe("in 2 d 2 h");
    expect(resetsIn("2026-10-27T11:00:00Z", NOW)).toBe("now");
  });
});

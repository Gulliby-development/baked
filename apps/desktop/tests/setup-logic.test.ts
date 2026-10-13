import { describe, expect, test } from "bun:test";
import {
  CHECKS_CAPABILITY,
  LIBRARY_CAPABILITY,
  offers,
} from "../src/renderer/client/capabilities.ts";
import type {
  Check,
  CheckEntry,
  CheckRunResult,
  ConfigView,
} from "../src/renderer/client/setup.ts";
import {
  checkDraft,
  checkResultText,
  commandLabel,
  draftToCheck,
  frozenRunState,
  gateMark,
  joinCommand,
  plainCheck,
  splitCommand,
  splitList,
  upsertCheck,
  workflowsWithChecks,
  workingSetBudget,
} from "../src/renderer/screens/setup/logic.ts";

const lint: Check = {
  id: "lint",
  executable: "bun",
  args: ["run", "lint"],
  cwd: ".",
  timeoutMs: 120_000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
};

describe("workingSetBudget", () => {
  test("lists large files and files past the budget by name, in order", () => {
    const kb = 1024;
    const result = workingSetBudget(
      [
        { path: "a", bytes: 10 * kb },
        { path: "big", bytes: 20 * kb },
        { path: "b", bytes: 15 * kb },
        { path: "c", bytes: 15 * kb },
        { path: "d", bytes: 15 * kb },
        { path: "e", bytes: 12 * kb },
        { path: "f", bytes: 2 * kb },
      ],
      64 * kb,
      16 * kb,
    );
    expect(result.fit).toEqual([
      "included",
      "too-large",
      "included",
      "included",
      "included",
      "over-budget",
      "included",
    ]);
    expect(result.used).toBe(57 * kb);
    expect(result.total).toBe(89 * kb);
  });
});

describe("commands", () => {
  test("splits on spaces and honors quotes", () => {
    expect(splitCommand(' bun  run "type check" \'a b\' ""')).toEqual([
      "bun",
      "run",
      "type check",
      "a b",
      "",
    ]);
    expect(splitCommand("")).toEqual([]);
  });

  test("joins words back so they split the same way", () => {
    const line = joinCommand("bun", ["scripts/x.ts", "two words"]);
    expect(line).toBe('bun scripts/x.ts "two words"');
    expect(splitCommand(line)).toEqual(["bun", "scripts/x.ts", "two words"]);
  });

  test("splits lists on commas and spaces without duplicates", () => {
    expect(splitList("CI, HOME\nCI  PATH")).toEqual(["CI", "HOME", "PATH"]);
  });
});

describe("check drafts", () => {
  test("round-trip a check through the form", () => {
    expect(draftToCheck(checkDraft(lint))).toEqual({ check: lint });
    const custom = { ...lint, report: "json" as const };
    expect(checkDraft(custom).jsonReport).toBe(true);
    expect(draftToCheck(checkDraft(custom))).toEqual({ check: custom });
  });

  test("refuse unsafe or incomplete input", () => {
    const base = checkDraft(lint);
    expect(draftToCheck({ ...base, id: "-x" })).toHaveProperty("error");
    expect(draftToCheck({ ...base, command: "  " })).toHaveProperty("error");
    expect(draftToCheck({ ...base, cwd: "../other" })).toHaveProperty("error");
    expect(draftToCheck({ ...base, cwd: "C:\\abs" })).toHaveProperty("error");
    expect(draftToCheck({ ...base, timeoutSeconds: "0" })).toHaveProperty("error");
    expect(draftToCheck({ ...base, timeoutSeconds: "3601" })).toHaveProperty("error");
    expect(draftToCheck({ ...base, writes: "/tmp/out" })).toHaveProperty("error");
  });

  test("upsert replaces by the previous ID or appends", () => {
    const renamed = { ...lint, id: "lint-all" };
    expect(upsertCheck([lint], renamed, "lint")).toEqual([renamed]);
    expect(upsertCheck([lint], renamed, null)).toEqual([lint, renamed]);
  });
});

describe("workflowsWithChecks", () => {
  const view = (project: ConfigView["project"], effective: ConfigView["effective"]): ConfigView => ({
    global: {},
    project,
    effective,
    paths: { global: "g", project: "p" },
  });

  test("keeps the rest of the effective policy when the project file has none", () => {
    const config = view(
      { telemetry: true },
      { workflows: { enabled: true, policy: { network: "deny", checks: [] } } },
    );
    expect(workflowsWithChecks(config, [lint])).toEqual({
      policy: { network: "deny", checks: [lint] },
    });
  });

  test("keeps the project's own workflow settings", () => {
    const config = view(
      { workflows: { defaultWorkflow: "quick", policy: { network: "ask", checks: [] } } },
      { workflows: { policy: { network: "ask", checks: [] } } },
    );
    expect(workflowsWithChecks(config, [lint])).toEqual({
      defaultWorkflow: "quick",
      policy: { network: "ask", checks: [lint] },
    });
  });

  test("is undefined without a configured policy", () => {
    expect(workflowsWithChecks(view({}, {}), [lint])).toBeUndefined();
  });
});

describe("checks over the API", () => {
  const result: CheckRunResult = {
    checkId: "tests",
    at: 0,
    status: "failed",
    exitCode: 2,
    durationMs: 112_000,
    outputTail: "1 fail",
    truncated: true,
  };

  test("plainCheck drops lastResult and other extra fields before a PUT", () => {
    const entry: CheckEntry & { extra?: string } = { ...lint, lastResult: result, extra: "x" };
    expect(plainCheck(entry)).toEqual(lint);
  });

  test("result lines name the status, a failing exit code and the duration", () => {
    expect(checkResultText(result)).toBe("failed · exit 2 · 1m 52s");
    expect(checkResultText({ ...result, status: "passed", exitCode: 0, durationMs: 6000 })).toBe(
      "passed · 6s",
    );
    expect(checkResultText({ ...result, status: "timeout", exitCode: null })).toBe(
      "timed out · 1m 52s",
    );
    expect(checkResultText({ ...result, status: "error", exitCode: null, durationMs: 0 })).toBe(
      "could not start · 0s",
    );
  });

  test("gate marks: unconfirmed project gates first, then the check's last result", () => {
    const policy = { source: "policy" as const };
    expect(gateMark({ source: "project", confirmed: false }, result).label).toBe("not confirmed");
    expect(gateMark(policy, { status: "passed" })).toMatchObject({ text: "✓", tone: "ok" });
    expect(gateMark(policy, { status: "timeout" })).toMatchObject({
      tone: "err",
      label: "timed out",
    });
    expect(gateMark(policy, { status: "cancelled" }).tone).toBe("");
    expect(gateMark(policy, null).label).toBe("not run");
  });

  test("capabilities decide without probing; an unreadable health answer probes", () => {
    expect(offers(["workflow", "checks"], CHECKS_CAPABILITY)).toBe(true);
    expect(offers(["workflow"], LIBRARY_CAPABILITY)).toBe(false);
    expect(offers(null, CHECKS_CAPABILITY)).toBeNull();
  });

  test("command names keep one slash", () => {
    expect(commandLabel("/fix-ci")).toBe("/fix-ci");
    expect(commandLabel("fix-ci")).toBe("/fix-ci");
  });
});

describe("runs that froze a changed file", () => {
  test("a driving run stops at its next step; stopped runs need a revised plan", () => {
    expect(frozenRunState({ status: "running", reason: "none" })).toEqual({
      text: "running; stops at its next step as blocked (input changed)",
      canRevise: false,
    });
    expect(frozenRunState({ status: "blocked", reason: "input_changed" })).toEqual({
      text: "blocked: input changed; revise the plan to continue",
      canRevise: true,
    });
    expect(frozenRunState({ status: "waiting", reason: "approval" })).toEqual({
      text: "waiting (approval); resuming needs a revised plan",
      canRevise: true,
    });
    expect(frozenRunState({ status: "paused", reason: "none" }).text).toBe(
      "paused; resuming needs a revised plan",
    );
    expect(frozenRunState({ status: "completed" }).canRevise).toBe(false);
  });
});

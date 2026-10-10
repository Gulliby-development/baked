import { describe, expect, test } from "bun:test";
import type { Check, ConfigView } from "../src/renderer/client/setup.ts";
import {
  checkDraft,
  classRoute,
  classRows,
  draftToCheck,
  joinCommand,
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

describe("model classes", () => {
  test("lists built-in classes first and who references each", () => {
    const rows = classRows({
      classes: { deep: { model: "a/opus", effort: "high", fallback: ["b/gpt"] }, fast: "a/haiku" },
      roles: { planner: "$deep", researcher: "$fast", reviewer: "b/gpt" },
      workflows: { sdd: { stages: { plan: { model: "$deep" } } } },
    });
    expect(rows.map((r) => r.name)).toEqual(["active", "fast", "coding", "review", "deep"]);
    expect(rows.find((r) => r.name === "deep")).toEqual({
      name: "deep",
      model: "a/opus",
      effort: "high",
      fallback: ["b/gpt"],
      usedBy: ["planner", "sdd plan"],
      builtin: false,
    });
    expect(rows.find((r) => r.name === "active")?.model).toBeNull();
  });

  test("stores a bare model when nothing else is set", () => {
    expect(classRoute("a/m", "default", [])).toBe("a/m");
    expect(classRoute("a/m", "low", [])).toEqual({ model: "a/m", effort: "low" });
    expect(classRoute("a/m", "default", ["b/n"])).toEqual({ model: "a/m", fallback: ["b/n"] });
  });
});

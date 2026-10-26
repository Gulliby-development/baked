import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  drops,
  graduationCandidates,
  loadRegression,
  loadTasks,
  passHatK,
  pickPerLanguage,
  renderTable,
  type SuiteTask,
  summarize,
  type TaskSummary,
  type TrialResult,
  validateTask,
} from "../bench/suite/lib.ts";

const tasks = loadTasks();

describe("bench suite tasks", () => {
  test("every task is well-formed", () => {
    for (const task of tasks) {
      const raw = JSON.parse(readFileSync(join(task.dir, "task.json"), "utf8"));
      expect({ id: task.id, problems: validateTask(task.dir, raw) }).toEqual({
        id: task.id,
        problems: [],
      });
    }
  });

  test("every supported language has at least two tasks", () => {
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.language, (counts.get(t.language) ?? 0) + 1);
    for (const lang of [
      "typescript",
      "javascript",
      "python",
      "go",
      "rust",
      "java",
      "kotlin",
      "csharp",
      "php",
      "lua",
      "c",
    ]) {
      expect([lang, (counts.get(lang) ?? 0) >= 2]).toEqual([lang, true]);
    }
  });

  test("regression tasks exist", () => {
    const ids = new Set(tasks.map((t) => t.id));
    for (const id of loadRegression()) expect(ids.has(id)).toBe(true);
  });

  test("validateTask reports a malformed task", () => {
    const problems = validateTask("/nowhere/x", { id: "Bad_Id", checks: [], origin: "1593" });
    expect(problems).toContain("id must be lowercase words joined by hyphens");
    expect(problems).toContain("checks must list at least one check");
    expect(problems).toContain("origin must look like #N");
    expect(problems).toContain("seed/ is missing");
  });

  test("a task may turn on an opt-in policy field and nothing else (#1981)", () => {
    expect(validateTask("/nowhere/x", { policy: { chainRewrite: "on" } })).not.toContain("policy.chainRewrite is not an opt-in field the suite allows");
    const problems = validateTask("/nowhere/x", { policy: { chainRewrite: "off", maxTotalTokens: 1 } });
    expect(problems).toContain("policy.chainRewrite is not an opt-in field the suite allows");
    expect(problems).toContain("policy.maxTotalTokens is not an opt-in field the suite allows");
    expect(validateTask("/nowhere/x", { policy: [] })).toContain("policy must be an object");
    // The nested-emphasis task measures finding chains with the rewrite on.
    expect(tasks.find((t) => t.id === "ts-bun-emphasis")?.policy).toEqual({ chainRewrite: "on" });
    // The one-literal misquote task measures the host's misquote fix and its continuation (#2058).
    expect(tasks.find((t) => t.id === "ts-bun-query-depth")?.policy).toEqual({ misquoteFix: "on" });
  });
});

describe("pass^k", () => {
  test("equals 1 only when all of k trials pass", () => {
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(3, 2, 3)).toBe(0);
    expect(passHatK(2, 2, 2)).toBe(1);
  });

  test("estimates from more trials than k", () => {
    expect(passHatK(4, 3, 2)).toBeCloseTo(0.5);
    expect(passHatK(5, 5, 3)).toBe(1);
    expect(passHatK(1, 1, 2)).toBe(0);
  });
});

function fakeTask(id: string, language: string): SuiteTask {
  return {
    id,
    language,
    toolchain: "x",
    requires: ["x"],
    allowedPaths: ["**"],
    checks: [],
    dir: "/x",
  };
}

function trial(taskId: string, passed: boolean, extra: Partial<TrialResult> = {}): TrialResult {
  return {
    taskId,
    trial: 1,
    runId: `${taskId}-run`,
    status: passed ? "completed" : "blocked:invalid_output",
    passed,
    approvals: 1,
    interventions: passed ? 0 : 1,
    tokens: 1000,
    costUsd: 0.1,
    ...extra,
  };
}

describe("selection and reporting", () => {
  const a1 = fakeTask("a-one", "a");
  const a2 = fakeTask("a-two", "a");
  const b1 = fakeTask("b-one", "b");

  test("one task per language, rotating by seed", () => {
    expect(pickPerLanguage([a1, a2, b1], 0).map((t) => t.id)).toEqual(["a-one", "b-one"]);
    expect(pickPerLanguage([a1, a2, b1], 1).map((t) => t.id)).toEqual(["a-two", "b-one"]);
  });

  test("summaries, drops and the table", () => {
    const results = [
      trial("a-one", true),
      trial("a-one", true),
      trial("b-one", true),
      trial("b-one", false),
    ];
    const s = summarize([a1, b1, a2], results, 2, ["a-one"]);
    expect(s.map((x) => [x.taskId, x.passK, x.interventionsPerRun])).toEqual([
      ["a-one", 1, 0],
      ["b-one", 0, 0.5],
    ]);
    expect(drops(s, new Map([["b-one", 1]])).map((x) => x.taskId)).toEqual(["b-one"]);
    expect(drops(s, new Map()).map((x) => x.taskId)).toEqual([]);
    const table = renderTable(s, [{ task: a2, missing: ["dotnet"] }], 2);
    expect(table).toContain("| a-one (regression) | a | 1.00 | 2/2 |");
    expect(table).toContain("| a-two | a | skipped | no dotnet |");
  });

  test("a failing regression task always counts as a drop", () => {
    const s = summarize([a1], [trial("a-one", false)], 1, ["a-one"]);
    expect(drops(s, new Map()).map((x) => x.taskId)).toEqual(["a-one"]);
  });

  test("graduation needs pass^k = 1 on each recent night", () => {
    const night = (passK: number): TaskSummary[] => [
      {
        taskId: "b-one",
        language: "b",
        trials: 2,
        passes: 2,
        passK,
        interventionsPerRun: 0,
        tokensPerRun: 1,
        costPerRun: 0,
        regression: false,
        runIds: [],
      },
    ];
    expect(graduationCandidates([night(1), night(1)], [], 2)).toEqual(["b-one"]);
    expect(graduationCandidates([night(1), night(0)], [], 2)).toEqual([]);
    expect(graduationCandidates([night(1)], [], 2)).toEqual([]);
    expect(graduationCandidates([night(1), night(1)], ["b-one"], 2)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  escapeRates,
  type FixMerge,
  type HotModule,
  loadHotModules,
  moduleTests,
  mutationIssue,
  parseIssues,
  parseRounds,
  touchedModules,
} from "../scripts/hot-modules";

const forecast: HotModule = {
  id: "cost-forecast",
  title: "Cost forecast",
  paths: ["src/core/workflows/cost-forecast.ts", "src/core/workflows/stage-price.ts"],
};
const approval: HotModule = { id: "auto-approval", title: "Auto-approval", paths: ["src/core/workflows/auto-approval.ts"] };

describe("hot-module list (#1718, #1723)", () => {
  test("every listed path exists and belongs to one module", () => {
    const modules = loadHotModules();
    const paths = modules.flatMap((module) => module.paths);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    expect(new Set(modules.map((m) => m.id)).size).toBe(modules.length);
  });

  test("every module has tests that import it", () => {
    const tests = Array.from(new Bun.Glob("tests/*.test.ts").scanSync()).map((path) => ({
      path,
      content: readFileSync(path, "utf8"),
    }));
    for (const module of loadHotModules()) expect(moduleTests(module, tests).length).toBeGreaterThan(0);
  });

  test("the mutation matrix of the weekly job runs every module", () => {
    const workflow = readFileSync(".github/workflows/hot-modules.yml", "utf8");
    const matrix = /module: \[([^\]]+)\]/.exec(workflow)?.[1]?.split(",").map((id) => id.trim());
    expect(matrix?.sort()).toEqual(loadHotModules().map((m) => m.id).sort());
  });
});

describe("touched modules and their tests", () => {
  test("a diff touches the modules that own its files", () => {
    expect(touchedModules([forecast, approval], ["src/core/workflows/stage-price.ts", "README.md"]).map((m) => m.id)).toEqual(["cost-forecast"]);
    expect(touchedModules([forecast, approval], ["src\\core\\workflows\\auto-approval.ts"]).map((m) => m.id)).toEqual(["auto-approval"]);
    expect(touchedModules([forecast], ["src/core/workflows/cost-forecast-view.ts"])).toEqual([]);
  });

  test("a module's tests are the test files importing one of its paths", () => {
    const tests = [
      { path: "tests/a.test.ts", content: 'import { costForecast } from "../src/core/workflows/cost-forecast.js";' },
      { path: "tests/b.test.ts", content: "import { x } from '../src/core/workflows/stage-price';" },
      { path: "tests/c.test.ts", content: 'import { y } from "../src/core/workflows/cost-forecast-view.js";' },
    ];
    expect(moduleTests(forecast, tests)).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });
});

describe("escape rate", () => {
  const rounds = parseRounds(
    JSON.stringify({ rounds: [45, 46, 47, 48].map((round, i) => ({ round, report: `report-202610${15 + i}T120000-abcd.md` })) }),
  );
  const fix = (ref: string, mergedAt: string, files: string[]): FixMerge => ({ ref, mergedAt, files });

  test("round ends come from the report names", () => {
    expect(rounds[0]).toEqual({ round: 45, end: "2026-10-15T12:00:00Z" });
    expect(parseRounds(JSON.stringify([{ round: 3, end: "2026-10-01T00:00:00Z" }]))).toEqual([{ round: 3, end: "2026-10-01T00:00:00Z" }]);
  });

  test("a fix escapes when a loop issue naming its module opens before the second round that measures it ends", () => {
    const fixes = [
      fix("#10", "2026-10-15T08:00:00Z", ["src/core/workflows/cost-forecast.ts"]), // R45: window to the end of R47
      fix("#11", "2026-10-15T09:00:00Z", ["src/core/workflows/auto-approval.ts"]),
      fix("#12", "2026-10-17T13:00:00Z", ["src/core/workflows/stage-price.ts"]), // R48: not measured yet
    ];
    const issues = parseIssues(
      JSON.stringify([
        [{ number: 20, title: "Forecast too low", body: "`stage-price.ts` prices the open task twice", created_at: "2026-10-17T10:00:00Z", labels: [{ name: "bench-loop" }] }],
        [
          { number: 21, title: "Approval asked twice", body: "auto-approval.ts", created_at: "2026-10-18T10:00:00Z", labels: ["bench-loop"] },
          { number: 22, title: "Idea", body: "cost-forecast.ts", created_at: "2026-10-16T10:00:00Z", labels: [{ name: "idea" }] },
          { number: 23, title: "PR", body: "cost-forecast.ts", created_at: "2026-10-16T10:00:00Z", pull_request: {} },
        ],
      ]),
    );
    expect(issues.map((i) => i.number)).toEqual([20, 21]);
    const [cost, auto] = escapeRates([forecast, approval], fixes, issues, rounds);
    expect(cost).toMatchObject({ fixes: 1, escaped: 1, pending: 1, rate: 1, escapes: [{ fix: "#10", issue: 20 }] });
    // #21 opened after R47 ended, outside the window of #11.
    expect(auto).toMatchObject({ fixes: 1, escaped: 0, rate: 0 });
    expect(escapeRates([forecast], fixes, issues, rounds, { from: 46 })[0]).toMatchObject({ fixes: 0, pending: 1, rate: null });
  });

  test("pages printed back to back by gh api --paginate parse as one list", () => {
    const page = (n: number) => JSON.stringify([{ number: n, title: "t", body: "", created_at: "2026-10-01T00:00:00Z", labels: [] }]);
    expect(parseIssues(`${page(1)}\n${page(2)}`).map((i) => i.number)).toEqual([1, 2]);
  });
});

describe("mutation issue", () => {
  const run = (recentFixes: string[], status: "survived" | "killed") => ({
    module: "cost-forecast",
    tests: ["tests/a.test.ts"],
    recentFixes,
    result: {
      schemaVersion: 1 as const,
      mode: "advisory" as const,
      engine: "built-in" as const,
      tests: ["tests/a.test.ts"],
      score: status === "killed" ? 100 : 0,
      mutants: [{ id: "M1", file: "src/core/workflows/cost-forecast.ts", line: 3, operator: "boundary", original: "a >= b", mutated: "a > b", status, blocking: false }],
    },
  });

  test("survivors in a module with a recent fix become an issue body naming the fix and the mutant", () => {
    const body = mutationIssue(run(["#1691"], "survived"));
    expect(body).toStartWith("Priority: P2\n");
    expect(body).toContain("#1691");
    expect(body).toContain("`src/core/workflows/cost-forecast.ts:3`");
    expect(body).toContain("`a >= b` → `a > b`");
  });

  test("no issue without a recent fix or without survivors", () => {
    expect(mutationIssue(run([], "survived"))).toBeNull();
    expect(mutationIssue(run(["#1691"], "killed"))).toBeNull();
  });
});

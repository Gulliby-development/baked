import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hostRowFiles, hostRowFileTasks, hostWritesRowFile } from "../src/core/workflows/host-apply.js";
import { estimateInitiative, type FeatureToEstimate } from "../src/core/workflows/initiatives/estimate.js";
import { boundaryPathCounts, hostRowCases, type InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import type { RunPolicy, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { restoreRowBlocks } from "../src/core/workflows/trace.js";

// #2640: the initiative budget preview prices a feature before any task plan exists, from its
// boundary paths and the test cases the split carries. Under `rowFileWrite: "on"` the host writes
// a prescribed row file of a language with a `ROW_FILE_SHAPES` row with no session, and task-plan
// sizing prices those tasks at nothing (`hostRowFileTasks`, #2633); the preview now asks the same
// decision (`hostWritesRowFile`) and counts such a file neither as a path nor as test cases.

const ON: Pick<RunPolicy, "rowFileWrite"> = { rowFileWrite: "on" };
const OFF: Pick<RunPolicy, "rowFileWrite"> = {};

const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `pytest.param("${prefix} ${i + 1}", ${i + 1}),`);
const block = (path: string, n: number) => ["```text", `RowTests in ${path} (${n} rows, (query, rank))`, ...rows(n, path), "```"].join("\n");
const request = (files: Record<string, number>) =>
  ["Build the search tool.", "", "The prescribed rows, one test each:", "", ...Object.entries(files).flatMap(([path, n]) => [block(path, n), ""])].join("\n");

const plan = (test: string, other: string): Pick<InitiativePlan, "features"> => ({
  features: [
    { id: "core", title: "Core", boundary: { scope: "s", paths: ["pkg/core.py", test] }, contract: "c", dependsOn: [], mandatory: true, testCases: 20 },
    { id: "rank", title: "Rank", boundary: { scope: "s", paths: ["pkg/rank.py", other] }, contract: "c", dependsOn: ["core"], mandatory: true, testCases: 12 },
  ],
});

describe("the preview prices prescribed rows the host writes at host cost (#2640)", () => {
  const req = request({ "tests/test_core.py": 20, "tests/test_rank.py": 12 });
  const split = plan("tests/test_core.py", "tests/test_rank.py");

  test("rowFileWrite on: a Python row file counts as no path and its rows as no test cases", () => {
    expect([...hostRowFiles(req, ["tests/test_core.py", "tests/test_rank.py", "pkg/core.py"], ON)]).toEqual([
      ["tests/test_core.py", 20],
      ["tests/test_rank.py", 12],
    ]);
    expect(Object.fromEntries(hostRowCases(split, req, ON))).toEqual({ core: 20, rank: 12 });
    expect(boundaryPathCounts(split, req, ON).get("core")).toEqual({ paths: 1, placeholders: 0, skeleton: 0 });
  });

  test("rowFileWrite off or shadow: the session price stays", () => {
    expect(hostRowFiles(req, ["tests/test_core.py"], OFF).size).toBe(0);
    expect(hostRowCases(split, req, OFF).size).toBe(0);
    expect(boundaryPathCounts(split, req, OFF).get("core")).toEqual({ paths: 2, placeholders: 0, skeleton: 0 });
    expect(boundaryPathCounts(split, req)).toEqual(boundaryPathCounts(split, req, OFF));
  });

  test("a language with no ROW_FILE_SHAPES row keeps the session price: a session writes its rows", () => {
    // bash has no row shape (#2553): the host refuses the file and a session transcribes it.
    const rust = request({ "tests/core_test.bats": 20, "tests/test_rank.py": 12 });
    const mixed = plan("tests/core_test.bats", "tests/test_rank.py");
    expect(hostWritesRowFile("tests/core_test.bats", ON)).toBe(false);
    expect(Object.fromEntries(hostRowCases(mixed, rust, ON))).toEqual({ rank: 12 });
    expect(boundaryPathCounts(mixed, rust, ON).get("core")).toEqual({ paths: 2, placeholders: 0, skeleton: 0 });
  });

  test("a file the request also supplies verbatim is no row file, as the scheduler's rowFileTasks reads it", () => {
    const verbatim = `${req}\nReplace \`tests/test_core.py\` with:\n\n\`\`\`python\nimport pytest\n\`\`\`\n`;
    expect([...hostRowFiles(verbatim, ["tests/test_core.py", "tests/test_rank.py"], ON).keys()]).toEqual(["tests/test_rank.py"]);
  });

  test("the preview and plan sizing agree file by file: one decision, `hostWritesRowFile`", () => {
    const task = (id: string, path: string): Task => ({
      id, title: id, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
      writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "r",
    });
    const rust = request({ "tests/core_test.bats": 20, "tests/test_rank.py": 12, "tests/test_cli.py": 4 });
    const paths = ["tests/core_test.bats", "tests/test_rank.py", "tests/test_cli.py"];
    const graph: Pick<TaskGraph, "tasks"> = { tasks: paths.map((p, i) => task(`T00${i + 1}`, p)) };
    const byTask = hostRowFileTasks(rust, graph, ON).map((id) => graph.tasks.find((t) => t.id === id)?.writes[0]?.path);
    expect(byTask).toEqual([...hostRowFiles(rust, paths, ON).keys()]);
    expect(byTask).toEqual(["tests/test_rank.py", "tests/test_cli.py"]);
  });

  test("the estimate drops the test-case floor of the rows the host writes", () => {
    const rate = { perCase: { low: 25_000, high: 40_000 }, samples: 6, basis: "project" as const };
    const features = (policy: Pick<RunPolicy, "rowFileWrite">): FeatureToEstimate[] => {
      const cases = hostRowCases(split, req, policy);
      return split.features.map((f) => {
        const testCases = Math.max(0, (f.testCases ?? 0) - (cases.get(f.id) ?? 0));
        return { id: f.id, title: f.id, workflowId: "sdd", size: "medium", stages: [], ...(testCases ? { testCases } : {}) };
      });
    };
    const of = (policy: Pick<RunPolicy, "rowFileWrite">) =>
      estimateInitiative({ features: features(policy), history: [], samples: [], maxTotalTokens: 30_000_000, testCaseRate: rate });
    const on = of(ON);
    const off = of(OFF);
    // Off: 20 cases at 25k-40k floor core at 0.50M-0.80M; on: no floor, no test volume.
    expect(off.features.find((f) => f.featureId === "core")).toMatchObject({ floor: "tests", testCases: 20 });
    expect(on.features.find((f) => f.featureId === "core")?.testCases).toBeUndefined();
    expect(on.testVolume).toBeNull();
    expect(on.expectedTokens).toBeLessThan(off.expectedTokens);
  });
});

describe("a trace replay restores the row blocks its request stand-in has no text of (#2640)", () => {
  test("each recorded row file gets a block of its rows, read as the request's, once", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE initiatives (id TEXT, prompt TEXT)");
    db.run("CREATE TABLE initiative_runs (initiative_id TEXT, run_id TEXT)");
    db.run("CREATE TABLE artifacts (run_id TEXT, logical_path TEXT, inline_content TEXT, created_at INTEGER)");
    db.run("INSERT INTO initiatives VALUES ('i', 'prompt-1\ntests/test_core.py')");
    db.run("INSERT INTO initiative_runs VALUES ('i', 'r1'), ('other', 'r2')");
    const record = (run: string, path: string, n: number, at: number) =>
      db.run("INSERT INTO artifacts VALUES (?, ?, ?, ?)", [run, `row-blocks/${path}.json`, JSON.stringify({ path, rows: Array.from({ length: n }, (_, i) => ({ row: i + 1 })) }), at]);
    record("r1", "tests/test_core.py", 20, 1);
    record("r1", "tests/test_rank.py", 12, 2);
    record("r2", "tests/test_else.py", 9, 3);
    restoreRowBlocks(db, "i");
    const prompt = (db.query("SELECT prompt FROM initiatives").get() as { prompt: string }).prompt;
    expect(Object.fromEntries(hostRowFiles(prompt, ["tests/test_core.py", "tests/test_rank.py", "tests/test_else.py"], ON))).toEqual({
      "tests/test_core.py": 20,
      "tests/test_rank.py": 12,
    });
    restoreRowBlocks(db, "i");
    expect((db.query("SELECT prompt FROM initiatives").get() as { prompt: string }).prompt).toBe(prompt);
  });
});

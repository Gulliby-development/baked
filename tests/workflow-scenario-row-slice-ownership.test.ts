import { describe, expect, test } from "bun:test";
import { criterionCases } from "../src/core/verification/criteria-cases.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import {
  ROW_TEXT_PER_CHAR,
  type SizingSample,
  sizePlan,
  splitTestTasks,
  suppliedRows,
} from "../src/core/workflows/sizing.js";

// Bench round 79 verhop (#2466): the brief gave `tests/check.bats` as 15 prescribed rows, sizing
// split it into T004 (rows 1-7) and T007 (rows 8-15), and the task-end walk dealt AC-003's literals
// 7/15 to T004 in the criteria's order, not by the rows that hold them. T004 was refused for
// literals of rows 10 and 13 and raised `spec_conflict` three times (946k tokens, a person answered).
// A slice now owns a literal by its own rows; a literal no row holds goes to the last slice.

/** The versions of the 15 rows; rows 10 and 13 hold AC-003's reasons, row 15 AC-005's tuple. */
const VERSIONS = [
  "1.2.3",
  "0.0.0",
  "1.2.3-alpha.1",
  "10.20.30",
  "1.0.0-rc.1",
  "2.0.0-beta",
  "3.1.4",
  "01.2.3",
  "1.02.3",
  "1.2.3+",
  "1.2.3-",
  "1.2",
  "v1.2.3",
  "1.2.3.4",
  "9.9.9",
];
const code = (i: number) => (i < 7 || i === 14 ? 0 : 1);

/** One row in each language's own spelling, as the request's block gives it. */
const LANGUAGES: { language: string; path: string; row: (version: string, i: number) => string }[] = [
  {
    language: "shell (bats)",
    path: "tests/check.bats",
    row: (v, i) => `run "check" "${v}" => ${code(i)} "${code(i) ? "" : `${v} ok\\n`}" "${code(i) ? "invalid\\n" : ""}"`,
  },
  { language: "typescript", path: "tests/check.test.ts", row: (v, i) => `["${v}", ${code(i)}],` },
  { language: "python", path: "tests/test_check.py", row: (v, i) => `("${v}", ${code(i)}),` },
  { language: "go", path: "internal/check/check_test.go", row: (v, i) => `{"${v}", ${code(i)}},` },
  { language: "rust", path: "tests/check.rs", row: (v, i) => `(r"${v}", ${code(i)}),` },
  { language: "c#", path: "tests/CheckTests.cs", row: (v, i) => `[InlineData("${v}", ${code(i)})]` },
  { language: "java", path: "src/test/java/CheckTest.java", row: (v, i) => `"${v}, ${code(i)}",` },
  { language: "scala", path: "src/test/scala/CheckSuite.scala", row: (v, i) => `("${v}", ${code(i)}),` },
];

const request = (path: string, rows: string[]) =>
  [
    "Add the check command to verhop.",
    "",
    "```text",
    `CheckTests in ${path} (${rows.length} rows, VERSION => CODE)`,
    ...rows,
    "```",
  ].join("\n");

const criterion = (id: string, then: string) => ({
  id,
  requirementIds: ["FR-001"],
  given: "a version string",
  when: "check runs",
  then,
  method: "automated" as const,
});
const spec: Pick<Spec, "criteria"> = {
  criteria: [
    // `1.2.3-alpha.1` is row 3; `1.2.3-0a.01a.-.a-b.1e3` is in no row.
    criterion("AC-002", "check accepts `1.2.3-alpha.1` and `1.2.3-0a.01a.-.a-b.1e3`"),
    // Rows 10, 13 and 14, all in the second slice.
    criterion("AC-003", "check rejects `1.2.3+`, `v1.2.3` and `1.2.3.4` with exit 1"),
  ],
};

const task = (id: string, path: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `test ${path}`,
  description: `Write ${path}`,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-002", "AC-003"],
  dependsOn: ["T001"],
  profileId: "implementer",
  writes: [{ path, action: "create" }],
  readHints: [],
  checkIds: ["tests"],
  origin: "planned",
  findingIds: [],
  rationale: "Required behavior",
  ...extra,
});
const graph = (path: string): TaskGraph => ({
  schemaVersion: 1,
  featureId: "verhop",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks: [
    { ...task("T001", "src/check.sh"), title: "check", dependsOn: [], criterionIds: [] },
    task("T004", path),
  ],
});
const history: SizingSample[] = Array.from({ length: 20 }, (_, i) => ({
  runId: `t${i}`,
  taskId: "T004",
  kind: "test",
  action: "create",
  source: "project",
  files: 1,
  tokens: 100_000 + i * 5_000,
  model: null,
  criteria: 2,
  cases: 2 + i,
}));

/** The row slices of the file, with the cap set so the rows' expected price makes two. */
function slices(path: string, rows: string[]): { tasks: Task[]; req: string } {
  const req = request(path, rows);
  const chars = rows.reduce((sum, row) => sum + [...row].length, 0);
  const expected = (chars * (ROW_TEXT_PER_CHAR.low + ROW_TEXT_PER_CHAR.high)) / 2;
  const policy: RunPolicy = {
    ...defaultWorkflowPolicy,
    sizing: { maxAttemptTokens: Math.ceil(expected * 0.6), rowVolume: true },
  };
  const plan = graph(path);
  const report = sizePlan({ graph: plan, policy, samples: history, spent: 0, spec, request: req });
  const split = splitTestTasks(plan, report, spec as Spec, undefined, [], req);
  return { tasks: split?.tasks ?? [], req };
}

const literals = (owner: Task, plan: Task[]) =>
  criterionCases(spec, owner, { checks: [], tasks: plan }).map((c) => c.literal);

describe("row slices own the criteria literals of their rows (#2466)", () => {
  for (const { language, path, row } of LANGUAGES) {
    test(`${language}: a slice is asked only for the literals its rows hold`, () => {
      const rows = VERSIONS.map(row);
      expect(suppliedRows(request(path, rows), [path]).get(path)?.lines).toEqual(rows);
      const { tasks } = slices(path, rows);
      const parts = tasks.filter((t) => t.sizingSlice?.taskId === "T004");
      expect(parts).toHaveLength(2);
      expect(parts.map((t) => t.sizingSlice?.rows)).toEqual([rows.slice(0, 7), rows.slice(7)]);
      const [first, second] = parts as [Task, Task];
      // Rows 1-7 hold only `1.2.3-alpha.1`; the reasons of rows 10, 13 and 14 belong to slice 2,
      // and the example no row holds goes to the last slice, whose file holds every row.
      expect(literals(first, tasks)).toEqual(["1.2.3-alpha.1"]);
      expect(literals(second, tasks).sort()).toEqual(
        ["1.2.3-0a.01a.-.a-b.1e3", "1.2.3+", "v1.2.3", "1.2.3.4"].sort(),
      );
    });
  }

  test("a tuple spelling that differs from the rows' notation goes to the last slice", () => {
    const { path, row } = LANGUAGES[0] as (typeof LANGUAGES)[number];
    const rows = VERSIONS.map(row);
    const tuple = {
      criteria: [criterion("AC-005", 'check prints `(0,"1.2.3 ok\\n","")` for a valid version')],
    };
    const { tasks } = slices(path, rows);
    const parts = tasks.filter((t) => t.sizingSlice?.taskId === "T004");
    const cases = (owner: Task) =>
      criterionCases(tuple, { ...owner, criterionIds: ["AC-005"] }, {
        checks: [],
        tasks: tasks.map((t) => (t.sizingSlice ? { ...t, criterionIds: ["AC-005"] } : t)),
      }).map((c) => c.literal);
    expect(cases(parts[0] as Task)).toEqual([]);
    expect(cases(parts[1] as Task).length).toBeGreaterThan(0);
  });

  test("slices without their rows (planner-written, or before this fix) keep the share rule", () => {
    const { path, row } = LANGUAGES[0] as (typeof LANGUAGES)[number];
    const { tasks } = slices(path, VERSIONS.map(row));
    const bare = tasks.map((t) => {
      if (!t.sizingSlice) return t;
      const { rows: _rows, ...slice } = t.sizingSlice;
      return { ...t, sizingSlice: slice };
    });
    const [first, second] = bare.filter((t) => t.sizingSlice) as [Task, Task];
    const all = [...literals(first, bare), ...literals(second, bare)].sort();
    expect(all).toEqual(
      ["1.2.3-alpha.1", "1.2.3-0a.01a.-.a-b.1e3", "1.2.3+", "v1.2.3", "1.2.3.4"].sort(),
    );
  });
});

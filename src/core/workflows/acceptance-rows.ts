import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import {
  hasInlineRows,
  INLINE_HARNESS,
  type InlineRowFile,
  type InlineRowTest,
  inlineRowFile,
  layoutFree,
} from "./acceptance-rows-inline.js";
import type { AcceptanceRow } from "./acceptance-rows-model.js";
import { WorkflowFault } from "./errors.js";
import type { Analysis, RunPolicy, Spec, TaskGraph } from "./schemas.js";
import type { Task } from "./types.js";

export const ROWS_ARTIFACT = "rows.json";
export const rowsAsDataOn = (policy: Pick<RunPolicy, "rowsAsData">): boolean =>
  policy.rowsAsData === "on";

const plain = (text: string): string => text.trim().replace(/^`(.*)`$/, "$1");
const cellsOf = (text: string): string[] =>
  text
    .trim()
    .replace(/^\|\s*|\s*\|$/g, "")
    .split("|")
    .map(plain);
const jsonOrText = (cell: string): unknown => {
  try {
    return JSON.parse(cell);
  } catch {
    return cell;
  }
};
const normalized = (text: string): string => JSON.stringify(cellsOf(text).map(jsonOrText));
/** An audit entry may copy the whole row, label included, or only its input and expected value. */
const auditedRow = (written: string, row: AcceptanceRow): boolean =>
  normalized(written) === normalized(row.source) ||
  normalized(written) === JSON.stringify([row.input, row.expected]);
/** An entry that names the row by its id or copies its leading cells (input and label) only. */
const rowKey = (written: string, row: AcceptanceRow): boolean => {
  if (written.trim() === row.id) return true;
  const echoed = cellsOf(written).map(jsonOrText);
  const cells = cellsOf(row.source).map(jsonOrText);
  return (
    echoed.length > 0 &&
    echoed.length < cells.length &&
    JSON.stringify(echoed) === JSON.stringify(cells.slice(0, echoed.length))
  );
};

/**
 * The row an audit entry is for: the one it copies whole, else the one it names by id or by
 * leading cells, when exactly one row of its criterion has them (#1892). R59 tags-command echoed
 * `["cp34:win32"] | full list` for a row whose expected cell is a long multi-line output, and the
 * analysis was refused for 7 of 32 rows it had derived correctly (83k tokens, 270 s).
 */
function auditedRowOf(
  derivation: NonNullable<Analysis["derivations"]>[number],
  rows: readonly AcceptanceRow[],
): AcceptanceRow | undefined {
  const own = rows.filter((row) => row.criterionId === derivation.criterionId);
  const whole = own.filter((row) => auditedRow(derivation.row, row));
  if (whole.length) return whole.length === 1 ? whole[0] : undefined;
  const keyed = own.filter((row) => rowKey(derivation.row, row));
  return keyed.length === 1 ? keyed[0] : undefined;
}
const finiteJson = (value: unknown): boolean => {
  if (typeof value === "number")
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) return value.every(finiteJson);
  return value === null || typeof value !== "object" || Object.values(value).every(finiteJson);
};

/** A label column the reader skips, so a spec can name each case (#1660). */
const LABEL_HEADER = /^(?:scenario|case|name|description|label)$/i;
interface Columns {
  width: number;
  input: number;
  expected: number;
  label?: number;
}
const headerOf = (cells: string[]): Columns | null => {
  if (cells.length !== 2 && cells.length !== 3) return null;
  const input = cells.findIndex((cell) => /^input$/i.test(cell));
  const expected = cells.findIndex((cell) => /^expected$/i.test(cell));
  const label = cells.findIndex((cell) => LABEL_HEADER.test(cell));
  if (input < 0 || expected < 0 || (cells.length === 3 && label < 0)) return null;
  return { width: cells.length, input, expected, ...(cells.length === 3 ? { label } : {}) };
};

/**
 * Only an explicit `Input | Expected` JSON table, with an optional label column, is data. Prose
 * and executable expressions stay manual.
 */
export function literalRows(spec: Pick<Spec, "criteria">, ids: readonly string[]): AcceptanceRow[] {
  return spec.criteria.flatMap((criterion) => {
    if (!ids.includes(criterion.id) || criterion.method !== "automated" || criterion.property)
      return [];
    const result: AcceptanceRow[] = [];
    for (const text of [criterion.given, criterion.when, criterion.then]) {
      let table: Columns | null = null;
      for (const line of text.split(/\r?\n/)) {
        const cells = cellsOf(line);
        const header = headerOf(cells);
        if (header) {
          table = header;
          continue;
        }
        if (!table) continue;
        if (cells.length !== table.width) {
          if (line.includes("|")) return [];
          table = null;
          continue;
        }
        if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
        try {
          const input: unknown = JSON.parse(cells[table.input] ?? "");
          const expected: unknown = JSON.parse(cells[table.expected] ?? "");
          if (!finiteJson(input) || !finiteJson(expected)) return [];
          const label = table.label === undefined ? "" : (cells[table.label] ?? "");
          result.push({
            id: `${criterion.id}:${result.length + 1}`,
            criterionId: criterion.id,
            source: line.trim(),
            ...(label ? { label } : {}),
            input,
            expected,
          });
        } catch {
          // Never partially emit a table whose remaining cases require an agent.
          return [];
        }
      }
    }
    return result;
  });
}

export const ROWS_NOTE =
  'Acceptance rows as data is enabled. For pure call-and-compare tests with JSON Input | Expected tables (an optional Scenario column is a label), set rows to the criterion IDs and rowTest to {framework, harness: "relative harness path", test: "relative test path", data: "relative JSON path"}, adding package where the framework needs one. Declare all three paths in writes, with test and data created by this task. Write only the harness; the host writes the JSON rows and the parameterized test, preserving row IDs, and compares the harness result with each expected value as JSON. Frameworks and harness contracts: "bun": a .ts or .js harness exporting actual(input), which may be async, and a .test.ts test. "pytest": a .py harness defining actual(input) and a test_*.py test. "go": a .go harness defining func Actual(input any) (any, error) in the same directory as a _test.go test, with package set to the Go package name. "junit" (JUnit 5): a .java harness class, named after its file, with static Object actual(Object input) in the same package as a *Test.java test, both under the directories of package (the Java package); input is built from Map<String, Object>, List<Object>, Long, Double, String, Boolean and null. "rust": a test tests/<name>.rs and a harness .rs file (best under tests/support/) defining pub fn actual(input: serde_json::Value) -> serde_json::Value; the project needs serde_json, at least in [dev-dependencies]. "xunit": a .cs harness static class, named after its file, with public static object? Actual(System.Text.Json.Nodes.JsonNode? input) and a .cs test in a project that references xunit, with package set to the C# namespace of both. Inline mode, for a brief or boundary that fixes the test files (no new harness, test or data file, no new dependency): set rowTest to {mode: "inline", framework, test: "a test file this task writes"}, adding package for go (the Go package), junit (the Java package of the file\'s directory) and xunit (the C# namespace of the file\'s class). Do not add other paths for it. The host appends the rows and their parameterized test to the end of that file between BEGIN and END acceptance rows comments (Go: also an import block after the package clause; junit and xunit: as a class nested in the file\'s own class, before its closing brace, so the file keeps one top-level type), and restores the block if an edit drops it. In that file define the harness the block calls, next to the task\'s ordinary tests: "bun": function acceptanceActual(input), which may be async; "pytest": def acceptance_actual(input); "go": func acceptanceActual(input any) (any, error), one per package directory; "junit": static Object acceptanceActual(Object input) in the class named after the file; "rust": fn acceptance_actual(input: &AcceptanceJson) -> AcceptanceJson, where the host block defines AcceptanceJson (Null, Bool, Number(f64), String, Array, Object; as_f64, as_i64, as_str, as_array, get, and From for numbers, strings, bools, Vec and Option); "xunit": a static (public or internal) object? AcceptanceActual(System.Text.Json.Nodes.JsonNode? input) in the class named after the file. Prefer inline whenever the files of the file mode would be extra files the request does not allow. Keep stateful, process, file and non-JSON cases in ordinary agent-written tests. Do not mark a criterion unless its whole table fits one harness.';

/** Told to the spec author, so the tables the planner may select are ones the host can read (#1660). */
export const SPEC_ROWS_NOTE =
  "Acceptance rows as data is enabled. When a criterion's cases are pure calls (one input value gives one output value, with no files, processes, time or state), write them as a Markdown table in its then with the header Input | Expected, or Input | Scenario | Expected where Scenario names each case. Every Input and Expected cell holds one JSON literal, optionally in backticks: a string, number, boolean, null, array or object, never a call expression, a command line or prose. Put several arguments in one JSON array or object and say in the criterion which element is which argument. Do not put | inside a cell. The host turns such tables into data-driven tests in every supported language; keep stateful, process and file cases in ordinary criteria.";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const baseName = (path: string, suffix: RegExp): string => posix.basename(path).replace(suffix, "");
const packageDir = (path: string, pkg: string): boolean =>
  `/${posix.dirname(path)}`.endsWith(`/${pkg.replaceAll(".", "/")}`);

type RowTest = NonNullable<Task["rowTest"]>;
type FileRowTest = Exclude<RowTest, { mode: "inline" }>;
export const inlineRows = (rowTest: RowTest): rowTest is InlineRowTest =>
  "mode" in rowTest && rowTest.mode === "inline";
/** The files only the host writes for a rows task: the file mode's test and data; inline, none. */
export const hostRowPaths = (task: Pick<Task, "rows" | "rowTest">): string[] =>
  task.rows?.length && task.rowTest && !inlineRows(task.rowTest)
    ? [task.rowTest.test, task.rowTest.data]
    : [];
/** The data file that holds a rows task's cases apart from its test; inline rows have none. */
export const rowDataPaths = (task: Pick<Task, "rows" | "rowTest">): string[] =>
  task.rows?.length && task.rowTest && !inlineRows(task.rowTest) ? [task.rowTest.data] : [];

/** The test file name each framework runs, and the package a typed language needs. */
function testFileProblem(rowTest: RowTest): string | null {
  const { framework, test } = rowTest;
  const pkg = rowTest.package;
  switch (framework) {
    case "bun":
      return /\.(?:test|spec)\.[jt]sx?$/.test(test) ? null : "need a .test.ts test";
    case "pytest":
      return /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(test)
        ? null
        : "need a test_*.py or *_test.py test";
    case "go":
      if (!test.endsWith("_test.go")) return "need a _test.go test";
      return pkg && IDENTIFIER.test(pkg) ? null : "need package set to the Go package name";
    case "junit":
      if (!/(?:Test|Tests|TestCase)\.java$|(?:^|\/)Test[^/]*\.java$/.test(test))
        return "need a *Test.java test";
      if (!IDENTIFIER.test(baseName(test, /\.java$/)))
        return "need a Java class name as the test file name";
      return pkg && packageDir(test, pkg)
        ? null
        : "need package set to the Java package whose directory holds the test";
    case "rust":
      return /(?:^|\/)tests\/[^/]+\.rs$/.test(test) ? null : "need a tests/<name>.rs test";
    case "xunit":
      if (!test.endsWith(".cs")) return "need a .cs test";
      if (!IDENTIFIER.test(baseName(test, /\.cs$/)))
        return "need a C# class name as the test file name";
      return pkg ? null : "need package set to the C# namespace of the test class";
  }
}

/** The file layout each framework's host-written test can load its harness from. */
function layoutProblem(rowTest: FileRowTest): string | null {
  const { framework, harness, test, data } = rowTest;
  const pkg = rowTest.package;
  if (!data.endsWith(".json")) return "need a .json data file";
  switch (framework) {
    case "bun":
      return /\.(?:test|spec)\.[jt]s$/.test(test) && /\.[jt]s$/.test(harness)
        ? null
        : "need a .test.ts test and a .ts or .js harness";
    case "pytest":
      return /(?:^|\/)test_[^/]+\.py$/.test(test) && harness.endsWith(".py")
        ? null
        : "need a test_*.py test and a .py harness";
    case "go":
      if (!test.endsWith("_test.go") || !harness.endsWith(".go") || harness.endsWith("_test.go"))
        return "need a _test.go test and a .go harness that is not a test file";
      if (posix.dirname(test) !== posix.dirname(harness))
        return "need the Go harness and test in one package directory";
      return pkg && IDENTIFIER.test(pkg) ? null : "need package set to the Go package name";
    case "junit":
      if (
        !/(?:Test|Tests|TestCase)\.java$|(?:^|\/)Test[^/]*\.java$/.test(test) ||
        !harness.endsWith(".java")
      )
        return "need a *Test.java test and a .java harness";
      if (![test, harness].every((path) => IDENTIFIER.test(baseName(path, /\.java$/))))
        return "need Java class names as the harness and test file names";
      return pkg && packageDir(test, pkg) && packageDir(harness, pkg)
        ? null
        : "need package set to the Java package whose directory holds the harness and the test";
    case "rust":
      return /(?:^|\/)tests\/[^/]+\.rs$/.test(test) && harness.endsWith(".rs")
        ? null
        : "need a tests/<name>.rs test and a .rs harness";
    case "xunit":
      if (!test.endsWith(".cs") || !harness.endsWith(".cs")) return "need a .cs test and harness";
      if (![test, harness].every((path) => IDENTIFIER.test(baseName(path, /\.cs$/))))
        return "need C# class names as the harness and test file names";
      return pkg ? null : "need package set to the C# namespace of the harness and the test";
  }
}

/** What an inline rows task needs: a test file it writes that no other task writes (#1763). */
function inlinePlanProblems(task: Task, rowTest: InlineRowTest, graph: TaskGraph): string | null {
  const layout = testFileProblem(rowTest);
  if (layout) return layout;
  const write = task.writes.find((w) => w.path === rowTest.test);
  if (!write || write.action === "delete" || write.content !== undefined)
    return "inline need the test file in the task's writes, without content";
  if (graph.tasks.some((o) => o.id !== task.id && o.writes.some((w) => w.path === rowTest.test)))
    return "inline need a test file no other task writes";
  if (
    rowTest.framework === "go" &&
    graph.tasks.some(
      (other) =>
        other.id !== task.id &&
        other.rowTest &&
        inlineRows(other.rowTest) &&
        other.rowTest.framework === "go" &&
        posix.dirname(other.rowTest.test) === posix.dirname(rowTest.test),
    )
  )
    return `inline need one Go test file per package directory, since each defines ${INLINE_HARNESS.go}`;
  return null;
}

/**
 * The planned tasks without rows and rowTest when the policy has rows as data off (#1816). The
 * planner is never told about the fields then, but they are in the task schema it fills, and a
 * plan rejected for them came back unchanged until the run blocked. They carry no work the run
 * would do, so the host drops them as a recorded edit.
 */
export function withoutRowsWhenOff(
  graph: TaskGraph,
  policy: RunPolicy,
  spec?: Pick<Spec, "criteria">,
): TaskGraph {
  // A spec without a table the host reads is the same case: the planner was told nothing (#1833).
  const offered = rowsAsDataOn(policy) && (!spec || rowsEligible(spec).length > 0);
  if (offered || !graph.tasks.some((t) => t.rows || t.rowTest)) return graph;
  return {
    ...graph,
    tasks: graph.tasks.map((task) =>
      task.rows || task.rowTest ? { ...task, rows: undefined, rowTest: undefined } : task,
    ),
  };
}

/**
 * The criteria whose spec text has a complete Input | Expected table of JSON cells, the only ones a
 * task may name in rows. The planner gets this list (#1833): R56 hdrlens rejected 4 plans in 3 of 9
 * features for rows on prose criteria, each rejection one more planner step (25k to 40k tokens).
 */
export function rowsEligible(spec: Pick<Spec, "criteria">): string[] {
  return spec.criteria.filter((c) => literalRows(spec, [c.id]).length > 0).map((c) => c.id);
}

/** What the planner is told about rows: the note and the criteria it may name, or null for none. */
export function plannerRows(
  spec: Pick<Spec, "criteria">,
  policy: RunPolicy,
): { note: string; eligible: string[] } | null {
  if (!rowsAsDataOn(policy)) return null;
  const eligible = rowsEligible(spec);
  if (!eligible.length) return null;
  return {
    note: `${ROWS_NOTE} Only the criteria in eligible (${eligible.join(", ")}) have a table the host reads; name no other criterion in rows.`,
    eligible,
  };
}

export function rowPlanProblems(spec: Spec, graph: TaskGraph, policy: RunPolicy): string[] {
  const eligible = rowsEligible(spec);
  return graph.tasks.flatMap((task) => {
    if (!task.rows && !task.rowTest) return [];
    const fail = (why: string) => [`Task ${task.id}: acceptance rows ${why}.`];
    if (!rowsAsDataOn(policy))
      return [`Task ${task.id}: remove rows and rowTest; acceptance rows are off for this run.`];
    if (!task.rows?.length || !task.rowTest) return fail("require both rows and rowTest");
    if (task.sizingSlice) return fail("cannot share a sizing slice; use a separate harness task");
    const owned = () =>
      new Set(task.rows).size === task.rows?.length &&
      !task.rows.some((id) => !task.criterionIds.includes(id));
    const complete = () => {
      const rows = literalRows(spec, task.rows ?? []);
      return !task.rows?.some((id) => !rows.some((row) => row.criterionId === id));
    };
    const table = `need a complete Input | Expected table (an optional Scenario column) of JSON cells for every criterion; ${eligible.length ? `only ${eligible.join(", ")} ${eligible.length === 1 ? "has" : "have"} one, so name only those in rows or remove rows and rowTest` : "no criterion of the spec has one, so remove rows and rowTest"}`;
    if (inlineRows(task.rowTest)) {
      const problem = inlinePlanProblems(task, task.rowTest, graph);
      if (problem) return fail(problem);
      if (!owned()) return fail("must name distinct criteria owned by this task");
      return complete() ? [] : fail(table);
    }
    const { harness, test, data, framework } = task.rowTest;
    if (new Set([harness, test, data]).size !== 3) return fail("need three distinct paths");
    const layout = layoutProblem(task.rowTest);
    if (layout) return fail(layout);
    if (
      framework === "go" &&
      graph.tasks.some(
        (other) =>
          other.id !== task.id &&
          other.rowTest &&
          !inlineRows(other.rowTest) &&
          other.rowTest.framework === "go" &&
          posix.dirname(other.rowTest.harness) === posix.dirname(harness),
      )
    )
      return fail("need one Go harness per package directory, since each defines Actual");
    if (
      [harness, test, data].some(
        (path) =>
          !task.writes.some(
            (w) => w.path === path && w.action !== "delete" && w.content === undefined,
          ),
      )
    )
      return fail("must declare the harness, test and data writes without content");
    if ([test, data].some((path) => task.writes.find((w) => w.path === path)?.action !== "create"))
      return fail("test and data files must be new files");
    if (
      new Set(task.rows).size !== task.rows.length ||
      task.rows.some((id) => !task.criterionIds.includes(id))
    )
      return fail("must name distinct criteria owned by this task");
    if (
      [test, data].some((path) =>
        graph.tasks.some(
          (other) => other.id !== task.id && other.writes.some((w) => w.path === path),
        ),
      )
    )
      return fail("test and data files cannot have another writer");
    const rows = literalRows(spec, task.rows);
    if (task.rows.some((id) => !rows.some((row) => row.criterionId === id))) return fail(table);
    return [];
  });
}

/** Each emitted row needs its own successful audit entry, including rows after the first one. */
export function rowAuditProblems(
  spec: Spec,
  graph: TaskGraph,
  analysis: Analysis,
  requireSuccess = true,
): string[] {
  const rows = literalRows(spec, [...new Set(graph.tasks.flatMap((t) => t.rows ?? []))]);
  const owners = (analysis.derivations ?? []).map((d) => ({ d, row: auditedRowOf(d, rows) }));
  return rows.flatMap((row) => {
    const audited = owners.filter((o) => o.row === row).map((o) => o.d);
    return audited.length === 1 && (!requireSuccess || audited[0]?.matches)
      ? []
      : [
          `Acceptance row ${row.id} needs exactly one matching, successful derivation: ${row.source}`,
        ];
  });
}

export interface RowsArtifact {
  schemaVersion: 1;
  specHash: string;
  graphHash: string;
  analysisHash: string;
  audit: Analysis;
  tasks: Pick<Task, "id" | "rows" | "rowTest">[];
  rows: AcceptanceRow[];
}

export function rowsArtifact(spec: Spec, graph: TaskGraph, analysis: Analysis): RowsArtifact {
  return {
    schemaVersion: 1,
    specHash: hashJson(spec),
    graphHash: hashJson(graph),
    analysisHash: hashJson(analysis),
    audit: analysis,
    tasks: graph.tasks
      .filter((task) => task.rows?.length)
      .map(({ id, rows, rowTest }) => ({ id, rows, rowTest })),
    rows: literalRows(spec, [...new Set(graph.tasks.flatMap((t) => t.rows ?? []))]),
  };
}

const importPath = (from: string, to: string): string => {
  const path = posix.relative(posix.dirname(from), to);
  return path.startsWith(".") ? path : `./${path}`;
};

type Template = (input: FileRowTest & { rows: AcceptanceRow[] }) => string;

// Two short lines, so a long harness path alone overruns a linter's line length (#1927).
const header = (comment: string, harness: string): string =>
  `${comment} Host-written acceptance rows.\n${comment} Review the harness in ${harness}.\n`;
const camel = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("");

/** A Java string literal; control characters are octal escapes, never \u (read before lexing). */
const javaString = (text: string): string =>
  `"${[...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (ch === '"' || ch === "\\") return `\\${ch}`;
      return code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, "0")}` : ch;
    })
    .join("")}"`;
const javaValue = (value: unknown): string => {
  if (value === null) return "(Object) null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isInteger(value) ? `${value}L` : `${value}d`;
  if (typeof value === "string") return javaString(value);
  if (Array.isArray(value)) return `list(${value.map(javaValue).join(", ")})`;
  return `map(${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${javaString(key)}, ${javaValue(item)}`)
    .join(", ")})`;
};
/** C# reads JSON escapes in a regular literal, but U+0085, U+2028 and U+2029 end its line. */
const csharpString = (text: string): string =>
  JSON.stringify(text).replace(
    /[\u0085\u2028\u2029]/g,
    (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );

/**
 * One contract for every framework: the agent writes only the harness, and the host's test feeds
 * it each row's input and compares its result with the expected value as JSON data.
 */
const TEMPLATES: Record<RowTest["framework"], Template> = {
  bun: ({ harness, test, data }) =>
    `${header("//", harness)}import { expect, test } from "bun:test";\nimport { actual } from ${JSON.stringify(importPath(test, harness))};\nimport rows from ${JSON.stringify(importPath(test, data))};\ntest.each(rows)("$id", async (row) => {\n  expect(await actual(row.input)).toEqual(row.expected);\n});\n`,
  // In isort's groups and ruff's and black's layout at any line length (#1927).
  pytest: ({ harness, test, data }) =>
    `${header("#", harness)}import importlib.util\nimport json\nfrom pathlib import Path\n\nimport pytest\n\n_base = Path(__file__).parent\n_harness_path = _base / ${JSON.stringify(importPath(test, harness))}\n_data_path = _base / ${JSON.stringify(importPath(test, data))}\n_spec = importlib.util.spec_from_file_location("rows_harness", _harness_path)\n_harness = importlib.util.module_from_spec(_spec)\n_spec.loader.exec_module(_harness)\n_rows = json.loads(_data_path.read_text(encoding="utf-8"))\n\n\n@pytest.mark.parametrize("row", _rows, ids=[row["id"] for row in _rows])\ndef test_acceptance_row(row):\n    assert _harness.actual(row["input"]) == row["expected"]\n`,
  // `go test` runs in the package directory, so the data path is relative to the test file.
  go: ({ harness, test, data, package: pkg }) =>
    `${header("//", harness)}package ${pkg}\n\nimport (\n\t"encoding/json"\n\t"os"\n\t"reflect"\n\t"testing"\n)\n\nfunc TestAcceptanceRows${camel(posix.basename(test, "_test.go"))}(t *testing.T) {\n\traw, err := os.ReadFile(${JSON.stringify(posix.relative(posix.dirname(test), data))})\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tvar rows []struct {\n\t\tID       string \`json:"id"\`\n\t\tInput    any    \`json:"input"\`\n\t\tExpected any    \`json:"expected"\`\n\t}\n\tif err := json.Unmarshal(raw, &rows); err != nil {\n\t\tt.Fatal(err)\n\t}\n\tfor _, row := range rows {\n\t\trow := row\n\t\tt.Run(row.ID, func(t *testing.T) {\n\t\t\tgot, err := Actual(row.Input)\n\t\t\tif err != nil {\n\t\t\t\tt.Fatal(err)\n\t\t\t}\n\t\t\ttext, err := json.Marshal(got)\n\t\t\tif err != nil {\n\t\t\t\tt.Fatal(err)\n\t\t\t}\n\t\t\tvar value any\n\t\t\tif err := json.Unmarshal(text, &value); err != nil {\n\t\t\t\tt.Fatal(err)\n\t\t\t}\n\t\t\tif !reflect.DeepEqual(value, row.Expected) {\n\t\t\t\twant, _ := json.Marshal(row.Expected)\n\t\t\t\tt.Fatalf("got %s, want %s", text, want)\n\t\t\t}\n\t\t})\n\t}\n}\n`,
  // Java has no JSON reader in its standard library, so the rows are Java literals here; the data
  // file still holds them for review and the case check.
  junit: ({ harness, test, package: pkg, rows }) =>
    `${header("//", harness)}package ${pkg};\n\nimport java.lang.reflect.Array;\nimport java.math.BigDecimal;\nimport java.util.ArrayList;\nimport java.util.Arrays;\nimport java.util.LinkedHashMap;\nimport java.util.List;\nimport java.util.Map;\nimport java.util.stream.Stream;\nimport org.junit.jupiter.api.Assertions;\nimport org.junit.jupiter.api.DynamicTest;\nimport org.junit.jupiter.api.TestFactory;\n\nclass ${posix.basename(test, ".java")} {\n  @TestFactory\n  Stream<DynamicTest> acceptanceRows() {\n    return Stream.of(\n${rows.map((row) => `        row(${javaString(row.id)}, ${javaValue(row.input)}, ${javaValue(row.expected)})`).join(",\n")});\n  }\n\n  private static DynamicTest row(String id, Object input, Object expected) {\n    return DynamicTest.dynamicTest(\n        id, () -> Assertions.assertEquals(normal(expected), normal(${posix.basename(harness, ".java")}.actual(input))));\n  }\n\n  private static Map<String, Object> map(Object... entries) {\n    Map<String, Object> out = new LinkedHashMap<>();\n    for (int i = 0; i < entries.length; i += 2) out.put((String) entries[i], entries[i + 1]);\n    return out;\n  }\n\n  private static List<Object> list(Object... items) {\n    return new ArrayList<>(Arrays.asList(items));\n  }\n\n  /** JSON numbers compare by value: 2, 2L and 2.0 are equal; collections compare as lists. */\n  private static Object normal(Object value) {\n    if (value == null || value instanceof String || value instanceof Boolean) return value;\n    if (value instanceof Character || value instanceof Enum) return value.toString();\n    if (value instanceof Double || value instanceof Float || value instanceof BigDecimal) {\n      double number = ((Number) value).doubleValue();\n      return number == Math.rint(number) && Math.abs(number) <= 9007199254740991d ? (Object) (long) number : (Object) number;\n    }\n    if (value instanceof Number) return ((Number) value).longValue();\n    if (value instanceof Map) {\n      Map<String, Object> out = new LinkedHashMap<>();\n      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet())\n        out.put(String.valueOf(entry.getKey()), normal(entry.getValue()));\n      return out;\n    }\n    List<Object> out = new ArrayList<>();\n    if (value instanceof Iterable) {\n      for (Object item : (Iterable<?>) value) out.add(normal(item));\n      return out;\n    }\n    if (value.getClass().isArray()) {\n      for (int i = 0; i < Array.getLength(value); i++) out.add(normal(Array.get(value, i)));\n      return out;\n    }\n    return value;\n  }\n}\n`,
  rust: ({ harness, test, data }) =>
    `${header("//", harness)}#[path = ${JSON.stringify(posix.relative(posix.dirname(test), harness))}]\nmod harness;\n\nuse serde_json::Value;\n\n/// JSON numbers compare by value, so 2 and 2.0 are equal.\nfn same(a: &Value, b: &Value) -> bool {\n    match (a, b) {\n        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),\n        (Value::Array(x), Value::Array(y)) => {\n            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))\n        }\n        (Value::Object(x), Value::Object(y)) => {\n            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map_or(false, |w| same(v, w)))\n        }\n        _ => a == b,\n    }\n}\n\n#[test]\nfn acceptance_rows() {\n    let rows: Vec<Value> =\n        serde_json::from_str(include_str!(${JSON.stringify(posix.relative(posix.dirname(test), data))})).expect("acceptance rows");\n    let mut failed = Vec::new();\n    for row in &rows {\n        let got = harness::actual(row["input"].clone());\n        if !same(&got, &row["expected"]) {\n            failed.push(format!("{}: got {}, want {}", row["id"], got, row["expected"]));\n        }\n    }\n    assert!(failed.is_empty(), "{}", failed.join("\\n"));\n}\n`,
  // A test project's output directory holds no source files, so the rows are a literal here too.
  xunit: ({ harness, test, package: pkg, rows }) =>
    `${header("//", harness)}using System.Collections.Generic;\nusing System.Text.Json;\nusing System.Text.Json.Nodes;\nusing Xunit;\n\nnamespace ${pkg}\n{\n    public class ${posix.basename(test, ".cs")}\n    {\n        private const string Rows = ${csharpString(JSON.stringify(rows.map(({ id, input, expected }) => ({ id, input, expected }))))};\n\n        public static IEnumerable<object[]> Data()\n        {\n            foreach (var row in JsonNode.Parse(Rows)!.AsArray())\n                yield return new object[]\n                {\n                    (string)row!["id"]!,\n                    row["input"]?.ToJsonString() ?? "null",\n                    row["expected"]?.ToJsonString() ?? "null",\n                };\n        }\n\n        [Theory]\n        [MemberData(nameof(Data))]\n        public void AcceptanceRow(string id, string input, string expected)\n        {\n            var actual = JsonSerializer.SerializeToNode(${posix.basename(harness, ".cs")}.Actual(JsonNode.Parse(input)));\n            Assert.True(\n                JsonNode.DeepEquals(actual, JsonNode.Parse(expected)),\n                $"{id}: got {actual?.ToJsonString() ?? "null"}, want {expected}");\n        }\n    }\n}\n`,
};

/** A file the host writes for a rows task: a whole file, or the blocks of an inline test file. */
export type RowFile = { path: string; content: string; inline?: undefined } | InlineRowFile;

/** No input or expected value is evaluated as source code; literals are escaped data. */
export function rowFiles(task: Task, artifact: RowsArtifact): RowFile[] {
  if (!task.rows?.length || !task.rowTest) return [];
  // A corrective of a rows task carries its rows and test under its own ID.
  if (
    !artifact.tasks.some(
      (selected) =>
        hashJson({ rows: selected.rows, rowTest: selected.rowTest }) ===
        hashJson({ rows: task.rows, rowTest: task.rowTest }),
    )
  )
    throw new WorkflowFault(
      "INPUT_CHANGED",
      `Acceptance rows for ${task.id} belong to an earlier plan; analyze again`,
    );
  const rows = artifact.rows.filter((row) => task.rows?.includes(row.criterionId));
  if (task.rows.some((id) => !rows.some((row) => row.criterionId === id)))
    throw new WorkflowFault(
      "ARTIFACT_MISSING",
      `Acceptance rows for ${task.id} are incomplete; analyze again`,
    );
  if (inlineRows(task.rowTest)) return [inlineRowFile(task.rowTest, rows)];
  const { framework, data, test } = task.rowTest;
  const content = TEMPLATES[framework]({ ...task.rowTest, rows });
  return [
    { path: data, content: `${JSON.stringify(rows, null, 2)}\n` },
    { path: test, content },
  ];
}

export async function rowFileProblems(
  root: string,
  files: ReturnType<typeof rowFiles>,
): Promise<string[]> {
  const problems = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(workspacePath(root, file.path), "utf8").catch(() => null);
      if (file.inline)
        return hasInlineRows(text, file)
          ? []
          : [
              `Host-written acceptance rows block in ${file.path} is missing or changed; restore it and edit only the harness and your own tests.`,
            ];
      // A formatter gate's fixer may lay a host file out again (#1927).
      return text !== null &&
        (text === file.content || layoutFree(text) === layoutFree(file.content))
        ? []
        : [
            `Host-written acceptance file ${file.path} is missing or changed; restore it and edit only the harness.`,
          ];
    }),
  );
  return problems.flat();
}

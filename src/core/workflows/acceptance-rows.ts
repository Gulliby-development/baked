import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
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
const normalized = (text: string): string => {
  try {
    return JSON.stringify(cellsOf(text).map((cell) => JSON.parse(cell)));
  } catch {
    return text;
  }
};
const finiteJson = (value: unknown): boolean => {
  if (typeof value === "number")
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) return value.every(finiteJson);
  return value === null || typeof value !== "object" || Object.values(value).every(finiteJson);
};

/** Only an explicit two-column JSON table is data. Prose and executable expressions stay manual. */
export function literalRows(spec: Pick<Spec, "criteria">, ids: readonly string[]): AcceptanceRow[] {
  return spec.criteria.flatMap((criterion) => {
    if (!ids.includes(criterion.id) || criterion.method !== "automated" || criterion.property)
      return [];
    const result: AcceptanceRow[] = [];
    for (const text of [criterion.given, criterion.when, criterion.then]) {
      let table = false;
      for (const line of text.split(/\r?\n/)) {
        const cells = cellsOf(line);
        if (cells.length !== 2) {
          if (table && line.includes("|")) return [];
          table = false;
          continue;
        }
        if (/^input$/i.test(cells[0] ?? "") && /^expected$/i.test(cells[1] ?? "")) {
          table = true;
          continue;
        }
        if (!table || cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
        try {
          const input: unknown = JSON.parse(cells[0] ?? "");
          const expected: unknown = JSON.parse(cells[1] ?? "");
          if (!finiteJson(input) || !finiteJson(expected)) return [];
          result.push({
            id: `${criterion.id}:${result.length + 1}`,
            criterionId: criterion.id,
            source: line.trim(),
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
  'Acceptance rows as data is enabled. For pure call-and-compare tests with JSON Input | Expected tables, set rows to the criterion IDs and rowTest to {framework: "bun" or "pytest", harness: "relative harness path", test: "relative test path", data: "relative JSON path"}. Declare all three paths in writes, with test and data created by this task. Write only the harness: export actual(input) for Bun, or def actual(input) for pytest. It may be async for Bun. The host writes the JSON rows and the parameterized tests, preserving row IDs. Keep stateful, process, file and non-JSON cases in ordinary agent-written tests. Do not mark a criterion unless its whole table fits one harness.';

export function rowPlanProblems(spec: Spec, graph: TaskGraph, policy: RunPolicy): string[] {
  return graph.tasks.flatMap((task) => {
    if (!task.rows && !task.rowTest) return [];
    const fail = (why: string) => [`Task ${task.id}: acceptance rows ${why}.`];
    if (!rowsAsDataOn(policy)) return fail('require rowsAsData: "on"');
    if (!task.rows?.length || !task.rowTest) return fail("require both rows and rowTest");
    if (task.sizingSlice) return fail("cannot share a sizing slice; use a separate harness task");
    const { harness, test, data, framework } = task.rowTest;
    if (new Set([harness, test, data]).size !== 3) return fail("need three distinct paths");
    if (
      !data.endsWith(".json") ||
      (framework === "bun"
        ? !/\.(?:test|spec)\.[jt]s$/.test(test) || !/\.[jt]s$/.test(harness)
        : !/(?:^|\/)test_[^/]+\.py$/.test(test) || !harness.endsWith(".py"))
    )
      return fail("need framework test, harness and JSON file extensions");
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
    if (task.rows.some((id) => !rows.some((row) => row.criterionId === id)))
      return fail("need a complete JSON Input | Expected table for every criterion");
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
  return rows.flatMap((row) => {
    const audited = (analysis.derivations ?? []).filter(
      (d) => d.criterionId === row.criterionId && normalized(d.row) === normalized(row.source),
    );
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

/** No input or expected value is evaluated as source code. Both frameworks load the same JSON. */
export function rowFiles(task: Task, artifact: RowsArtifact): { path: string; content: string }[] {
  if (!task.rows?.length || !task.rowTest) return [];
  if (
    !artifact.tasks.some(
      (selected) =>
        selected.id === task.id &&
        hashJson({ rows: selected.rows, rowTest: selected.rowTest }) ===
          hashJson({ rows: task.rows, rowTest: task.rowTest }),
    )
  )
    throw new WorkflowFault(
      "INPUT_CHANGED",
      `Acceptance rows for ${task.id} belong to an earlier plan; analyze again`,
    );
  const { framework, harness, test, data } = task.rowTest;
  const rows = artifact.rows.filter((row) => task.rows?.includes(row.criterionId));
  if (task.rows.some((id) => !rows.some((row) => row.criterionId === id)))
    throw new WorkflowFault(
      "ARTIFACT_MISSING",
      `Acceptance rows for ${task.id} are incomplete; analyze again`,
    );
  const content =
    framework === "bun"
      ? `// Host-written acceptance rows. Review the harness in ${harness}.\nimport { expect, test } from "bun:test";\nimport { actual } from ${JSON.stringify(importPath(test, harness))};\nimport rows from ${JSON.stringify(importPath(test, data))};\ntest.each(rows)("$id", async (row) => {\n  expect(await actual(row.input)).toEqual(row.expected);\n});\n`
      : `# Host-written acceptance rows. Review the harness in ${harness}.\nimport importlib.util\nimport json\nfrom pathlib import Path\nimport pytest\n\n_base = Path(__file__).parent\n_spec = importlib.util.spec_from_file_location("acceptance_harness", _base / ${JSON.stringify(importPath(test, harness))})\n_harness = importlib.util.module_from_spec(_spec)\n_spec.loader.exec_module(_harness)\n_rows = json.loads((_base / ${JSON.stringify(importPath(test, data))}).read_text(encoding="utf-8"))\n\n@pytest.mark.parametrize("row", _rows, ids=[row["id"] for row in _rows])\ndef test_acceptance_row(row):\n    assert _harness.actual(row["input"]) == row["expected"]\n`;
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
    files.map(async (file) =>
      (await readFile(workspacePath(root, file.path), "utf8").catch(() => null)) === file.content
        ? []
        : [
            `Host-written acceptance file ${file.path} is missing or changed; restore it and edit only the harness.`,
          ],
    ),
  );
  return problems.flat();
}

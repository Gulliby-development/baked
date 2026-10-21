import { posix } from "node:path";
import type { RowsArtifact } from "./acceptance-rows.js";
import { INLINE_HARNESS, type InlineRowFile, inlineRowFile } from "./acceptance-rows-inline.js";
import type { AcceptanceRow } from "./acceptance-rows-model.js";
import { writtenCodePaths } from "./check-policy.js";
import type { TaskGraph } from "./schemas.js";
import { isTestTask } from "./tests-first.js";
import type { Task } from "./types.js";

type Framework = keyof typeof INLINE_HARNESS;

/**
 * Row replay (#1617): a source task's code meets the audited rows of the criteria it implements
 * before it is accepted, not when a later test task fails on it and cannot edit the source. Four
 * of six correctives of bench round 53 (1.80M tokens) fixed a source defect an audited row
 * already named. The agent writes a one-shot harness file that calls its code; the host appends
 * the inline rows block of the row task's framework (#1763), runs it with the project's own test
 * command for that one file, and removes it. The file is never part of the task's writes.
 */
export interface RowReplay {
  /** The row task whose rows and framework the replay uses. */
  rowTaskId: string;
  criteria: string[];
  rows: AcceptanceRow[];
  /** The block and path of the one-shot harness file. */
  file: InlineRowFile;
  framework: Framework;
  /** The Go package, Java package or C# namespace of the harness file. */
  package?: string;
  /** The class the harness defines (JUnit, xUnit), named after the file. */
  className?: string;
}

/** The harness file in the row test's directory, named so the project's test command finds it. */
const REPLAY_FILE: Record<Framework, (dir: string, id: string, test: string) => string> = {
  bun: (dir, id, test) =>
    posix.join(dir, `baked-replay-${id}.test.${/\.jsx?$/.test(test) ? "js" : "ts"}`),
  pytest: (dir, id) => posix.join(dir, `test_baked_replay_${id}.py`),
  go: (dir, id) => posix.join(dir, `baked_replay_${id}_test.go`),
  rust: (_dir, id) => `tests/baked_replay_${id}.rs`,
  junit: (dir, id) => posix.join(dir, `BakedReplay${id.toUpperCase()}Test.java`),
  xunit: (dir, id) => posix.join(dir, `BakedReplay${id.toUpperCase()}Tests.cs`),
};

const dependencies = (graph: Pick<TaskGraph, "tasks">, id: string): Set<string> => {
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return seen;
};

/**
 * The replay a source task runs before it is accepted, or null: a task that writes code and no
 * rows of its own, and implements a criterion whose audited rows a row task that does not come
 * before it tests. With several such row tasks, the one with the most of the task's rows.
 */
export function rowReplay(
  graph: Pick<TaskGraph, "tasks"> | null | undefined,
  artifact: Pick<RowsArtifact, "tasks" | "rows">,
  task: Task,
): RowReplay | null {
  if (!graph || task.rows?.length || isTestTask(task) || !writtenCodePaths(task).length)
    return null;
  const before = dependencies({ tasks: [...graph.tasks, task] }, task.id);
  const options = artifact.tasks.flatMap((rowTask) => {
    if (rowTask.id === task.id || before.has(rowTask.id) || !rowTask.rowTest) return [];
    const criteria = (rowTask.rows ?? []).filter((id) => task.criterionIds.includes(id));
    const rows = artifact.rows.filter((row) => criteria.includes(row.criterionId));
    return rows.length ? [{ rowTask, criteria, rows }] : [];
  });
  const best = options.sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!best?.rowTask.rowTest) return null;
  const { framework, package: pkg, test } = best.rowTask.rowTest;
  const path = REPLAY_FILE[framework](posix.dirname(test), task.id.toLowerCase(), test);
  return {
    rowTaskId: best.rowTask.id,
    criteria: best.criteria,
    rows: best.rows,
    file: inlineRowFile(
      { mode: "inline", framework, ...(pkg ? { package: pkg } : {}), test: path },
      best.rows,
    ),
    framework,
    ...(pkg ? { package: pkg } : {}),
    ...(framework === "junit" || framework === "xunit"
      ? { className: posix.basename(path).replace(/\.\w+$/, "") }
      : {}),
  };
}

/** What the replay tells the agent: the file, the harness it defines and a few rows. */
export function replayNote(replay: RowReplay): string {
  const where = [
    replay.package
      ? `${replay.framework === "xunit" ? "namespace" : "package"} ${replay.package}`
      : "",
    replay.className ? `class ${replay.className}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `Before this task is accepted the host replays the ${replay.rows.length} audited rows of ${replay.criteria.join(", ")} against your code. Call replay_rows with harness: the whole source of the ${replay.framework} test file ${replay.file.path}${where ? ` (${where})` : ""}, which defines ${INLINE_HARNESS[replay.framework]}(input) as the inline rows mode does: it calls this task's public entry point with the row's JSON input and returns the result as the row's expected JSON value (an error as the value the row expects for it). The host appends the rows block, runs that one file with the project's test command, and removes it: the file is not one of this task's writes and needs no edit tool. Fix the code for each failing row, not the rows. Rows: ${replay.rows
    .slice(0, 3)
    .map((row) => `${row.id} ${JSON.stringify(row.input)} -> ${JSON.stringify(row.expected)}`)
    .join("; ")}${replay.rows.length > 3 ? "; ..." : ""}.`;
}

export interface ReplayResult {
  /** `failed`: rows did not hold; `error`: the file did not build or run, so no row was decided. */
  status: "passed" | "failed" | "error";
  failed: string[];
  output: string;
}

const FAILURE_LINE = /\b(?:fail(?:ed|ure)?|error|got)\b|✗/i;
const OUTPUT_TAIL = 4000;

/** A run of the harness file read as rows: the IDs on failure lines, or an error with its output. */
export function replayResult(
  status: "passed" | "failed" | "inconclusive",
  output: string,
  rows: readonly AcceptanceRow[],
): ReplayResult {
  if (status === "passed") return { status: "passed", failed: [], output: "" };
  const lines = output.split(/\r?\n/).filter((line) => FAILURE_LINE.test(line));
  const failed = rows
    .filter((row) => lines.some((line) => line.includes(row.id)))
    .map((row) => row.id);
  const tail = output.slice(-OUTPUT_TAIL);
  if (status === "failed" && failed.length) {
    const named = lines.filter((line) => failed.some((id) => line.includes(id)));
    return { status: "failed", failed, output: named.join("\n").slice(-OUTPUT_TAIL) || tail };
  }
  return { status: "error", failed: [], output: tail };
}

/** The refusal lines of a result, keyed so the same list is not refused twice. */
export function replayProblems(replay: RowReplay, result: ReplayResult | null): string[] {
  if (!result)
    return [
      `The audited rows of ${replay.criteria.join(", ")} were not replayed: call replay_rows with a harness for ${replay.file.path}.`,
    ];
  if (result.status === "passed") return [];
  if (result.status === "error")
    return [`The row replay file ${replay.file.path} did not run: ${result.output.trim()}`];
  const rows = new Map(replay.rows.map((row) => [row.id, row]));
  return result.failed.map((id) => {
    const row = rows.get(id);
    return `Row ${id} fails: ${JSON.stringify(row?.input)} should give ${JSON.stringify(row?.expected)} (${row?.source ?? ""}).`;
  });
}

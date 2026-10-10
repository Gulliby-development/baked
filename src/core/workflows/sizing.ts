import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STAGE_RANGES, rangeOf, type TokenRange } from "./estimate.js";
import type { RunPolicy, TaskGraph } from "./schemas.js";
import { DEFAULT_MAX_ATTEMPT_TOKENS } from "./step-budget.js";
import type { Task } from "./types.js";

/**
 * Plan-time sizing. Once the plan names the tasks and the files they write, each task is priced
 * per written file by the kind of file: tests cost far more than code, and the size of a file says
 * little about the size of its change. The rates are the tokens earlier tasks of the same kind
 * spent per file to get done, their corrective tasks included. The price sets each task's attempt
 * cap, raises the run budget up to the ceiling the policy allows, and decides when a plan is too
 * large and must be split.
 */

export type FileKind = "code" | "test";
export type TaskKind = FileKind | "mixed";

/** One finished task of history: what it took to get done and what kind of files it wrote. */
export interface SizingSample {
  runId: string;
  taskId: string;
  kind: TaskKind;
  files: number;
  /** Tokens of the task's attempts and of the corrective tasks that wrote the same files. */
  tokens: number;
}

/** Tokens per written file when history has no task of the kind; measured on this project. */
export const DEFAULT_PER_FILE: Record<FileKind, TokenRange> = {
  code: { low: 30_000, high: 100_000 },
  test: { low: 150_000, high: 350_000 },
};
/** Steps of a test task attempt when the policy names none; test tasks ran out at 20. */
export const DEFAULT_TEST_TASK_STEPS = 32;
/** Without a configured ceiling, a task attempt may grow to this. */
export const DEFAULT_MAX_SIZED_ATTEMPT = 600_000;
/** A correction round of review and convergence on top of one pass. */
const VERIFICATION_FACTOR = 1.5;

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
export const fileKind = (path: string): FileKind => (TEST_PATH.test(path) ? "test" : "code");

function writtenFiles(task: Pick<Task, "writes">): string[] {
  return task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
}
export function taskKind(task: Pick<Task, "writes">): TaskKind {
  const kinds = new Set(writtenFiles(task).map(fileKind));
  return kinds.size === 1 ? ([...kinds][0] as FileKind) : "mixed";
}

/**
 * Finished tasks of a workflow store, read-only. A corrective task is not a sample of its own: its
 * tokens join the planned task of the same run that writes the same files, because getting that
 * task done took both.
 */
export function samplesFrom(databasePath: string): SizingSample[] {
  if (!existsSync(databasePath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true });
    const runs = db.query<{ id: string }, []>("SELECT id FROM runs WHERE status='completed'").all();
    const samples: SizingSample[] = [];
    for (const { id } of runs) {
      const tasks = db
        .query<{ id: string; definition_json: string }, [string]>(
          "SELECT id, definition_json FROM tasks WHERE run_id=? AND status='verified'",
        )
        .all(id)
        .map((row) => ({
          id: row.id,
          ...(JSON.parse(row.definition_json) as Pick<Task, "writes" | "origin">),
        }));
      const spent = new Map(
        db
          .query<{ stage: string; tokens: number | null }, [string]>(
            `SELECT s.stage_id AS stage, SUM(COALESCE(a.used_tokens,0)) AS tokens FROM attempts a
             JOIN steps s ON s.run_id=a.run_id AND s.id=a.step_id
             WHERE a.run_id=? AND s.stage_id LIKE 'task-%' AND a.model_id IS NOT NULL
             GROUP BY s.stage_id`,
          )
          .all(id)
          .map((row) => [row.stage, row.tokens ?? 0]),
      );
      const planned = tasks.filter((task) => task.origin === "planned");
      const totals = new Map(planned.map((task) => [task.id, spent.get(`task-${task.id}`) ?? 0]));
      for (const correction of tasks.filter((task) => task.origin !== "planned")) {
        const files = writtenFiles(correction);
        const base = planned.find((task) =>
          files.every((path) => writtenFiles(task).includes(path)),
        );
        if (base)
          totals.set(
            base.id,
            (totals.get(base.id) ?? 0) + (spent.get(`task-${correction.id}`) ?? 0),
          );
      }
      for (const task of planned) {
        const files = writtenFiles(task).length;
        const tokens = totals.get(task.id) ?? 0;
        if (files > 0 && tokens > 0)
          samples.push({ runId: id, taskId: task.id, kind: taskKind(task), files, tokens });
      }
    }
    return samples;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** History from this run's own store and the extra stores the policy names, without duplicates. */
export function sizingHistory(workspace: string, policy: RunPolicy): SizingSample[] {
  const stores = [
    join(workspace, ".baked", "workflows.sqlite"),
    ...(policy.sizing?.historyStores ?? []).map((path) =>
      path.endsWith(".sqlite") ? path : join(path, ".baked", "workflows.sqlite"),
    ),
  ];
  const seen = new Set<string>();
  return stores
    .flatMap((path) => samplesFrom(path))
    .filter((sample) => {
      const key = `${sample.runId}/${sample.taskId}`;
      return !seen.has(key) && seen.add(key);
    });
}

export interface KindRate {
  perFile: TokenRange;
  samples: number;
  basis: "history" | "defaults";
}

/** Tokens per written file of each kind, from tasks that wrote only files of that kind. */
export function perFileRates(samples: SizingSample[]): Record<FileKind, KindRate> {
  const rate = (kind: FileKind): KindRate => {
    const own = samples.filter((sample) => sample.kind === kind);
    const range = rangeOf(own.map((sample) => sample.tokens / sample.files));
    return range
      ? { perFile: range, samples: own.length, basis: "history" }
      : { perFile: DEFAULT_PER_FILE[kind], samples: 0, basis: "defaults" };
  };
  return { code: rate("code"), test: rate("test") };
}

export interface TaskSize {
  taskId: string;
  kind: TaskKind;
  files: number;
  /** Tokens the task is expected to need to get done, its corrections included. */
  estimate: TokenRange;
  /** Cap for one attempt of this task. */
  attemptTokens: number;
  /** Step cap for one attempt; null keeps the profile's and the policy's. */
  attemptSteps: number | null;
  /** Above one attempt and writes several files: the plan should split it. */
  oversized: boolean;
}

export interface SizingReport {
  schemaVersion: 2;
  rates: Record<FileKind, KindRate>;
  tasks: TaskSize[];
  /** Tokens the run is expected to need in total, from what it spent so far. */
  runTokens: number;
  budgetBefore: number;
  budgetAfter: number;
  maxAttemptTokens: number;
  maxRunTokens: number | null;
  decision: "fits" | "raise-budget" | "split-tasks" | "split-feature";
  reasons: string[];
}

/** One task's price: the per-file rate of each file it writes, summed. */
export function priceTask(
  task: Pick<Task, "writes">,
  rates: Record<FileKind, KindRate>,
): TokenRange {
  return writtenFiles(task).reduce(
    (total, path) => {
      const rate = rates[fileKind(path)].perFile;
      return { low: total.low + rate.low, high: total.high + rate.high };
    },
    { low: 0, high: 0 },
  );
}

/**
 * Prices a planned graph. `spent` is what the run used before implementation; the review and
 * convergence stages are priced at their generic upper range plus a correction round.
 */
export function sizePlan(input: {
  graph: TaskGraph;
  policy: RunPolicy;
  samples: SizingSample[];
  spent: number;
}): SizingReport {
  const rates = perFileRates(input.samples);
  const maxAttemptTokens = input.policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxRunTokens = input.policy.sizing?.maxRunTokens ?? null;
  const floor = input.policy.maxAttemptTokens ?? DEFAULT_MAX_ATTEMPT_TOKENS;
  const testSteps = input.policy.sizing?.testTaskSteps ?? DEFAULT_TEST_TASK_STEPS;
  const tasks = input.graph.tasks
    .filter((task) => writtenFiles(task).length > 0)
    .map((task): TaskSize => {
      const estimate = priceTask(task, rates);
      const files = writtenFiles(task).length;
      return {
        taskId: task.id,
        kind: taskKind(task),
        files,
        estimate,
        attemptTokens: Math.min(maxAttemptTokens, Math.max(floor, Math.round(estimate.high))),
        attemptSteps: taskKind(task) === "test" ? testSteps : null,
        oversized: files > 1 && estimate.high > maxAttemptTokens,
      };
    });
  const verification =
    ((DEFAULT_STAGE_RANGES.review?.high ?? 0) + (DEFAULT_STAGE_RANGES.converge?.high ?? 0)) *
    VERIFICATION_FACTOR;
  const runTokens = Math.round(
    input.spent + tasks.reduce((total, task) => total + task.estimate.high, 0) + verification,
  );
  const budgetBefore = input.policy.maxTotalTokens;
  const reasons: string[] = [];
  let decision: SizingReport["decision"] = "fits";
  let budgetAfter = budgetBefore;
  const oversized = tasks.filter((task) => task.oversized);
  if (maxRunTokens !== null && runTokens > maxRunTokens) {
    decision = "split-feature";
    reasons.push(
      `The plan needs about ${runTokens} tokens, above the ${maxRunTokens} the policy allows one run`,
    );
  } else if (oversized.length) {
    decision = "split-tasks";
    for (const task of oversized)
      reasons.push(
        `${task.taskId} writes ${task.files} files and needs about ${Math.round(task.estimate.high)} tokens, above one attempt's ${maxAttemptTokens}`,
      );
  }
  if (runTokens > budgetBefore && maxRunTokens !== null) {
    budgetAfter = Math.min(maxRunTokens, runTokens);
    if (decision === "fits") decision = "raise-budget";
    reasons.push(`The run budget grows from ${budgetBefore} to ${budgetAfter} tokens`);
  }
  return {
    schemaVersion: 2,
    rates,
    tasks,
    runTokens,
    budgetBefore,
    budgetAfter,
    maxAttemptTokens,
    maxRunTokens,
    decision,
    reasons,
  };
}

/** How many code files one attempt covers, and what the planner is told before it plans. */
export function plannerSizing(
  policy: RunPolicy,
  samples: SizingSample[],
): { maxCodeFilesPerTask: number; note: string } {
  const rates = perFileRates(samples);
  const maxAttemptTokens = policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxCodeFilesPerTask = Math.max(1, Math.floor(maxAttemptTokens / rates.code.perFile.high));
  return {
    maxCodeFilesPerTask,
    note: `Give every task that writes code the policy's typecheck check, so its errors show in that task. Put tests in tasks of their own: a test file costs about ${Math.round(rates.test.perFile.high / 1000)}k tokens, a code file about ${Math.round(rates.code.perFile.high / 1000)}k. Keep each code task to at most ${maxCodeFilesPerTask} files. Give tasks that can be built independently disjoint writes and no dependency between them, so they run in parallel and are merged afterwards; a test task depends on the code tasks whose criteria it covers.`,
  };
}

const SOURCE = /\.[cm]?[jt]sx?$/i;

/**
 * The policy's task-scope typecheck check: the one named `typecheck`, else one that runs
 * `typecheck` or `tsc`. A feature-scope check does not run per task, so naming it would not help.
 */
export function typecheckCheckId(policy: RunPolicy): string | null {
  const checks = policy.checks.filter((c) => c.scope === "task");
  const check =
    checks.find((c) => c.id === "typecheck") ??
    checks.find((c) => /\b(typecheck|tsc)\b/.test([c.executable, ...c.args].join(" ")));
  return check?.id ?? null;
}

/**
 * A test task waits for the code tasks whose criteria it covers. Planners told to keep
 * independent tasks free of dependencies also left tests without them, and a test task that ran
 * beside its code spent 398k before the code existed (run 6bb3052f).
 */
export function withTestDependencies(graph: TaskGraph): TaskGraph {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.dependsOn ?? []).some((id) => reaches(id, to, seen));
  };
  const tasks = graph.tasks.map((task) => {
    if (taskKind(task) !== "test") return task;
    const added = graph.tasks
      .filter(
        (code) =>
          code.id !== task.id &&
          taskKind(code) !== "test" &&
          code.criterionIds.some((id) => task.criterionIds.includes(id)) &&
          !reaches(task.id, code.id) &&
          !reaches(code.id, task.id),
      )
      .map((code) => code.id);
    return added.length ? { ...task, dependsOn: [...task.dependsOn, ...added] } : task;
  });
  return { ...graph, tasks };
}

/**
 * Returned to the planner at submission when sizing is on: a task that writes source code and
 * does not name the policy's typecheck check would show its type errors only in a later task.
 */
export function codeTaskCheckProblems(graph: TaskGraph, policy: RunPolicy): string[] {
  const id = policy.sizing ? typecheckCheckId(policy) : null;
  if (!id) return [];
  return graph.tasks
    .filter(
      (task) =>
        writtenFiles(task).some((path) => fileKind(path) === "code" && SOURCE.test(path)) &&
        !task.checkIds.includes(id),
    )
    .map(
      (task) =>
        `Task ${task.id} writes source code but its checkIds do not name the policy check ${id}; add it so its type errors show in that task.`,
    );
}

/** The note that sends an oversized plan back to the planner once. */
export function splitNote(report: SizingReport, maxCodeFilesPerTask: number): string {
  return `Sizing: the plan is too large for its attempts. ${report.reasons.join(". ")}. Re-plan with smaller tasks: tests in tasks of their own, at most ${maxCodeFilesPerTask} code files per task, disjoint writes and no dependency between tasks where possible, so they run in parallel.`;
}

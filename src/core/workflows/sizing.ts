import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STAGE_RANGES, historyStorePaths, rangeOf, type TokenRange } from "./estimate.js";
import type { RunPolicy, TaskGraph } from "./schemas.js";
import { DEFAULT_MAX_ATTEMPT_TOKENS } from "./step-budget.js";
import type { Task } from "./types.js";

/**
 * Plan-time sizing. Once the plan names the tasks and the files they write, each task is priced
 * per written file by the kind of file (code, test or docs) and by whether the task creates or
 * modifies it: tests cost far more than code, a README cost more than a code file, and editing
 * existing code cost more than writing new code. The size of a file says little about the size of
 * its change. The rates are the tokens earlier tasks of the same kind spent per file to get done,
 * their corrective tasks included, taken from this project's own runs first: rates carried over
 * from another project were off in both directions. The price sets each task's attempt cap, raises
 * the run budget up to the ceiling the policy allows, and decides when a plan is too large and
 * must be split.
 */

export type FileKind = "code" | "test" | "docs";
export type TaskKind = FileKind | "mixed";
export type WriteAction = "create" | "modify";
export const WRITE_ACTIONS: readonly WriteAction[] = ["create", "modify"];

/** One finished task of history: what it took to get done and what kind of files it wrote. */
export interface SizingSample {
  runId: string;
  taskId: string;
  kind: TaskKind;
  /** Whether the task created or modified its files; mixed when it did both. */
  action: WriteAction | "mixed";
  /** This project's own store, or a store the policy names in `historyStores`. */
  source: "project" | "shared";
  files: number;
  /** Tokens of the task's attempts and of the corrective tasks that wrote the same files. */
  tokens: number;
  /** The model that spent most of the task's own tokens; null in history without attempts. */
  model: string | null;
}

/**
 * Tokens per written file when history has no task of the kind. They are wide on purpose: they
 * must hold for any provider and model, and a cap that is too low costs a failed attempt while one
 * that is too high costs nothing that is not spent.
 */
export const DEFAULT_PER_FILE: Record<FileKind, Record<WriteAction, TokenRange>> = {
  code: { create: { low: 30_000, high: 100_000 }, modify: { low: 40_000, high: 130_000 } },
  test: { create: { low: 60_000, high: 350_000 }, modify: { low: 150_000, high: 350_000 } },
  docs: { create: { low: 40_000, high: 250_000 }, modify: { low: 60_000, high: 250_000 } },
};
/** This project's own samples of a kind and action needed before other projects' are left out. */
export const MIN_PROJECT_SAMPLES = 2;
/**
 * Samples of a kind, from any store, at which their own upper bound replaces the default's. With
 * fewer, a rate from elsewhere keeps the default's room; with this many the history is measured
 * well enough that the default high would only overprice (cronsay: 8 test samples, high 350k
 * against a measured 72k-ish median).
 */
export const MIN_HISTORY_SAMPLES = 6;
/**
 * Samples of a kind that the planned model ran, needed before other models' are left out. Models
 * spend differently on the same task: claude-code runs cost 1.3-1.5x the tokens per task of codex
 * runs (R04), so a switch of provider was priced with the other provider's rates.
 */
export const MIN_MODEL_SAMPLES = 2;
/** Steps of a test task attempt when the policy names none; test tasks ran out at 20. */
export const DEFAULT_TEST_TASK_STEPS = 32;
/** Without a configured ceiling, a task attempt may grow to this. */
export const DEFAULT_MAX_SIZED_ATTEMPT = 600_000;
/** A correction round of review and convergence on top of one pass. */
const VERIFICATION_FACTOR = 1.5;
/**
 * Share of the priced work kept in the run budget for repair and convergence tasks, which the
 * price does not include. In round 03 they were 30% of all tokens (md-site 34%, zoneslot 50%).
 */
export const REPAIR_RESERVE = 0.3;

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DOCS_EXTENSION = /\.(md|mdx|markdown|rst|adoc)$/i;
const DOCS_DIR = /(^|\/)docs?\//i;
const SOURCE = /\.[cm]?[jt]sx?$/i;
/** Documentation by extension anywhere, or a non-source file under `docs/`; then tests; else code. */
export const fileKind = (path: string): FileKind =>
  DOCS_EXTENSION.test(path) || (DOCS_DIR.test(path) && !SOURCE.test(path))
    ? "docs"
    : TEST_PATH.test(path)
      ? "test"
      : "code";

type Written = { path: string; action: WriteAction };
function written(task: Pick<Task, "writes">): Written[] {
  return task.writes.flatMap((w) =>
    w.action === "delete" ? [] : [{ path: w.path, action: w.action }],
  );
}
function writtenFiles(task: Pick<Task, "writes">): string[] {
  return written(task).map((w) => w.path);
}
export function taskKind(task: Pick<Task, "writes">): TaskKind {
  const kinds = new Set(writtenFiles(task).map(fileKind));
  return kinds.size === 1 ? ([...kinds][0] as FileKind) : "mixed";
}
function taskAction(task: Pick<Task, "writes">): SizingSample["action"] {
  const actions = new Set(written(task).map((w) => w.action));
  return actions.size === 1 ? ([...actions][0] as WriteAction) : "mixed";
}

/**
 * Finished tasks of a workflow store, read-only. A corrective task is not a sample of its own: its
 * tokens join the planned task of the same run that writes the same files, because getting that
 * task done took both.
 */
export function samplesFrom(
  databasePath: string,
  source: SizingSample["source"] = "project",
): SizingSample[] {
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
      const byModel = db
        .query<{ stage: string; model: string; tokens: number | null }, [string]>(
          `SELECT s.stage_id AS stage, a.model_id AS model, SUM(COALESCE(a.used_tokens,0)) AS tokens
           FROM attempts a JOIN steps s ON s.run_id=a.run_id AND s.id=a.step_id
           WHERE a.run_id=? AND s.stage_id LIKE 'task-%' AND a.model_id IS NOT NULL
           GROUP BY s.stage_id, a.model_id`,
        )
        .all(id);
      const spent = new Map<string, number>();
      const modelOf = new Map<string, { model: string; tokens: number }>();
      for (const row of byModel) {
        const tokens = row.tokens ?? 0;
        spent.set(row.stage, (spent.get(row.stage) ?? 0) + tokens);
        const top = modelOf.get(row.stage);
        if (!top || tokens > top.tokens) modelOf.set(row.stage, { model: row.model, tokens });
      }
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
          samples.push({
            runId: id,
            taskId: task.id,
            kind: taskKind(task),
            action: taskAction(task),
            source,
            files,
            tokens,
            model: modelOf.get(`task-${task.id}`)?.model ?? null,
          });
      }
    }
    return samples;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * History from this run's own store (this project) and the extra stores the policy names, without
 * duplicates; a run found in both counts as this project's.
 */
export function sizingHistory(workspace: string, policy: RunPolicy): SizingSample[] {
  const own = join(workspace, ".baked", "workflows.sqlite");
  const shared = historyStorePaths(workspace, policy);
  const seen = new Set<string>();
  return [samplesFrom(own, "project"), ...shared.map((path) => samplesFrom(path, "shared"))]
    .flat()
    .filter((sample) => {
      const key = `${sample.runId}/${sample.taskId}`;
      return !seen.has(key) && seen.add(key);
    });
}

export interface KindRate {
  perFile: TokenRange;
  samples: number;
  /**
   * `project`: this project's own tasks of the kind and action. `history`: too few of those, so
   * other projects' tasks and tasks that both created and modified count too, and the upper bound
   * is at least the default's. `defaults`: no task of the kind.
   */
  basis: "project" | "history" | "defaults";
  /**
   * The model whose tasks alone set the rate, or null when the rate is from every model: no model
   * was asked for, or it ran fewer than `MIN_MODEL_SAMPLES` tasks of the kind.
   */
  model: string | null;
}
export type Rates = Record<FileKind, Record<WriteAction, KindRate>>;

/**
 * Tokens per written file of each kind and action, from tasks that wrote only files of that kind.
 * This project's tasks that only created (or only modified) such files decide alone once there are
 * enough of them. Otherwise every task of the kind counts, from any store and with either action,
 * since a rate from elsewhere is a guess: it keeps at least the default upper bound, so a task it
 * underprices still gets the default's room.
 */
export function perFileRates(samples: SizingSample[], model: string | null = null): Rates {
  const perFile = (list: SizingSample[]) => rangeOf(list.map((s) => s.tokens / s.files));
  const rateOf = (
    samples: SizingSample[],
    kind: FileKind,
    action: WriteAction,
  ): Omit<KindRate, "model"> => {
    const fallback = DEFAULT_PER_FILE[kind][action];
    const ofKind = samples.filter((sample) => sample.kind === kind);
    const exact = ofKind.filter((sample) => sample.action === action);
    const project = exact.filter((sample) => sample.source === "project");
    const own = project.length >= MIN_PROJECT_SAMPLES ? perFile(project) : null;
    if (own) return { perFile: own, samples: project.length, basis: "project" };
    const pool = exact.length ? exact : ofKind;
    const range = perFile(pool);
    return range
      ? {
          perFile: {
            low: range.low,
            high:
              pool.length >= MIN_HISTORY_SAMPLES ? range.high : Math.max(range.high, fallback.high),
          },
          samples: pool.length,
          basis: "history",
        }
      : { perFile: fallback, samples: 0, basis: "defaults" };
  };
  const byAction = (kind: FileKind) => {
    // Only the planned model's tasks once it ran enough of the kind; else every model's.
    const own = model
      ? samples.filter((sample) => sample.kind === kind && sample.model === model)
      : [];
    const ofModel = own.length >= MIN_MODEL_SAMPLES ? model : null;
    return Object.fromEntries(
      WRITE_ACTIONS.map((action) => [
        action,
        { ...rateOf(ofModel ? own : samples, kind, action), model: ofModel },
      ]),
    ) as Record<WriteAction, KindRate>;
  };
  return { code: byAction("code"), test: byAction("test"), docs: byAction("docs") };
}

/** The highest per-file price of a kind, over creating and modifying. */
const highest = (rates: Rates, kind: FileKind): number =>
  Math.max(...WRITE_ACTIONS.map((action) => rates[kind][action].perFile.high));

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
  schemaVersion: 3;
  /** The model the tasks were priced for; null when none was known. */
  model: string | null;
  rates: Rates;
  tasks: TaskSize[];
  /**
   * Tokens the run is expected to need in total, from what it spent so far: the tasks' midpoints
   * plus a margin that grows with the square root of their number, not the sum of every task's
   * upper bound, since independent tasks do not all hit their worst case together.
   */
  runTokens: number;
  /** The tasks alone: the sum of their lower bounds, of their midpoints, and of their upper bounds. */
  taskTokens: { low: number; expected: number; high: number };
  /** Tokens held on top of the price for repair and convergence tasks. */
  repairReserve: number;
  budgetBefore: number;
  budgetAfter: number;
  maxAttemptTokens: number;
  maxRunTokens: number | null;
  decision: "fits" | "raise-budget" | "split-tasks" | "split-feature";
  reasons: string[];
}

/** One task's price: the per-file rate of each file it writes, by its kind and action, summed. */
export function priceTask(task: Pick<Task, "writes">, rates: Rates): TokenRange {
  return written(task).reduce(
    (total, { path, action }) => {
      const rate = rates[fileKind(path)][action].perFile;
      return { low: total.low + rate.low, high: total.high + rate.high };
    },
    { low: 0, high: 0 },
  );
}

/**
 * The price of a set of tasks: the sum of their midpoints plus the root of the summed squares of
 * their half-ranges. One task is priced at its upper bound; many independent ones well below the
 * sum of their upper bounds (seven priced runs of round 01 cost 0.36-0.77x the summed highs).
 */
export function taskTotal(estimates: TokenRange[]): {
  low: number;
  expected: number;
  high: number;
  price: number;
} {
  let low = 0;
  let high = 0;
  let squares = 0;
  for (const estimate of estimates) {
    low += estimate.low;
    high += estimate.high;
    squares += ((estimate.high - estimate.low) / 2) ** 2;
  }
  const expected = (low + high) / 2;
  return {
    low: Math.round(low),
    expected: Math.round(expected),
    high: Math.round(high),
    price: Math.round(Math.min(high, expected + Math.sqrt(squares))),
  };
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
  /** The model the tasks will run on; its own history prices them once it has enough. */
  model?: string | null;
}): SizingReport {
  const rates = perFileRates(input.samples, input.model ?? null);
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
  const taskTokens = taskTotal(tasks.map((task) => task.estimate));
  const priced = taskTokens.price + verification;
  const runTokens = Math.round(input.spent + priced);
  const repairReserve = Math.round(priced * REPAIR_RESERVE);
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
  if (runTokens + repairReserve > budgetBefore && maxRunTokens !== null) {
    budgetAfter = Math.max(budgetBefore, Math.min(maxRunTokens, runTokens + repairReserve));
    if (decision === "fits") decision = "raise-budget";
    reasons.push(
      budgetAfter > budgetBefore
        ? `The run budget grows from ${budgetBefore} to ${budgetAfter} tokens (${repairReserve} of it held for repair and convergence)`
        : `The run budget stays at ${budgetBefore} tokens, the policy's ceiling; the plan and its repair reserve of ${repairReserve} need about ${runTokens + repairReserve}`,
    );
  }
  return {
    schemaVersion: 3,
    model: input.model ?? null,
    rates,
    tasks,
    runTokens,
    taskTokens: { low: taskTokens.low, expected: taskTokens.expected, high: taskTokens.high },
    repairReserve,
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
  model: string | null = null,
): { maxCodeFilesPerTask: number; note: string } {
  const rates = perFileRates(samples, model);
  const maxAttemptTokens = policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxCodeFilesPerTask = Math.max(1, Math.floor(maxAttemptTokens / highest(rates, "code")));
  const k = (kind: FileKind) => `${Math.round(highest(rates, kind) / 1000)}k`;
  return {
    maxCodeFilesPerTask,
    note: `Give every task that writes code the policy's typecheck check, so its errors show in that task. Put tests in tasks of their own: a test file costs about ${k("test")} tokens, a code file about ${k("code")}, a documentation file about ${k("docs")}. Keep each code task to at most ${maxCodeFilesPerTask} files. Give tasks that can be built independently disjoint writes and no dependency between them, so they run in parallel and are merged afterwards; a test task depends on the code tasks whose criteria it covers. A test task above one attempt is split into one task per test file.`,
  };
}

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

/**
 * Splits each oversized test task into one task per test file, so the plan needs no second round
 * for it: test files rarely depend on each other, and a planner told to split a test task did not
 * (expenses-py-r4). The first file keeps the task's ID and the others get new ones; every part
 * keeps the task's criteria, checks and dependencies, and a task that depended on it depends on
 * every part. Returns null when no test task is oversized.
 */
export function splitTestTasks(graph: TaskGraph, report: SizingReport): TaskGraph | null {
  const oversized = new Set(
    report.tasks.filter((task) => task.oversized && task.kind === "test").map((t) => t.taskId),
  );
  if (!oversized.size) return null;
  let next = Math.max(...graph.tasks.map((task) => Number(task.id.slice(1)))) + 1;
  const parts = new Map<string, string[]>();
  const tasks = graph.tasks.flatMap((task) => {
    if (!oversized.has(task.id)) return [task];
    const files = task.writes.filter((write) => write.action !== "delete");
    const deletes = task.writes.filter((write) => write.action === "delete");
    const split = files.map((write, index) => {
      const id = index === 0 ? task.id : `T${String(next++).padStart(3, "0")}`;
      const siblings = files.filter((other) => other !== write).map((other) => other.path);
      return {
        ...task,
        id,
        writes: index === 0 ? [write, ...deletes] : [write],
        description: `${task.description}\nSizing split this task by file: write only ${write.path}; ${siblings.join(", ")} belong to the other parts of ${task.id}.`,
      };
    });
    parts.set(
      task.id,
      split.map((part) => part.id),
    );
    return split;
  });
  return {
    ...graph,
    tasks: tasks.map((task) => ({
      ...task,
      dependsOn: [
        ...new Set(
          task.dependsOn.flatMap((id) => {
            const split = parts.get(id);
            return split && !split.includes(task.id) ? split : [id];
          }),
        ),
      ],
    })),
  };
}

/** The note that sends an oversized plan back to the planner once. */
export function splitNote(report: SizingReport, maxCodeFilesPerTask: number): string {
  return `Sizing: the plan is too large for its attempts. ${report.reasons.join(". ")}. Re-plan with smaller tasks: tests in tasks of their own, at most ${maxCodeFilesPerTask} code files per task, disjoint writes and no dependency between tasks where possible, so they run in parallel.`;
}

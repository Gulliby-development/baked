import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePath } from "../specs/validate.js";
import { DEFAULT_STAGE_RANGES, rangeOf, type TokenRange } from "./estimate.js";
import type { RunPolicy, TaskGraph } from "./schemas.js";
import { DEFAULT_MAX_ATTEMPT_TOKENS } from "./step-budget.js";
import type { Task } from "./types.js";

/**
 * Plan-time sizing. Once the plan names the tasks and the files they write, the cost of the
 * implementation is priced from what earlier runs spent per kilobyte of written files. The price
 * sets each task's attempt cap, raises the run budget up to the ceiling the policy allows, and
 * decides when a plan is too large and must be split.
 */

/** One finished run of history: what its tasks spent and how much code they wrote to. */
export interface SizingSample {
  runId: string;
  taskTokens: number;
  writeBytes: number;
}

/** Tokens per KiB of written files when no history exists; measured on this project's runs. */
export const DEFAULT_TOKENS_PER_KB: TokenRange = { low: 3_000, high: 6_000 };
/** Below this, a task keeps the default attempt cap. */
const MIN_TASK_TOKENS = 60_000;
/** Without a configured ceiling, a task attempt may grow to this. */
export const DEFAULT_MAX_SIZED_ATTEMPT = 600_000;
/** Corrective rounds and retries on top of the first implementation, as observed. */
const REPAIR_FACTOR = 1.5;
/** Fewer finished runs than this give no rate; the defaults apply. */
const MIN_SAMPLES = 2;

const kb = (bytes: number): number => Math.max(1, bytes / 1024);

function fileBytes(root: string, path: string): number {
  try {
    const absolute = workspacePath(root, path);
    return existsSync(absolute) ? statSync(absolute).size : 0;
  } catch {
    return 0;
  }
}

/** Bytes of the files a task writes, as they are in the root now; created files count as zero. */
export function writeBytes(root: string, task: Pick<Task, "writes">): number {
  return task.writes
    .filter((w) => w.action !== "delete")
    .reduce((total, w) => total + fileBytes(root, w.path), 0);
}

/**
 * Finished runs of a workflow store, read-only: the tokens of all their task attempts and the
 * current size of the distinct files their planned tasks write. The workspace of a store is the
 * directory that holds its `.baked` folder.
 */
export function samplesFrom(databasePath: string): SizingSample[] {
  if (!existsSync(databasePath)) return [];
  const root = dirname(dirname(databasePath));
  let db: Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true });
    const runs = db.query<{ id: string }, []>("SELECT id FROM runs WHERE status='completed'").all();
    const samples: SizingSample[] = [];
    for (const { id } of runs) {
      const tasks = db
        .query<{ id: string; definition_json: string }, [string]>(
          "SELECT id, definition_json FROM tasks WHERE run_id=? AND status<>'invalidated' AND status<>'cancelled'",
        )
        .all(id);
      const tokens =
        db
          .query<{ tokens: number | null }, [string]>(
            `SELECT SUM(COALESCE(a.used_tokens,0)) AS tokens FROM attempts a
             JOIN steps s ON s.run_id=a.run_id AND s.id=a.step_id
             WHERE a.run_id=? AND s.stage_id LIKE 'task-%' AND a.model_id IS NOT NULL`,
          )
          .get(id)?.tokens ?? 0;
      const paths = new Set<string>();
      for (const task of tasks) {
        const definition = JSON.parse(task.definition_json) as Pick<Task, "writes" | "origin">;
        if (definition.origin !== "planned") continue;
        for (const write of definition.writes) if (write.action !== "delete") paths.add(write.path);
      }
      const bytes = [...paths].reduce((total, path) => total + fileBytes(root, path), 0);
      if (tokens > 0 && bytes > 0)
        samples.push({ runId: id, taskTokens: tokens, writeBytes: bytes });
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
    .filter((sample) => !seen.has(sample.runId) && seen.add(sample.runId));
}

export interface TaskSize {
  taskId: string;
  writeBytes: number;
  /** Tokens the task's attempts are expected to spend, including its corrections. */
  estimate: TokenRange;
  /** Cap for one attempt of this task. */
  attemptTokens: number;
  /** Larger than one attempt may grow to: the plan should split it. */
  oversized: boolean;
}

export interface SizingReport {
  schemaVersion: 1;
  basis: "history" | "defaults";
  samples: number;
  tokensPerKb: TokenRange;
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

/** Tokens per KiB of written files, from history where there is enough of it. */
export function tokensPerKb(samples: SizingSample[]): {
  rate: TokenRange;
  basis: SizingReport["basis"];
} {
  const rates = samples.map((s) => s.taskTokens / kb(s.writeBytes));
  const range = samples.length >= MIN_SAMPLES ? rangeOf(rates) : null;
  return range
    ? { rate: range, basis: "history" }
    : { rate: DEFAULT_TOKENS_PER_KB, basis: "defaults" };
}

/**
 * Prices a planned graph. `spent` is what the run used before implementation; the review and
 * convergence stages are priced at their generic upper range, once more for a correction round.
 */
export function sizePlan(input: {
  graph: TaskGraph;
  root: string;
  policy: RunPolicy;
  samples: SizingSample[];
  spent: number;
}): SizingReport {
  const { rate, basis } = tokensPerKb(input.samples);
  const maxAttemptTokens = input.policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxRunTokens = input.policy.sizing?.maxRunTokens ?? null;
  const floor = input.policy.maxAttemptTokens ?? DEFAULT_MAX_ATTEMPT_TOKENS;
  const tasks = input.graph.tasks
    .filter((task) => task.writes.length > 0)
    .map((task): TaskSize => {
      const bytes = writeBytes(input.root, task);
      const estimate = {
        low: Math.max(MIN_TASK_TOKENS, Math.round(rate.low * kb(bytes))),
        high: Math.max(MIN_TASK_TOKENS, Math.round(rate.high * kb(bytes) * REPAIR_FACTOR)),
      };
      return {
        taskId: task.id,
        writeBytes: bytes,
        estimate,
        attemptTokens: Math.min(maxAttemptTokens, Math.max(floor, estimate.high)),
        oversized: estimate.high > maxAttemptTokens,
      };
    });
  const verification =
    ((DEFAULT_STAGE_RANGES.review?.high ?? 0) + (DEFAULT_STAGE_RANGES.converge?.high ?? 0)) *
    REPAIR_FACTOR;
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
        `${task.taskId} needs about ${task.estimate.high} tokens, above one attempt's ${maxAttemptTokens}`,
      );
  }
  if (runTokens > budgetBefore && maxRunTokens !== null) {
    budgetAfter = Math.min(maxRunTokens, runTokens);
    if (decision === "fits") decision = "raise-budget";
    reasons.push(`The run budget grows from ${budgetBefore} to ${budgetAfter} tokens`);
  }
  return {
    schemaVersion: 1,
    basis,
    samples: input.samples.length,
    tokensPerKb: rate,
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

/** What the planner is told about task size before it plans. */
export function plannerSizing(
  policy: RunPolicy,
  samples: SizingSample[],
): {
  maxTaskKb: number;
  note: string;
} {
  const { rate } = tokensPerKb(samples);
  const maxAttemptTokens = policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxTaskKb = Math.max(8, Math.floor(maxAttemptTokens / (rate.high * REPAIR_FACTOR)));
  return {
    maxTaskKb,
    note: `Keep each task to about ${maxTaskKb} KiB of files to write (existing size). Split larger work into tasks with disjoint writes and no dependency between them where the code allows: such tasks run in parallel and are merged afterwards. Put new tests in a task of their own when the code task is large.`,
  };
}

/** The note that sends an oversized plan back to the planner once. */
export function splitNote(report: SizingReport, maxTaskKb: number): string {
  return `Sizing: the plan is too large for its attempts. ${report.reasons.join(". ")}. Re-plan with smaller tasks: about ${maxTaskKb} KiB of files to write per task, disjoint writes and no dependency between tasks where possible, so they run in parallel; put tests in their own task.`;
}

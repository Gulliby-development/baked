import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isManifestFile, isTestFile } from "../intelligence/language-traits.js";
import { isTestOf } from "../verification/convergence.js";
import { criterionCases, type SpecText } from "../verification/criteria-cases.js";
import { MAX_EXTENDED_MS } from "./budget.js";
import { DEFAULT_STAGE_RANGES, historyStorePaths, rangeOf, type TokenRange } from "./estimate.js";
import { extendToOf, type RunPolicy, SpecSchema, type TaskGraph } from "./schemas.js";
import { DEFAULT_MAX_ATTEMPT_TOKENS } from "./step-budget.js";
import type { WorkflowStore } from "./store.js";
import { hostWritten } from "./task-graph.js";
import type { Task } from "./types.js";

/**
 * Plan-time sizing. Once the plan names the tasks and the files they write, each task is priced
 * per written file and test tasks also by their criteria and literal cases. File rates depend
 * on the kind of file (code, test or docs) and on whether the task creates or
 * modifies it: tests cost far more than code, a README cost more than a code file, and editing
 * existing code cost more than writing new code. The size of a file says little about the size of
 * its change. The rates are the tokens earlier tasks of the same kind spent per file to get done,
 * their corrective tasks included, taken from this project's own runs first: rates carried over
 * from another project were off in both directions. The price sets each task's attempt cap, raises
 * the run budget up to the ceiling the policy allows, and decides when a plan is too large and
 * must be split.
 */

export type FileKind = "code" | "test" | "docs" | "manifest";
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
  /** The acceptance criteria the planned task covered; absent in older history. */
  criteria?: number;
  /** Literal cases from the accepted spec; absent in history without a readable spec. */
  cases?: number;
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
  // A project manifest or solution file is a few declarative lines; priced as code, the skeleton
  // task of ratesim 029a5aec (two csproj files, an slnx entry, a console entry point) came to 763k
  // against 191k spent and was split (#1132).
  manifest: { create: { low: 5_000, high: 40_000 }, modify: { low: 5_000, high: 40_000 } },
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
/** Finished runs in history needed before their loop cost replaces the flat reserve. */
export const MIN_LOOP_RUNS = 3;
/** The calibrated reserve stays within these shares of the priced work. */
export const RESERVE_BOUNDS = { min: REPAIR_RESERVE, max: 3 } as const;
/**
 * Tokens a run spends per active minute until enough runs are in history. Kept below the observed
 * rates (cfgtrace 2ad7c3e4 spent 81-104k a minute) so the time estimate errs long (#933).
 */
export const DEFAULT_TOKENS_PER_MINUTE = 60_000;
/** Runs in history needed before their rate replaces the default. */
export const MIN_RATE_RUNS = 3;
/** Runs shorter than this, or below `MIN_RATE_TOKENS`, say little about a run's pace. */
const MIN_RATE_MS = 5 * 60_000;
const MIN_RATE_TOKENS = 100_000;
/** The active-time cap holds the estimated time plus this share. */
export const ACTIVE_TIME_MARGIN = 0.25;

const DOCS_EXTENSION = /\.(md|mdx|markdown|rst|adoc)$/i;
const DOCS_DIR = /(^|\/)docs?\//i;
const SOURCE = /\.[cm]?[jt]sx?$/i;
/**
 * Documentation by extension anywhere, or a non-source file under `docs/`; then project manifests
 * and solution files; then tests; else code.
 */
export const fileKind = (path: string): FileKind =>
  DOCS_EXTENSION.test(path) || (DOCS_DIR.test(path) && !SOURCE.test(path))
    ? "docs"
    : isManifestFile(path)
      ? "manifest"
      : isTestFile(path)
        ? "test"
        : "code";

type Written = { path: string; action: WriteAction };
/** The files an agent writes for the task: none when the host writes them (#1460). */
function written(task: Pick<Task, "writes">): Written[] {
  if (hostWritten(task)) return [];
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
      let spec: SpecText | null = null;
      try {
        const artifact = db
          .query<{ inline_content: string | null; blob_path: string | null }, [string]>(
            "SELECT inline_content, blob_path FROM artifacts WHERE run_id=? AND logical_path='spec.json' ORDER BY revision DESC LIMIT 1",
          )
          .get(id);
        const content =
          artifact?.inline_content ??
          (artifact?.blob_path
            ? readFileSync(
                join(dirname(databasePath), "..", artifact.blob_path.replaceAll("\\", "/")),
                "utf8",
              )
            : null);
        if (content) spec = SpecSchema.safeParse(JSON.parse(content)).data ?? null;
      } catch {
        // Older stores and synthetic history may have no spec artifacts. Keep their file rates.
      }
      const tasks = db
        .query<{ id: string; definition_json: string }, [string]>(
          "SELECT id, definition_json FROM tasks WHERE run_id=? AND status='verified'",
        )
        .all(id)
        .map((row) => ({
          id: row.id,
          ...(JSON.parse(row.definition_json) as Pick<Task, "writes" | "origin"> &
            Partial<Pick<Task, "criterionIds">>),
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
            criteria: task.criterionIds?.length ?? 0,
            ...(spec && task.criterionIds
              ? { cases: criterionCases(spec, { criterionIds: task.criterionIds }).length }
              : {}),
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
 * The review and repair loop of each finished run in a workflow store, as a share of its first
 * pass. The first pass is the first generation of every planned task and of the review and
 * converge stages (with their dimension and skeptic steps); the loop is everything those stages
 * ran again after it plus every corrective task. junitdigest 3e5be74b spent 5.0M after a first
 * pass of 1.9M, while the flat reserve held 0.77M (#747).
 */
export function loopSharesFrom(databasePath: string): number[] {
  if (!existsSync(databasePath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true });
    const runs = db
      .query<{ id: string; definition_json: string }, []>(
        "SELECT id, definition_json FROM runs WHERE status='completed'",
      )
      .all();
    const shares: number[] = [];
    for (const run of runs) {
      const stages = (
        JSON.parse(run.definition_json) as { stages?: { id: string; kind: string }[] }
      ).stages;
      const verification = new Set(
        (stages ?? []).filter((s) => s.kind === "review" || s.kind === "converge").map((s) => s.id),
      );
      const planned = new Set(
        db
          .query<{ id: string; definition_json: string }, [string]>(
            "SELECT id, definition_json FROM tasks WHERE run_id=?",
          )
          .all(run.id)
          .filter(
            (t) => (JSON.parse(t.definition_json) as Pick<Task, "origin">).origin === "planned",
          )
          .map((t) => t.id),
      );
      const rows = db
        .query<{ stage: string; generation: number; tokens: number | null }, [string]>(
          `SELECT s.stage_id AS stage, s.generation AS generation, SUM(COALESCE(a.used_tokens,0)) AS tokens
           FROM attempts a JOIN steps s ON s.run_id=a.run_id AND s.id=a.step_id
           WHERE a.run_id=? GROUP BY s.stage_id, s.generation`,
        )
        .all(run.id);
      let first = 0;
      let loop = 0;
      for (const row of rows) {
        const tokens = row.tokens ?? 0;
        const task = row.stage.startsWith("task-") ? row.stage.slice(5) : null;
        const verifying =
          verification.has(row.stage) ||
          row.stage.startsWith("dimension-") ||
          row.stage.startsWith("skeptic-");
        if (task !== null && !planned.has(task)) loop += tokens;
        else if (task !== null || verifying) {
          if (row.generation === 0) first += tokens;
          else loop += tokens;
        }
      }
      if (first > 0) shares.push(loop / first);
    }
    return shares;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Loop shares of this project's store and the extra stores the policy names. */
export function loopHistory(workspace: string, policy: RunPolicy): number[] {
  return [
    join(workspace, ".baked", "workflows.sqlite"),
    ...historyStorePaths(workspace, policy),
  ].flatMap((path) => loopSharesFrom(path));
}

const reserveNote = (reserve: { share: number; basis: "history" | "default"; runs: number }) =>
  reserve.basis === "history"
    ? `${Math.round(reserve.share * 100)}% of the priced work, the median loop of ${reserve.runs} finished runs`
    : `the flat ${Math.round(reserve.share * 100)}% until ${MIN_LOOP_RUNS} finished runs are in history`;

/**
 * The share of the priced work held for repair and convergence: the median loop share of at
 * least `MIN_LOOP_RUNS` finished runs, within `RESERVE_BOUNDS`, or the flat `REPAIR_RESERVE`.
 */
export function repairReserveShare(loopShares: readonly number[]): {
  share: number;
  basis: "history" | "default";
  runs: number;
} {
  if (loopShares.length < MIN_LOOP_RUNS)
    return { share: REPAIR_RESERVE, basis: "default", runs: loopShares.length };
  const sorted = [...loopShares].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  const share = Math.min(RESERVE_BOUNDS.max, Math.max(RESERVE_BOUNDS.min, median));
  return { share: Math.round(share * 100) / 100, basis: "history", runs: loopShares.length };
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
  return {
    code: byAction("code"),
    test: byAction("test"),
    docs: byAction("docs"),
    manifest: byAction("manifest"),
  };
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
  /** Above one attempt and writes several files or tests: the plan should split it. */
  oversized: boolean;
  cases?: number;
  /** Sequential slices of this test file, including this task. */
  sliceCount?: number;
}

export interface SizingReport {
  schemaVersion: 3;
  /** The model the tasks were priced for; null when none was known. */
  model: string | null;
  rates: Rates;
  /** Tokens per criterion that price test tasks (`criterionRate`); null without that history. */
  criterionRate: CriterionRate | null;
  /** Tokens per literal case of finished test tasks; null until two have readable specs. */
  caseRate?: CaseRate | null;
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
  /** The reserve's share of the priced work and where it came from (`repairReserveShare`). */
  reserve: { share: number; basis: "history" | "default"; runs: number };
  budgetBefore: number;
  budgetAfter: number;
  maxAttemptTokens: number;
  maxRunTokens: number | null;
  /**
   * The active time the sized budget needs at the observed token rate, and the active-time cap
   * before and after sizing. The cap grows with the budget, under the same ceiling (#933).
   */
  activeTime: {
    tokensPerMinute: number;
    basis: "history" | "default";
    runs: number;
    estimatedMs: number;
    before: number;
    after: number;
  };
  decision: "fits" | "raise-budget" | "split-tasks" | "split-feature";
  reasons: string[];
  /**
   * Present when the plan and its repair reserve need more than the budget can reach at the
   * policy's ceiling: the line the approval shows, and how far the run is expected to get (#974).
   */
  overCeiling?: {
    needTokens: number;
    ceilingTokens: number;
    /** Tasks, in plan order, whose midpoints fit what the ceiling leaves after verification. */
    expectedTasks: number;
    totalTasks: number;
    /** How far the run may grow past the ceiling on progress (`extendToOf`); null when it may not. */
    extendToTokens: number | null;
    warning: string;
  };
}

/** Tokens the final review and convergence are priced at, on top of the tasks. */
export function verificationTokens(): number {
  return (
    ((DEFAULT_STAGE_RANGES.review?.high ?? 0) + (DEFAULT_STAGE_RANGES.converge?.high ?? 0)) *
    VERIFICATION_FACTOR
  );
}

/** Tokens per covered criterion of finished test tasks, and how many tasks measured it. */
export interface CriterionRate {
  perCriterion: TokenRange;
  samples: number;
  /** As in `KindRate`: this project's own test tasks, or every store's. */
  basis: "project" | "history";
  model: string | null;
}

/**
 * Tokens per criterion of the finished test tasks in history, or null with fewer than
 * `MIN_PROJECT_SAMPLES` of them. A test task's work grows with the criteria it covers (each needs
 * its cases and exact outputs) more than with its file count: a one-file part of a split test task
 * that covered five criteria was priced at a per-file rate of 180k and used 547k on average
 * (cfgtrace b4427c85, #1265). Measured, never a constant, so it holds for any provider.
 */
export function criterionRate(
  samples: SizingSample[],
  model: string | null = null,
): CriterionRate | null {
  const measured = testUnitRate(samples, "criteria", model);
  return measured ? { perCriterion: measured.range, ...measured.source } : null;
}

export interface CaseRate {
  perCase: TokenRange;
  samples: number;
  basis: "project" | "history";
  model: string | null;
}

/** Literal cases use the same project and model selection as criteria. No invented case rate. */
export function caseRate(samples: SizingSample[], model: string | null = null): CaseRate | null {
  const measured = testUnitRate(samples, "cases", model);
  return measured ? { perCase: measured.range, ...measured.source } : null;
}

function testUnitRate(samples: SizingSample[], unit: "criteria" | "cases", model: string | null) {
  const tests = samples.filter((s) => s.kind === "test" && (s[unit] ?? 0) > 0);
  const own = model ? tests.filter((s) => s.model === model) : [];
  const ofModel = own.length >= MIN_MODEL_SAMPLES ? model : null;
  const pool = ofModel ? own : tests;
  const project = pool.filter((s) => s.source === "project");
  const basis: CriterionRate["basis"] =
    project.length >= MIN_PROJECT_SAMPLES ? "project" : "history";
  const chosen = basis === "project" ? project : pool;
  if (chosen.length < MIN_PROJECT_SAMPLES) return null;
  const range = rangeOf(chosen.map((s) => s.tokens / (s[unit] ?? 1)));
  return range ? { range, source: { samples: chosen.length, basis, model: ofModel } } : null;
}

/**
 * One task's price: the per-file rate of each file it writes, by its kind and action, summed. A
 * test task costs at least its criteria and literal cases at their measured rates. Sequential
 * slices share the file price and each pay for their own criteria and cases.
 */
export function priceTask(
  task: Pick<Task, "writes"> & Partial<Pick<Task, "criterionIds" | "sizingSlice">>,
  rates: Rates,
  perCriterion: CriterionRate | null = null,
  cases = 0,
  perCase: CaseRate | null = null,
): TokenRange {
  const share = taskKind(task) === "test" ? (task.sizingSlice?.share ?? 1) : 1;
  const byFile = written(task).reduce(
    (total, { path, action }) => {
      const rate = rates[fileKind(path)][action].perFile;
      return { low: total.low + rate.low * share, high: total.high + rate.high * share };
    },
    { low: 0, high: 0 },
  );
  const criteria = task.criterionIds?.length ?? 0;
  if (taskKind(task) !== "test") return byFile;
  return {
    low: Math.round(
      Math.max(
        byFile.low,
        criteria * (perCriterion?.perCriterion.low ?? 0),
        cases * (perCase?.perCase.low ?? 0),
      ),
    ),
    high: Math.round(
      Math.max(
        byFile.high,
        criteria * (perCriterion?.perCriterion.high ?? 0),
        cases * (perCase?.perCase.high ?? 0),
      ),
    ),
  };
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
  /** Loop shares of finished runs (`loopHistory`); they set the repair reserve once enough. */
  loopShares?: readonly number[];
  /** Tokens per active minute of earlier runs (`rateHistory`); they set the time estimate. */
  tokenRates?: readonly number[];
  /** Accepted criteria, including their quoted inputs and table rows. */
  spec?: SpecText | null;
}): SizingReport {
  const rates = perFileRates(input.samples, input.model ?? null);
  const perCriterion = criterionRate(input.samples, input.model ?? null);
  const perCase = caseRate(input.samples, input.model ?? null);
  const maxAttemptTokens = input.policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxRunTokens = input.policy.sizing?.maxRunTokens ?? null;
  const floor = input.policy.maxAttemptTokens ?? DEFAULT_MAX_ATTEMPT_TOKENS;
  const testSteps = input.policy.sizing?.testTaskSteps ?? DEFAULT_TEST_TASK_STEPS;
  const tasks = input.graph.tasks
    .filter((task) => writtenFiles(task).length > 0)
    .map((task): TaskSize => {
      const kind = taskKind(task);
      const cases = input.spec && kind === "test" ? criterionCases(input.spec, task).length : 0;
      const estimate = priceTask(task, rates, perCriterion, cases, perCase);
      const files = writtenFiles(task).length;
      return {
        taskId: task.id,
        kind,
        files,
        estimate,
        attemptTokens: Math.min(maxAttemptTokens, Math.max(floor, Math.round(estimate.high))),
        attemptSteps: taskKind(task) === "test" ? testSteps : null,
        oversized: (files > 1 || kind === "test") && estimate.high > maxAttemptTokens,
        ...(kind === "test" ? { cases, sliceCount: task.sizingSlice?.count ?? 1 } : {}),
      };
    });
  const verification = verificationTokens();
  const taskTokens = taskTotal(tasks.map((task) => task.estimate));
  const priced = taskTokens.price + verification;
  const runTokens = Math.round(input.spent + priced);
  const reserve = repairReserveShare(input.loopShares ?? []);
  const repairReserve = Math.round(priced * reserve.share);
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
        ? `The run budget grows from ${budgetBefore} to ${budgetAfter} tokens (${repairReserve} of it held for repair and convergence, ${reserveNote(reserve)})`
        : `The run budget stays at ${budgetBefore} tokens, the policy's ceiling; the plan and its repair reserve of ${repairReserve} need about ${runTokens + repairReserve}`,
    );
  }
  const rate = tokensPerMinute(input.tokenRates ?? []);
  const needed = Math.min(runTokens + repairReserve, budgetAfter);
  const estimatedMs = Math.round((needed / rate.tokensPerMinute) * 60_000);
  const timeBefore = input.policy.maxActiveMs;
  const timeAfter =
    maxRunTokens !== null && estimatedMs * (1 + ACTIVE_TIME_MARGIN) > timeBefore
      ? Math.max(
          timeBefore,
          Math.min(
            MAX_EXTENDED_MS,
            Math.ceil((estimatedMs * (1 + ACTIVE_TIME_MARGIN)) / 60_000) * 60_000,
          ),
        )
      : timeBefore;
  if (estimatedMs > timeBefore || timeAfter > timeBefore) {
    if (timeAfter > timeBefore && decision === "fits") decision = "raise-budget";
    reasons.push(
      `Estimated active time at ${rate.tokensPerMinute} tokens per minute (${rateNote(rate)}): ${minutes(estimatedMs)} min against maxActiveMs ${minutes(timeBefore)} min; ${
        timeAfter > timeBefore
          ? `the active-time cap grows to ${minutes(timeAfter)} min`
          : maxRunTokens === null
            ? "the cap stays, as the policy sets no maxRunTokens ceiling"
            : "the cap stays at its ceiling"
      }`,
    );
  }
  const need = runTokens + repairReserve;
  let overCeiling: SizingReport["overCeiling"];
  if (maxRunTokens !== null && need > budgetAfter && budgetAfter >= maxRunTokens) {
    let left = budgetAfter - input.spent - verification;
    let expectedTasks = 0;
    for (const task of tasks) {
      left -= (task.estimate.low + task.estimate.high) / 2;
      if (left < 0) break;
      expectedTasks += 1;
    }
    const extendToTokens = extendToOf(input.policy);
    const warning = `Plan and reserve need ${need} tokens, ceiling is ${budgetAfter}; the run is expected to stop at about ${expectedTasks} of ${tasks.length} tasks${
      extendToTokens !== null && extendToTokens > budgetAfter
        ? ` unless it grows on progress, up to ${extendToTokens}`
        : ""
    }`;
    overCeiling = {
      needTokens: need,
      ceilingTokens: budgetAfter,
      expectedTasks,
      totalTasks: tasks.length,
      extendToTokens,
      warning,
    };
    reasons.push(warning);
  }
  return {
    schemaVersion: 3,
    model: input.model ?? null,
    rates,
    criterionRate: perCriterion,
    caseRate: perCase,
    tasks,
    runTokens,
    taskTokens: { low: taskTokens.low, expected: taskTokens.expected, high: taskTokens.high },
    repairReserve,
    reserve,
    budgetBefore,
    budgetAfter,
    maxAttemptTokens,
    maxRunTokens,
    activeTime: { ...rate, estimatedMs, before: timeBefore, after: timeAfter },
    decision,
    reasons,
    ...(overCeiling ? { overCeiling } : {}),
  };
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

const rateNote = (rate: { basis: "history" | "default"; runs: number }) =>
  rate.basis === "history"
    ? `the median of ${rate.runs} earlier runs`
    : `the default until ${MIN_RATE_RUNS} runs are in history`;

/** The median tokens per active minute of at least `MIN_RATE_RUNS` runs, or the default. */
export function tokensPerMinute(rates: readonly number[]): {
  tokensPerMinute: number;
  basis: "history" | "default";
  runs: number;
} {
  const usable = rates.filter((rate) => Number.isFinite(rate) && rate > 0);
  if (usable.length < MIN_RATE_RUNS)
    return { tokensPerMinute: DEFAULT_TOKENS_PER_MINUTE, basis: "default", runs: usable.length };
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { tokensPerMinute: Math.round(median), basis: "history", runs: usable.length };
}

/**
 * Tokens per active minute of the runs in a workflow store that ran long enough to show a pace:
 * every run that is not created or still running, with at least five active minutes.
 */
export function tokenRatesFrom(databasePath: string): number[] {
  if (!existsSync(databasePath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true });
    return db
      .query<{ tokens: number; ms: number }, [number, number]>(
        "SELECT token_usage AS tokens, active_ms AS ms FROM runs WHERE status NOT IN ('created','running') AND active_ms>=? AND token_usage>=?",
      )
      .all(MIN_RATE_MS, MIN_RATE_TOKENS)
      .map((run) => run.tokens / (run.ms / 60_000));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Token rates of this project's store and the extra stores the policy names. */
export function rateHistory(workspace: string, policy: RunPolicy): number[] {
  return [
    join(workspace, ".baked", "workflows.sqlite"),
    ...historyStorePaths(workspace, policy),
  ].flatMap((path) => tokenRatesFrom(path));
}

/** How many code files one attempt covers, and what the planner is told before it plans. */
export function plannerSizing(
  policy: RunPolicy,
  samples: SizingSample[],
  model: string | null = null,
): { maxCodeFilesPerTask: number; note: string } {
  const rates = perFileRates(samples, model);
  const perCriterion = criterionRate(samples, model);
  const perCase = caseRate(samples, model);
  const maxAttemptTokens = policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxCodeFilesPerTask = Math.max(1, Math.floor(maxAttemptTokens / highest(rates, "code")));
  const k = (kind: FileKind) => `${Math.round(highest(rates, kind) / 1000)}k`;
  return {
    maxCodeFilesPerTask,
    note: `Give every task that writes code the policy's typecheck check, so its errors show in that task. Put tests in tasks of their own: a test file costs about ${k("test")} tokens, a code file about ${k("code")}, a documentation file about ${k("docs")}, a project manifest or solution file about ${k("manifest")}.${perCriterion ? ` A test task costs at least about ${Math.round(perCriterion.perCriterion.high / 1000)}k per criterion it covers.` : ""} ${perCase ? ` Each literal test case costs at least about ${Math.round(perCase.perCase.high / 1000)}k tokens.` : ""} Keep each code task to at most ${maxCodeFilesPerTask} files. A task whose writes all carry their content is written by the host and costs nothing, whatever its file count. Give tasks that can be built independently disjoint writes and no dependency between them, so they run in parallel and are merged afterwards; a test task depends on the code tasks whose criteria it covers. Keep test tasks within the ${maxAttemptTokens} token attempt cap by the cases their criteria name, even when they write only one file. An oversized test file is split into sequential slices of whole criteria: create it first, then modify it, each slice depending on the previous. Preserve earlier slices and test only the assigned criteria. If one criterion alone exceeds the cap, write and check its cases in batches inside the same attempt.`,
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
 * Splits oversized test tasks by file, then into sequential criterion slices of each file, so the plan needs no second round
 * for it: test files rarely depend on each other, and a planner told to split a test task did not
 * (expenses-py-r4). The first file keeps the task's ID and the others get new ones; every part
 * keeps the task's checks and dependencies, and a task that depended on it depends on every part.
 * Slices of one file divide its per-file price by case weight, keep whole criteria, and preserve
 * create/modify order. A criterion that alone exceeds the cap stays intact with batching guidance.
 * A part keeps only the task's criteria that the code tasks writing its tested file cover (see
 * `partCriteria`). Returns null when no test task is oversized.
 */
/** Opens the note a sizing split appends to each part's copy of its task's description. */
export const SPLIT_PART = "Sizing split this task by file:";
export const SLICE_PART = "Sizing split this test file into slices:";

export function splitTestTasks(
  graph: TaskGraph,
  report: SizingReport,
  spec?: SpecText | null,
): TaskGraph | null {
  const oversized = new Set(
    report.tasks.filter((task) => task.oversized && task.kind === "test").map((t) => t.taskId),
  );
  if (!oversized.size) return null;
  let next = Math.max(...graph.tasks.map((task) => Number(task.id.slice(1)))) + 1;
  const parts = new Map<string, string[]>();
  const tasks = graph.tasks.flatMap((task) => {
    if (!oversized.has(task.id) || task.sizingSlice) return [task];
    const files = task.writes.filter((write) => write.action !== "delete");
    const deletes = task.writes.filter((write) => write.action === "delete");
    const criteria = partCriteria(
      graph,
      task,
      files.map((write) => write.path),
    );
    const split: Task[] = [];
    for (const [fileIndex, write] of files.entries()) {
      const siblings = files.filter((other) => other !== write).map((other) => other.path);
      const own = criteria[fileIndex] ?? task.criterionIds;
      const base = { ...task, criterionIds: own, writes: [write] };
      const cases = (ids: string[]) =>
        spec ? criterionCases(spec, { criterionIds: ids }).length : 0;
      const weights = new Map(own.map((id) => [id, Math.max(1, cases([id]))]));
      const weight = (ids: string[]) => ids.reduce((sum, id) => sum + (weights.get(id) ?? 1), 0);
      const total = weight(own);
      // Later slices modify the file. Use the higher action rate while grouping, so a cheap
      // create rate does not leave the continuation slices above the attempt cap.
      const continuation = { ...base, writes: [{ ...write, action: "modify" as const }] };
      const high = (ids: string[]) =>
        Math.max(
          ...[base, continuation].map(
            (part) =>
              priceTask(
                {
                  ...part,
                  criterionIds: ids,
                  sizingSlice: { taskId: task.id, index: 0, count: 1, share: weight(ids) / total },
                },
                report.rates,
                report.criterionRate,
                cases(ids),
                report.caseRate,
              ).high,
          ),
        );
      const groups: string[][] = [];
      let group: string[] = [];
      const needsSlices =
        priceTask(base, report.rates, report.criterionRate, cases(own), report.caseRate).high >
        report.maxAttemptTokens;
      if (!needsSlices) groups.push(own);
      else {
        for (const id of own) {
          if (group.length && high([...group, id]) > report.maxAttemptTokens) {
            groups.push(group);
            group = [];
          }
          group.push(id);
        }
        if (group.length) groups.push(group);
      }
      let previous: string | null = null;
      for (const [index, ids] of groups.entries()) {
        const id = split.length === 0 ? task.id : `T${String(next++).padStart(3, "0")}`;
        const others = task.criterionIds.filter((c) => !ids.includes(c));
        const sliced = groups.length > 1;
        const scope = others.length
          ? ` Cover only ${ids.join(", ")} in it; ${others.join(", ")} are covered by the other parts' ${sliced ? "slices" : "files"}, so do not test them here.`
          : "";
        const note = sliced
          ? `${SLICE_PART} write only ${write.path}; the other slices belong to the other parts of ${task.id}. Slice ${index + 1} of ${groups.length}. Preserve existing tests and add only this slice's criteria.`
          : `${SPLIT_PART} write only ${write.path}; ${siblings.join(", ")} belong to the other parts of ${task.id}.`;
        const batch =
          needsSlices && high(ids) > report.maxAttemptTokens
            ? " This criterion alone exceeds one attempt. Write its cases in small batches inside this attempt, run tests-written after each batch, and preserve earlier batches."
            : "";
        const sliceWrite = previous ? { ...write, action: "modify" as const } : write;
        split.push({
          ...task,
          id,
          criterionIds: ids,
          requirementIds: spec
            ? [
                ...new Set(
                  spec.criteria.filter((c) => ids.includes(c.id)).flatMap((c) => c.requirementIds),
                ),
              ]
            : task.requirementIds,
          writes: split.length === 0 ? [sliceWrite, ...deletes] : [sliceWrite],
          dependsOn: [...task.dependsOn, ...(previous ? [previous] : [])],
          ...(sliced
            ? {
                sizingSlice: {
                  taskId: task.id,
                  index,
                  count: groups.length,
                  share: weight(ids) / total,
                },
              }
            : {}),
          description: `${task.description}\n${note}${scope}${batch}`,
        });
        previous = id;
      }
    }
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

/**
 * The criteria of `task` each of its test files covers, in the order of `files`: those of the code
 * tasks that write the file a test file is named after (`tests/test_schema.py` for
 * `cfgtrace/schema.py`). A file whose source no code task writes, or whose code tasks share none
 * of the criteria, keeps every criterion, and a criterion no part gets goes to those parts, or to
 * the first part when every part matched. cfgtrace b4427c85 gave all 14 one-file parts their
 * group's whole criteria list: each wrote a file that tried to cover the group, the parts cost
 * 7.65M tokens and three of them contradicted the spec (#1245).
 */
export function partCriteria(graph: TaskGraph, task: Task, files: string[]): string[][] {
  const matched = files.map((file) => {
    const covered = new Set(
      graph.tasks
        .filter((t) => t.id !== task.id && t.writes.some((w) => isTestOf(file, w.path)))
        .flatMap((t) => t.criterionIds),
    );
    const own = task.criterionIds.filter((c) => covered.has(c));
    return own.length ? own : null;
  });
  const assigned = new Set(matched.flatMap((own) => own ?? []));
  const rest = task.criterionIds.filter((c) => !assigned.has(c));
  const open = matched.some((own) => own === null);
  return matched.map((own, index) =>
    own === null
      ? task.criterionIds
      : !open && index === 0 && rest.length
        ? task.criterionIds.filter((c) => own.includes(c) || rest.includes(c))
        : own,
  );
}

/** The note that sends an oversized plan back to the planner once. */
export function splitNote(report: SizingReport, maxCodeFilesPerTask: number): string {
  return `Sizing: the plan is too large for its attempts. ${report.reasons.join(". ")}. Re-plan with smaller tasks: tests in tasks of their own, split a large single test file into sequential criterion slices with create then modify writes and a dependency on the preceding slice, at most ${maxCodeFilesPerTask} code files per task, disjoint writes and no dependency between tasks where possible, so they run in parallel. Files whose whole content the request fixes (module stubs, a registration file) go in one task whose writes carry their content, which the host writes for nothing.`;
}

/** The approval's line for the sized active time against the active-time cap (#933). */
export function activeTimeText(time: SizingReport["activeTime"]): string {
  const rate = `${Math.round(time.tokensPerMinute / 1000)}k tokens per minute, ${
    time.basis === "history" ? `the median of ${time.runs} runs` : "the default rate"
  }`;
  const cap =
    time.after > time.before
      ? `; sizing raised the cap to ${minutes(time.after)} min`
      : time.estimatedMs > time.before
        ? "; the run may stop at the cap"
        : "";
  return `Estimated active time at the observed rate (${rate}): ${minutes(time.estimatedMs)} min against maxActiveMs ${minutes(time.before)} min${cap}`;
}

/**
 * The latest plan pricing's over-ceiling line as an approval body field, or nothing when the
 * plan fits: approving a plan the ceiling cannot finish names where it should stop (#974).
 */
export function overCeilingOf(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): { budgetWarning?: string } {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-"))
    .at(-1);
  if (!latest) return {};
  const report = JSON.parse(store.readArtifact(runId, latest.id)) as Partial<SizingReport>;
  return report.overCeiling ? { budgetWarning: report.overCeiling.warning } : {};
}

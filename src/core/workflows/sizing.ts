import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changedLines, diffSections } from "../intelligence/call-context.js";
import { isManifestFile, isTestFile } from "../intelligence/language-traits.js";
import { isTestOf } from "../verification/convergence.js";
import {
  type CaseContext,
  criterionCases,
  missingCases,
  type SpecText,
} from "../verification/criteria-cases.js";
import { type Fence, fences } from "../verification/doc-examples.js";
import { hostRowPaths, literalRows, rowsAsDataOn } from "./acceptance-rows.js";
import { MAX_EXTENDED_MS } from "./budget.js";
import { DEFAULT_STAGE_RANGES, historyStorePaths, rangeOf, type TokenRange } from "./estimate.js";
import { type HostEdit, plannerGraph, recordGraphEdits } from "./host-edits.js";
import { MIN_DURATION_SAMPLES } from "./initiatives/duration.js";
import { extendToOf, type RunPolicy, SpecSchema, type TaskGraph } from "./schemas.js";
import { DEFAULT_MAX_ATTEMPT_TOKENS } from "./step-budget.js";
import type { WorkflowStore } from "./store.js";
import { hostWritten } from "./task-graph.js";
import type { Task } from "./types.js";

/**
 * Plan-time sizing. Code, docs and manifests use per-file rates. Test tasks use the median and
 * 90th percentile of finished task costs; cases choose a broad bucket, never a multiplier on
 * historical costs. Prices set attempt caps and the run budget. Observed case capacity decides
 * proactive test splits independently of those token prices.
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
  /** A finished task of the active run, preferred to earlier runs. */
  current?: boolean;
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
/** A bucket needs two finished tasks; otherwise use the whole test-task distribution. */
export const MIN_TEST_TASK_SAMPLES = 2;
/** Cold-start allowance per literal case until case-bearing history is available. */
export const DEFAULT_PER_CASE: TokenRange = { low: 15_000, high: 75_000 };
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
type SizingTask = Pick<Task, "writes"> & Partial<Pick<Task, "rows" | "rowTest">>;
/** A selected criterion may also name ordinary cases; only its emitted row cases are free. */
function pricedCaseCount(
  spec: SpecText,
  task: Parameters<typeof criterionCases>[1],
  context: CaseContext,
): number {
  const rows = task.rows?.length ? literalRows(spec, task.rows) : [];
  return criterionCases(spec, task, context).filter(
    (item) =>
      !rows.some(
        (row) =>
          row.criterionId === item.criterionId && missingCases([item], [row.source]).length === 0,
      ),
  ).length;
}
/** The files an agent writes for the task: none when the host writes them (#1460). */
function written(task: SizingTask): Written[] {
  if (hostWritten(task)) return [];
  const generated = hostRowPaths(task);
  return task.writes.flatMap((w) =>
    w.action === "delete" || generated.includes(w.path) ? [] : [{ path: w.path, action: w.action }],
  );
}
function writtenFiles(task: SizingTask): string[] {
  return written(task).map((w) => w.path);
}
export function taskKind(task: SizingTask): TaskKind {
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
  currentRunId?: string,
): SizingSample[] {
  if (!existsSync(databasePath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true });
    const runs = currentRunId
      ? [{ id: currentRunId }]
      : db.query<{ id: string }, []>("SELECT id FROM runs WHERE status='completed'").all();
    const samples: SizingSample[] = [];
    for (const { id } of runs) {
      let spec: SpecText | null = null;
      let checks: CaseContext["checks"] = [];
      try {
        const policy = db
          .query<{ policy_json: string }, [string]>("SELECT policy_json FROM runs WHERE id=?")
          .get(id);
        if (policy)
          checks =
            (JSON.parse(policy.policy_json) as Partial<Pick<RunPolicy, "checks">>).checks ?? [];
      } catch {
        // A run without a readable policy prices every quoted literal, as before #1762.
      }
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
        .query<{ id: string; definition_json: string; status: string }, [string]>(
          currentRunId
            ? "SELECT id, definition_json, status FROM tasks WHERE run_id=?"
            : "SELECT id, definition_json, status FROM tasks WHERE run_id=? AND status='verified'",
        )
        .all(id)
        .map((row) => ({
          id: row.id,
          status: row.status,
          ...(JSON.parse(row.definition_json) as Pick<Task, "writes" | "origin"> &
            Partial<Pick<Task, "criterionIds" | "description" | "dependsOn" | "sizingSlice">>),
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
      for (const correction of tasks.filter(
        (task) => task.origin !== "planned" && ["implemented", "verified"].includes(task.status),
      )) {
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
        if (!["implemented", "verified"].includes(task.status)) continue;
        const files = writtenFiles(task).length;
        const tokens = totals.get(task.id) ?? 0;
        if (files > 0 && tokens > 0)
          samples.push({
            runId: id,
            taskId: task.id,
            ...(currentRunId ? { current: true } : {}),
            kind: taskKind(task),
            action: taskAction(task),
            source,
            files,
            tokens,
            model: modelOf.get(`task-${task.id}`)?.model ?? null,
            criteria: task.criterionIds?.length ?? 0,
            ...(spec && task.criterionIds
              ? {
                  cases: pricedCaseCount(
                    spec,
                    { ...task, criterionIds: task.criterionIds },
                    {
                      checks,
                      tasks: planned.map((t) => ({ ...t, criterionIds: t.criterionIds ?? [] })),
                      includeBroad: true,
                    },
                  ),
                }
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

/**
 * Supplied-lines pricing (`sizing.suppliedDiff`, #2002). A request that carries a task's change
 * verbatim (a unified diff, or the file's whole content) leaves the agent little to find out, and
 * the per-file rates of history overpriced such tasks several times over: spdxok-update (bench
 * round 64) priced two 2-file tasks at 307k-762k and 242k-683k from 79-214 history samples, split
 * the plan, paid 98k for the replan, and the three tasks it got cost 59k, 72k and 105k.
 *
 * Measured exact-diff updates cost 56k-79k per changed file (round 63, sdd) and 34k (ecfit quick),
 * 134k (spdxok) and 320k (mdtoc) in round 64. The floor's low end is the lowest of them, 34k, never
 * a quantile (AGENTS.md forecast-floor rule); its high end is the highest outcome of a run that
 * applied the supplied lines as given, 134k: mdtoc's 320k came from a different defect (round 64
 * Issue 6), not from the size of the change. These are per written file.
 */
export const SUPPLIED_PER_FILE: TokenRange = { low: 34_000, high: 134_000 };
/**
 * Tokens per supplied changed line: the edit writes each line once and every later step of the
 * attempt sends it again. It only takes over from the per-file floor above about 136 lines a file,
 * a whole file's content rather than a hunk; round 64 recorded no line counts to measure it on.
 */
export const SUPPLIED_PER_LINE: TokenRange = { low: 250, high: 1_000 };

/** A path as a request writes it: no `./`, no diff timestamp after a tab. */
const requestPath = (path: string): string =>
  (path.split("\t")[0] ?? "").trim().replace(/^(?:\.\/)+/, "");

/**
 * The path a fenced block's first line names in a comment (`# a.py`, `// src/a.ts`, `-- a.lua`,
 * `; a.lisp`), or null. The token must look like a file path (an extension); words may follow it
 * when it has a directory (`// src/frames.ts   (names and shapes are fixed)`) or when they open
 * with punctuation (`# setup.py (entry point)`), so a comment such as `// Node.js helper` is not
 * a path (#2453).
 */
export function headerPath(first: string | undefined): string | null {
  const m = /^\s*(?:#|\/\/|--|;)\s*(\S+)(.*)$/.exec(first ?? "");
  const token = m?.[1]?.replace(/[:,]$/, "") ?? "";
  if (!/^(?:\.\/)*[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z]\w*$/.test(token)) return null;
  const rest = m?.[2]?.trim() ?? "";
  return !rest || token.includes("/") || /^[([{\-\u2013\u2014:,;]/.test(rest)
    ? requestPath(token)
    : null;
}

/** Paths a piece of prose names: in backticks, or as a bare `dir/name.ext` token. */
const namedPaths = (text: string): string[] =>
  [
    ...[...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1] as string),
    ...[...text.matchAll(/[\w./-]+\.\w+/g)].map((m) => m[0]),
  ].map(requestPath);

/**
 * The one path of `wanted` a block is attributed to (#2453). A comment on its first line that
 * names a path (`headerPath`) decides alone: the block is that file's, and not for any wanted
 * path when the header names another file; `byHeader` when the last line of prose before it does
 * not name that path too. Otherwise the one path of `wanted` the last prose line names ("Replace
 * `src/a.ts` with:"), among those ending in the header's name when the header is a bare file name
 * (`# config.py`). Null when none or more than one is named.
 */
function blockPath(
  block: Fence,
  wanted: ReadonlySet<string>,
): { path: string; byHeader: boolean } | null {
  const last = lastLine(block.prose);
  const header = headerPath(block.lines[0]);
  if (header && wanted.has(header))
    return { path: header, byHeader: !namedPaths(last).includes(header) };
  // A bare file name in the header (`# config.py`) still lets the prose say which directory.
  const fits = (path: string) => !header || (!header.includes("/") && path.endsWith(`/${header}`));
  const named = new Set(namedPaths(last).filter((path) => wanted.has(path) && fits(path)));
  return named.size === 1 ? { path: [...named][0] as string, byHeader: false } : null;
}

/**
 * The part of a block's last prose line that speaks about `path`, for `WHOLE_FILE` (#2453): the
 * clauses (split at `;`, `:` and sentence ends) that name it, or, when none does, the clauses that
 * name no path. R78 deltaglue's "... `src/assemble.ts`; tests check the whole stream" before the
 * `// src/cli.ts` listing made the listing a whole file through a clause about other files.
 */
function pathClauses(prose: string, path: string): string {
  const clauses = lastLine(prose).split(/[;:]|[.!?](?=\s|$)/);
  const naming = clauses.filter((clause) => namedPaths(clause).includes(path));
  return (naming.length ? naming : clauses.filter((clause) => !namedPaths(clause).length)).join(
    " ",
  );
}

/**
 * Prose before a fenced file that says the block is the file's whole content ("Replace `a.ts`
 * with:", "the full contents of `a.ts`"), not an excerpt to merge into it.
 */
const WHOLE_FILE =
  /\b(?:replace[ds]?|overwrite|whole|full|entire|complete|contents?|exactly|verbatim)\b/i;

/** One verbatim block a request gives for a path (#2023). */
export type SuppliedBlock =
  | {
      kind: "diff";
      /** Added and removed lines of the path's hunks (`changedLines`). */
      lines: number;
      /** The path's sections of the diff, ready for `git apply -p1` (`diffSections`). */
      patch: string;
    }
  | {
      kind: "file";
      lines: number;
      /** The block's text, ending in a newline. */
      content: string;
      /** Whether the prose before it says it is the whole file (`WHOLE_FILE`). */
      whole: boolean;
      /**
       * Set when only a comment on its first line names the path and the prose does not say it is
       * the whole file: an API listing as likely as a file (R77 trailspin's `// internal/cli/cli.go`
       * signatures, #2438). The host neither writes it nor compares a delivery with it.
       */
      listing?: true;
      /** The Markdown section the block is, for a Markdown file (`markdownRegion`, #2101). */
      region?: MarkdownRegion;
    };

/** A Markdown section by its heading: the title (trimmed) and the heading's level. */
export interface MarkdownRegion {
  title: string;
  level: number;
}

const MARKDOWN_FILE = /\.(?:md|mdx|markdown)$/i;
/**
 * Prose that says a fenced Markdown block is the whole file. Stricter than `WHOLE_FILE`, whose
 * "exactly" and "verbatim" describe a section's text as well ("add this section exactly").
 */
const WHOLE_DOCUMENT =
  /\b(?:whole|full|entire|complete|overwrite)\b|\breplace[ds]?\s+(?:the\s+)?(?:file|readme|`?[\w./-]+\.(?:md|mdx|markdown)`?)(?:\s|$|[:.,])/i;

/**
 * The section a fenced block gives for a Markdown file (#2101): a block whose first non-blank
 * line is a heading, for a `.md`, `.mdx` or `.markdown` path, when the prose before it does not
 * say it is the whole file (`WHOLE_DOCUMENT`). Bench round 67 srtvet-update gave the README
 * section "## Cleaning spaces" verbatim, and the README task (T003, 123k tokens) was an
 * implementer's: the host had no way to write a section into an existing file. Null otherwise.
 */
export function markdownRegion(
  path: string,
  lines: readonly string[],
  prose: string,
): MarkdownRegion | null {
  if (!MARKDOWN_FILE.test(path)) return null;
  if (WHOLE_DOCUMENT.test(prose.trim().split("\n").at(-1) ?? "")) return null;
  const heading = HEADING.exec(lines.find((line) => line.trim()) ?? "");
  const title = heading?.[2]?.trim();
  return heading && title ? { title, level: heading[1]?.length ?? 1 } : null;
}

/**
 * The one reader of a request's verbatim blocks (#2002, #2023): for each path of `paths`, every
 * fenced unified diff hunk for it (`+++` headers, read by `changedLines` and `diffSections`) and
 * every fenced block attributed to it (`blockPath`). A path no block supplies is absent. Pricing
 * (`suppliedLines`) and the host's apply decision (`hostApplyDecision`) both read it. A fenced
 * block of a path that also has a diff is context, not a supplied file, when it quotes the diff's
 * lines or its prose calls it the old or new line (`quotesDiff`, #2366): the diff alone supplies
 * the path, and a block that is neither still conflicts with it.
 */
export function suppliedBlocks(
  request: string,
  paths: readonly string[],
): Map<string, SuppliedBlock[]> {
  const wanted = new Set(paths.map(requestPath));
  const out = new Map<string, SuppliedBlock[]>();
  const prose = new Map<SuppliedBlock, string>();
  const add = (path: string, block: SuppliedBlock) => {
    const key = requestPath(path);
    if (wanted.has(key) && block.lines > 0) out.set(key, [...(out.get(key) ?? []), block]);
  };
  for (const block of fences(request)) {
    const body = block.lines.join("\n");
    if (/^\+\+\+ /m.test(body)) {
      const sections = diffSections(body);
      for (const [path, lines] of changedLines(body)) {
        const key = requestPath(path);
        const patch = sections
          .filter((s) => !s.deletes && requestPath(s.path) === key)
          .map((s) => s.patch)
          .join("");
        add(path, { kind: "diff", lines: lines.length, patch });
      }
      continue;
    }
    const attributed = blockPath(block, wanted);
    if (!attributed) continue;
    const { path } = attributed;
    const region = markdownRegion(path, block.lines, block.prose);
    const whole = WHOLE_FILE.test(pathClauses(block.prose, path));
    const file: SuppliedBlock = {
      kind: "file",
      lines: block.lines.length,
      content: `${body}\n`,
      whole,
      ...(attributed.byHeader && !whole ? { listing: true } : {}),
      ...(region ? { region } : {}),
    };
    prose.set(file, block.prose);
    add(path, file);
  }
  // A path with a diff: the blocks that quote its change are context, and the diff wins (#2366).
  for (const [path, blocks] of out) {
    const lines = diffLines(blocks);
    if (lines)
      out.set(
        path,
        blocks.filter((b) => b.kind !== "file" || !quotesDiff(b.content, prose.get(b), lines)),
      );
  }
  return out;
}

const lastLine = (prose: string): string => prose.trim().split("\n").at(-1) ?? "";

/**
 * Prose that introduces a fenced block as a line of the change, not as the file (#2366): "Old
 * line:", "New lines:", "the line", or "Before:" / "After:" at its end.
 */
const QUOTED_LINE =
  /\b(?:old|new|original|current|updated|changed|replacement)\s+lines?\b|\bthe\s+lines?\b|\b(?:before|after)(?:\s+the\s+change)?\s*:?\s*$/i;

/** The text of every hunk line (added, removed or context) of a path's diffs; null without one. */
function diffLines(blocks: readonly SuppliedBlock[]): Set<string> | null {
  const patches = blocks.flatMap((b) => (b.kind === "diff" ? [b.patch] : []));
  if (!patches.length) return null;
  return new Set(
    patches
      .join("")
      .split("\n")
      .filter((line) => /^[ +-]/.test(line) && !/^(?:---|\+\+\+) /.test(line))
      .map((line) => line.slice(1).trim()),
  );
}

/**
 * Whether a fenced block next to a diff of its path quotes the change rather than giving the file
 * (#2366): the prose before it says it is the old or new line (`QUOTED_LINE`), or every non-blank
 * line of it is a line of the diff. R75 evalpin-update quoted the old and new line of
 * `tests/cli.rs` after "Exactly one existing test changes ... Old line:", the quote was read as
 * the whole file next to the diff, and the host declined T002 for an implementer.
 */
function quotesDiff(content: string, prose: string | undefined, lines: ReadonlySet<string>) {
  if (QUOTED_LINE.test(lastLine(prose ?? ""))) return true;
  const quoted = content.split("\n").filter((line) => line.trim());
  return quoted.length > 0 && quoted.every((line) => lines.has(line.trim()));
}

/**
 * Lines each path of `paths` gets from the verbatim blocks of a request (`suppliedBlocks`): the
 * added and removed lines of a fenced unified diff, or every line of a fenced block attributed to
 * the path. A path no block supplies is absent.
 */
export function suppliedLines(request: string, paths: readonly string[]): Map<string, number> {
  return new Map(
    [...suppliedBlocks(request, paths)].map(([path, blocks]) => [
      path,
      blocks.reduce((sum, block) => sum + block.lines, 0),
    ]),
  );
}

/**
 * Tokens per character of a text a test compares exactly, when the request supplies it verbatim
 * (#2101). Bench round 67 srtvet-update T005 compared the README section "## Cleaning spaces"
 * (1,264 characters with backticks and two fenced blocks, given in the request) byte for byte in
 * Go and cost 1.64M tokens in one session, four check rounds over the string's quoting, against a
 * price of 285k-834k from its 14 cases. The high end is that run's 1,300 tokens a character; the
 * low end is half of it, an attempt that gets the quoting right in two rounds. One measurement.
 */
export const SUPPLIED_TEXT_PER_CHAR: TokenRange = { low: 650, high: 1_300 };

/** A criterion that compares a text exactly, not by its parts. */
const EXACT_TEXT =
  /\b(?:exact(?:ly)?|verbatim|byte[- ](?:for[- ]byte|exact)|identical|character[- ]for[- ]character)\b/i;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The Markdown sections of a request, by heading title (lower case): the characters from the
 * heading line to the line before the next heading of the same or a higher level, or to the close
 * of the fence the section is quoted in. A heading inside a fenced block of the section (`# a
 * shell comment`) ends nothing.
 */
export function requestSections(request: string): Map<string, number> {
  return new Map(
    [...requestSectionTexts(request)].map(([title, text]) => [title, [...text].length]),
  );
}

/**
 * The text of each Markdown section of a request, by heading title (lower case), as
 * `requestSections` measures it: from the heading line to the end of the section, trailing space
 * trimmed. The first section of a title wins.
 */
export function requestSectionTexts(request: string): Map<string, string> {
  const lines = request.split(/\r?\n/);
  const sections = new Map<string, string>();
  // The fences open at each line: the outer one a section may be quoted in, then its inner ones.
  const open: { char: string; length: number; info?: string }[] = [];
  const closes = (line: string, fence: { char: string; length: number }) => {
    const m = FENCE_LINE.exec(line);
    return !!m && m[1]?.[0] === fence.char && (m[1]?.length ?? 0) >= fence.length && !m[2]?.trim();
  };
  const step = (stack: { char: string; length: number; info?: string }[], line: string) => {
    const top = stack.at(-1);
    if (top && closes(line, top)) {
      stack.pop();
      return;
    }
    const m = FENCE_LINE.exec(line);
    // Outside a fence any fence line opens one; inside, one with an info string (`` ```text ``),
    // a block of the Markdown file the outer fence quotes.
    if (m && (!top || m[2]?.trim()))
      stack.push({
        char: m[1]?.[0] ?? "`",
        length: m[1]?.length ?? 3,
        info: m[2]?.trim().toLowerCase() ?? "",
      });
  };
  for (const [i, line] of lines.entries()) {
    // A heading of the request, or of a Markdown file it quotes in a fence.
    const quoted = open.length === 1 && ["", "md", "markdown"].includes(open[0]?.info ?? "");
    const heading = !open.length || quoted ? HEADING.exec(line) : null;
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const outer = open.at(-1);
      const inner: { char: string; length: number }[] = [];
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (!inner.length && outer && closes(next, outer)) {
          end = j;
          break;
        }
        const h = inner.length ? null : HEADING.exec(next);
        if (h && (h[1]?.length ?? 1) <= level) {
          end = j;
          break;
        }
        step(inner, next);
      }
      const text = lines.slice(i, end).join("\n").replace(/\s+$/, "");
      const title = (heading[2] ?? "").trim().toLowerCase();
      if (!sections.has(title)) sections.set(title, text);
    }
    step(open, line);
  }
  return sections;
}

/**
 * The characters of the request's sections a test task compares exactly (#2101): a section whose
 * title a criterion of the task names, in a criterion that says the comparison is exact
 * (`EXACT_TEXT`). Zero when there is none.
 */
export function exactTextChars(
  request: string,
  spec: SpecText,
  task: Pick<Task, "criterionIds">,
): number {
  return exactTextSections(request, spec, task).reduce((sum, s) => sum + [...s.text].length, 0);
}

/**
 * The request's sections a task's criteria compare exactly (#2101): a section whose title a
 * criterion of the task names, in a criterion that says the comparison is exact (`EXACT_TEXT`),
 * with its text. Empty when there is none.
 */
export function exactTextSections(
  request: string,
  spec: SpecText,
  task: Pick<Task, "criterionIds">,
): { title: string; text: string }[] {
  const sections = requestSectionTexts(request);
  if (!sections.size) return [];
  const named = new Set<string>();
  for (const criterion of spec.criteria) {
    if (!task.criterionIds.includes(criterion.id)) continue;
    const text = `${criterion.given}\n${criterion.when}\n${criterion.then}`;
    if (!EXACT_TEXT.test(text)) continue;
    const lower = text.toLowerCase();
    for (const title of sections.keys())
      if (title.length >= 3 && lower.includes(title)) named.add(title);
  }
  return [...named].map((title) => ({ title, text: sections.get(title) ?? "" }));
}

/** A task priced from the lines the request supplies for it. */
export interface SuppliedPrice {
  estimate: TokenRange;
  /** Supplied changed lines over the task's written files. */
  lines: number;
  /** Whether the lines alone, not the per-file floor, put one attempt above the cap. */
  oversized: boolean;
}

/**
 * The one rule that decides supplied pricing (#2002): a task whose every written file has a
 * supplied block is priced at `SUPPLIED_PER_LINE` per supplied line, at least `SUPPLIED_PER_FILE`
 * per file. Its split is decided on those lines, never on the number of files, and for a test task
 * never on its case count. Null for any other task, which keeps its history price.
 *
 * A test task is no exception (#2019): the case rates of `testTaskRates` assume the agent designs
 * the cases, and a test file the request gives verbatim leaves it only the copying. Bench round 65
 * aclvet-update priced summary_test.go (98 lines given) at 384k-893k and cli_test.go (a 2-line
 * diff) at 426k-1.14M; they cost 58k and 104k.
 */
export function suppliedTaskPrice(
  task: SizingTask,
  supplied: ReadonlyMap<string, number> | null,
  cap: number,
): SuppliedPrice | null {
  if (!supplied?.size) return null;
  const files = writtenFiles(task);
  if (!files.length) return null;
  let lines = 0;
  for (const path of files) {
    const count = supplied.get(requestPath(path));
    if (!count) return null;
    lines += count;
  }
  return {
    estimate: {
      low: Math.max(files.length * SUPPLIED_PER_FILE.low, lines * SUPPLIED_PER_LINE.low),
      high: Math.max(files.length * SUPPLIED_PER_FILE.high, lines * SUPPLIED_PER_LINE.high),
    },
    lines,
    oversized: files.length > 1 && lines * SUPPLIED_PER_LINE.high > cap,
  };
}

/** Where a history-priced task's estimate came from: measured tasks, or only the defaults. */
function historyBasis(
  task: SizingTask,
  rates: Rates,
  tests: TestTaskRates,
  cases: number,
): "history" | "default" {
  if (taskKind(task) === "test") {
    const measured = (cases > 0 ? tests.buckets[caseBucket(cases)] : null) ?? tests.all;
    if (measured && tests.hasCases) return "history";
  }
  return written(task).some(
    ({ path, action }) => rates[fileKind(path)][action].basis !== "defaults",
  )
    ? "history"
    : "default";
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
  /** Tests exceed observed case capacity, or the cold-start allowance; code exceeds its cap. */
  oversized: boolean;
  /**
   * What priced the task (#2002): `supplied`, the lines the request supplies for it
   * (`suppliedTaskPrice`); `history`, finished tasks; `default`, the defaults alone. Absent in
   * reports written before it.
   */
  basis?: "supplied" | "history" | "default";
  /** The supplied changed lines of a `supplied` task. */
  suppliedLines?: number;
  /**
   * The characters of the request's sections a test task compares exactly, which price it when
   * above its case price (#2101).
   */
  exactTextChars?: number;
  cases?: number;
  /** Sequential slices of this test file, including this task. */
  sliceCount?: number;
  /** A rows task (`rows` and `rowTest`), with its criteria that have no rows (#1930). */
  rowsTask?: TestTaskRows;
}

/** What sizing knows of a rows task: the criteria a planner could move to a test task of their own. */
export interface TestTaskRows {
  movable: string[];
}

export interface SizingReport {
  schemaVersion: 3;
  /** The model the tasks were priced for; null when none was known. */
  model: string | null;
  rates: Rates;
  /** Legacy unit-rate fields retained for readers of schema version 3. */
  criterionRate: null;
  caseRate: null;
  /** Per-task distributions, with optional broad case-count buckets. */
  testTaskRates: TestTaskRates;
  /** Largest finished task's counts, used for proactive splitting. */
  testTaskLimit: TestTaskLimit | null;
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
    /** `initiative` when the initiative's own finished runs set the pace (#2336). */
    basis: PaceBasis;
    runs: number;
    /**
     * The tokens per active minute of the initiative's other finished feature runs, rounded; empty
     * outside an initiative. Absent in reports before #2336.
     */
    ownRates?: number[];
    /** With basis `initiative`: the history's pace it was preferred to. */
    history?: { tokensPerMinute: number; basis: "history" | "default"; runs: number };
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

export interface TestTaskRate {
  perTask: TokenRange;
  samples: number;
  basis: "run" | "project" | "history";
  model: string | null;
}
export interface TestTaskRates {
  all: TestTaskRate | null;
  buckets: Partial<Record<"small" | "medium" | "large", TestTaskRate>>;
  /** Older history without readable specs cannot replace the cold-start case allowance. */
  hasCases: boolean;
}
export interface TestTaskLimit {
  tokens: number;
  cases: number;
  criteria: number;
}

const caseBucket = (cases: number): "small" | "medium" | "large" =>
  cases <= 5 ? "small" : cases <= 20 ? "medium" : "large";

function testHistory(samples: SizingSample[], model: string | null) {
  const tests = samples.filter(
    (s) => s.kind === "test" && Number.isFinite(s.tokens) && s.tokens > 0,
  );
  const own = model ? tests.filter((s) => s.model === model) : [];
  const ofModel = own.length >= MIN_MODEL_SAMPLES ? model : null;
  const pool = ofModel ? own : tests;
  const current = pool.filter((s) => s.current);
  const project = pool.filter((s) => s.source === "project");
  const basis: TestTaskRate["basis"] = current.length
    ? "run"
    : project.length >= MIN_PROJECT_SAMPLES
      ? "project"
      : "history";
  const chosen = basis === "run" ? current : basis === "project" ? project : pool;
  return { chosen, source: { samples: chosen.length, basis, model: ofModel } };
}

/** Median and nearest-rank 90th percentile of whole tasks, including equal-case-count samples. */
export function testTaskRates(samples: SizingSample[], model: string | null = null): TestTaskRates {
  const { chosen, source } = testHistory(samples, model);
  const rate = (tasks: SizingSample[]): TestTaskRate => {
    const sorted = tasks.map((s) => s.tokens).sort((a, b) => a - b);
    const quantile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] ?? 0;
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    return {
      perTask: { low: Math.round(median), high: quantile(0.9) },
      ...source,
      samples: tasks.length,
    };
  };
  const buckets: TestTaskRates["buckets"] = {};
  for (const bucket of ["small", "medium", "large"] as const) {
    const tasks = chosen.filter((s) => (s.cases ?? 0) > 0 && caseBucket(s.cases ?? 0) === bucket);
    if (tasks.length >= MIN_TEST_TASK_SAMPLES) buckets[bucket] = rate(tasks);
  }
  return {
    all: chosen.length ? rate(chosen) : null,
    buckets,
    hasCases: chosen.some((s) => (s.cases ?? 0) > 0),
  };
}

function testTaskLimit(samples: SizingSample[], model: string | null): TestTaskLimit | null {
  const { chosen } = testHistory(samples, model);
  if (!chosen.length) return null;
  return {
    tokens: Math.max(...chosen.map((s) => s.tokens)),
    cases: Math.max(...chosen.map((s) => s.cases ?? 0)),
    criteria: Math.max(...chosen.map((s) => s.criteria ?? 0)),
  };
}

/** What a literal test case costs, as the initiative estimate prices a brief's test volume. */
export interface TestCaseRate {
  perCase: TokenRange;
  /** Finished runs whose test tasks with cases the rate is measured on; 0 for the default. */
  samples: number;
  /**
   * `project`: this project's own runs. `history`: too few of those, so every store's.
   * `defaults`: fewer than two runs with finished test tasks with cases (`DEFAULT_PER_CASE`).
   */
  basis: "project" | "history" | "defaults";
}

/**
 * Tokens per literal case of finished runs' test tasks, for the test volume a brief demands of an
 * initiative's feature (#2055). Each run's test tasks count as one rate (their tokens over their
 * cases), since a brief's volume is per feature and one task's rate swings with how its cases fall
 * into files: in the bench-trace corpus single tasks ran from 1,354 tokens a case, initiative
 * features from 2,152. From the lowest run rate, as a forecast floor takes it (#1806), up to their
 * median, this project's runs first: in bench round 66 nodepluck's test tasks were 17.26M tokens,
 * 51.9 percent of the initiative, and its features' rates ran from 21k to 41k a case.
 */
export function testCaseRate(samples: SizingSample[]): TestCaseRate {
  const tests = samples.filter(
    (s) => s.kind === "test" && (s.cases ?? 0) > 0 && Number.isFinite(s.tokens) && s.tokens > 0,
  );
  const runs = (pool: SizingSample[]) => {
    const byRun = new Map<string, { tokens: number; cases: number }>();
    for (const s of pool) {
      const run = byRun.get(s.runId) ?? { tokens: 0, cases: 0 };
      run.tokens += s.tokens;
      run.cases += s.cases ?? 0;
      byRun.set(s.runId, run);
    }
    return [...byRun.values()].map((run) => run.tokens / run.cases);
  };
  const project = runs(tests.filter((s) => s.source === "project"));
  const basis = project.length >= MIN_PROJECT_SAMPLES ? "project" : "history";
  const rates = (basis === "project" ? project : runs(tests)).sort((a, b) => a - b);
  if (rates.length < MIN_PROJECT_SAMPLES)
    return { perCase: DEFAULT_PER_CASE, samples: 0, basis: "defaults" };
  const mid = Math.floor(rates.length / 2);
  const median =
    rates.length % 2 ? (rates[mid] ?? 0) : ((rates[mid - 1] ?? 0) + (rates[mid] ?? 0)) / 2;
  return {
    perCase: { low: Math.round(rates[0] ?? 0), high: Math.round(median) },
    samples: rates.length,
    basis,
  };
}

/** Test history prices a whole task. Only cold starts multiply a default by the case count. */
export function priceTask(
  task: SizingTask & Partial<Pick<Task, "criterionIds" | "sizingSlice">>,
  rates: Rates,
  tests: TestTaskRates = { all: null, buckets: {}, hasCases: false },
  cases = 0,
): TokenRange {
  const share = taskKind(task) === "test" ? (task.sizingSlice?.share ?? 1) : 1;
  const byFile = written(task).reduce(
    (total, { path, action }) => {
      const rate = rates[fileKind(path)][action].perFile;
      return { low: total.low + rate.low * share, high: total.high + rate.high * share };
    },
    { low: 0, high: 0 },
  );
  if (taskKind(task) !== "test") return byFile;
  const measured = (cases > 0 ? tests.buckets[caseBucket(cases)] : null) ?? tests.all;
  if (measured && tests.hasCases) return measured.perTask;
  return {
    low: Math.round(Math.max(byFile.low, cases * DEFAULT_PER_CASE.low)),
    high: Math.round(Math.max(byFile.high, cases * DEFAULT_PER_CASE.high)),
  };
}

/**
 * How many times the observed case capacity a test task may cover and stay whole while its price
 * fits one attempt (#1789). The capacity is the largest case count a finished task handled, and
 * splitting at it keeps every later task at or under it, so it never grew: bench round 53 cut
 * url-shortener's 8 planned tasks into 20 at a capacity of 4 and spent 5.78M tokens against
 * 3.42M. In the bench-trace corpus a whole test task of 9-16 cases cost a median 349k tokens and a
 * chain of slices of the same size 572k, with the same share of attempts that reached a cap.
 */
export const CAPACITY_PROBE = 4;

/**
 * Whether a test task of `cases` literal cases priced at `estimate` is split. With an observed
 * case capacity, a task above it splits when it covers more than `CAPACITY_PROBE` times it or its
 * expected price is above one attempt's cap; a whole task that finishes raises the capacity for
 * later runs. Without one, only the price decides.
 *
 * A rows task is never sliced, by the host or by the planner (`rowPlanProblems`), and its price is
 * a finished task's tokens over all its continuations, not one attempt's. So price alone never
 * splits it: only its cases above `CAPACITY_PROBE` times the capacity do, and only when it has
 * criteria without rows to move into a test task of their own. Bench round 60, wheeltags explain:
 * a 40-case rows task priced above the cap went between plan and analysis five times, 1.03M tokens,
 * while the planner note said to keep it whole (#1930).
 */
export function exceedsTestCapacity(
  cases: number,
  limit: TestTaskLimit | null,
  estimate: TokenRange,
  cap: number,
  keepSmall = true,
  rows: TestTaskRows | null = null,
): boolean {
  const capacity = limit?.cases ?? 0;
  if (rows) {
    if (!rows.movable.length) return false;
    return capacity > 0
      ? cases > CAPACITY_PROBE * capacity
      : cases > 5 && expectedPrice(estimate) > cap;
  }
  if (capacity > 0) {
    if ((keepSmall && cases <= 5) || cases <= capacity) return false;
    return cases > CAPACITY_PROBE * capacity || expectedPrice(estimate) > cap;
  }
  return (cases === 0 || cases > 5) && expectedPrice(estimate) > cap;
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
  /**
   * Tokens per active minute of the finished feature runs of the run's initiative
   * (`initiativeRates`); from `MIN_DURATION_SAMPLES` of them their median sets the time estimate
   * before the history's (#2336).
   */
  ownRates?: readonly number[];
  /** Accepted criteria, including their quoted inputs and table rows. */
  spec?: SpecText | null;
  /** Price only these tasks while keeping the full graph for shared case ownership. */
  taskIds?: ReadonlySet<string>;
  /** The request as the user wrote it; with `sizing.suppliedDiff` its verbatim blocks price tasks. */
  request?: string | null;
}): SizingReport {
  const rates = perFileRates(input.samples, input.model ?? null);
  const tests = testTaskRates(input.samples, input.model ?? null);
  const limit = testTaskLimit(input.samples, input.model ?? null);
  const maxAttemptTokens = input.policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxRunTokens = input.policy.sizing?.maxRunTokens ?? null;
  const floor = input.policy.maxAttemptTokens ?? DEFAULT_MAX_ATTEMPT_TOKENS;
  const testSteps = input.policy.sizing?.testTaskSteps ?? DEFAULT_TEST_TASK_STEPS;
  const supplied =
    input.policy.sizing?.suppliedDiff && input.request
      ? suppliedLines(input.request, input.graph.tasks.flatMap(writtenFiles))
      : null;
  const tasks = input.graph.tasks
    .filter((task) => !input.taskIds || input.taskIds.has(task.id))
    .filter((task) => writtenFiles(task).length > 0)
    .map((task): TaskSize => {
      const kind = taskKind(task);
      const cases =
        input.spec && kind === "test"
          ? pricedCaseCount(input.spec, task, {
              checks: input.policy.checks,
              tasks: input.graph.tasks,
              includeBroad: true,
            })
          : 0;
      const fromRequest = suppliedTaskPrice(task, supplied, maxAttemptTokens);
      const byCases = fromRequest?.estimate ?? priceTask(task, rates, tests, cases);
      // A test that compares a supplied text exactly costs by the text's size (#2101).
      const textChars =
        supplied && input.request && input.spec && kind === "test" && !fromRequest
          ? exactTextChars(input.request, input.spec, task)
          : 0;
      const estimate = textChars
        ? {
            low: Math.max(byCases.low, textChars * SUPPLIED_TEXT_PER_CHAR.low),
            high: Math.max(byCases.high, textChars * SUPPLIED_TEXT_PER_CHAR.high),
          }
        : byCases;
      const files = writtenFiles(task).length;
      const rowsTask =
        kind === "test" && task.rows?.length
          ? { movable: task.criterionIds.filter((id) => !task.rows?.includes(id)) }
          : null;
      return {
        taskId: task.id,
        kind,
        files,
        estimate,
        attemptTokens: Math.min(maxAttemptTokens, Math.max(floor, Math.round(estimate.high))),
        attemptSteps: taskKind(task) === "test" ? testSteps : null,
        oversized: fromRequest
          ? fromRequest.oversized
          : kind === "test"
            ? // A slice of one criterion is as small as the host splits; its worker writes and
              // checks the cases in batches, so sending it to the planner asks for no plan (#1930).
              !(task.sizingSlice && task.criterionIds.length === 1) &&
              // A slice holds the same text, so the text's price never splits a task.
              exceedsTestCapacity(cases, limit, byCases, maxAttemptTokens, true, rowsTask)
            : files > 1 && estimate.high > maxAttemptTokens,
        basis: fromRequest ? "supplied" : historyBasis(task, rates, tests, cases),
        ...(fromRequest ? { suppliedLines: fromRequest.lines } : {}),
        ...(textChars ? { exactTextChars: textChars } : {}),
        ...(kind === "test" ? { cases, sliceCount: task.sizingSlice?.count ?? 1 } : {}),
        ...(rowsTask ? { rowsTask } : {}),
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
        task.basis === "supplied"
          ? // Split on the supplied lines alone (`suppliedTaskPrice`), whatever the task's kind.
            `${task.taskId} writes ${task.files} files and needs about ${Math.round(task.estimate.high)} tokens for the ${task.suppliedLines} lines the request supplies, above one attempt's ${maxAttemptTokens}`
          : task.rowsTask
            ? `${task.taskId} is a rows task covering ${task.cases} cases, ${(limit?.cases ?? 0) > 0 ? `above ${CAPACITY_PROBE} times the observed capacity of ${limit?.cases}` : `above one attempt's ${maxAttemptTokens} tokens`}; a rows task is never sliced, so keep only its rows criteria in it and move ${task.rowsTask.movable.join(", ")} into a test task of their own, writing another test file, that depends on it`
            : task.kind === "test" &&
                (limit?.cases ?? 0) > 0 &&
                (task.cases ?? 0) > CAPACITY_PROBE * (limit?.cases ?? 0)
              ? `${task.taskId} covers ${task.cases} cases, above ${CAPACITY_PROBE} times the observed capacity of ${limit?.cases}`
              : `${task.taskId} writes ${task.files} files and needs about ${Math.round(task.kind === "test" ? expectedPrice(task.estimate) : task.estimate.high)} tokens, above one attempt's ${maxAttemptTokens}`,
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
  // Rounded as recorded, so a replay of the report picks the same pace.
  const ownRates = (input.ownRates ?? [])
    .filter((rate) => Number.isFinite(rate) && rate > 0)
    .map((rate) => Math.round(rate));
  const rate = activePace(input.tokenRates ?? [], ownRates);
  const needed = Math.min(runTokens + repairReserve, budgetAfter);
  const timeBefore = input.policy.maxActiveMs;
  const { estimatedMs, after: timeAfter } = activeTimeLimit({
    neededTokens: needed,
    tokensPerMinute: rate.tokensPerMinute,
    maxActiveMs: timeBefore,
    maxRunTokens,
  });
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
    criterionRate: null,
    caseRate: null,
    testTaskRates: tests,
    testTaskLimit: limit,
    tasks,
    runTokens,
    taskTokens: { low: taskTokens.low, expected: taskTokens.expected, high: taskTokens.high },
    repairReserve,
    reserve,
    budgetBefore,
    budgetAfter,
    maxAttemptTokens,
    maxRunTokens,
    activeTime: { ...rate, ownRates, estimatedMs, before: timeBefore, after: timeAfter },
    decision,
    reasons,
    ...(overCeiling ? { overCeiling } : {}),
  };
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

const rateNote = (rate: { basis: PaceBasis; runs: number }) =>
  rate.basis === "initiative"
    ? `the median of ${rate.runs} finished runs of this initiative`
    : rate.basis === "history"
      ? `the median of ${rate.runs} earlier runs`
      : `the default until ${MIN_RATE_RUNS} runs are in history`;

/** Where a run's tokens per active minute come from. */
export type PaceBasis = "initiative" | "history" | "default";

/**
 * The active time a sized budget needs at a pace, and the active-time cap after sizing: the cap
 * grows to the time plus `ACTIVE_TIME_MARGIN`, rounded up to the minute, under `MAX_EXTENDED_MS`
 * and only under a `maxRunTokens` ceiling (#933). The bench replay decides it again from a sizing
 * report's recorded inputs (`replayActiveTimes`).
 */
export function activeTimeLimit(input: {
  neededTokens: number;
  tokensPerMinute: number;
  maxActiveMs: number;
  maxRunTokens: number | null;
}): { estimatedMs: number; after: number } {
  const estimatedMs = Math.round((input.neededTokens / input.tokensPerMinute) * 60_000);
  const before = input.maxActiveMs;
  const after =
    input.maxRunTokens !== null && estimatedMs * (1 + ACTIVE_TIME_MARGIN) > before
      ? Math.max(
          before,
          Math.min(
            MAX_EXTENDED_MS,
            Math.ceil((estimatedMs * (1 + ACTIVE_TIME_MARGIN)) / 60_000) * 60_000,
          ),
        )
      : before;
  return { estimatedMs, after };
}

/**
 * The pace that sizes a run's active time (#2336): the median of its initiative's own finished
 * feature runs once there are `MIN_DURATION_SAMPLES` of them, when it is slower than the history's
 * (`tokensPerMinute`); else the history's. R74 ladlemath ran at about 58k tokens per active minute
 * while the median of 262 runs of every project stayed at 134k, so every feature run was sized at
 * half the time it needed and three stopped on their active deadline. The history stays the prior
 * a faster initiative does not go below: a cap too short stops a run for a person's extend, one too
 * long costs nothing the token and dollar limits do not already bound. The history's rate is kept
 * beside the initiative's, so a replay decides again from the record.
 */
export function activePace(
  rates: readonly number[],
  ownRates: readonly number[] = [],
): {
  tokensPerMinute: number;
  basis: PaceBasis;
  runs: number;
  history?: { tokensPerMinute: number; basis: "history" | "default"; runs: number };
} {
  return paceOf(tokensPerMinute(rates), ownRates);
}

/** `activePace` on a history rate already reduced to its median (a recorded sizing report). */
export function paceOf(
  history: { tokensPerMinute: number; basis: "history" | "default"; runs: number },
  ownRates: readonly number[],
): ReturnType<typeof activePace> {
  const own = ownPace(ownRates);
  if (!own || own.tokensPerMinute >= history.tokensPerMinute) return history;
  return { ...own, basis: "initiative", history };
}

/**
 * The median tokens per active minute of an initiative's own finished feature runs, from
 * `MIN_DURATION_SAMPLES` of them; null with fewer.
 */
export function ownPace(
  ownRates: readonly number[],
): { tokensPerMinute: number; runs: number } | null {
  const own = ownRates.filter((rate) => Number.isFinite(rate) && rate > 0);
  if (own.length < MIN_DURATION_SAMPLES) return null;
  return { tokensPerMinute: Math.round(medianOf(own)), runs: own.length };
}

const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/**
 * A finished run's tokens per active minute, or null when it ran too briefly to show a pace: the
 * same floor as the history's (`tokenRatesFrom`).
 */
export function runPace(tokens: number, activeMs: number): number | null {
  if (activeMs < MIN_RATE_MS || tokens < MIN_RATE_TOKENS) return null;
  return tokens / (activeMs / 60_000);
}

/** The median tokens per active minute of at least `MIN_RATE_RUNS` runs, or the default. */
export function tokensPerMinute(rates: readonly number[]): {
  tokensPerMinute: number;
  basis: "history" | "default";
  runs: number;
} {
  const usable = rates.filter((rate) => Number.isFinite(rate) && rate > 0);
  if (usable.length < MIN_RATE_RUNS)
    return { tokensPerMinute: DEFAULT_TOKENS_PER_MINUTE, basis: "default", runs: usable.length };
  return { tokensPerMinute: Math.round(medianOf(usable)), basis: "history", runs: usable.length };
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

/**
 * How sizing treats a rows task, told to the planner both before it plans and in a split note, so
 * the plan it is asked for is one the rows rule accepts (#1930).
 */
export const ROWS_TASK_NOTE =
  "A rows task (rows and rowTest) is never sliced and stays whole whatever its price; its continuations finish it. If sizing names one as too large, keep only its rows criteria in it and move its other criteria into a test task of their own, writing another test file, that depends on it.";

/** How many code files one attempt covers, and what the planner is told before it plans. */
export function plannerSizing(
  policy: RunPolicy,
  samples: SizingSample[],
  model: string | null = null,
): { maxCodeFilesPerTask: number; note: string } {
  const rates = perFileRates(samples, model);
  const tests = testTaskRates(samples, model);
  const limit = testTaskLimit(samples, model);
  const maxAttemptTokens = policy.sizing?.maxAttemptTokens ?? DEFAULT_MAX_SIZED_ATTEMPT;
  const maxCodeFilesPerTask = Math.max(1, Math.floor(maxAttemptTokens / highest(rates, "code")));
  const k = (kind: FileKind) => `${Math.round(highest(rates, kind) / 1000)}k`;
  return {
    maxCodeFilesPerTask,
    note: `Give every task that writes code the policy's typecheck check, so its errors show in that task. Put tests in tasks of their own. A code file costs about ${k("code")} tokens, a documentation file about ${k("docs")}, a project manifest or solution file about ${k("manifest")}. ${tests.all && tests.hasCases ? `Finished test tasks cost a median ${Math.round(tests.all.perTask.low / 1000)}k and 90th percentile ${Math.round(tests.all.perTask.high / 1000)}k tokens per task; case counts select broad buckets, not a per-case historical rate.` : `Without history, allow ${DEFAULT_PER_CASE.low}-${DEFAULT_PER_CASE.high} tokens per literal case, at least the file allowance.`} Keep each code task to at most ${maxCodeFilesPerTask} files. A task whose writes all carry their content is written by the host and costs nothing, whatever its file count. Give independent tasks disjoint writes and no dependency between them; a test task depends on the code tasks whose criteria it covers. ${limit?.cases ? `Keep a test task whole up to ${CAPACITY_PROBE * limit.cases} literal cases (${CAPACITY_PROBE} times ${limit.cases}, the largest finished task handled): slices of one file cost more in total than the whole file. Split it only above that; the host itself splits a test task without rows whose price is above one attempt.` : "Keep a file with five or fewer literal cases in one task. Without observed case capacity, split a larger test file only when its default expected price exceeds the cap."} Split into sequential slices of whole criteria: create it first, then modify it, each slice depending on the previous. Preserve earlier slices and test only the assigned criteria. If one criterion alone exceeds the capacity, write and check its cases in batches inside the same attempt.${rowsAsDataOn(policy) ? ` ${ROWS_TASK_NOTE}` : ""}`,
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
export function codeTaskCheckProblems(
  graph: TaskGraph,
  policy: RunPolicy,
  edits?: readonly HostEdit[],
): string[] {
  const id = policy.sizing ? typecheckCheckId(policy) : null;
  if (!id) return [];
  return plannerGraph(graph, edits)
    .tasks.filter(
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
 * New-file parts wait for all slices updating existing tests.
 * Slices keep whole criteria within observed case capacity and preserve create/modify order.
 * Without capacity, they share the fallback file allowance. An indivisible criterion gets batching guidance.
 * A part keeps only the task's criteria that the code tasks writing its tested file cover (see
 * `partCriteria`). Returns null when no test task is oversized.
 */
/** Opens the note a sizing split appends to each part's copy of its task's description. */
export const SPLIT_PART = "Sizing split this task by file:";
export const SLICE_PART = "Sizing split this test file into slices:";

const expectedPrice = (estimate: TokenRange): number => (estimate.low + estimate.high) / 2;

export function splitTestTasks(
  graph: TaskGraph,
  report: SizingReport,
  spec?: SpecText | null,
  edits?: HostEdit[],
  checks: CaseContext["checks"] = [],
): TaskGraph | null {
  const oversized = new Set(
    report.tasks.filter((task) => task.oversized && task.kind === "test").map((t) => t.taskId),
  );
  if (!oversized.size) return null;
  let next = Math.max(...graph.tasks.map((task) => Number(task.id.slice(1)))) + 1;
  const parts = new Map<string, string[]>();
  const origins = new Map<string, string>();
  const tasks = graph.tasks.flatMap((task) => {
    if (!oversized.has(task.id) || task.sizingSlice || task.rows?.length) return [task];
    const suppliedTask = report.tasks.some((t) => t.taskId === task.id && t.basis === "supplied");
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
        spec
          ? criterionCases(
              spec,
              { ...task, criterionIds: ids },
              {
                checks,
                tasks: graph.tasks,
                includeBroad: true,
              },
            ).length
          : 0;
      const weights = new Map(own.map((id) => [id, Math.max(1, cases([id]))]));
      const weight = (ids: string[]) => ids.reduce((sum, id) => sum + (weights.get(id) ?? 1), 0);
      const total = weight(own);
      const estimate = (ids: string[]): TokenRange => {
        const part = {
          ...base,
          criterionIds: ids,
          sizingSlice: { taskId: task.id, index: 0, count: 1, share: weight(ids) / total },
        };
        // Continuations modify the file, so grouping must also allow for that action's rate.
        const estimates = [
          part,
          { ...part, writes: [{ ...write, action: "modify" as const }] },
        ].map((slice) => priceTask(slice, report.rates, report.testTaskRates, cases(ids)));
        return {
          low: Math.max(...estimates.map((e) => e.low)),
          high: Math.max(...estimates.map((e) => e.high)),
        };
      };
      const exceeds = (ids: string[]) =>
        exceedsTestCapacity(
          cases(ids),
          report.testTaskLimit,
          estimate(ids),
          report.maxAttemptTokens,
          false,
        );
      const groups: string[][] = [];
      let group: string[] = [];
      // A file the request supplies verbatim is copied whole, never sliced by criterion (#2019).
      const needsSlices =
        !suppliedTask &&
        exceedsTestCapacity(
          cases(own),
          report.testTaskLimit,
          priceTask(base, report.rates, report.testTaskRates, cases(own)),
          report.maxAttemptTokens,
        );
      if (!needsSlices) groups.push(own);
      else {
        for (const id of own) {
          if (group.length && exceeds([...group, id])) {
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
          needsSlices && exceeds(ids)
            ? " This criterion alone exceeds one attempt. Write its cases in small batches inside this attempt, check each batch with the task's available checks, and preserve earlier batches."
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
          description: `${task.description.split(/\nSizing split (?:this task by file|this test file into slices):/)[0]}\n${note}${scope}${batch}`,
        });
        previous = id;
      }
    }
    const existing = new Set(files.filter((write) => write.action === "modify").map((w) => w.path));
    const updates = split.filter((part) => part.writes.some((w) => existing.has(w.path)));
    for (const part of split) {
      if (part.writes.some((w) => w.action !== "delete" && !existing.has(w.path))) {
        part.dependsOn = [...new Set([...part.dependsOn, ...updates.map((t) => t.id)])];
        if (updates.length)
          part.description += ` Existing-test updates ${updates.map((t) => `${t.id} (${t.writes[0]?.path})`).join(", ")} finish before this part; leave those assertions to them.`;
      } else if (updates.length < split.length) {
        part.description +=
          " This part updates existing assertions; the new test parts cover their shared acceptance cases.";
      }
    }
    if (split.length > 1) {
      for (const [index, part] of split.entries())
        part.title = `${task.title} (part ${index + 1} of ${split.length})`;
    }
    parts.set(
      task.id,
      split.map((part) => part.id),
    );
    for (const part of split) origins.set(part.id, task.id);
    return split;
  });
  const result = {
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
  return recordGraphEdits(graph, result, "sizing-split", edits, origins);
}

/**
 * The criteria of `task` each of its test files covers, in the order of `files`: those of the code
 * tasks that write the file a test file is named after (`tests/test_schema.py` for
 * `cfgtrace/schema.py`). A file whose source no code task writes, or whose code tasks share none
 * of the criteria, keeps the unassigned criteria, or all when none remain. A criterion no part gets goes to those parts, or to
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
      ? rest.length
        ? rest
        : task.criterionIds
      : !open && index === 0 && rest.length
        ? task.criterionIds.filter((c) => own.includes(c) || rest.includes(c))
        : own,
  );
}

/** The note that sends an oversized plan back to the planner once. */
export function splitNote(
  report: SizingReport,
  maxCodeFilesPerTask: number,
  maxTasks?: number,
): string {
  const approval =
    maxTasks === undefined
      ? ""
      : ` Automatic approval allows at most ${maxTasks} planned tasks before host sizing splits, not counting tasks the host writes from their content. Prefer fewer, larger slices when they fit the sizing capacity. Give every slice of one test task \`sizingSlice\` with that task's ID, its index, the slice count and its share, so they count as one planned task; extra tasks requested by sizing do not count against that task limit; file, path and other approval limits still apply.`;
  return `Sizing: the plan is too large for its attempts. ${report.reasons.join(". ")}. Re-plan with smaller tasks: tests in tasks of their own, keep a file with five or fewer literal cases whole, split a test task only above the observed case capacity (or the fallback allowance without capacity) into sequential criterion slices with create then modify writes and a dependency on the preceding slice, at most ${maxCodeFilesPerTask} code files per task, disjoint writes and no dependency between tasks where possible, so they run in parallel. Files whose whole content the request fixes (module stubs, a registration file) go in one task whose writes carry their content, which the host writes for nothing.${report.tasks.some((task) => task.rowsTask) ? ` ${ROWS_TASK_NOTE}` : ""}${approval}`;
}

/** The approval's line for the sized active time against the active-time cap (#933). */
export function activeTimeText(time: SizingReport["activeTime"]): string {
  const rate = `${Math.round(time.tokensPerMinute / 1000)}k tokens per minute, ${
    time.basis === "initiative"
      ? `the median of ${time.runs} finished runs of this initiative`
      : time.basis === "history"
        ? `the median of ${time.runs} runs`
        : "the default rate"
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

/**
 * The approval's line naming what priced the tasks, when the request's supplied lines priced any
 * of them (#2002): "Task estimates: T001 (12 lines), T002 (8 lines) from the lines the request
 * supplies; T003 from history". Null when every task kept its history or default price.
 */
export function estimateSourceText(tasks: readonly TaskSize[]): string | null {
  const supplied = tasks.filter((t) => t.basis === "supplied");
  if (!supplied.length) return null;
  const ids = (basis: TaskSize["basis"]) =>
    tasks
      .filter((t) => t.basis === basis)
      .map((t) => t.taskId)
      .join(", ");
  const parts = [
    `${supplied.map((t) => `${t.taskId} (${t.suppliedLines ?? 0} lines)`).join(", ")} from the lines the request supplies`,
    ...(ids("history") ? [`${ids("history")} from history`] : []),
    ...(ids("default") ? [`${ids("default")} from the default rates`] : []),
  ];
  return `Task estimates: ${parts.join("; ")}`;
}

/** The latest plan pricing's estimate source as an approval body field (`estimateSourceText`). */
export function estimateSourceOf(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): { estimateSource?: string } {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-"))
    .at(-1);
  if (!latest) return {};
  const report = JSON.parse(store.readArtifact(runId, latest.id)) as Partial<SizingReport>;
  const text = estimateSourceText(report.tasks ?? []);
  return text ? { estimateSource: text } : {};
}

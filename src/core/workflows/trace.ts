import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { canonical, hashBytes } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { assertForecastFits, costForecast } from "./cost-forecast.js";
import { WorkflowFault } from "./errors.js";
import { PolicySchema, type RunPolicy } from "./schemas.js";
import { WorkflowStore } from "./store.js";

/**
 * Usage traces of recorded runs, and their replay through the current pricing and gating code
 * (#1649). A trace is a copy of a workspace's workflow database with the work itself taken out:
 * prompts, model output, file contents and prose are gone, while every token count, price input,
 * policy revision, task and stage transition and timestamp stays. The replay rewinds the copy to
 * each attempt a run started and asks the current code what it would have decided there, so a
 * change to the forecast, sizing or cap growth is measured on real rounds before it merges.
 */

/** Artifacts whose contents the replay reads; every other artifact is dropped from a trace. */
const KEPT_ARTIFACTS = new Set([
  "sizing",
  "usage",
  "policy-revision",
  "cost-forecast",
  "cost-forecast-progress",
  "routing",
  "estimate",
  "plan",
  "spec",
  "tasks",
]);

/** Tables that hold evidence, effects or prose the replay never reads. */
const DROPPED_TABLES = [
  "check_results",
  "criterion_results",
  "evidence",
  "effects",
  "commands",
  "workspace_leases",
  "attention_notices",
  "project_memory_edits",
  "critic_outcomes",
  "initiative_commands",
];

/**
 * JSON keys whose string values are prose or content: a trace keeps their shape, not their text.
 * Keys that also name enums elsewhere (a check's `scope`, a profile's `output`, a run's `reason`)
 * are left out, so the replay can still parse what it reads.
 */
const PROSE = new Set([
  "answer",
  "claim",
  "comment",
  "completionCriteria",
  "content",
  "contract",
  "description",
  "detail",
  "diff",
  "error",
  "explanation",
  "given",
  "goals",
  "impact",
  "instructions",
  "markdown",
  "message",
  "notes",
  "patch",
  "prompt",
  "question",
  "rationale",
  "request",
  "requestText",
  "stack",
  "statement",
  "summary",
  "system",
  "text",
  "then",
  "title",
  "unresolved",
  "when",
]);

const blank = (value: unknown): unknown =>
  typeof value === "string"
    ? ""
    : Array.isArray(value)
      ? value.map(blank)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blank(v)]))
        : value;

/** `value` with every string under a prose key emptied, keeping arrays and their lengths. */
export function scrubTrace(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubTrace);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, PROSE.has(key) ? blank(v) : scrubTrace(v)]),
  );
}

const scrubJson = (text: string | null): string | null => {
  if (text === null) return null;
  try {
    return canonical(scrubTrace(JSON.parse(text)));
  } catch {
    return "";
  }
};

const tables = (db: Database): Set<string> =>
  new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

const columns = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

export interface TraceExport {
  path: string;
  runs: number;
  initiatives: number;
  bytes: number;
}

/**
 * Writes the trace of the workflow database of `workspace` to `out`, gzip-compressed. The source
 * is opened read-only; `runIds` limits the trace to those runs (the default is every run).
 */
export function exportTrace(
  workspace: string,
  out: string,
  options: { runIds?: string[] } = {},
): TraceExport {
  const source = workspacePath(workspace, ".baked/workflows.sqlite");
  if (!existsSync(source)) throw new Error(`No workflow database in ${workspace}`);
  const scratch = mkdtempSync(join(tmpdir(), "baked-trace-"));
  try {
    const copy = join(scratch, "trace.sqlite");
    const read = new Database(source, { readonly: true });
    try {
      read.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    } finally {
      read.close();
    }
    const db = new Database(copy);
    try {
      db.exec("PRAGMA foreign_keys=OFF; PRAGMA journal_mode=DELETE;");
      for (const { name } of db
        .query("SELECT name FROM sqlite_master WHERE type='trigger'")
        .all() as { name: string }[])
        db.exec(`DROP TRIGGER "${name}"`);
      const present = tables(db);
      db.transaction(() => {
        for (const table of DROPPED_TABLES) if (present.has(table)) db.exec(`DELETE FROM ${table}`);
        if (options.runIds) {
          const keep = new Set(options.runIds);
          const drop = (db.query("SELECT id FROM runs").all() as { id: string }[])
            .map((r) => r.id)
            .filter((id) => !keep.has(id));
          for (const runId of drop)
            for (const table of present)
              if (table !== "runs" && columns(db, table).includes("run_id"))
                db.run(`DELETE FROM ${table} WHERE run_id=?`, [runId]);
          for (const runId of drop) db.run("DELETE FROM runs WHERE id=?", [runId]);
        }
        // Artifacts: the kinds the replay reads, inlined and scrubbed; the rest are dropped.
        const artifacts = db
          .query(
            "SELECT run_id, id, kind, inline_content, blob_path FROM artifacts ORDER BY created_at",
          )
          .all() as {
          run_id: string;
          id: string;
          kind: string;
          inline_content: string | null;
          blob_path: string | null;
        }[];
        for (const a of artifacts) {
          let text: string | null = null;
          if (KEPT_ARTIFACTS.has(a.kind)) {
            try {
              text =
                a.inline_content ??
                readFileSync(
                  workspacePath(workspace, (a.blob_path ?? "").replaceAll("\\", "/")),
                  "utf8",
                );
            } catch {
              text = null;
            }
          }
          const content = text === null ? null : scrubJson(text);
          if (content === null) {
            db.run(
              "UPDATE steps SET output_artifact_id=NULL WHERE run_id=? AND output_artifact_id=?",
              [a.run_id, a.id],
            );
            db.run("DELETE FROM artifacts WHERE run_id=? AND id=?", [a.run_id, a.id]);
            continue;
          }
          db.run(
            "UPDATE artifacts SET inline_content=?, blob_path=NULL, content_hash=?, byte_length=? WHERE run_id=? AND id=?",
            [content, hashBytes(content), Buffer.byteLength(content), a.run_id, a.id],
          );
        }
        // Every JSON column keeps its shape without its prose.
        for (const table of present)
          for (const column of columns(db, table).filter(
            // Policies and workflow definitions hold settings and enums, no prose.
            (c) =>
              (c.endsWith("_json") && c !== "policy_json" && c !== "definition_json") ||
              (table === "tasks" && c === "definition_json"),
          )) {
            const rows = db.query(`SELECT rowid AS r, ${column} AS v FROM ${table}`).all() as {
              r: number;
              v: string | null;
            }[];
            for (const row of rows)
              db.run(`UPDATE ${table} SET ${column}=? WHERE rowid=?`, [
                scrubJson(row.v) ?? null,
                row.r,
              ]);
          }
        if (present.has("findings")) db.exec("UPDATE findings SET body_json='{}'");
        if (present.has("initiatives")) db.exec("UPDATE initiatives SET title='', prompt=''");
        if (present.has("features")) {
          const rows = db.query("SELECT id, directory FROM features").all() as {
            id: string;
            directory: string;
          }[];
          for (const row of rows)
            db.run("UPDATE features SET directory=? WHERE id=?", [
              basename(row.directory.replaceAll("\\", "/")),
              row.id,
            ]);
        }
        if (present.has("runs")) db.exec("UPDATE runs SET owner_id=NULL");
      })();
      db.exec("VACUUM");
    } finally {
      db.close();
    }
    const bytes = readFileSync(copy);
    const zipped = Bun.gzipSync(bytes);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, zipped);
    const counted = new Database(copy, { readonly: true });
    try {
      const count = (table: string) =>
        tables(counted).has(table)
          ? ((counted.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n ?? 0)
          : 0;
      return {
        path: out,
        runs: count("runs"),
        initiatives: count("initiatives"),
        bytes: zipped.length,
      };
    } finally {
      counted.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What the forecast gate did, or would do, before one attempt. */
export type ForecastDecision = "pass" | "grow" | "stop";

export interface ReplayBoundary {
  attemptId: string;
  at: number;
  recorded: ForecastDecision;
  replayed: ForecastDecision;
  /** The replayed forecast's total and the ceiling it was held to, when there was a forecast. */
  projectedUsd: number | null;
  ceilingUsd: number | null;
  spentUsd: number | null;
}

export interface RunReplay {
  runId: string;
  featureId: string;
  /** What the run had spent when it ended, from its attempts' usage. */
  finalUsd: number | null;
  boundaries: ReplayBoundary[];
  /** Attempts where the current code stops or grows the cap and the recorded run did not. */
  newStops: number;
  newGrowth: number;
  /** Stops the recorded run made that the current code does not. */
  removedStops: number;
  /** The forecast over what the run finally cost, at the first forecast past 25%, 50% and 75% of it. */
  ratios: { at: number; ratio: number }[];
}

export interface TraceReplay {
  trace: string;
  runs: RunReplay[];
}

interface RevisionRecord {
  createdAt: number;
  kind: string;
  previous: Record<string, unknown>;
}

/** Opens a trace in a scratch workspace; `dispose` removes it. */
export function openTrace(path: string): { store: WorkflowStore; dispose: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), "baked-replay-"));
  mkdirSync(join(workspace, ".baked"), { recursive: true });
  const bytes = readFileSync(path);
  const raw = path.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes;
  writeFileSync(join(workspace, ".baked", "workflows.sqlite"), raw);
  const store = new WorkflowStore(workspace);
  return {
    store,
    dispose: () => {
      store.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

const decisionOf = (
  artifacts: { kind: string; created_at: number; content: string | null }[],
  from: number,
  to: number,
): ForecastDecision => {
  const within = artifacts.filter((a) => a.created_at >= from && a.created_at < to);
  if (within.some((a) => a.kind === "cost-forecast")) return "stop";
  if (
    within.some(
      (a) =>
        a.kind === "policy-revision" &&
        (JSON.parse(a.content ?? "{}") as { kind?: string }).kind === "forecast-growth",
    )
  )
    return "grow";
  return "pass";
};

/**
 * Replays the forecast gate of one run: from its last attempt back to its first, the store is
 * rewound to the moment the attempt started (later attempts, artifacts and events removed, task
 * and step states and the policy as they were then) and `assertForecastFits` decides again.
 */
function replayRun(store: WorkflowStore, runId: string): RunReplay | null {
  const db = store.connection;
  const run = store.run(runId);
  const final = PolicySchema.parse(JSON.parse(run.policy_json));
  const artifacts = db
    .query(
      "SELECT kind, created_at, inline_content AS content FROM artifacts WHERE run_id=? AND kind IN ('cost-forecast','policy-revision')",
    )
    .all(runId) as { kind: string; created_at: number; content: string | null }[];
  const revisions: RevisionRecord[] = artifacts
    .filter((a) => a.kind === "policy-revision")
    .map((a) => {
      const body = JSON.parse(a.content ?? "{}") as {
        kind?: string;
        previous?: Record<string, unknown>;
      };
      return { createdAt: a.created_at, kind: body.kind ?? "", previous: body.previous ?? {} };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  const priced = db
    .query(
      "SELECT rowid AS r, id, started_at FROM attempts WHERE run_id=? AND model_id IS NOT NULL ORDER BY started_at, rowid",
    )
    .all(runId) as { r: number; id: string; started_at: number }[];
  if (!priced.length) return null;
  const capped =
    final.maxCostUsd !== null || revisions.some((r) => typeof r.previous.maxCostUsd === "number");
  if (!capped) return null;
  const finalUsd = store.costUsage(runId).spentUsd;
  const policyAt = (t: number): RunPolicy => {
    let policy: Record<string, unknown> = { ...final };
    for (const revision of revisions) {
      if (revision.createdAt <= t) break;
      policy = { ...policy, ...revision.previous };
    }
    return PolicySchema.parse(policy);
  };
  const taskEvents = (
    db
      .query(
        "SELECT at, payload_json FROM events WHERE run_id=? AND type='task.state_changed' ORDER BY seq",
      )
      .all(runId) as { at: number; payload_json: string }[]
  ).map((e) => ({
    at: e.at,
    ...(JSON.parse(e.payload_json) as { taskId: string; to: string; generation?: number }),
  }));
  const stepEvents = (
    db
      .query(
        "SELECT at, type, payload_json FROM events WHERE run_id=? AND type IN ('stage.started','stage.finished') ORDER BY seq",
      )
      .all(runId) as { at: number; type: string; payload_json: string }[]
  ).map((e) => ({
    at: e.at,
    type: e.type,
    ...(JSON.parse(e.payload_json) as { stepId: string; status?: string }),
  }));
  const boundaries: ReplayBoundary[] = [];
  for (let i = priced.length - 1; i >= 0; i--) {
    const attempt = priced[i];
    if (!attempt) continue;
    const t = attempt.started_at;
    const next = priced[i + 1]?.started_at ?? Number.POSITIVE_INFINITY;
    db.transaction(() => {
      db.run(
        "DELETE FROM attempts WHERE run_id=? AND (started_at>? OR (started_at=? AND rowid>?))",
        [runId, t, t, attempt.r],
      );
      db.run(
        "UPDATE attempts SET status='running', used_tokens=NULL, usage_complete=0, ended_at=NULL WHERE run_id=? AND (ended_at IS NULL OR ended_at>? OR id=?)",
        [runId, t, attempt.id],
      );
      db.run("DELETE FROM artifacts WHERE run_id=? AND created_at>?", [runId, t]);
      db.run("DELETE FROM events WHERE run_id=? AND at>?", [runId, t]);
      const tasks = db.query("SELECT id FROM tasks WHERE run_id=?").all(runId) as { id: string }[];
      for (const task of tasks) {
        const last = taskEvents.filter((e) => e.taskId === task.id && e.at <= t).at(-1);
        db.run("UPDATE tasks SET status=?, generation=? WHERE run_id=? AND id=?", [
          last?.to ?? "pending",
          last?.generation ?? 0,
          runId,
          task.id,
        ]);
      }
      const steps = db.query("SELECT id FROM steps WHERE run_id=?").all(runId) as { id: string }[];
      for (const step of steps) {
        const events = stepEvents.filter((e) => e.stepId === step.id && e.at <= t);
        const finished = events.filter((e) => e.type === "stage.finished").at(-1);
        if (!events.length) {
          const used = db
            .query("SELECT 1 FROM attempts WHERE run_id=? AND step_id=? LIMIT 1")
            .get(runId, step.id);
          if (!used) continue;
        }
        db.run("UPDATE steps SET status=? WHERE run_id=? AND id=?", [
          finished?.status ?? "running",
          runId,
          step.id,
        ]);
      }
      db.run(
        "UPDATE runs SET policy_json=?, estimated_cost_microusd=NULL, status='running' WHERE id=?",
        [canonical(policyAt(t)), runId],
      );
    })();
    const policy = policyAt(t);
    const forecast = costForecast(store, runId, policy);
    let replayed: ForecastDecision = "pass";
    const before = store.artifacts(runId).length;
    try {
      assertForecastFits(store, runId, structuredClone(policy));
      const grown = store
        .artifacts(runId)
        .slice(before)
        .some(
          (a) =>
            a.kind === "policy-revision" &&
            (JSON.parse(store.readArtifact(runId, a.id)) as { kind?: string }).kind ===
              "forecast-growth",
        );
      if (grown) replayed = "grow";
    } catch (error) {
      if (!(error instanceof WorkflowFault) || error.details.reason !== "cost-forecast")
        throw error;
      replayed = "stop";
    }
    boundaries.unshift({
      attemptId: attempt.id,
      at: t,
      recorded: decisionOf(artifacts, t, next),
      replayed,
      projectedUsd: forecast?.projectedUsd ?? null,
      ceilingUsd: forecast?.ceilingUsd ?? null,
      spentUsd: forecast?.spentUsd ?? null,
    });
  }
  const ratios: RunReplay["ratios"] = [];
  if (finalUsd > 0)
    for (const at of [0.25, 0.5, 0.75]) {
      const found = boundaries.find(
        (b) => b.projectedUsd !== null && (b.spentUsd ?? 0) >= finalUsd * at,
      );
      if (found?.projectedUsd != null) ratios.push({ at, ratio: found.projectedUsd / finalUsd });
    }
  return {
    runId,
    featureId: run.feature_id,
    finalUsd: finalUsd > 0 ? finalUsd : null,
    boundaries,
    newStops: boundaries.filter((b) => b.replayed === "stop" && b.recorded !== "stop").length,
    newGrowth: boundaries.filter((b) => b.replayed === "grow" && b.recorded === "pass").length,
    removedStops: boundaries.filter((b) => b.recorded === "stop" && b.replayed !== "stop").length,
    ratios,
  };
}

/** Replays the forecast gate of every run in the trace at `path` with a dollar cap. */
export function replayTrace(path: string): TraceReplay {
  const { store, dispose } = openTrace(path);
  try {
    const runIds = (
      store.connection.query("SELECT id FROM runs ORDER BY created_at").all() as { id: string }[]
    ).map((r) => r.id);
    const runs: RunReplay[] = [];
    for (const runId of runIds) {
      const replay = replayRun(store, runId);
      if (replay) runs.push(replay);
    }
    return { trace: path, runs };
  } finally {
    dispose();
  }
}

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { builtinProfiles } from "../agents/profiles/builtin.js";
import {
  type CallReasoning,
  type CallTiming,
  providerFirstByteMs,
} from "../llm/provider-health.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { assertForecastFits, costForecast } from "./cost-forecast.js";
import { WorkflowFault } from "./errors.js";
import { type ShareGateRecord, shareShortfall } from "./initiatives/service.js";
import { recordingOf } from "./model-recording.js";
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
  // The run state (`internal/state.json`): an initiative's feature views read it (#1707).
  "state",
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

/**
 * Run-state fields that hold content under keys other artifacts use for settings: the plan and
 * research text, the report, instructions, the initiative plan, and files a run froze or carried.
 */
const STATE_CONTENT = new Set([
  "plan",
  "research",
  "report",
  "instructionText",
  "initiativePlan",
  "frozenFiles",
  "taskCarry",
]);

/**
 * Stand-ins for prose: each distinct string of an export becomes `KEY-N`, so a schema that
 * rejects an empty title or a duplicate task description still parses a trace, and two equal
 * strings stay equal, without keeping any text (#1707). The empty string stays empty.
 */
export class StandIns {
  private readonly seen = new Map<string, string>();
  of(key: string, text: string): string {
    if (text === "") return "";
    let standIn = this.seen.get(text);
    if (standIn === undefined) {
      standIn = `${key}-${this.seen.size + 1}`;
      this.seen.set(text, standIn);
    }
    return standIn;
  }
}

const replaced = (key: string, value: unknown, standIns: StandIns): unknown =>
  typeof value === "string"
    ? standIns.of(key, value)
    : Array.isArray(value)
      ? value.map((v) => replaced(key, v, standIns))
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaced(key, v, standIns)]))
        : value;

/**
 * `value` with every string under a prose key (and under `content`, the keys a run state keeps
 * content in) replaced by its stand-in, keeping arrays, their lengths and record keys. Any other
 * string with whitespace in it is prose too: enums, IDs, hashes, model IDs and paths have none,
 * and a spec's `problem` or `inScope` would otherwise need its key listed here (#1707).
 */
export function scrubTrace(
  value: unknown,
  standIns: StandIns = new StandIns(),
  content: ReadonlySet<string> = PROSE,
  key = "text",
): unknown {
  if (typeof value === "string") return /\s/.test(value) ? standIns.of(key, value) : value;
  if (Array.isArray(value)) return value.map((v) => scrubTrace(v, standIns, content, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      PROSE.has(k) || content.has(k)
        ? replaced(k, v, standIns)
        : scrubTrace(v, standIns, content, k),
    ]),
  );
}

const scrubJson = (
  text: string | null,
  standIns: StandIns,
  content: ReadonlySet<string> = PROSE,
): string | null => {
  if (text === null) return null;
  try {
    return canonical(scrubTrace(JSON.parse(text), standIns, content));
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

const textColumns = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[])
    .filter((c) => c.type.toUpperCase() === "TEXT")
    .map((c) => c.name);

export interface TraceExport {
  path: string;
  runs: number;
  initiatives: number;
  bytes: number;
}

/** One run of `exportRecordings`: what a replay of it needs besides the calls. */
export interface RecordingEntry {
  runId: string;
  featureId: string;
  workflowId: string;
  status: string;
  reason: string;
  /** The Git commit of the run's first workspace snapshot: the tree a replay starts from. */
  gitHead: string | null;
  calls: number;
  /** The recording's file name in the output folder. */
  file: string;
}

/**
 * Writes the model calls each run of `workspace` recorded (`--record-model-calls`) to
 * `outDir/RUN_ID.json.gz`, in the format `workflow run --replay` reads once unzipped, and a
 * `manifest.json` of the runs (#1715). Bench apps are public MIT repositories, so prompts and
 * model output may be kept; nothing else of `.baked/` is. The database is read without changes.
 */
export function exportRecordings(
  workspace: string,
  outDir: string,
  options: { runIds?: string[] } = {},
): RecordingEntry[] {
  const source = workspacePath(workspace, ".baked/workflows.sqlite");
  if (!existsSync(source)) throw new Error(`No workflow database in ${workspace}`);
  const db = new Database(source, { readonly: true });
  try {
    const runs = db
      .query("SELECT id, feature_id, status, reason, definition_json FROM runs ORDER BY created_at")
      .all() as {
      id: string;
      feature_id: string;
      status: string;
      reason: string;
      definition_json: string;
    }[];
    const keep = options.runIds ? new Set(options.runIds) : null;
    const entries: RecordingEntry[] = [];
    mkdirSync(outDir, { recursive: true });
    for (const run of runs) {
      if (keep && !keep.has(run.id)) continue;
      const texts = (
        db
          .query(
            "SELECT inline_content, blob_path FROM artifacts WHERE run_id=? AND logical_path LIKE 'recordings/%' ORDER BY created_at",
          )
          .all(run.id) as { inline_content: string | null; blob_path: string | null }[]
      ).map(
        (row) =>
          row.inline_content ??
          readFileSync(
            workspacePath(workspace, (row.blob_path ?? "").replaceAll("\\", "/")),
            "utf8",
          ),
      );
      if (!texts.length) continue;
      const recording = recordingOf(run.id, texts);
      const file = `${run.id}.json.gz`;
      writeFileSync(join(outDir, file), Bun.gzipSync(Buffer.from(JSON.stringify(recording))));
      const head = db
        .query(
          "SELECT git_head FROM workspace_snapshots WHERE run_id=? ORDER BY created_at LIMIT 1",
        )
        .get(run.id) as { git_head: string | null } | null;
      entries.push({
        runId: run.id,
        featureId: run.feature_id,
        workflowId: (JSON.parse(run.definition_json) as { id?: string }).id ?? "",
        status: run.status,
        reason: run.reason,
        gitHead: head?.git_head ?? null,
        calls: recording.calls.length,
        file,
      });
    }
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(entries, null, 2)}\n`);
    return entries;
  } finally {
    db.close();
  }
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
      const standIns = new StandIns();
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
        const readText = (a: (typeof artifacts)[number]): string | null => {
          if (!KEPT_ARTIFACTS.has(a.kind)) return null;
          try {
            return (
              a.inline_content ??
              readFileSync(
                workspacePath(workspace, (a.blob_path ?? "").replaceAll("\\", "/")),
                "utf8",
              )
            );
          } catch {
            return null;
          }
        };
        // A contract hash is the hash of a run's spec, and stand-ins change the spec: map each
        // original hash to the scrubbed spec's, upstream first, so pinned dependencies and the
        // initiative's records still match the contract they name (#1707).
        const contracts = new Map<string, string>();
        const remap = (text: string): string => {
          let mapped = text;
          for (const [from, to] of contracts) mapped = mapped.replaceAll(from, to);
          return mapped;
        };
        for (const a of artifacts.filter((row) => row.kind === "state")) {
          const text = readText(a);
          const spec = text === null ? null : (JSON.parse(text) as { spec?: unknown }).spec;
          if (!spec || text === null) continue;
          const scrubbed = scrubJson(text, standIns, STATE_CONTENT);
          if (!scrubbed) continue;
          contracts.set(
            hashJson(spec),
            hashJson((JSON.parse(remap(scrubbed)) as { spec: unknown }).spec),
          );
        }
        for (const a of artifacts) {
          const text = readText(a);
          const scrubbed =
            text === null
              ? null
              : scrubJson(text, standIns, a.kind === "state" ? STATE_CONTENT : PROSE);
          const content = scrubbed === null ? null : remap(scrubbed);
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
            for (const row of rows) {
              const scrubbed = scrubJson(row.v, standIns);
              db.run(`UPDATE ${table} SET ${column}=? WHERE rowid=?`, [
                scrubbed === null ? null : remap(scrubbed),
                row.r,
              ]);
            }
          }
        // Contract hashes in plain columns (an initiative's pinned contracts, say).
        for (const table of [...present].filter((t) => t !== "artifacts"))
          for (const column of textColumns(db, table).filter((c) => !c.endsWith("_json")))
            for (const [from, to] of contracts)
              db.run(
                `UPDATE ${table} SET ${column}=replace(${column}, ?, ?) WHERE ${column} LIKE ?`,
                [from, to, `%${from}%`],
              );
        if (present.has("findings")) db.exec("UPDATE findings SET body_json='{}'");
        if (present.has("initiatives"))
          for (const row of db.query("SELECT rowid AS r, title, prompt FROM initiatives").all() as {
            r: number;
            title: string;
            prompt: string;
          }[])
            db.run("UPDATE initiatives SET title=?, prompt=? WHERE rowid=?", [
              standIns.of("title", row.title),
              standIns.of("prompt", row.prompt),
              row.r,
            ]);
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
  /** Each recorded model call against the current first-response deadline. */
  firstByte: FirstByteBoundary[];
  /** Calls the current deadline would end as an outage that got their answer in the recording. */
  newFirstByteStops: number;
}

/** The first-response deadline of a call; `providerFirstByteMs` unless a test passes another. */
export type FirstByteLimit = (provider: string, context: CallReasoning) => number;

export interface FirstByteBoundary {
  attemptId: string;
  /** The call's index in its attempt. */
  call: number;
  provider: string;
  stage: string | null;
  effort: string | null;
  /** When the first response came, or null when none did. */
  firstByteMs: number | null;
  durationMs: number;
  /**
   * Taken from the attempt's length: a trace from before call timings were kept (#1715), where a
   * buffering CLI attempt of one step is one call whose answer arrived at its end.
   */
  estimated: boolean;
  limitMs: number;
  recorded: "pass" | "stop";
  replayed: "pass" | "stop";
}

const BUFFERED_CLI = new Set(["codex", "claude-code"]);
const PROFILE_OUTPUT = new Map(builtinProfiles.map((p) => [p.id, p.output]));

/**
 * Every recorded model call of a run against the first-response deadline `limit` gives it now. A
 * call that answered after the deadline would now end as an outage, as the 60 s limit of #1613
 * ended the plan and specify calls of buffering CLI adapters in R50 (#1639).
 */
export function replayFirstByte(
  store: WorkflowStore,
  runId: string,
  limit: FirstByteLimit = providerFirstByteMs,
): FirstByteBoundary[] {
  // A refused call (a 429, say) answered before any deadline; it is the retry ladder's, not this.
  const answered = recordedCalls(store, runId).filter(({ call }) => call.status === undefined);
  return answered.map(({ attemptId, call, index, estimated }) => {
    const limitMs = limit(call.provider, call);
    const replayed =
      call.firstByteMs !== null ? call.firstByteMs > limitMs : call.durationMs >= limitMs;
    return {
      attemptId,
      call: index,
      provider: call.provider,
      stage: call.stage ?? null,
      effort: call.effort ?? null,
      firstByteMs: call.firstByteMs,
      durationMs: call.durationMs,
      estimated,
      limitMs,
      recorded: call.firstByteMs === null ? "stop" : "pass",
      replayed: replayed ? "stop" : "pass",
    };
  });
}

/**
 * Each model call of a run's attempts, from the `calls` of their `usage.json`. Traces recorded
 * before calls were kept stand in a completed, one-step buffered CLI attempt as one call whose
 * first response is the attempt's length (`estimated`).
 */
function recordedCalls(
  store: WorkflowStore,
  runId: string,
): { attemptId: string; call: CallTiming; index: number; estimated: boolean }[] {
  const attempts = store.connection
    .query(
      "SELECT id, model_id, status, started_at, ended_at FROM attempts WHERE run_id=? AND model_id IS NOT NULL ORDER BY started_at, rowid",
    )
    .all(runId) as {
    id: string;
    model_id: string;
    status: string;
    started_at: number;
    ended_at: number | null;
  }[];
  return attempts.flatMap((attempt) => {
    const saved = store.latestArtifact(runId, `attempts/${attempt.id}/usage.json`);
    const usage = saved
      ? (JSON.parse(store.readArtifact(runId, saved.id)) as {
          profileId?: string;
          effort?: string;
          steps?: unknown[];
          calls?: CallTiming[];
        })
      : {};
    const provider = attempt.model_id.split("/")[0] ?? attempt.model_id;
    let calls = usage.calls ?? [];
    const estimated =
      !usage.calls &&
      BUFFERED_CLI.has(provider) &&
      attempt.status === "completed" &&
      attempt.ended_at !== null &&
      usage.steps?.length === 1;
    if (estimated && attempt.ended_at !== null) {
      const durationMs = attempt.ended_at - attempt.started_at;
      const stage = PROFILE_OUTPUT.get(usage.profileId ?? "");
      calls = [
        {
          provider,
          ...(stage ? { stage } : {}),
          ...(usage.effort ? { effort: usage.effort } : {}),
          firstByteMs: durationMs,
          durationMs,
        },
      ];
    }
    return calls.map((call, index) => ({ attemptId: attempt.id, call, index, estimated }));
  });
}

/** Healthy first responses of one call shape across the corpus (#1729). */
export interface FirstByteProfile {
  provider: string;
  stage: string | null;
  effort: string | null;
  calls: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** True when every sample is an attempt's length rather than a recorded call (older traces). */
  estimated: boolean;
}

/** What the recorded rounds say about providers' latencies and refusals, for fault profiles. */
export interface CallProfile {
  firstByte: FirstByteProfile[];
  /** The `retry-after` waits providers sent with refusals, in milliseconds, by provider. */
  retryAfterMs: Record<string, number[]>;
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;

/** The `retry-after` header in milliseconds: seconds, or an HTTP date relative to `at`. */
function retryAfterOf(value: string, at: number): number | null {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - at);
}

/**
 * The latencies and refusal waits of every recorded call in the traces at `paths`, grouped by
 * provider, stage and effort: the parameters the provider fault matrix tests limits against, so
 * a round with slower healthy calls moves them without a hand-written number (#1729).
 */
export function corpusCallProfile(paths: string[]): CallProfile {
  const groups = new Map<string, { sample: FirstByteProfile; values: number[] }>();
  const retryAfterMs: Record<string, number[]> = {};
  for (const path of paths) {
    const { store, dispose } = openTrace(path);
    try {
      for (const { id } of store.connection.query("SELECT id FROM runs").all() as {
        id: string;
      }[])
        for (const { call, estimated } of recordedCalls(store, id)) {
          if (call.retryAfter) {
            const wait = retryAfterOf(call.retryAfter, Date.now());
            if (wait !== null)
              retryAfterMs[call.provider] = [...(retryAfterMs[call.provider] ?? []), wait];
          }
          if (call.firstByteMs === null || call.status !== undefined) continue;
          const key = `${call.provider}|${call.stage ?? ""}|${call.effort ?? ""}`;
          const group = groups.get(key) ?? {
            sample: {
              provider: call.provider,
              stage: call.stage ?? null,
              effort: call.effort ?? null,
              calls: 0,
              p50Ms: 0,
              p99Ms: 0,
              maxMs: 0,
              estimated: true,
            },
            values: [],
          };
          group.values.push(call.firstByteMs);
          group.sample.estimated &&= estimated;
          groups.set(key, group);
        }
    } finally {
      dispose();
    }
  }
  const firstByte = [...groups.values()]
    .map(({ sample, values }) => {
      const sorted = values.sort((a, b) => a - b);
      return {
        ...sample,
        calls: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted.at(-1) ?? 0,
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        (a.stage ?? "").localeCompare(b.stage ?? "") ||
        (a.effort ?? "").localeCompare(b.effort ?? ""),
    );
  for (const waits of Object.values(retryAfterMs)) waits.sort((a, b) => a - b);
  return { firstByte, retryAfterMs };
}

/** One recorded share-gate decision of an initiative's feature, and the current gate's (#1707). */
export interface ShareGateBoundary {
  featureId: string;
  recorded: "pass" | "park";
  replayed: "pass" | "park";
}

export interface InitiativeReplay {
  initiativeId: string;
  shareGate: ShareGateBoundary[];
  /** Features the recording started that the current gate parks. */
  newShareStops: number;
}

export type ShareGate = (
  view: ShareGateRecord["view"],
  feature: ShareGateRecord["feature"],
) => unknown;

/**
 * Every recorded share-gate decision of the trace's initiatives (`feature.share_gate` events)
 * against `gate`, the current `shareShortfall` by default. Traces before #1707 record none.
 */
export function replayShareGate(
  store: WorkflowStore,
  gate: ShareGate = shareShortfall,
): InitiativeReplay[] {
  const rows = store.connection
    .query(
      "SELECT initiative_id, payload_json FROM initiative_events WHERE type='feature.share_gate' ORDER BY initiative_id, seq",
    )
    .all() as { initiative_id: string; payload_json: string }[];
  const byInitiative = new Map<string, ShareGateBoundary[]>();
  for (const row of rows) {
    const record = JSON.parse(row.payload_json) as ShareGateRecord;
    const boundaries = byInitiative.get(row.initiative_id) ?? [];
    boundaries.push({
      featureId: record.featureId,
      recorded: record.verdict,
      replayed: gate(record.view, record.feature) ? "park" : "pass",
    });
    byInitiative.set(row.initiative_id, boundaries);
  }
  return [...byInitiative].map(([initiativeId, shareGate]) => ({
    initiativeId,
    shareGate,
    newShareStops: shareGate.filter((b) => b.recorded === "pass" && b.replayed === "park").length,
  }));
}

export interface TraceReplay {
  trace: string;
  runs: RunReplay[];
  initiatives: InitiativeReplay[];
}

interface RevisionRecord {
  createdAt: number;
  kind: string;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
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
function replayRun(
  store: WorkflowStore,
  runId: string,
): Omit<RunReplay, "firstByte" | "newFirstByteStops"> | null {
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
        next?: Record<string, unknown>;
      };
      return {
        createdAt: a.created_at,
        kind: body.kind ?? "",
        previous: body.previous ?? {},
        next: body.next ?? {},
      };
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
  // The policy the run started with, then each revision's own limits forward. Undoing `previous`
  // backwards from the final policy went wrong where a revision was written from a stale copy and
  // its `previous` undid an earlier growth (#1704).
  let initial: Record<string, unknown> = { ...final };
  for (const revision of revisions) initial = { ...initial, ...revision.previous };
  const policyAt = (t: number): RunPolicy => {
    let policy = initial;
    for (const revision of [...revisions].reverse()) {
      if (revision.createdAt > t) break;
      policy = { ...policy, ...revision.next };
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
export function replayTrace(
  path: string,
  options: { firstByteLimit?: FirstByteLimit; shareGate?: ShareGate } = {},
): TraceReplay {
  const { store, dispose } = openTrace(path);
  try {
    const runIds = (
      store.connection.query("SELECT id FROM runs ORDER BY created_at").all() as { id: string }[]
    ).map((r) => r.id);
    // Call timings are read before the forecast replay rewinds each run's attempts.
    const timings = new Map(
      runIds.map((runId) => [runId, replayFirstByte(store, runId, options.firstByteLimit)]),
    );
    const runs: RunReplay[] = [];
    for (const runId of runIds) {
      const firstByte = timings.get(runId) ?? [];
      const replay = replayRun(store, runId) ?? {
        runId,
        featureId: store.run(runId).feature_id,
        finalUsd: null,
        boundaries: [],
        newStops: 0,
        newGrowth: 0,
        removedStops: 0,
        ratios: [],
      };
      if (!replay.boundaries.length && !firstByte.length) continue;
      runs.push({
        ...replay,
        firstByte,
        newFirstByteStops: firstByte.filter((b) => b.replayed === "stop" && b.recorded === "pass")
          .length,
      });
    }
    return { trace: path, runs, initiatives: replayShareGate(store, options.shareGate) };
  } finally {
    dispose();
  }
}

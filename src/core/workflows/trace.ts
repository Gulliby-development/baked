import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import { builtinProfiles } from "../agents/profiles/builtin.js";
import { ModelRoutingSchema, type RouteEffort } from "../llm/model-routing.js";
import {
  POLICY_REFUSAL_KIND,
  POLICY_REFUSALS_DIR,
  policyRefusalDecision,
} from "../llm/policy-refusal.js";
import {
  type CallReasoning,
  type CallTiming,
  providerFirstByteMs,
} from "../llm/provider-health.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { planApprovalDecision, requestedPathTokens } from "./auto-approval.js";
import { callCostRate } from "./budget.js";
import { assertForecastFits, costForecast } from "./cost-forecast.js";
import { WorkflowFault } from "./errors.js";
import type { initiativePriceSamples } from "./initiatives/forecast.js";
import { InitiativeService, type ShareGateRecord, shareShortfall } from "./initiatives/service.js";
import { recordingOf } from "./model-recording.js";
import { type PlanCostRate, planCostOf } from "./plan-cost.js";
import { PolicySchema, type RunPolicy } from "./schemas.js";
import { NativeWorkflowService } from "./service.js";
import { exceedsTestCapacity, type SizingReport } from "./sizing.js";
import { costStageOf, runPrices } from "./stage-price.js";
import { type LadderRung, nextRung, type RecoveryPlacement } from "./stall-ladder.js";
import { type ArtifactRow, WorkflowStore } from "./store.js";
import { RuntimeStateSchema } from "./types.js";

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
  // A provider's usage-policy refusal of an attempt and what the run did with it (#1895).
  POLICY_REFUSAL_KIND,
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
      REQUEST_KEYS.has(k) && typeof v === "string"
        ? requestStandIn(k, v, standIns)
        : PROSE.has(k) || content.has(k)
          ? replaced(k, v, standIns)
          : scrubTrace(v, standIns, content, k),
    ]),
  );
}

/** A run state's request texts, whose named files the auto-approval replay reads (#1707). */
const REQUEST_KEYS = new Set(["requestText", "prompt"]);

/**
 * A request's stand-in, followed by the file names and paths it names to change, one per line
 * (`requestedPathTokens`): enough for a replay to decide a request-named manifest edit as the run
 * did, and no prose.
 */
const requestStandIn = (key: string, text: string, standIns: StandIns): string =>
  [standIns.of(key, text), ...requestedPathTokens(text)].filter(Boolean).join("\n");

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
  /** Each recorded attempt's reservation against the current per-call cost cap (#1740). */
  costCap: CostCapBoundary[];
  /** Attempts the recording started that the current cost cap refuses. */
  newCostStops: number;
  /** Each recorded model call against the current first-response deadline. */
  firstByte: FirstByteBoundary[];
  /** Calls the current deadline would end as an outage that got their answer in the recording. */
  newFirstByteStops: number;
  /** Each planned test task of the run's sizing reports against the current split rule (#1789). */
  testSplits: TestSplitBoundary[];
  /** Test tasks the current rule splits that the recorded sizing kept whole. */
  newTestSplits: number;
  /** Each recorded stalled attempt against the current recovery ladder (#1877). */
  stallLadder: StallLadderBoundary[];
  /** Stalled attempts after which the current ladder takes another rung than the recording. */
  newRecoveries: number;
  /** Each attempt a provider refused under its usage policy, against the current rule (#1895). */
  policyRefusals: PolicyRefusalBoundary[];
  /** Refusals the current rule stops the run on that the recording ran again. */
  newPolicyStops: number;
}

/** What a run does with a refused attempt; `policyRefusalDecision` unless a test passes another. */
export type PolicyRefusalRule = typeof policyRefusalDecision;

export interface PolicyRefusalBoundary {
  attemptId: string;
  /** The task, or the stage profile, the refusals are counted for. */
  key: string;
  model: string;
  /** Refusals of the same key and model recorded before this one. */
  prior: number;
  recorded: "retry" | "stop";
  replayed: "retry" | "stop";
}

/**
 * Every usage-policy refusal a run recorded (`provider/policy-refusals/*.json`, #1895), decided
 * again by `decide` from the refusals of the same task or stage profile and model before it.
 * Traces from before #1895 record none.
 */
export function replayPolicyRefusals(
  store: WorkflowStore,
  runId: string,
  decide: PolicyRefusalRule = policyRefusalDecision,
): PolicyRefusalBoundary[] {
  const seen = new Map<string, number>();
  return store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith(POLICY_REFUSALS_DIR))
    .flatMap((artifact) => {
      let record: {
        attemptId?: string;
        taskId?: string;
        profile?: string;
        model?: string;
        decision?: "retry" | "stop";
      };
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      const key = record.taskId ?? record.profile ?? "";
      const model = record.model ?? "";
      const prior = seen.get(`${key}\0${model}`) ?? 0;
      seen.set(`${key}\0${model}`, prior + 1);
      return [
        {
          attemptId: record.attemptId ?? "",
          key,
          model,
          prior,
          recorded: record.decision ?? "retry",
          replayed: decide(prior),
        },
      ];
    });
}

/**
 * A recorded attempt's reservation against the per-call cost cap (`costCapDecision`, #1740): every
 * recorded attempt passed it, growing the cap or not, so a `stop` is a refusal the round did not
 * see.
 */
export interface CostCapBoundary {
  attemptId: string;
  at: number;
  stage: string;
  model: string;
  tokens: number;
  replayed: "pass" | "grow" | "stop";
  requestedUsd: number;
  spentUsd: number;
  reservedUsd: number;
  ceilingUsd: number;
}

/** A call's dollars per token; `callCostRate` unless a test passes another. */
export type CallRate = typeof callCostRate;

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

/** The recovery ladder's choice after a stalled call; `nextRung` unless a test passes another. */
export type StallRule = typeof nextRung;

/** A recorded stalled attempt against the current recovery ladder (#1877). */
export interface StallLadderBoundary {
  attemptId: string;
  stage: string | null;
  model: string;
  /** The rung the run took after this attempt (`attempt.recovery`), or none. */
  recorded: LadderRung | "none";
  replayed: LadderRung | "none";
}

/**
 * Walks the recovery ladder again over each stage's recorded attempts: an attempt whose last model
 * call got no first response is a stall, one that completed ends the ladder. The route comes from
 * the run's routing record, the effort from the attempt's usage. Effects are not in a trace, so an
 * attempt that edited files before it stalled counts as one that did not.
 */
export function replayStallLadder(
  store: WorkflowStore,
  runId: string,
  rule: StallRule = nextRung,
): StallLadderBoundary[] {
  const attempts = store.connection
    .query(
      "SELECT id, step_id, model_id, status FROM attempts WHERE run_id=? AND model_id IS NOT NULL ORDER BY started_at, rowid",
    )
    .all(runId) as { id: string; step_id: string; model_id: string; status: string }[];
  const taken = new Map(
    store
      .events(runId, 0, 1_000_000)
      .flatMap((event) =>
        event.type === "attempt.recovery"
          ? [[event.payload.attemptId, event.payload.rung] as const]
          : [],
      ),
  );
  const saved = store.latestArtifact(runId, "routing.json");
  const routing = saved
    ? (JSON.parse(store.readArtifact(runId, saved.id)) as {
        stages?: Record<string, { model: string; effort?: string; fallback?: string[] }>;
        profiles?: Record<string, { model: string; effort?: string; fallback?: string[] }>;
      })
    : {};
  const ladders = new Map<string, RecoveryPlacement | undefined>();
  const boundaries: StallLadderBoundary[] = [];
  for (const attempt of attempts) {
    const stage = store.rootStage(runId, attempt.step_id);
    const usageArtifact = store.latestArtifact(runId, `attempts/${attempt.id}/usage.json`);
    const usage = usageArtifact
      ? (JSON.parse(store.readArtifact(runId, usageArtifact.id)) as {
          profileId?: string;
          effort?: string;
          calls?: CallTiming[];
        })
      : {};
    const key = `${stage}:${usage.profileId ?? ""}`;
    if (attempt.status === "completed") {
      ladders.delete(key);
      continue;
    }
    const last = usage.calls?.at(-1);
    if (
      attempt.status !== "failed" ||
      !last ||
      last.firstByteMs !== null ||
      last.status !== undefined
    )
      continue;
    const entry =
      (stage ? routing.stages?.[stage] : undefined) ??
      (usage.profileId ? routing.profiles?.[usage.profileId] : undefined);
    const models = entry ? [entry.model, ...(entry.fallback ?? [])] : [attempt.model_id];
    const effort = (usage.effort ?? entry?.effort) as RouteEffort | undefined;
    const current = ladders.get(key);
    const next = rule(current, {
      model: attempt.model_id,
      models,
      fallbackIndex: Math.max(0, models.indexOf(attempt.model_id)),
      effort,
    });
    ladders.set(key, next ?? undefined);
    boundaries.push({
      attemptId: attempt.id,
      stage,
      model: attempt.model_id,
      recorded: taken.get(attempt.id) ?? "none",
      replayed: next?.rung ?? "none",
    });
  }
  return boundaries;
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

/**
 * One feature start of an initiative with the trace rewound to that moment: the initiative's view
 * computed again by the current code (its estimate, prices and dollar forecast) and the start gate
 * asked again. Every boundary is a start the recording made.
 */
export interface InitiativeStartBoundary {
  featureId: string;
  at: number;
  /** Features accepted when it started, of the split's features. */
  accepted: number;
  features: number;
  spentUsd: number;
  forecastUsd: number | null;
  ceilingUsd: number | null;
  replayed: "pass" | "park";
  /** Each feature's token range in the estimate the current code makes at this start (#1806). */
  estimate: { featureId: string; low: number; high: number }[];
}

export interface InitiativeReplay {
  initiativeId: string;
  shareGate: ShareGateBoundary[];
  /** Features the recording started that the current gate parks on the recorded inputs. */
  newShareStops: number;
  starts: InitiativeStartBoundary[];
  /** Features the recording started that the current gate parks on recomputed inputs. */
  newStartStops: number;
  /** What the initiative spent in the end, its split run included. */
  finalUsd: number | null;
  /** The policy's history stores the corpus has no trace of; their runs price nothing. */
  missingHistory: string[];
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
): Pick<InitiativeReplay, "initiativeId" | "shareGate" | "newShareStops">[] {
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

/** Measured stage usage for an initiative's prices; `initiativePriceSamples` unless a test passes an older one. */
export type PriceSamples = typeof initiativePriceSamples;

/** The corpus trace of a history store the policy names, or null; see `corpusHistoryTrace`. */
export type HistoryTrace = (store: string) => string | null;

/**
 * A bench app the runner kept at `.../RNN/app` is `RNN/app.sqlite.gz` in the corpus at `root`.
 * Apps from before the corpus (R44 and older) have no trace.
 */
export function corpusHistoryTrace(root: string): HistoryTrace {
  return (store) => {
    const dir = store.replace(/[\\/]+$/, "").replace(/[\\/]\.baked[\\/]workflows\.sqlite$/, "");
    const match = /(?:^|[\\/])(R\d+)[\\/]([^\\/]+)$/.exec(dir);
    const trace = match ? join(root, match[1] ?? "", `${match[2]}.sqlite.gz`) : null;
    return trace && existsSync(trace) ? trace : null;
  };
}

const NO_AGENTS = {
  execute: () => Promise.reject(new Error("A trace replay runs no agents")),
};

/**
 * Replays the start gate (`shareShortfall`, with the dollar forecast in it) at every feature
 * start of the trace's initiatives (#1707). From the last start back to the first, the trace is
 * rewound to the moment the start was linked: later runs, links, events and requests removed,
 * the runs still going then rewound like a run replay. The initiative's history stores are
 * replaced by their corpus traces, so its estimate and prices read what the round's runner read.
 * A start made under an earlier split revision is not replayed.
 */
export function replayInitiativeStarts(
  path: string,
  options: { gate?: ShareGate; priceSamples?: PriceSamples; historyTrace?: HistoryTrace } = {},
): Omit<InitiativeReplay, "shareGate" | "newShareStops">[] {
  const gate = options.gate ?? shareShortfall;
  const historyTrace = options.historyTrace ?? corpusHistoryTrace(dirname(dirname(path)));
  const probe = openTrace(path);
  let ids: string[];
  try {
    ids = (
      probe.store.connection.query("SELECT id FROM initiatives ORDER BY created_at").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  } finally {
    probe.dispose();
  }
  // Each initiative gets its own copies: a rewind removes every later run of the trace.
  return ids.map((id) => replayStarts(path, id, gate, options.priceSamples, historyTrace));
}

/**
 * The runner's model routing as the trace's latest routing record before `t` shows it: each
 * profile's route names the configured class, role or profile it came from. Features without a
 * run are routed with it, as the runner routed them; without it every stage would run on the
 * initiative's model and be priced there.
 */
function routingAt(db: Database, t: number): Pick<AppConfig, "modelRouting"> {
  const row = db
    .query(
      "SELECT inline_content AS content FROM artifacts WHERE kind='routing' AND created_at<? ORDER BY created_at DESC LIMIT 1",
    )
    .get(t) as { content: string | null } | null;
  if (!row?.content) return {};
  const record = JSON.parse(row.content) as {
    profiles?: Record<string, { model?: string; effort?: string; source?: string }>;
  };
  const routing: Record<string, Record<string, { model: string; effort?: string }>> = {};
  for (const route of Object.values(record.profiles ?? {})) {
    const [, kind, name] =
      /^modelRouting\.(classes|roles|profiles)\.(.+)$/.exec(route.source ?? "") ?? [];
    if (!kind || !name || !route.model) continue;
    routing[kind] = {
      ...routing[kind],
      [name]: { model: route.model, ...(route.effort ? { effort: route.effort } : {}) },
    };
  }
  const parsed = ModelRoutingSchema.safeParse(routing);
  return parsed.success && Object.keys(routing).length ? { modelRouting: parsed.data } : {};
}

/** Tables other than `runs` whose rows belong to a run. */
function runTables(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((t) => t.name)
    .filter(
      (name) =>
        name !== "runs" &&
        (db.query(`PRAGMA table_info("${name}")`).all() as { name: string }[]).some(
          (c) => c.name === "run_id",
        ),
    );
}

/** Removes runs with all their rows, inside the caller's transaction. */
function removeRuns(db: Database, tables: string[], runIds: Iterable<string>): void {
  // Rows of a removed run go in any order; the keys must hold once they are all gone.
  db.run("PRAGMA defer_foreign_keys=ON");
  for (const runId of runIds) {
    for (const table of tables) db.run(`DELETE FROM "${table}" WHERE run_id=?`, [runId]);
    db.run("DELETE FROM runs WHERE id=?", [runId]);
  }
}

function replayStarts(
  path: string,
  initiativeId: string,
  gate: ShareGate,
  priceSamples: PriceSamples | undefined,
  historyTrace: HistoryTrace,
): Omit<InitiativeReplay, "shareGate" | "newShareStops"> {
  const { store, workspace, dispose } = openTrace(path);
  const histories = new Map<string, ReturnType<typeof openTrace>>();
  try {
    const db = store.connection;
    const row = db
      .query("SELECT settings_json, decompose_run_id FROM initiatives WHERE id=?")
      .get(initiativeId) as { settings_json: string; decompose_run_id: string | null };
    const settings = JSON.parse(row.settings_json) as {
      basePolicy?: { sizing?: { historyStores?: string[] } };
    };
    const missingHistory: string[] = [];
    const sizing = settings.basePolicy?.sizing;
    if (sizing?.historyStores) {
      const mapped: string[] = [];
      for (const named of sizing.historyStores) {
        const trace = historyTrace(named);
        if (trace && !histories.has(trace)) histories.set(trace, openTrace(trace));
        const history = trace ? histories.get(trace) : undefined;
        if (history) mapped.push(history.workspace);
        else missingHistory.push(named);
      }
      sizing.historyStores = mapped;
      db.run("UPDATE initiatives SET settings_json=? WHERE id=?", [
        JSON.stringify(settings),
        initiativeId,
      ]);
    }
    const links = db
      .query(
        "SELECT feature_id, run_id, created_at FROM initiative_runs WHERE initiative_id=? ORDER BY created_at, rowid",
      )
      .all(initiativeId) as { feature_id: string; run_id: string; created_at: number }[];
    const linked = [
      ...new Set([
        ...(row.decompose_run_id ? [row.decompose_run_id] : []),
        ...links.map((l) => l.run_id),
      ]),
    ];
    const finalUsd = linked.reduce((sum, runId) => sum + store.costUsage(runId).spentUsd, 0);
    const revisedAt = (
      db
        .query("SELECT MAX(created_at) AS at FROM initiative_revisions WHERE initiative_id=?")
        .get(initiativeId) as { at: number | null }
    ).at;
    const tables = runTables(db);
    const runIds = (db.query("SELECT id FROM runs").all() as { id: string }[]).map((r) => r.id);
    const rewinders = new Map(runIds.map((runId) => [runId, runRewinder(store, runId)]));
    const states = new Map(
      runIds.map((runId) => [
        runId,
        (
          db
            .query(
              "SELECT at, payload_json FROM events WHERE run_id=? AND type='run.state_changed' ORDER BY seq",
            )
            .all(runId) as { at: number; payload_json: string }[]
        ).map((e) => ({
          at: e.at,
          ...(JSON.parse(e.payload_json) as { to: string; reason: string }),
        })),
      ]),
    );
    const starts: InitiativeStartBoundary[] = [];
    for (const link of [...links].reverse()) {
      const t = link.created_at;
      if (revisedAt !== null && revisedAt >= t) break;
      db.transaction(() => {
        const late = new Set([
          link.run_id,
          ...links.filter((l) => l.created_at >= t).map((l) => l.run_id),
          ...(db.query("SELECT id FROM runs WHERE created_at>=?").all(t) as { id: string }[]).map(
            (r) => r.id,
          ),
        ]);
        removeRuns(db, tables, late);
        db.run("DELETE FROM initiative_runs WHERE initiative_id=? AND created_at>=?", [
          initiativeId,
          t,
        ]);
        db.run("DELETE FROM initiative_events WHERE initiative_id=? AND at>=?", [initiativeId, t]);
        db.run("DELETE FROM initiative_requests WHERE initiative_id=? AND created_at>=?", [
          initiativeId,
          t,
        ]);
        db.run(
          "UPDATE initiative_requests SET status='pending', answer_json=NULL, actor=NULL, decided_at=NULL WHERE initiative_id=? AND decided_at>=?",
          [initiativeId, t],
        );
        db.run("UPDATE initiatives SET status='active', reason='' WHERE id=?", [initiativeId]);
        for (const runId of runIds) {
          if (late.has(runId) || !rewinders.has(runId)) continue;
          const state = states
            .get(runId)
            ?.filter((e) => e.at < t)
            .at(-1);
          rewinders.get(runId)?.(t, undefined, ["state"]);
          db.run("UPDATE runs SET status=?, reason=? WHERE id=?", [
            state?.to ?? "running",
            state?.reason ?? "none",
            runId,
          ]);
        }
        for (const runId of late) rewinders.delete(runId);
      })();
      // A history store of the same round holds runs the runner had not made or finished yet.
      for (const history of histories.values()) {
        const hdb = history.store.connection;
        const later = (
          hdb.query("SELECT id FROM runs WHERE created_at>=? OR updated_at>?").all(t, t) as {
            id: string;
          }[]
        ).map((r) => r.id);
        if (later.length) hdb.transaction(() => removeRuns(hdb, runTables(hdb), later))();
      }
      const service = new NativeWorkflowService(
        workspace,
        { ...DEFAULT_CONFIG, ...routingAt(db, t) },
        NO_AGENTS,
        true,
      );
      try {
        const initiatives = new InitiativeService(service);
        if (priceSamples) initiatives.priceSamples = priceSamples;
        const view = initiatives.view(initiativeId);
        const feature = view.features.find((f) => f.id === link.feature_id);
        const cost = view.budget.cost;
        const estimate = (initiatives.estimate(initiativeId)?.features ?? []).map((f) => ({
          featureId: f.featureId,
          low: f.tokens.low,
          high: f.tokens.high,
        }));
        starts.unshift({
          featureId: link.feature_id,
          at: t,
          accepted: view.features.filter((f) => f.state === "accepted").length,
          features: view.features.length,
          spentUsd: cost.spentUsd,
          forecastUsd: cost.forecastUsd,
          ceilingUsd: cost.ceilingUsd,
          replayed: feature && gate(view, feature) ? "park" : "pass",
          estimate,
        });
      } finally {
        service.close();
      }
    }
    return {
      initiativeId,
      starts,
      newStartStops: starts.filter((b) => b.replayed === "park").length,
      finalUsd: finalUsd > 0 ? Math.round(finalUsd * 100) / 100 : null,
      missingHistory,
    };
  } finally {
    dispose();
    for (const history of histories.values()) history.dispose();
  }
}

/** Whether sizing splits a test task; `exceedsTestCapacity` unless a test passes another. */
export type TestSplitRule = typeof exceedsTestCapacity;

/** A planned test task of a recorded sizing report against the split rule (#1789). */
export interface TestSplitBoundary {
  /** The report's logical path, `sizing/plan-N.json`. */
  report: string;
  taskId: string;
  cases: number;
  recorded: "whole" | "split";
  replayed: "whole" | "split";
}

/**
 * Every planned test task of the run's sizing reports, split or kept whole again by `decide` on
 * the inputs the report recorded: its literal cases, its price, the observed case capacity and one
 * attempt's cap. Slices of a split file are not split again, so they are left out, as are tasks of
 * reports that did not record case counts. Round 53 split
 * url-shortener's test files at a capacity of 4 cases and spent 5.78M tokens against 3.42M (#1789).
 */
export function replayTestSplits(
  store: WorkflowStore,
  runId: string,
  decide: TestSplitRule = exceedsTestCapacity,
): TestSplitBoundary[] {
  const reports = store.connection
    .query(
      "SELECT id, logical_path AS path FROM artifacts WHERE run_id=? AND logical_path LIKE 'sizing/plan-%' ORDER BY created_at, id",
    )
    .all(runId) as { id: string; path: string }[];
  return reports.flatMap(({ id, path }) => {
    const report = JSON.parse(store.readArtifact(runId, id)) as Partial<SizingReport>;
    if (!report.tasks || typeof report.maxAttemptTokens !== "number") return [];
    const cap = report.maxAttemptTokens;
    return (
      report.tasks
        // Reports from before literal case counts (#1562) did not record a task's cases.
        .filter(
          (task) => task.kind === "test" && task.cases !== undefined && (task.sliceCount ?? 1) <= 1,
        )
        .map((task) => ({
          report: path,
          taskId: task.taskId,
          cases: task.cases ?? 0,
          recorded: task.oversized ? ("split" as const) : ("whole" as const),
          // A rows task is decided as one from #1930 on; older reports did not mark it.
          replayed: decide(
            task.cases ?? 0,
            report.testTaskLimit ?? null,
            task.estimate,
            cap,
            true,
            task.rowsTask ?? null,
          )
            ? ("split" as const)
            : ("whole" as const),
        }))
    );
  });
}

/** A plan approval of a trace, priced again by the current code at the moment it was asked. */
export interface PlanPriceReplay {
  runId: string;
  model: string;
  /** The planned tasks' dollars the approval showed. */
  recorded: { low: number; high: number };
  /** The same plan priced by the current code; null when it has no price. */
  replayed: { low: number; high: number } | null;
  rate: PlanCostRate | null;
  /** What the run's task attempts after the approval cost. */
  actualUsd: number;
}

/**
 * Replays the price of every accepted plan approval of a trace (#1792): a fresh copy is rewound to
 * the moment the plan was approved (runs made later removed, runs still going then not counted as
 * finished, the run itself rewound like a run replay) and `planCostOf` prices its tasks again,
 * with `historyStores` as its policy's history (other traces, opened by the caller); null prices
 * them without a policy, from the run's own attempts alone, as before #1792. The approval is
 * compared with what the run's tasks then cost.
 */
export function replayPlanPrices(
  path: string,
  historyStores: string[] | null = [],
): PlanPriceReplay[] {
  const read = openTrace(path);
  let approvals: (Omit<PlanPriceReplay, "replayed" | "rate"> & { at: number })[];
  try {
    const db = read.store.connection;
    const rows = db
      .query(
        "SELECT run_id, decided_at, body_json FROM requests WHERE kind='approval' AND status='accepted' AND decided_at IS NOT NULL ORDER BY decided_at",
      )
      .all() as { run_id: string; decided_at: number; body_json: string }[];
    approvals = rows.flatMap((row) => {
      const shown = (
        JSON.parse(row.body_json) as {
          planCost?: { implementation?: { model: string; usd: { low: number; high: number } } };
        }
      ).planCost?.implementation;
      if (!shown) return [];
      const started = new Map(read.store.attempts(row.run_id).map((a) => [a.id, a.started_at]));
      const actualUsd = runPrices(read.store, row.run_id)
        .samples.filter(
          (a) => a.stage === "implement" && (started.get(a.attemptId) ?? 0) > row.decided_at,
        )
        .reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
      return [
        {
          runId: row.run_id,
          at: row.decided_at,
          model: shown.model,
          recorded: shown.usd,
          actualUsd,
        },
      ];
    });
  } finally {
    read.dispose();
  }
  return approvals.map(({ at, ...approval }) => {
    const { store, dispose } = openTrace(path);
    try {
      const db = store.connection;
      db.transaction(() => {
        const later = db
          .query("SELECT id FROM runs WHERE created_at>? AND id<>?")
          .all(at, approval.runId) as { id: string }[];
        removeRuns(
          db,
          runTables(db),
          later.map((r) => r.id),
        );
        db.run("UPDATE runs SET status='running' WHERE updated_at>? AND id<>?", [
          at,
          approval.runId,
        ]);
        runRewinder(store, approval.runId)(at);
      })();
      const cost = planCostOf(
        store,
        approval.runId,
        historyStores ? { sizing: { historyStores } } : undefined,
      ).implementation;
      return { ...approval, replayed: cost?.usd ?? null, rate: cost?.rate ?? null };
    } finally {
      dispose();
    }
  });
}

/** A plan approval's host decision: approved on its own, or with a person. */
export type ApprovalDecision = "auto" | "person";

/** A plan approval of a trace, decided again by the current code on the state it was asked with. */
export interface PlanApprovalReplay {
  runId: string;
  recorded: ApprovalDecision;
  replayed: ApprovalDecision;
  /** Why the replay needs a person; empty when it approves. */
  reasons: string[];
}

/**
 * Replays the host's auto-approval decision at every plan approval of a trace (#1707): the run
 * state the scheduler held when it asked (`internal/state.json` then), the run's earlier requests
 * and its artifacts until then go to `planApprovalDecision` (or `decide`, to replay an older rule).
 * The trace keeps no request prose and no files: deliverable coverage is not replayed, the
 * manifest edits a request names are read from the paths the export kept of it (traces exported
 * before #1707's export change kept none), and a path exists when the plan modifies it rather than
 * creates it. A package the approval reviewer approved counts as approved when the replay leaves it
 * reviewable. Approvals of runs without auto approval are skipped.
 */
export function replayPlanApprovals(
  path: string,
  decide: typeof planApprovalDecision = planApprovalDecision,
): PlanApprovalReplay[] {
  const { store, dispose } = openTrace(path);
  try {
    const db = store.connection;
    const asked = db
      .query(
        "SELECT r.run_id, r.id, r.body_json, e.at FROM requests r JOIN events e ON e.run_id=r.run_id AND e.type='request.created' AND json_extract(e.payload_json,'$.requestId')=r.id WHERE r.kind='approval' ORDER BY e.at",
      )
      .all() as { run_id: string; id: string; body_json: string; at: number }[];
    return asked.flatMap((request) => {
      const body = JSON.parse(request.body_json) as {
        policy?: unknown;
        autoApproval?: { mode?: string };
      };
      const policy = PolicySchema.safeParse(body.policy);
      if (!policy.success || !policy.data.autoApproval) return [];
      const made = new Set(
        (
          db
            .query("SELECT id FROM artifacts WHERE run_id=? AND created_at<=?")
            .all(request.run_id, request.at) as { id: string }[]
        ).map((a) => a.id),
      );
      const artifacts = store.artifacts(request.run_id).filter((a) => made.has(a.id));
      const read = (artifact: ArtifactRow) => store.readArtifact(request.run_id, artifact.id);
      const latest = artifacts.filter((a) => a.logical_path === "internal/state.json").at(-1);
      const state = latest ? RuntimeStateSchema.safeParse(JSON.parse(read(latest))) : null;
      if (!state?.success || !state.data.spec || !state.data.graph) return [];
      const { spec, graph } = state.data;
      const earlier = new Set(
        asked.filter((r) => r.run_id === request.run_id && r.at < request.at).map((r) => r.id),
      );
      const result = decide(
        policy.data,
        { ...state.data, spec, graph },
        store.requests(request.run_id).filter((r) => earlier.has(r.id)),
        artifacts,
        read,
        {
          scaffold: false,
          coverage: false,
          exists: (file) =>
            graph.tasks.some((t) => t.writes.some((w) => w.path === file && w.action !== "create")),
        },
      );
      const reviewed = body.autoApproval?.mode === "model-review";
      return [
        {
          runId: request.run_id,
          recorded: body.autoApproval?.mode ? "auto" : "person",
          replayed: result.approval || (reviewed && result.reviewable) ? "auto" : "person",
          reasons: result.approval ? [] : result.reasons,
        },
      ];
    });
  } finally {
    dispose();
  }
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
export function openTrace(path: string): {
  store: WorkflowStore;
  workspace: string;
  dispose: () => void;
} {
  const workspace = mkdtempSync(join(tmpdir(), "baked-replay-"));
  mkdirSync(join(workspace, ".baked"), { recursive: true });
  const bytes = readFileSync(path);
  const raw = path.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes;
  writeFileSync(join(workspace, ".baked", "workflows.sqlite"), raw);
  const store = new WorkflowStore(workspace);
  return {
    store,
    workspace,
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
 * Rewinds one run's attempts, artifacts, events, tasks and steps to the moment `t`: later rows
 * are removed, and an attempt that was still running then is running again. With `current`, the
 * attempt that starts at `t` is kept as the running one. Kinds in `keep` stay, as the run state
 * an initiative's feature views read.
 */
function runRewinder(
  store: WorkflowStore,
  runId: string,
): (t: number, current?: { r: number; id: string }, keep?: string[]) => void {
  const db = store.connection;
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
  return (t, current, keep = []) => {
    db.run("DELETE FROM attempts WHERE run_id=? AND (started_at>? OR (started_at=? AND rowid>?))", [
      runId,
      t,
      t,
      current?.r ?? Number.MAX_SAFE_INTEGER,
    ]);
    db.run(
      "UPDATE attempts SET status='running', used_tokens=NULL, usage_complete=0, ended_at=NULL WHERE run_id=? AND (ended_at IS NULL OR ended_at>? OR id=?)",
      [runId, t, current?.id ?? ""],
    );
    const kept = keep.length ? ` AND kind NOT IN (${keep.map(() => "?").join(",")})` : "";
    db.run(`DELETE FROM artifacts WHERE run_id=? AND created_at>?${kept}`, [runId, t, ...keep]);
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
  };
}

/**
 * Replays the forecast gate of one run: from its last attempt back to its first, the store is
 * rewound to the moment the attempt started (later attempts, artifacts and events removed, task
 * and step states and the policy as they were then) and `assertForecastFits` decides again.
 */
function replayRun(
  store: WorkflowStore,
  runId: string,
  callRate: CallRate = callCostRate,
): Omit<
  RunReplay,
  | "firstByte"
  | "newFirstByteStops"
  | "testSplits"
  | "newTestSplits"
  | "stallLadder"
  | "newRecoveries"
  | "policyRefusals"
  | "newPolicyStops"
> | null {
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
      "SELECT rowid AS r, id, step_id, model_id, reserved_tokens, started_at FROM attempts WHERE run_id=? AND model_id IS NOT NULL ORDER BY started_at, rowid",
    )
    .all(runId) as {
    r: number;
    id: string;
    step_id: string;
    model_id: string;
    reserved_tokens: number;
    started_at: number;
  }[];
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
  const rewind = runRewinder(store, runId);
  const boundaries: ReplayBoundary[] = [];
  const costCap: CostCapBoundary[] = [];
  for (let i = priced.length - 1; i >= 0; i--) {
    const attempt = priced[i];
    if (!attempt) continue;
    const t = attempt.started_at;
    const next = priced[i + 1]?.started_at ?? Number.POSITIVE_INFINITY;
    db.transaction(() => {
      rewind(t, attempt);
      db.run(
        "UPDATE runs SET policy_json=?, estimated_cost_microusd=NULL, status='running' WHERE id=?",
        [canonical(policyAt(t)), runId],
      );
    })();
    const policy = policyAt(t);
    // The attempt's reservation against the cost cap, as `reserve` checked it before the
    // attempt started. Its tokens are the largest the attempt reserved (`expandReservation`
    // checks a raise the same way, later and with more spent). A growth it writes is undone
    // before the forecast replay.
    const checked = store.costCapDecision(
      runId,
      attempt.step_id,
      structuredClone(policy),
      attempt.model_id,
      attempt.reserved_tokens,
      attempt.id,
      callRate,
    );
    if (checked)
      costCap.unshift({
        attemptId: attempt.id,
        at: t,
        stage: costStageOf(store, runId, attempt.step_id),
        model: attempt.model_id,
        tokens: attempt.reserved_tokens,
        replayed: checked.decision,
        requestedUsd: checked.requestedUsd,
        spentUsd: checked.spentUsd,
        reservedUsd: checked.reservedUsd,
        ceilingUsd: checked.ceilingUsd,
      });
    db.transaction(() => {
      db.run("DELETE FROM artifacts WHERE run_id=? AND created_at>?", [runId, t]);
      db.run("UPDATE runs SET policy_json=? WHERE id=?", [canonical(policy), runId]);
    })();
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
    costCap,
    newCostStops: costCap.filter((b) => b.replayed === "stop").length,
  };
}

/** Replays the forecast gate of every run in the trace at `path` with a dollar cap. */
export function replayTrace(
  path: string,
  options: {
    firstByteLimit?: FirstByteLimit;
    shareGate?: ShareGate;
    callRate?: CallRate;
    testSplit?: TestSplitRule;
    stallRule?: StallRule;
    priceSamples?: PriceSamples;
    historyTrace?: HistoryTrace;
    policyRefusal?: PolicyRefusalRule;
  } = {},
): TraceReplay {
  // Initiative starts rewind their own copies of the trace, before the run replay rewinds this one.
  const starts = replayInitiativeStarts(path, {
    ...(options.shareGate ? { gate: options.shareGate } : {}),
    ...(options.priceSamples ? { priceSamples: options.priceSamples } : {}),
    ...(options.historyTrace ? { historyTrace: options.historyTrace } : {}),
  });
  const { store, dispose } = openTrace(path);
  try {
    const runIds = (
      store.connection.query("SELECT id FROM runs ORDER BY created_at").all() as { id: string }[]
    ).map((r) => r.id);
    // Call timings are read before the forecast replay rewinds each run's attempts.
    const timings = new Map(
      runIds.map((runId) => [runId, replayFirstByte(store, runId, options.firstByteLimit)]),
    );
    const splits = new Map(
      runIds.map((runId) => [runId, replayTestSplits(store, runId, options.testSplit)]),
    );
    const stalls = new Map(
      runIds.map((runId) => [runId, replayStallLadder(store, runId, options.stallRule)]),
    );
    const refusals = new Map(
      runIds.map((runId) => [runId, replayPolicyRefusals(store, runId, options.policyRefusal)]),
    );
    const runs: RunReplay[] = [];
    for (const runId of runIds) {
      const firstByte = timings.get(runId) ?? [];
      const replay = replayRun(store, runId, options.callRate) ?? {
        runId,
        featureId: store.run(runId).feature_id,
        finalUsd: null,
        boundaries: [],
        newStops: 0,
        newGrowth: 0,
        removedStops: 0,
        ratios: [],
        costCap: [],
        newCostStops: 0,
      };
      const testSplits = splits.get(runId) ?? [];
      const stallLadder = stalls.get(runId) ?? [];
      const policyRefusals = refusals.get(runId) ?? [];
      if (
        !replay.boundaries.length &&
        !firstByte.length &&
        !testSplits.length &&
        !stallLadder.length &&
        !policyRefusals.length
      )
        continue;
      runs.push({
        ...replay,
        firstByte,
        newFirstByteStops: firstByte.filter((b) => b.replayed === "stop" && b.recorded === "pass")
          .length,
        testSplits,
        newTestSplits: testSplits.filter((b) => b.replayed === "split" && b.recorded === "whole")
          .length,
        stallLadder,
        newRecoveries: stallLadder.filter((b) => b.replayed !== b.recorded).length,
        policyRefusals,
        newPolicyStops: policyRefusals.filter(
          (b) => b.replayed === "stop" && b.recorded === "retry",
        ).length,
      });
    }
    const gates = replayShareGate(store, options.shareGate);
    const initiatives = [
      ...new Set([...starts.map((i) => i.initiativeId), ...gates.map((i) => i.initiativeId)]),
    ].map((initiativeId): InitiativeReplay => {
      const gate = gates.find((i) => i.initiativeId === initiativeId);
      return {
        initiativeId,
        shareGate: gate?.shareGate ?? [],
        newShareStops: gate?.newShareStops ?? 0,
        starts: [],
        newStartStops: 0,
        finalUsd: null,
        missingHistory: [],
        ...starts.find((i) => i.initiativeId === initiativeId),
      };
    });
    return { trace: path, runs, initiatives };
  } finally {
    dispose();
  }
}

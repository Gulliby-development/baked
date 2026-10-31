import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import { builtinProfiles } from "../agents/profiles/builtin.js";
import { FirstByteHistory } from "../llm/first-byte-history.js";
import { ModelRoutingSchema, type RouteEffort } from "../llm/model-routing.js";
import {
  POLICY_REFUSAL_KIND,
  POLICY_REFUSALS_DIR,
  policyRefusalDecision,
} from "../llm/policy-refusal.js";
import {
  type CallReasoning,
  type CallTiming,
  firstByteDeadline,
  providerFirstByteMs,
} from "../llm/provider-health.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { replayUnselectedTests } from "../verification/check-runner.js";
import {
  CASE_WALK_DIR,
  CASE_WALK_KIND,
  type CaseWalk,
  type CaseWalkRecord,
  caseWalkDecision,
} from "../verification/criteria-cases.js";
import {
  EDGE_DIR,
  EDGE_KIND,
  type EdgeCrashRule,
  type EdgeRecord,
  type EdgeRule,
  edgeCrashDecision,
  edgeDecision,
} from "../verification/edge-inputs.js";
import { CHAIN_SITES_DIR, type SitesRecord, siteDecision } from "../verification/family-sites.js";
import { generatedCaseDecision } from "../verification/generated-values.js";
import type { ReproOutcome } from "../verification/repro.js";
import {
  TEST_CAP_DIR,
  TEST_CAP_KIND,
  type TestCapMeasure,
  type TestCapRecord,
  testCapDecision,
} from "../verification/test-cap.js";
import {
  type AttemptCheckpoint,
  checkpointPath,
  checkpointWouldFinish,
  type UnfinishedEnd,
  usageStoppedBy,
} from "./attempt-checkpoint.js";
import { planApprovalDecision, requestedPathTokens } from "./auto-approval.js";
import {
  BASELINE_FIX_KIND,
  type BaselineFailureDecision,
  type BaselineFailureRecord,
  type BaselineFailureRule,
  baselineFailureDecision,
  baselineFixPath,
} from "./baseline-fix.js";
import {
  BASELINE_SIGNATURE_DIR,
  BASELINE_SIGNATURE_KIND,
  type BaselineSignatureDecision,
  type BaselineSignatureRecord,
  type BaselineSignatureRule,
  baselineSignatureDecision,
} from "./baseline-signature.js";
import { callCostRate } from "./budget.js";
import { type CleanSizingShadow, cleanRates, cleanSizingShadow } from "./clean-pace.js";
import {
  CONFLICT_FINISH_DIR,
  CONFLICT_FINISH_KIND,
  type ConflictFinishBranch,
  type ConflictFinishRecord,
  type ConflictFinishRule,
  conflictFinishDecision,
  conflictFinishReady,
} from "./conflict-finish.js";
import {
  type CorrectiveDeferRecord,
  type CorrectiveDeferRule,
  correctiveDeferDecision,
  DEFER_DIR,
  DEFER_KIND,
} from "./corrective-defer.js";
import {
  hostDecision,
  missingDiagnosed,
  SCOPE_KIND,
  type ScopeDecision,
  type ScopeRule,
  scopeRecords,
  type UnownedDecision,
  type UnownedRule,
  unownedRule,
} from "./corrective-scope.js";
import { assertForecastFits, costForecast } from "./cost-forecast.js";
import { WorkflowFault } from "./errors.js";
import {
  EVIDENCE_DECISION_KIND,
  EVIDENCE_DECISIONS_DIR,
  type EvidenceRecord,
  type EvidenceRule,
  type EvidenceSite,
  evidenceDecision,
} from "./evidence-decisions.js";
import {
  type BatteryRecord,
  type BatteryRule,
  batteryDecision,
  batteryOf,
  type CaseCrash,
  CHAIN_BATTERY_DIR,
  CHAIN_FAMILY_DIR,
  CHAIN_KIND,
  CHAIN_REWRITE_AT,
  CHAIN_TASKS_DIR,
  type ChainFinding,
  type ChainRecord,
  type ChainRule,
  chainFindings,
  chainRecord,
  chainRewriteDecision,
  type FamilyRecord,
  type FamilyRule,
  familyDecision,
  familyKey,
  findingChain,
  type RewriteRepeatRule,
  rewriteRepeatDecision,
  rewritesSymbol,
  withRewrites,
} from "./finding-chain.js";
import {
  HOST_APPLY_KIND,
  type HostApplyRule,
  hostApplyDecision,
  hostApplyRecords,
} from "./host-apply.js";
import type { initiativePriceSamples } from "./initiatives/forecast.js";
import {
  type PoolBoundDecision,
  type PoolBoundInputs,
  poolBoundDecision,
  type RunBound,
} from "./initiatives/growth.js";
import {
  type CostView,
  dollarCapPark,
  dollarShortfall,
  type FeatureView,
  InitiativeService,
  type InitiativeView,
  planChargedGate,
  poolGrowthOf,
  type ShareGateRecord,
  shareGatePool,
  shareShortfall,
  shareSpareUsd,
  timeGrowthInputs,
  timeShortfall,
} from "./initiatives/service.js";
import {
  type PlanShareDecision,
  type PlanShareInputs,
  planShareDecision,
  type TimePoolExtension,
  type TimePoolGrowthInputs,
  type TokenPoolView,
  timePoolExtensionDecision,
} from "./initiatives/token-pool.js";
import {
  INVALID_OUTPUT_REPEATS_DIR,
  type InvalidOutputRecord,
  invalidOutputDecision,
} from "./invalid-output-repeat.js";
import {
  MISQUOTE_FIX_DIR,
  MISQUOTE_FIX_KIND,
  type MisquoteFixRecord,
  type MisquoteFixRule,
  misquoteFixDecision,
} from "./misquote-fix.js";
import { recordingOf } from "./model-recording.js";
import { type PlanCostRate, planCostOf, plannedRunTokens } from "./plan-cost.js";
import {
  REPEAT_KIND,
  REPEAT_TASKS_DIR,
  type RepeatCheck,
  type RepeatDecision,
  type RepeatRecord,
  type RepeatRule,
  repeatedFailureDecision,
  unfinishedRepeatRemedies,
} from "./repeated-failure.js";
import {
  REQUEST_CONFLICT_KIND,
  REQUEST_CONFLICTS_DIR,
  type RequestConflictDecision,
  type RequestConflictRecord,
  type RequestConflictRule,
  requestConflictDecision,
} from "./request-conflict.js";
import {
  CONVERGENCE_GATE_DIR,
  CONVERGENCE_GATE_KIND,
  type ConvergenceDecision,
  type ConvergenceGate,
  type ConvergenceGateRecord,
  convergenceGateDecision,
  REVIEW_GATE_DIR,
  REVIEW_GATE_KIND,
  type ReviewGate,
  type ReviewGateRecord,
  reviewGateDecision,
} from "./review-gate.js";
import {
  ROW_BLOCK_DIR,
  ROW_BLOCK_KIND,
  ROW_RUN_KIND,
  type RowBlockRecord,
  type RowBlockRule,
  type RowMoveRule,
  type RowMoves,
  rowBlockDecision,
  rowMoveDecision,
} from "./row-block-drift.js";
import {
  ROW_RESTORE_DIR,
  ROW_RESTORE_KIND,
  type RowRestoreRecord,
  type RowRestoreRule,
  rowRestoreDecision,
} from "./row-restore.js";
import { PolicySchema, type RunPolicy } from "./schemas.js";
import { NativeWorkflowService } from "./service.js";
import {
  activeTimeLimit,
  exceedsTestCapacity,
  type PaceBasis,
  paceOf,
  rowVolumePrice,
  runPace,
  type SizingReport,
} from "./sizing.js";
import {
  SOURCE_DEFECT_DIR,
  SOURCE_DEFECT_KIND,
  type SourceDefectRecord,
  type SourceDefectRule,
  sourceDefectDecision,
} from "./source-defect.js";
import { costStageOf, runPrices } from "./stage-price.js";
import {
  type LadderRung,
  nextRung,
  type RecoveryPlacement,
  type StallPark,
  stallParkDecision,
} from "./stall-ladder.js";
import { readFallback } from "./stall-siblings.js";
import type { AttemptUsageRecord } from "./step-budget.js";
import { type ArtifactRow, WorkflowStore } from "./store.js";
import { SUPPLIED_CHECK_KIND } from "./supplied-checks.js";
import {
  INTEGRITY_DIR,
  INTEGRITY_KIND,
  type IntegrityMeasure,
  type IntegrityRecord,
  integrityDecision,
} from "./test-integrity.js";
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
  // Finding chains: each corrective's rewrite decision, each battery run before a review (#1959)
  // and each rewrite's sibling probe (#1969).
  CHAIN_KIND,
  // Each failing corrective's required checks, normalized output stood in (#1996).
  REPEAT_KIND,
  // Each spec conflict's request decision: checked sides and re-audit verdicts, no quotes (#2016).
  REQUEST_CONFLICT_KIND,
  // Each planned task's host apply decision: its writes' supplied blocks and apply checks (#2023).
  HOST_APPLY_KIND,
  // Each planned task's static checks on its supplied content: paths, lines, rule ids (#2275).
  SUPPLIED_CHECK_KIND,
  // Each misquote settle's host-fix decision: occurrence counts and spelling flags, no text (#2047).
  MISQUOTE_FIX_KIND,
  // Each checks-stage restore decision of a prescribed row file: per row its flags, no text (#2522).
  ROW_RESTORE_KIND,
  // Each planned source task's edge-input probe: its cases' criteria and outcomes (#1808).
  EDGE_KIND,
  // Each test-integrity scan: per-file counts and flags, no code (#1715).
  INTEGRITY_KIND,
  // Each task-end case walk: which cases a file held, no literals (#1715).
  CASE_WALK_KIND,
  // Each task-end test cap check: per-file and per-class test counts and caps, no code (#2368).
  TEST_CAP_KIND,
  // Each checks-stage row block comparison: per prescribed row its literal counts, no text (#2486).
  ROW_BLOCK_KIND,
  // Each failing check's route with a miscounted byte run: files, bytes off, no text (#2515).
  ROW_RUN_KIND,
  // Each review's gate: the findings' labels and repro outcomes, no claims (#1715).
  REVIEW_GATE_KIND,
  // Each task-level corrective's write-scope precondition: diagnosed paths and writes (#2094).
  SCOPE_KIND,
  // Each convergence gate: the same labels, criterion verdicts and evidence counts (#1715).
  CONVERGENCE_GATE_KIND,
  // Each decision for the request or the platform on checked evidence: states, no quotes (#2032).
  EVIDENCE_DECISION_KIND,
  // Each settled conflict's host finish decision: edits, case and check counts, no text (#2033).
  CONFLICT_FINISH_KIND,
  // Each blocked corrective's order decision: stop code, ready task ids, writers (#2109).
  DEFER_KIND,
  // Each baseline failure's repair decision: finding counts, file paths, the fix (#2215).
  BASELINE_FIX_KIND,
  // Each baseline comparison of a failing required check: both signatures, line by line (#2295).
  BASELINE_SIGNATURE_KIND,
  // Each test task's wrong-value failure route: counts, task ids and paths, no literals (#2220).
  SOURCE_DEFECT_KIND,
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

/** Folds the user's home directory out of absolute paths (`/home/<user>`, `/Users/<user>`,
 * `C:\\Users\\<user>`) so recorded command output names no account (#2136). */
export function foldHomeDirs(text: string): string {
  return text.replace(/(?:\b[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[^\\/\s"'`]+/g, "~");
}

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
        : // A finding's defect class keys finding chains (#2048): kept folded, so the labels one
          // run wrote with and without spaces stay equal and need no stand-in.
          k === "family" && typeof v === "string"
          ? (familyKey(v) ?? "")
          : // A probed case's output tail is what its crash decision replays on (#2136): kept,
            // at most `OUTPUT_TAIL_CHARS` characters of a command's output, with the home
            // directory of an absolute path folded to `~` (the decision matches a frame's file by
            // its suffix, so the fold keeps the replay exact).
            k === "outputTail" && typeof v === "string"
            ? foldHomeDirs(v)
            : // A family's sites are code, and the host's site check replays on their text and
              // the lines it read (#2343): kept, each string at most `SITE_TEXT_CHARS` long.
              k === "sites" && Array.isArray(v)
              ? keptCode(v)
              : PROSE.has(k) || content.has(k)
                ? replaced(k, v, standIns)
                : scrubTrace(v, standIns, content, k),
    ]),
  );
}

/** The longest code string of a family site a trace keeps (#2343): a site's text or a line. */
const SITE_TEXT_CHARS = 400;

const keptCode = (value: unknown): unknown =>
  typeof value === "string"
    ? value.slice(0, SITE_TEXT_CHARS)
    : Array.isArray(value)
      ? value.map(keptCode)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keptCode(v)]))
        : value;

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
 * The bound of a gzipped trace: the corpus keeps every round's traces in the repository, and R74
 * ladlemath's 42.5 MiB trace could not join it (#2338). `exportTrace` refuses a larger one and
 * names the tables that made it so.
 */
export const TRACE_MAX_BYTES = 10 * 1024 * 1024;

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** The unpacked bytes of each table's text and blob values, largest first. */
function tableSizes(path: string): { table: string; bytes: number }[] {
  const db = new Database(path, { readonly: true });
  try {
    return [...tables(db)]
      .map((table) => {
        const sum = columns(db, table)
          .map((c) => `COALESCE(SUM(LENGTH(CAST("${c}" AS BLOB))),0)`)
          .join("+");
        const row = db.query(`SELECT ${sum || "0"} AS n FROM "${table}"`).get() as { n: number };
        return { table, bytes: row.n };
      })
      .sort((a, b) => b.bytes - a.bytes);
  } finally {
    db.close();
  }
}

/**
 * A run state without its file manifests (#2338): `expectedFiles` and each prior review's `files`
 * hold a hash per tracked file in every revision of the state, 257 KB and 516 KB of R74
 * ladlemath's largest state. No replay reads them; the reviews' findings stay for
 * `stateFindings`. A state that does not parse is returned as it is.
 */
export function withoutFileManifests(text: string): string {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return text;
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) return text;
  if (state.expectedFiles && typeof state.expectedFiles === "object") state.expectedFiles = {};
  const prior = state.priorReviews;
  if (prior && typeof prior === "object")
    for (const entry of Object.values(prior as Record<string, unknown>))
      if (entry && typeof entry === "object" && "files" in entry)
        (entry as { files: unknown }).files = {};
  return JSON.stringify(state);
}

/**
 * Writes the trace of the workflow database of `workspace` to `out`, gzip-compressed. The source
 * is opened read-only; `runIds` limits the trace to those runs (the default is every run).
 */
export function exportTrace(
  workspace: string,
  out: string,
  options: { runIds?: string[]; maxBytes?: number } = {},
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
            const text =
              a.inline_content ??
              readFileSync(
                workspacePath(workspace, (a.blob_path ?? "").replaceAll("\\", "/")),
                "utf8",
              );
            return a.kind === "state" ? withoutFileManifests(text) : text;
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
        // A snapshot's file manifest is a hash per file of the project; no replay reads one, and
        // with a committed dependency tree they were most of a trace (#2338). The manifest hash
        // stays, so two snapshots of the same files still compare equal.
        if (present.has("workspace_snapshots"))
          db.exec("UPDATE workspace_snapshots SET manifest_json='{}'");
      })();
      db.exec("VACUUM");
    } finally {
      db.close();
    }
    const bytes = readFileSync(copy);
    // The best compression: R60 wheeltags was 2.28 MB at the default level and 2.10 MB at this one,
    // against the corpus's 2 MB guide (#1937).
    const zipped = Bun.gzipSync(bytes, { level: 9 });
    const limit = options.maxBytes ?? TRACE_MAX_BYTES;
    if (zipped.length > limit) {
      const sizes = tableSizes(copy).slice(0, 5);
      throw new Error(
        `The trace is ${mib(zipped.length)} gzipped, above its ${mib(limit)} bound. Largest tables unpacked: ${sizes.map((t) => `${t.table} ${mib(t.bytes)}`).join(", ")}`,
      );
    }
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
  /** Each recorded finding-chain decision against the current rules (#1959). */
  findingChains: FindingChainBoundary[];
  /** Chain decisions (rewrite or patch, reopen or pass) the current rules make differently. */
  newChainDecisions: number;
  /** Each failing corrective's checks against the corrective's before it (#1996). */
  repeatedFailures: RepeatedFailureBoundary[];
  /** Chains the current rule records a repeated-failure would-stop on that the recording did not. */
  newRepeatStops: number;
  /** Each spec conflict's decision for the request against the current rule (#2016). */
  requestConflicts: RequestConflictBoundary[];
  /** Conflict reports the current rule settles, re-audits or leaves differently than the recording. */
  newConflictDecisions: number;
  /** Each planned task's host apply decision against the current rule (#2023, shadow). */
  hostApply: HostApplyBoundary[];
  /** Tasks whose apply decision (would apply or not) the current rule makes differently. */
  newApplyDecisions: number;
  /** Each misquote settle's host-fix decision against the current rule (#2047). */
  misquoteFixes: MisquoteFixBoundary[];
  /** Misquote settles whose host-fix decision (apply or open a session) the current rule changes. */
  newMisquoteFixes: number;
  /** Each checks-stage restore decision of a prescribed row file against the current rule (#2522). */
  rowRestores: RowRestoreBoundary[];
  /** Rows the current rule restores that the recorded decision did not (#2522). */
  newRowRestores: number;
  /** Each case of a source task's edge-input probe against the current rule (#1808). */
  edgeProbes: EdgeProbeBoundary[];
  /**
   * Probed cases the current rule turns into a finding, or lets pass, unlike the recording, and
   * cases whose shadow crash decision (#2136) differs from the recorded one.
   */
  newEdgeDecisions: number;
  /** Each test-integrity scan's findings against the current rule (#1715). */
  integrity: IntegrityBoundary[];
  /** Integrity findings (rule and path) the current rule reports that the recording did not. */
  newIntegrityFindings: number;
  /** Each task-end case walk's refusals against the current rule (#1715). */
  caseWalks: CaseWalkBoundary[];
  /** Cases the current rule refuses a task for that the recorded walk did not. */
  newCaseRefusals: number;
  /** Each task-end test cap check's files and classes over their cap against the current rule (#2368). */
  testCaps: TestCapBoundary[];
  /** Files or classes the current rule finds over their cap that the recorded check did not. */
  newTestCapRefusals: number;
  /** Each review's gate against the current rule (#1715). */
  reviewGates: ReviewGateBoundary[];
  /** Findings the current rule repairs that the recorded gate kept as notes. */
  newGateRepairs: number;
  /** Each convergence gate against the current rule (#1715). */
  convergenceGates: ConvergenceGateBoundary[];
  /** Convergence findings whose verdict (repair, limitation or note) the current rule changes. */
  newConvergenceVerdicts: number;
  /** Each decision for the request or the platform on checked evidence (#2032). */
  evidenceDecisions: EvidenceDecisionBoundary[];
  /** Findings and conflict reports the current rule settles differently than the recording. */
  newEvidenceDecisions: number;
  /** Each task-level corrective's write-scope precondition against the current rule (#2094). */
  correctiveScopes: CorrectiveScopeBoundary[];
  /** Correctives the current rule refuses for a diagnosed file outside their writes that the recording let run. */
  newScopeStops: number;
  /** Correctives whose named files outside their writes the current rule decides otherwise (#2133). */
  newUnownedDecisions: number;
  /** Each settled conflict's host finish decision against the current rule (#2033). */
  conflictFinishes: ConflictFinishBoundary[];
  /** Settled conflicts the current rule finishes on the host, or not, differently. */
  newConflictFinishes: number;
  /** Each blocked corrective's order decision against the current rule (#2109). */
  correctiveDefers: CorrectiveDeferBoundary[];
  /** Blocked correctives the current rule runs independent work past, or not, differently. */
  newDeferDecisions: number;
  /** Each required check's baseline failure decision against the current rule (#2215). */
  baselineFailures: BaselineFailureBoundary[];
  /** Baseline failures the current rule repairs, would stop on or leaves differently. */
  newBaselineDecisions: number;
  /** Each baseline comparison of a failing required check against the current rule (#2295). */
  baselineSignatures: BaselineSignatureBoundary[];
  /** Baseline comparisons the current rule matches, by either signature, differently. */
  newSignatureDecisions: number;
  /** Each test task's wrong-value failure route against the current rule (#2220). */
  sourceDefects: SourceDefectBoundary[];
  /** Test task failures the current rule routes to the source's task, or not, differently. */
  newSourceDefectRoutes: number;
  /** Each sizing report's active-time cap against the current pace rule (#2336). */
  activeTimes: ActiveTimeBoundary[];
  /** Sizing reports whose active-time cap the current pace sets differently. */
  newActiveTimes: number;
  /**
   * Sizing reports whose recorded cap the clean pace would set differently (#2414, shadow): what
   * making it the default changes; not an accepted-decision count.
   */
  cleanPaceChanges: number;
  /** Each written-tests run whose declared-class filter selected no test (#2363). */
  unselectedTests: UnselectedTestsBoundary[];
  /** Such runs the recording did not record a `written_tests_unselected` would-stop for. */
  newUnselectedStops: number;
  /** Each implementer attempt's green checkpoint against the current would-finish rule (#2470). */
  attemptCheckpoints: AttemptCheckpointBoundary[];
  /** Checkpoints the current rule records a `decision.would_finish` for that the recording did not. */
  newWouldFinishes: number;
  /** Each checks-stage comparison of a test file with its prescribed rows (#2486). */
  rowBlocks: RowBlockBoundary[];
  /** Rows the current rule says drift that the recorded comparison did not. */
  newRowBlockDrifts: number;
  /** File rows the current move rule says are added or duplicated that the recording did not (#2503). */
  newRowBlockMoves: number;
}

export interface RowBlockBoundary {
  path: string;
  mode: RowBlockRecord["mode"];
  /** The drifting rows (from 1), as recorded and as the current rule decides. */
  recorded: number[];
  replayed: number[];
  /** The file rows beyond the block (#2503), as recorded and as the current rule places them; null in records before it. */
  moves: { recorded: RowMoves; replayed: RowMoves } | null;
}

/**
 * Every checks-stage row block comparison a run recorded (`row-blocks/<path>.json`, #2486),
 * decided again from its per-row counts, and its file rows placed again from their matches (#2503).
 * Whether a file holds a literal, and which prescribed rows a file row matches, read text a trace
 * does not keep, so a change to the literal lookup (`verbatimHeld`) or the row matching is covered
 * by the scenario test, not replayed. Traces before #2486 record none; records before #2503 keep
 * no file rows (`moves` null).
 */
export function replayRowBlocks(
  store: WorkflowStore,
  runId: string,
  decide: RowBlockRule = rowBlockDecision,
  move: RowMoveRule = rowMoveDecision,
): RowBlockBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === ROW_BLOCK_KIND && a.logical_path.startsWith(ROW_BLOCK_DIR))
    .flatMap((artifact) => {
      let record: RowBlockRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (record.schemaVersion !== 1) return [];
      return [
        {
          path: record.path,
          mode: record.mode,
          recorded: record.drifting,
          replayed: decide(record.rows),
          moves:
            record.fileRows && record.moves
              ? { recorded: record.moves, replayed: move(record.fileRows) }
              : null,
        },
      ];
    });
}

export interface AttemptCheckpointBoundary {
  attemptId: string;
  taskId: string | null;
  /** How the attempt ended unfinished, from the recorded would-finish or its usage; null when it did not. */
  stoppedBy: UnfinishedEnd | null;
  /** Whether the run recorded the `decision.would_finish`. */
  recorded: boolean;
  replayed: boolean;
}

/** Decides an attempt's would-finish from its checkpoint and how it ended (`checkpointWouldFinish`). */
export type CheckpointRule = typeof checkpointWouldFinish;

/**
 * Every recorded attempt checkpoint (`attempts/<attempt>/checkpoint.json`, #2470) decided again by
 * `rule`, with whether the run recorded the would-finish. The end is the recorded would-finish's
 * (a stall leaves no usage record of it), else the attempt's usage record's cap or watcher stop.
 * Traces before #2470 hold no checkpoint.
 */
export function replayAttemptCheckpoints(
  store: WorkflowStore,
  runId: string,
  rule: CheckpointRule = checkpointWouldFinish,
): AttemptCheckpointBoundary[] {
  const recorded = new Map<string, UnfinishedEnd | null>();
  for (const e of store.eventsOfType(runId, "decision.would_finish"))
    if (e.type === "decision.would_finish") {
      const inputs = e.payload.inputs as { attemptId?: unknown; stoppedBy?: unknown };
      if (typeof inputs.attemptId === "string")
        recorded.set(
          inputs.attemptId,
          typeof inputs.stoppedBy === "string" ? (inputs.stoppedBy as UnfinishedEnd) : null,
        );
    }
  const boundaries: AttemptCheckpointBoundary[] = [];
  for (const attempt of store.attempts(runId)) {
    const row = store.latestArtifact(runId, checkpointPath(attempt.id));
    if (!row) continue;
    const checkpoint = store.readArtifactJson<AttemptCheckpoint>(runId, row);
    const usageRow = store.latestArtifact(runId, `attempts/${attempt.id}/usage.json`);
    const usage = usageRow
      ? store.readArtifactJson<AttemptUsageRecord>(runId, usageRow)
      : undefined;
    const stoppedBy = recorded.get(attempt.id) ?? usageStoppedBy(usage);
    const decision = rule(checkpoint, {
      stoppedBy,
      totalTokens: usage?.totalTokens ?? attempt.used_tokens,
    });
    boundaries.push({
      attemptId: attempt.id,
      taskId: checkpoint.taskId,
      stoppedBy,
      recorded: recorded.has(attempt.id),
      replayed: decision !== null,
    });
  }
  return boundaries;
}

export interface UnselectedTestsBoundary {
  checkId: string;
  command: string;
  declared: string[];
  /** Whether the run recorded the `written_tests_unselected` would-stop for the check. */
  recorded: boolean;
}

/**
 * Every recorded written-tests run that selected the classes its files declare and ran no test
 * (#2363), decided again on the current rule, with whether the run recorded the would-stop. Traces
 * before #2363 hold no check that names its declared classes.
 */
export function replayUnselectedTestRuns(
  store: WorkflowStore,
  runId: string,
): UnselectedTestsBoundary[] {
  const recorded = new Set(
    store
      .eventsOfType(runId, "decision.would_stop")
      .flatMap((e) =>
        e.type === "decision.would_stop" && e.payload.reason === "written_tests_unselected"
          ? [String((e.payload.inputs as { checkId?: unknown } | undefined)?.checkId)]
          : [],
      ),
  );
  return replayUnselectedTests(store, runId).map((decision) => ({
    ...decision,
    recorded: recorded.has(decision.checkId),
  }));
}

export interface ActiveTimeBoundary {
  report: string;
  recorded: { tokensPerMinute: number; basis: PaceBasis; after: number };
  replayed: { tokensPerMinute: number; basis: PaceBasis; after: number };
  /**
   * In shadow (#2414): the cap at the clean pace, from the rates the report recorded beside its
   * pace (`cleanPace`), else from the trace's runs that completed before it (`cleanRates`).
   */
  clean: CleanSizingShadow | null;
}

/** Picks the pace that sizes a run's active time from the history's and the initiative's rates. */
export type ActivePaceRule = (
  history: { tokensPerMinute: number; basis: "history" | "default"; runs: number },
  ownRates: readonly number[],
) => { tokensPerMinute: number; basis: PaceBasis };

/**
 * The tokens per active minute of the other feature runs of the run's initiative that had
 * completed by `at`, for a sizing report recorded before #2336 kept them; empty outside an
 * initiative or in a trace without its tables.
 */
/** The other runs of the run's initiative that had completed by `at`; empty outside one. */
function initiativeRunsAt(store: WorkflowStore, runId: string, at: number): string[] {
  try {
    return (
      store.connection
        .query(
          `SELECT DISTINCT r.id AS id FROM initiative_runs l JOIN runs r ON r.id=l.run_id
         WHERE l.initiative_id IN (SELECT initiative_id FROM initiative_runs WHERE run_id=?) AND l.run_id<>? AND r.status='completed'
         AND (SELECT MAX(e.at) FROM events e WHERE e.run_id=r.id AND e.type='run.state_changed' AND json_extract(e.payload_json,'$.to')='completed')<=?`,
        )
        .all(runId, runId, at) as { id: string }[]
    ).map((r) => r.id);
  } catch {
    return [];
  }
}

function initiativeRatesAt(store: WorkflowStore, runId: string, at: number): number[] {
  try {
    const rows = store.connection
      .query(
        `SELECT DISTINCT r.id AS id, r.token_usage AS tokens, r.active_ms AS ms FROM initiative_runs l JOIN runs r ON r.id=l.run_id
         WHERE l.initiative_id IN (SELECT initiative_id FROM initiative_runs WHERE run_id=?) AND l.run_id<>? AND r.status='completed'
         AND (SELECT MAX(e.at) FROM events e WHERE e.run_id=r.id AND e.type='run.state_changed' AND json_extract(e.payload_json,'$.to')='completed')<=?`,
      )
      .all(runId, runId, at) as { id: string; tokens: number; ms: number }[];
    return rows.flatMap((r) => {
      const pace = runPace(r.tokens, r.ms);
      return pace === null ? [] : [Math.round(pace)];
    });
  } catch {
    return [];
  }
}

/**
 * Every plan and progress sizing report's active-time cap, decided again by `pace` and
 * `activeTimeLimit` from what the report recorded: the tokens it sized (the run's price and repair
 * reserve under the budget), the cap before, the `maxRunTokens` ceiling, the history's pace and the
 * initiative's own rates. A report before #2336 recorded neither the own rates nor the history's
 * pace beside an initiative's; its own rates are read from the trace's runs of the initiative that
 * completed before it, and its recorded pace is the history's.
 */
export function replayActiveTimes(
  store: WorkflowStore,
  runId: string,
  pace: ActivePaceRule = paceOf,
): ActiveTimeBoundary[] {
  const reports = store.connection
    .query(
      "SELECT id, logical_path AS path, created_at AS at FROM artifacts WHERE run_id=? AND (logical_path LIKE 'sizing/plan-%' OR logical_path LIKE 'sizing/progress-%') ORDER BY created_at, id",
    )
    .all(runId) as { id: string; path: string; at: number }[];
  return reports.flatMap(({ id, path, at }) => {
    let report: Partial<SizingReport>;
    try {
      report = JSON.parse(store.readArtifact(runId, id)) as Partial<SizingReport>;
    } catch {
      return [];
    }
    const time = report.activeTime;
    if (
      !time ||
      typeof report.runTokens !== "number" ||
      typeof report.budgetAfter !== "number" ||
      report.maxRunTokens === undefined
    )
      return [];
    const history =
      time.history ??
      (time.basis === "initiative"
        ? null
        : { tokensPerMinute: time.tokensPerMinute, basis: time.basis, runs: time.runs });
    if (!history) return [];
    const chosen = pace(history, time.ownRates ?? initiativeRatesAt(store, runId, at));
    const recordedClean = (report as { cleanPace?: CleanSizingShadow }).cleanPace;
    const clean = cleanSizingShadow(
      report,
      recordedClean
        ? { rates: recordedClean.rates, silentMs: recordedClean.silentMs }
        : cleanRates(store, initiativeRunsAt(store, runId, at)),
    );
    const after = activeTimeLimit({
      neededTokens: Math.min(report.runTokens + (report.repairReserve ?? 0), report.budgetAfter),
      tokensPerMinute: chosen.tokensPerMinute,
      maxActiveMs: time.before,
      maxRunTokens: report.maxRunTokens,
    }).after;
    return [
      {
        report: path,
        recorded: { tokensPerMinute: time.tokensPerMinute, basis: time.basis, after: time.after },
        replayed: { tokensPerMinute: chosen.tokensPerMinute, basis: chosen.basis, after },
        clean,
      },
    ];
  });
}

export interface BaselineFailureBoundary {
  checkId: string;
  findings: number;
  recorded: BaselineFailureDecision;
  replayed: BaselineFailureDecision;
}

/**
 * Every baseline failure decision a run recorded (`baseline-fix/<check>.json`, #2215), decided
 * again from its recorded finding counts, plan and git facts. Traces before #2215 record none.
 */
export function replayBaselineFailures(
  store: WorkflowStore,
  runId: string,
  decide: BaselineFailureRule = baselineFailureDecision,
): BaselineFailureBoundary[] {
  return store
    .artifacts(runId)
    .filter(
      (a) =>
        a.kind === BASELINE_FIX_KIND &&
        !a.logical_path.endsWith("-repair.json") &&
        a.logical_path.endsWith(".json"),
    )
    .flatMap((artifact) => {
      let record: BaselineFailureRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (artifact.logical_path !== baselineFixPath(record.checkId)) return [];
      return [
        {
          checkId: record.checkId,
          findings: record.findings,
          recorded: record.decision,
          replayed: decide({
            fileLocal: record.fileLocal,
            fix: record.fix,
            findings: record.findings,
            complete: record.complete,
            correctable: record.correctable,
            planned: record.planned,
            untracked: record.untracked,
            enabled: record.enabled,
            ...(record.exempt !== undefined ? { exempt: record.exempt } : {}),
          }),
        },
      ];
    });
}

export interface BaselineSignatureBoundary {
  checkId: string;
  at: BaselineSignatureRecord["at"];
  recorded: BaselineSignatureDecision;
  replayed: BaselineSignatureDecision;
}

/**
 * Every baseline comparison a run recorded (`baseline-signature/<check>-<hash>.json`, #2295),
 * decided again from its legacy and shaped signature lines, each a stand-in in a trace, so equal
 * lines stay equal. Traces before #2295 record none.
 */
export function replayBaselineSignatures(
  store: WorkflowStore,
  runId: string,
  decide: BaselineSignatureRule = baselineSignatureDecision,
): BaselineSignatureBoundary[] {
  return store
    .artifacts(runId)
    .filter(
      (a) =>
        a.kind === BASELINE_SIGNATURE_KIND && a.logical_path.startsWith(BASELINE_SIGNATURE_DIR),
    )
    .flatMap((artifact) => {
      let record: BaselineSignatureRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (!record.legacy || !record.shaped) return [];
      return [
        {
          checkId: record.checkId,
          at: record.at,
          recorded: record.decision,
          replayed: decide({ legacy: record.legacy, shaped: record.shaped, subset: record.subset }),
        },
      ];
    });
}

export interface SourceDefectBoundary {
  taskId: string;
  mode: SourceDefectRecord["mode"];
  owners: string[];
  recorded: boolean;
  replayed: boolean;
}

/**
 * Every route decision of a test task's failure a run recorded (`source-defect/tasks/`, #2220),
 * decided again from its recorded counts, owners and files. Traces before #2220 record none.
 */
export function replaySourceDefects(
  store: WorkflowStore,
  runId: string,
  decide: SourceDefectRule = sourceDefectDecision,
): SourceDefectBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === SOURCE_DEFECT_KIND && a.logical_path.startsWith(SOURCE_DEFECT_DIR))
    .flatMap((artifact) => {
      let record: SourceDefectRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      const input = {
        testTask: record.testTask ?? false,
        self: record.self ?? false,
        expected: record.expected ?? 0,
        matched: record.matched ?? 0,
        owners: record.owners ?? [],
        files: record.files ?? [],
      };
      return [
        {
          taskId: record.taskId,
          mode: record.mode,
          owners: input.owners,
          recorded: record.route,
          replayed: decide(input),
        },
      ];
    });
}

export interface CorrectiveDeferBoundary {
  taskId: string;
  mode: CorrectiveDeferRecord["mode"];
  /** The ready tasks the blocked chains did not hold. */
  ready: number;
  recorded: boolean;
  replayed: boolean;
}

/**
 * Every order decision of a blocked corrective a run recorded (`blocks/correctives/`, #2109),
 * decided again from its recorded ready tasks and writers. Traces before #2109 record none.
 */
export function replayCorrectiveDefers(
  store: WorkflowStore,
  runId: string,
  decide: CorrectiveDeferRule = correctiveDeferDecision,
): CorrectiveDeferBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === DEFER_KIND && a.logical_path.startsWith(DEFER_DIR))
    .flatMap((artifact) => {
      let record: CorrectiveDeferRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      const input = { ready: record.ready ?? [], writers: record.writers ?? 1 };
      return [
        {
          taskId: record.taskId,
          mode: record.mode,
          ready: input.ready.length,
          recorded: record.defer,
          replayed: decide(input),
        },
      ];
    });
}

export interface CorrectiveScopeBoundary {
  taskId: string;
  at: "create" | "start" | "result";
  recorded: ScopeDecision;
  replayed: ScopeDecision;
  /** The diagnosed files the current rule finds outside the corrective's writes. */
  missing: string[];
  /** The recorded decision over the named files outside the writes (#2133); null before it. */
  unownedRecorded: UnownedDecision | "fits" | null;
  /** The current rule's decision over the same recorded inputs. */
  unownedReplayed: UnownedDecision | "fits" | null;
}

/**
 * Every write-scope precondition of a task-level corrective a run recorded (`scope/tasks/`,
 * #2094), decided again from its recorded diagnosed files and writes, and the host's decision
 * over the files a corrective's evidence names outside its writes from each path's recorded
 * owner, writers, feature and approval (#2133). Traces before #2094 record none, and records
 * before #2133 no named files.
 */
export function replayCorrectiveScopes(
  store: WorkflowStore,
  runId: string,
  rule: ScopeRule = missingDiagnosed,
  unowned: UnownedRule = unownedRule,
): CorrectiveScopeBoundary[] {
  return scopeRecords(store, runId).map((record) => {
    const missing = rule(record.diagnosed ?? [], record.writes ?? []);
    const paths = record.unowned?.map((p) => ({
      decision: unowned({
        path: p.path,
        owner: p.owner ?? null,
        openWriters: p.openWriters ?? [],
        feature: p.feature ?? null,
        allowed: p.allowed === true,
        ...(p.upstream ? { upstream: p.upstream } : {}),
      }),
    }));
    return {
      taskId: record.taskId,
      at: record.at,
      recorded: record.decision,
      replayed: missing.length ? "refuse" : "fits",
      missing,
      unownedRecorded: record.host ?? null,
      unownedReplayed: paths ? hostDecision(paths) : null,
    };
  });
}

export interface ConflictFinishBoundary {
  taskId: string;
  branch: ConflictFinishBranch;
  mode: ConflictFinishRecord["mode"];
  /** The tree was ready for the checks: edits, intact rows, no open case. */
  ready: boolean;
  recorded: boolean;
  replayed: boolean;
}

/**
 * Every host finish decision of a settled conflict a run recorded (`conflicts/finish/`, #2033),
 * decided again from its recorded counts and check statuses. A shadow record ran no checks, so
 * it finishes under no rule that needs one; `ready` says whether `on` would have run them.
 * Traces before #2033 record none.
 */
export function replayConflictFinishes(
  store: WorkflowStore,
  runId: string,
  decide: ConflictFinishRule = conflictFinishDecision,
): ConflictFinishBoundary[] {
  return store
    .artifacts(runId)
    .filter(
      (a) => a.kind === CONFLICT_FINISH_KIND && a.logical_path.startsWith(CONFLICT_FINISH_DIR),
    )
    .flatMap((artifact) => {
      let record: ConflictFinishRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      const input = {
        branch: record.branch,
        edits: record.edits ?? 0,
        rows: record.rows ?? null,
        cases: record.cases ?? 0,
        overruled: record.overruled ?? 0,
        checks: record.checks ?? null,
      };
      return [
        {
          taskId: record.taskId,
          branch: record.branch,
          mode: record.mode,
          ready: conflictFinishReady(input),
          recorded: record.finish,
          replayed: decide(input),
        },
      ];
    });
}

export interface EvidenceDecisionBoundary {
  site: EvidenceSite;
  ref: string;
  report: number;
  recorded: boolean;
  replayed: boolean;
}

/**
 * Every decision a run made for the request or the platform on checked evidence
 * (`conflicts/evidence/`, #2032), decided again from its recorded inputs: eligibility, the
 * evidence state, whether the wording rule matched and whether its fallback applied. Traces before
 * #2032 record none.
 */
export function replayEvidenceDecisions(
  store: WorkflowStore,
  runId: string,
  decide: EvidenceRule = evidenceDecision,
): EvidenceDecisionBoundary[] {
  return store
    .artifacts(runId)
    .filter(
      (a) => a.kind === EVIDENCE_DECISION_KIND && a.logical_path.startsWith(EVIDENCE_DECISIONS_DIR),
    )
    .flatMap((artifact) => {
      let record: EvidenceRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      const replayed = decide({
        site: record.site,
        eligible: record.eligible ?? false,
        evidence: record.evidence ?? "absent",
        wording: record.wording ?? false,
        fallback: record.fallback ?? false,
      });
      return [
        {
          site: record.site,
          ref: record.ref,
          report: record.report,
          recorded: record.decision,
          replayed,
        },
      ];
    });
}

export type ConvergenceGateRule = (gate: ConvergenceGate) => ConvergenceDecision;

export interface ConvergenceGateBoundary {
  /** Each finding's verdict, as recorded and as the current rule decides. */
  recorded: ConvergenceDecision["verdicts"];
  replayed: ConvergenceDecision["verdicts"];
  /** The criteria left failing, as recorded and as the current rule decides. */
  recordedFailing: string[];
  replayedFailing: string[];
}

/**
 * Every convergence gate a run recorded (`convergence-gate/`, #1715), decided again from each
 * finding's labels and repro outcome, whether it is on a test or documentation file and the
 * criteria it names, each criterion's verdict and evidence count, and whether the required checks
 * passed. As for the review gate, a repro ran only for the recorded candidates. Traces before #1715
 * record none.
 */
export function replayConvergenceGates(
  store: WorkflowStore,
  runId: string,
  decide: ConvergenceGateRule = convergenceGateDecision,
): ConvergenceGateBoundary[] {
  return store
    .artifacts(runId)
    .filter(
      (a) => a.kind === CONVERGENCE_GATE_KIND && a.logical_path.startsWith(CONVERGENCE_GATE_DIR),
    )
    .flatMap((artifact) => {
      let record: ConvergenceGateRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (record.schemaVersion !== 1) return [];
      const replayed = decide(record);
      return [
        {
          recorded: record.decision.verdicts,
          replayed: replayed.verdicts,
          recordedFailing: record.decision.failing,
          replayedFailing: replayed.failing,
        },
      ];
    });
}

export type ReviewGateRule = (gate: ReviewGate) => string[];

export interface ReviewGateBoundary {
  reviewer: string;
  findings: number;
  /** IDs of the findings that start a correction, as recorded and as the current rule decides. */
  recorded: string[];
  replayed: string[];
}

/**
 * Every review gate a run recorded (`review-gate/`, #1715), decided again from each finding's
 * severity, kind, basis, confidence, sibling note and repro outcome, and the round's repaired
 * severities. A repro runs only for a finding the recorded gate made a candidate, so a rule that
 * makes another one a candidate replays it without an outcome. Traces before #1715 record none.
 */
export function replayReviewGates(
  store: WorkflowStore,
  runId: string,
  decide: ReviewGateRule = reviewGateDecision,
): ReviewGateBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === REVIEW_GATE_KIND && a.logical_path.startsWith(REVIEW_GATE_DIR))
    .flatMap((artifact) => {
      let record: ReviewGateRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (record.schemaVersion !== 1) return [];
      return [
        {
          reviewer: record.reviewer,
          findings: record.findings.length,
          recorded: record.repaired,
          replayed: decide(record),
        },
      ];
    });
}

export type CaseWalkRule = (walk: CaseWalk) => number[];

export interface CaseWalkBoundary {
  taskId: string;
  cases: number;
  /** `criterion#index` of each refused case, as recorded and as the current rule decides. */
  recorded: string[];
  replayed: string[];
}

/**
 * Every task-end case walk a run recorded (`case-walk/tasks/`, #1715), decided again from what
 * held each case: the task's own test files, the host's intact rows, a sibling task's files. The
 * matching itself reads test code and case literals a trace does not keep, so a change to how a
 * file holds a case is not replayed, only which unheld cases refuse the task. Traces before #1715
 * record none.
 */
export function replayCaseWalks(
  store: WorkflowStore,
  runId: string,
  decide: CaseWalkRule = caseWalkDecision,
): CaseWalkBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === CASE_WALK_KIND && a.logical_path.startsWith(CASE_WALK_DIR))
    .flatMap((artifact) => {
      let record: CaseWalkRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (record.schemaVersion !== 1) return [];
      const key = (i: number) => `${record.cases[i]?.criterionId ?? "?"}#${i}`;
      // The walk's `generated_case` would-stop (#2344), on the generated values it recorded.
      const generated = (stop: boolean | undefined) => (stop ? ["generated_case"] : []);
      return [
        {
          taskId: record.taskId,
          cases: record.cases.length,
          recorded: [...record.refused.map(key), ...generated(record.generatedStop)],
          replayed: [
            ...decide(record).map(key),
            ...generated(record.generated && generatedCaseDecision(record)),
          ],
        },
      ];
    });
}

export type TestCapRule = (measures: readonly TestCapMeasure[]) => number[];

export interface TestCapBoundary {
  taskId: string;
  mode: TestCapRecord["mode"];
  /** `path#scope#unit` of each count over its cap, as recorded and as the current rule decides. */
  recorded: string[];
  replayed: string[];
}

/**
 * Every task-end test cap check a run recorded (`test-cap/tasks/`, #2368), decided again from its
 * recorded counts. The counting reads code a trace does not keep, so a change to
 * `TEST_DECLARATIONS` is not replayed, only which counts are over their cap. Traces before #2368
 * record none.
 */
export function replayTestCaps(
  store: WorkflowStore,
  runId: string,
  decide: TestCapRule = testCapDecision,
): TestCapBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === TEST_CAP_KIND && a.logical_path.startsWith(TEST_CAP_DIR))
    .flatMap((artifact) => {
      let record: TestCapRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (record.schemaVersion !== 1) return [];
      const key = (i: number) => {
        const m = record.measures[i];
        return m ? `${m.path}#${m.scope}${m.unit === undefined ? "" : `#${String(m.unit)}`}` : "?";
      };
      return [
        {
          taskId: record.taskId,
          mode: record.mode,
          recorded: record.refused.map(key),
          replayed: decide(record.measures).map(key),
        },
      ];
    });
}

export type IntegrityRule = (
  measures: readonly IntegrityMeasure[],
) => { rule: string; path: string }[];

export interface IntegrityBoundary {
  scope: IntegrityRecord["scope"];
  taskId: string | null;
  mode: IntegrityRecord["mode"];
  /** `rule path` of each finding, as recorded and as the current rule decides. */
  recorded: string[];
  replayed: string[];
}

/**
 * Every test-integrity scan a run recorded (`integrity/decisions/`, #1715), decided again from its
 * recorded measures: each changed file's test, assertion, skip, suppression and bypass counts and
 * the exemptions that applied (a reasoned write, a requested removal, a rewrite or strengthen
 * finding). The counting itself reads code a trace does not keep, so a change to how a rule counts
 * is not replayed, only what the rules decide from the counts. Traces before #1715 record none.
 */
export function replayIntegrity(
  store: WorkflowStore,
  runId: string,
  decide: IntegrityRule = integrityDecision,
): IntegrityBoundary[] {
  const key = (f: { rule: string; path: string }) => `${f.rule} ${f.path}`;
  return store
    .artifacts(runId)
    .filter((a) => a.kind === INTEGRITY_KIND && a.logical_path.startsWith(INTEGRITY_DIR))
    .flatMap((artifact) => {
      let record: IntegrityRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (record.schemaVersion !== 1) return [];
      return [
        {
          scope: record.scope,
          taskId: record.taskId,
          mode: record.mode,
          recorded: [...new Set(record.findings.map(key))],
          replayed: [...new Set(decide(record.measures).map(key))],
        },
      ];
    });
}

export interface MisquoteFixBoundary {
  taskId: string;
  mode: MisquoteFixRecord["mode"];
  recorded: boolean;
  replayed: boolean;
  /** Why the current rule opens a session; null when it would apply the replacement. */
  reason: string | null;
  /** The checks on the host's edit as recorded; null when the host did not edit. */
  checks: MisquoteFixRecord["checks"];
}

/**
 * Every misquote host-fix decision a run recorded (`conflicts/misquote/`, #2047), decided again
 * from its recorded sites: occurrence counts and spelling flags. Traces before #2047 record none.
 */
export function replayMisquoteFixes(
  store: WorkflowStore,
  runId: string,
  decide: MisquoteFixRule = misquoteFixDecision,
): MisquoteFixBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === MISQUOTE_FIX_KIND && a.logical_path.startsWith(MISQUOTE_FIX_DIR))
    .flatMap((artifact) => {
      let record: MisquoteFixRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      const verdict = decide(record.sites ?? []);
      return [
        {
          taskId: record.taskId,
          mode: record.mode,
          recorded: record.apply,
          replayed: verdict.apply,
          reason: verdict.reason,
          checks: record.checks ?? null,
        },
      ];
    });
}

export interface RowRestoreBoundary {
  path: string;
  /**
   * Where the restore was decided: `checks`, the checks stage (records without `at`); `task-end`,
   * a row-file task's end (#2529, with `task` and any best-of-N `candidate`); `resume`, `drive`
   * and `task` as #2543 records them.
   */
  at: NonNullable<RowRestoreRecord["at"]> | "checks";
  /** The task whose end or session start recorded it; null at the checks stage and on resume. */
  task: string | null;
  candidate: number | null;
  mode: RowRestoreRecord["mode"];
  /** The rows the run restored (or would have, in shadow), and those the current rule restores. */
  recorded: number[];
  replayed: number[];
  verdict: RowRestoreRecord["verdict"];
}

/**
 * Every row restore decision a run recorded (`row-restores/<path>.json`, #2522), decided again
 * from its sites' flags, keyed by where it was decided (`at`: the checks stage, a task's end,
 * #2529, or the sites of #2543). Whether a restored file holds the row reads text a trace
 * does not keep, so a change to that is covered by `tests/workflow-scenario-row-restore.test.ts`.
 * Traces before #2522 record none.
 */
export function replayRowRestores(
  store: WorkflowStore,
  runId: string,
  decide: RowRestoreRule = rowRestoreDecision,
): RowRestoreBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === ROW_RESTORE_KIND && a.logical_path.startsWith(ROW_RESTORE_DIR))
    .flatMap((artifact) => {
      let record: RowRestoreRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      if (record.schemaVersion !== 1) return [];
      return [
        {
          path: record.path,
          at: record.at ?? "checks",
          task:
            record.at === "task" || record.at === "task-end" ? (record.blocked?.[0] ?? null) : null,
          candidate: record.candidate ?? null,
          mode: record.mode,
          recorded: record.restore,
          replayed: decide(record.sites),
          verdict: record.verdict,
        },
      ];
    });
}

export interface EdgeProbeBoundary {
  /** The probe record's path and the case's number. */
  key: string;
  criterionId: string;
  recorded: "finding" | "pass";
  replayed: "finding" | "pass";
  /**
   * The shadow crash decision (#2136) as recorded and on the recorded output's tail; null on a
   * record from before #2136, which kept no output.
   */
  crashRecorded: "finding" | "pass" | null;
  crashReplayed: "finding" | "pass" | null;
}

/** Each case of one edge probe record, decided again (#1808) and its crash decision (#2136). */
export function replayEdgeRecord(
  path: string,
  record: EdgeRecord,
  decide: EdgeRule = edgeDecision,
  crash: EdgeCrashRule = edgeCrashDecision,
): EdgeProbeBoundary[] {
  return (record.cases ?? []).map((c, index) => ({
    key: `${path}#${String(index + 1)}`,
    criterionId: c.criterionId,
    recorded: c.decision,
    replayed: decide(c.status),
    crashRecorded: c.crash ?? null,
    crashReplayed:
      c.outputTail === undefined
        ? null
        : crash(c.status, c.outputTail, record.files ?? []).decision,
  }));
}

/**
 * Every case of every edge-input probe a run recorded (`probes/edge/`, #1808), decided again from
 * its recorded outcome, and its crash decision from its output's tail (#2136). Traces from before
 * #1808 record none; traces from before #2136 keep no output, so their crash decisions are null.
 */
export function replayEdgeProbes(
  store: WorkflowStore,
  runId: string,
  decide: EdgeRule = edgeDecision,
  crash: EdgeCrashRule = edgeCrashDecision,
): EdgeProbeBoundary[] {
  return store
    .artifacts(runId)
    .filter((a) => a.kind === EDGE_KIND && a.logical_path.startsWith(EDGE_DIR))
    .flatMap((artifact) => {
      let record: EdgeRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      return replayEdgeRecord(artifact.logical_path, record, decide, crash);
    });
}

export interface HostApplyBoundary {
  taskId: string;
  recorded: boolean;
  replayed: boolean;
  /** Why the current rule would start an implementer; null when it would apply. */
  reason: string | null;
}

/**
 * Every host apply decision a run recorded (`host-apply/tasks/`, #2023), decided again from its
 * recorded writes: each write's supplied blocks, whether it exists and whether its diff applied.
 * Traces before #2023 record none.
 */
export function replayHostApply(
  store: WorkflowStore,
  runId: string,
  decide: HostApplyRule = hostApplyDecision,
): HostApplyBoundary[] {
  return hostApplyRecords(store, runId).map((record) => {
    const verdict = decide(record.writes ?? []);
    return {
      taskId: record.taskId,
      recorded: record.wouldApply,
      replayed: verdict.wouldApply,
      reason: verdict.reason,
    };
  });
}

export interface RequestConflictBoundary {
  taskId: string;
  /** The task's how-manieth conflict report, from 1. */
  report: number;
  recorded: RequestConflictDecision;
  replayed: RequestConflictDecision;
}

/**
 * Every spec conflict decision for the request a run recorded (`conflicts/request/`, #2016),
 * decided again from its recorded inputs: the checked sides, the foreign tests, the cited criteria
 * and the re-audit's verdicts. A record whose re-audit ran is decided on those verdicts, so a
 * rule that would not have asked the re-audit replays its first answer. Traces before #2016
 * record none.
 */
export function replayRequestConflicts(
  store: WorkflowStore,
  runId: string,
  decide: RequestConflictRule = requestConflictDecision,
): RequestConflictBoundary[] {
  return store
    .artifacts(runId)
    .filter(
      (a) => a.kind === REQUEST_CONFLICT_KIND && a.logical_path.startsWith(REQUEST_CONFLICTS_DIR),
    )
    .flatMap((artifact) => {
      let record: RequestConflictRecord;
      try {
        record = JSON.parse(store.readArtifact(runId, artifact.id));
      } catch {
        return [];
      }
      const input = {
        sides: record.sides ?? [],
        foreignTests: record.foreignTests ?? 0,
        criterionIds: record.criterionIds ?? [],
        reaudit: record.reaudit ?? null,
        reauditedBefore: record.reauditedBefore ?? false,
      };
      // The re-audit is a step of the decision: with its verdicts recorded, ask the rule with them.
      const first = decide({ ...input, reaudit: null });
      const replayed = first === "reaudit" && input.reaudit !== null ? decide(input) : first;
      return [
        { taskId: record.taskId, report: record.report, recorded: record.decision, replayed },
      ];
    });
}

export interface RepeatedFailureBoundary {
  taskId: string;
  /**
   * The corrective whose failure this one was compared with, or null; for a task's unfinished end
   * (#2437), the task itself when its previous unfinished end was compared.
   */
  previous: string | null;
  /** The first task of the chain, or `task-<id>` for a task's unfinished ends; each records one would-stop. */
  root: string;
  /** What the run recorded; null for a run from before #1996, decided from its findings. */
  recorded: RepeatDecision | null;
  replayed: RepeatDecision;
  /** `record`: the `repeats/tasks/` records; `findings`: the stood-in check findings. */
  source: "record" | "findings";
  /**
   * `invalid-output`: an `invalid_output` stop's repeat decision (`repeats/invalid-output/`,
   * #2520), keyed by its diagnostic in `taskId`, with the key it was compared with in `previous`;
   * absent for a task's record.
   */
  kind?: "invalid-output";
  /** A repeated unfinished end's remedies: those its block offered, and those replayed (#2520). */
  remedies?: { recorded: string[]; replayed: string[] };
}

/**
 * The failing checks of each task-level corrective of a run recorded before `repeats/` existed,
 * from its check findings (the findings `repairPredecessors` gives the corrective, without a
 * review's `basis`): each finding's stood-in impact (its failing lines) and file. The claim names
 * the task, so it is left out, and with it the check id: two checks failing with the same lines
 * on the same file count as one. Traces before #1981 keep no finding bodies and give none.
 */
function findingRounds(
  store: WorkflowStore,
  runId: string,
): { taskId: string; corrected: string | null; checks: RepeatCheck[] }[] {
  const artifact = store.latestArtifact(runId, "internal/state.json");
  if (!artifact) return [];
  let state: {
    graph?: { tasks?: { id: string; origin: string; findingIds: string[] }[] } | null;
    repairPredecessors?: Record<string, string>;
  };
  try {
    state = JSON.parse(store.readArtifact(runId, artifact.id));
  } catch {
    return [];
  }
  const predecessors = state.repairPredecessors ?? {};
  const bodies = new Map(
    store.findings(runId).map((row) => {
      try {
        return [row.id, JSON.parse(row.body_json) as Record<string, unknown>] as const;
      } catch {
        return [row.id, {}] as const;
      }
    }),
  );
  return (state.graph?.tasks ?? []).flatMap((task) => {
    if (task.origin !== "repair") return [];
    const checks = [...bodies].flatMap(([id, body]): RepeatCheck[] =>
      predecessors[id] === task.id &&
      body.basis === undefined &&
      typeof body.impact === "string" &&
      Array.isArray(body.evidenceIds) &&
      body.evidenceIds.length > 0
        ? [{ id: "", text: body.impact, files: typeof body.file === "string" ? [body.file] : [] }]
        : [],
    );
    if (!checks.length) return [];
    const corrected = task.findingIds.map((id) => predecessors[id]).find(Boolean) ?? null;
    return [{ taskId: task.id, corrected, checks }];
  });
}

/**
 * Every failing corrective's required checks a run recorded (`repeats/tasks/`, #1996), decided
 * again against the record of the corrective it corrects. A trace keeps each check's normalized
 * output as a stand-in, and equal outputs get equal stand-ins, so a repeat replays as a repeat.
 * A run recorded before #1996 has no records: its correctives are decided from their check
 * findings (`findingRounds`), with nothing recorded to compare.
 */
export function replayRepeatedFailures(
  store: WorkflowStore,
  runId: string,
  decide: RepeatRule = repeatedFailureDecision,
): RepeatedFailureBoundary[] {
  // A corrective's record (one per task) and a task's unfinished ends (#2437, the latest per task,
  // each decided against the end before it) are kept apart: neither is the other's round.
  const records = new Map<string, RepeatRecord>();
  const unfinished = new Map<string, RepeatRecord>();
  const boundaries = new Map<string, RepeatedFailureBoundary>();
  for (const artifact of store.artifacts(runId)) {
    if (artifact.kind !== REPEAT_KIND || !artifact.logical_path.startsWith(REPEAT_TASKS_DIR))
      continue;
    let record: RepeatRecord;
    try {
      record = JSON.parse(store.readArtifact(runId, artifact.id)) as RepeatRecord;
    } catch {
      continue;
    }
    const end = record.end === "unfinished";
    const previous = record.previous
      ? (end ? unfinished : records).get(record.previous)?.checks
      : undefined;
    (end ? unfinished : records).set(record.taskId, record);
    boundaries.set(`${end ? "unfinished" : "chain"} ${record.taskId}`, {
      taskId: record.taskId,
      previous: record.previous,
      root: end ? `task-${record.taskId}` : record.root,
      recorded: record.decision,
      replayed: decide(previous ?? null, record.checks),
      source: "record" as const,
      ...(end && record.remedies
        ? {
            remedies: {
              recorded: record.remedies,
              replayed: unfinishedRepeatRemedies(record.ends ?? 2),
            },
          }
        : {}),
    });
  }
  const stops = replayInvalidOutputRepeats(store, runId);
  if (boundaries.size) return [...boundaries.values(), ...stops];
  const rounds = new Map<string, { checks: RepeatCheck[]; root: string }>();
  const found = findingRounds(store, runId).map((round): RepeatedFailureBoundary => {
    const previous = round.corrected ? rounds.get(round.corrected) : undefined;
    const root = previous?.root ?? round.corrected ?? round.taskId;
    rounds.set(round.taskId, { checks: round.checks, root });
    return {
      taskId: round.taskId,
      previous: previous ? (round.corrected ?? null) : null,
      root,
      recorded: null,
      replayed: decide(previous?.checks ?? null, round.checks),
      source: "findings" as const,
    };
  });
  return [...found, ...stops];
}

/**
 * Each `invalid_output` stop's repeat decision (`repeats/invalid-output/`, #2520), decided again
 * from its recorded inputs: the refused writes, the diagnostic's hash, the run inputs, whether the
 * prompt held the note and the key the last resume recorded. Traces from before #2520 have none.
 */
function replayInvalidOutputRepeats(
  store: WorkflowStore,
  runId: string,
): RepeatedFailureBoundary[] {
  return store.artifacts(runId).flatMap((artifact): RepeatedFailureBoundary[] => {
    if (
      artifact.kind !== REPEAT_KIND ||
      !artifact.logical_path.startsWith(INVALID_OUTPUT_REPEATS_DIR)
    )
      return [];
    try {
      const record = JSON.parse(store.readArtifact(runId, artifact.id)) as InvalidOutputRecord;
      return [
        {
          taskId: record.diagnosticId,
          previous: record.previous,
          root: "invalid-output",
          recorded: record.decision,
          replayed: invalidOutputDecision(record),
          source: "record",
          kind: "invalid-output",
        },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * Chains where the replay records a would-stop the run did not: one per chain, as the run does.
 * An `invalid_output` stop's repeat decision is no would-stop and is left out.
 */
export function newRepeatStops(boundaries: readonly RepeatedFailureBoundary[]): number {
  const chains = boundaries.filter((b) => b.kind === undefined);
  const recorded = new Set(chains.filter((b) => b.recorded === "repeat").map((b) => b.root));
  return new Set(
    chains.filter((b) => b.replayed === "repeat" && !recorded.has(b.root)).map((b) => b.root),
  ).size;
}

export interface FindingChainBoundary {
  /**
   * The corrective task of a rewrite decision, the battery record's path, or a probed case's.
   * `crash` is a battery or sibling-probe case's shadow crash decision (#2136). `rewrite_repeat`
   * is a symbol rewrite's count of earlier rewrites (#2568): `none`, `probe` or `ask`, keyed
   * `<task>#rewrites`.
   */
  key: string;
  kind: "rewrite" | "rewrite_repeat" | "battery" | "family" | "crash" | "site";
  recorded: string;
  replayed: string;
}

/**
 * Every finding-chain decision a run recorded (#1959), decided again from its recorded inputs: a
 * corrective's rewrite from its chain's length and the run's policy (`chains/tasks/`), a
 * battery's reopen from its cases' outcomes (`chains/battery/`), and whether each case of a
 * rewrite's sibling probe joined its battery (`chains/family/`, #1969). Traces from before #1959
 * record none.
 */
export function replayFindingChains(
  store: WorkflowStore,
  runId: string,
  rules: {
    chain?: ChainRule;
    battery?: BatteryRule;
    family?: FamilyRule;
    rewriteRepeat?: RewriteRepeatRule;
  } = {},
): FindingChainBoundary[] {
  const decideChain = rules.chain ?? chainRewriteDecision;
  const decideRepeat = rules.rewriteRepeat ?? rewriteRepeatDecision;
  const decideBattery = rules.battery ?? batteryDecision;
  const decideFamily = rules.family ?? familyDecision;
  return store.artifacts(runId).flatMap((artifact): FindingChainBoundary[] => {
    if (artifact.kind !== CHAIN_KIND) return [];
    try {
      if (artifact.logical_path.startsWith(CHAIN_TASKS_DIR)) {
        const record = JSON.parse(store.readArtifact(runId, artifact.id)) as ChainRecord;
        return [
          {
            key: record.taskId,
            kind: "rewrite",
            recorded: record.decision,
            replayed: decideChain(record.length, record.policy),
          },
          // A symbol rewrite's count of earlier rewrites (#2568); records before it have none.
          ...(rewritesSymbol(record) && record.rewrites !== undefined
            ? [
                {
                  key: `${record.taskId}#rewrites`,
                  kind: "rewrite_repeat" as const,
                  recorded: record.repeat ?? "none",
                  replayed: decideRepeat(record.rewrites),
                },
              ]
            : []),
        ];
      }
      // A case's shadow crash decision (#2136), on its recorded output's tail and the chain's file.
      const crashes = (
        cases: readonly (CaseCrash & { status: ReproOutcome["status"] })[],
        file: (index: number) => string | null,
      ): FindingChainBoundary[] =>
        cases.flatMap((c, index) =>
          c.outputTail === undefined || c.crash === undefined
            ? []
            : [
                {
                  key: `${artifact.logical_path}#${String(index + 1)}`,
                  kind: "crash" as const,
                  recorded: c.crash,
                  replayed: edgeCrashDecision(
                    c.status,
                    c.outputTail,
                    [file(index)].filter((f): f is string => Boolean(f)),
                  ).decision,
                },
              ],
        );
      if (artifact.logical_path.startsWith(CHAIN_BATTERY_DIR)) {
        const record = JSON.parse(store.readArtifact(runId, artifact.id)) as BatteryRecord;
        return [
          {
            key: artifact.logical_path,
            kind: "battery",
            recorded: record.decision,
            replayed: decideBattery(record.cases.map((c) => c.status)),
          },
          ...crashes(record.cases, (index) => record.cases[index]?.file ?? null),
        ];
      }
      // A family site's check (#2343), on the lines it read; a missing file read none.
      if (artifact.logical_path.startsWith(CHAIN_SITES_DIR)) {
        const record = JSON.parse(store.readArtifact(runId, artifact.id)) as SitesRecord;
        return record.sites.flatMap((site, index) => {
          if (site.verdict === "no_file") return [];
          const { verdict } = siteDecision(site.text, site.line, site.window);
          return [
            {
              key: `${artifact.logical_path}#${String(index + 1)}`,
              kind: "site" as const,
              recorded: site.verdict,
              replayed:
                verdict === "kept" && site.verdict === "unwritable" ? site.verdict : verdict,
            },
          ];
        });
      }
      if (artifact.logical_path.startsWith(CHAIN_FAMILY_DIR)) {
        const record = JSON.parse(store.readArtifact(runId, artifact.id)) as FamilyRecord;
        return [
          ...record.cases.map((c, index) => ({
            key: `${artifact.logical_path}#${String(index + 1)}`,
            kind: "family" as const,
            recorded: c.decision,
            replayed: decideFamily(c.status),
          })),
          ...crashes(record.cases, () => record.file),
        ];
      }
    } catch {
      return [];
    }
    return [];
  });
}

/** One finding of a run, with the chain its corrective would get under a chain-rewrite policy. */
export interface ChainEscalation {
  findingId: string;
  /** The corrective task the run gave the finding, or null. */
  taskId: string | null;
  /** The finding's chain on its file and symbol or family, oldest first, as recorded so far. */
  chain: string[];
  /** The finding's family, the second half of the chain key (#2048); null when it names none. */
  family: string | null;
  decision: "rewrite" | "patch";
  /** The findings whose repros a rewrite's battery holds, oldest first; empty for a patch. */
  battery: string[];
  /**
   * The earlier rewrites of the step's symbol or family (#2568): steps before it whose finding
   * the run gave a corrective and which the policy rewrote.
   */
  rewrites: number;
  /** What the count decides for a rewrite: `probe` at the second, `ask` after two; else `none`. */
  repeat: "none" | "probe" | "ask";
}

export interface ChainEscalationReplay {
  runId: string;
  steps: ChainEscalation[];
  /**
   * Findings the trace holds no body for, so no step is decided on them and a chain that links to
   * one ends there. Traces before #1981 kept no finding bodies; their review findings are read
   * from the run state's last two reviews, and convergence findings are lost.
   */
  missingBodies: string[];
}

/** The review findings the run states of a trace still hold, by id (`reviews`, `priorReviews`). */
function stateFindings(store: WorkflowStore, runId: string): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  const walk = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      for (const item of value)
        if (
          key === "findings" &&
          item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string" &&
          "claim" in item
        )
          found.set((item as { id: string }).id, item as Record<string, unknown>);
        else walk(item, key);
    } else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  for (const artifact of store.artifacts(runId))
    if (artifact.kind === "state")
      try {
        const state = JSON.parse(store.readArtifact(runId, artifact.id)) as Record<string, unknown>;
        walk({ reviews: state.reviews, priorReviews: state.priorReviews }, "");
      } catch {}
  return found;
}

/**
 * What a chain-rewrite policy (`policy`, `on` unless given) would have decided for each finding a
 * run recorded (#1981): in recorded order, the finding's `repeatOf` chain among the findings
 * recorded until then, the rewrite or patch its corrective gets, and the battery a rewrite holds.
 * It reads finding bodies, so it answers for runs recorded before `chains/` records existed or
 * with the policy off.
 */
export function replayChainEscalation(
  store: WorkflowStore,
  runId: string,
  options: {
    policy?: "on" | "off";
    decide?: ChainRule;
    /**
     * Families to read for findings by id in place of the recorded ones (#2048): what a reviewer
     * that declares families would have said on a run recorded before the field existed.
     */
    families?: Readonly<Record<string, string | null>>;
    /** Decides each step's count of earlier rewrites (#2568); the current rule by default. */
    rewriteRepeat?: RewriteRepeatRule;
  } = {},
): ChainEscalationReplay {
  const policy = options.policy ?? "on";
  const decide = options.decide ?? chainRewriteDecision;
  const rows = store.findings(runId);
  const fromState = stateFindings(store, runId);
  const missing = new Set<string>();
  const extra: (Record<string, unknown> & { id: string })[] = [];
  for (const row of rows) {
    const body = JSON.parse(row.body_json) as Record<string, unknown>;
    if (Object.keys(body).length) continue;
    const recovered = fromState.get(row.id);
    if (recovered) extra.push({ ...recovered, id: row.id });
    else missing.add(row.id);
  }
  const all = chainFindings(store, runId, extra);
  for (const [id, family] of Object.entries(options.families ?? {})) {
    const finding = all.get(id);
    if (finding) all.set(id, { ...finding, family: familyKey(family) });
  }
  const steps: ChainEscalation[] = [];
  const known = new Map<string, ChainFinding>();
  // The rewrites decided so far, for each step's count of earlier rewrites (#2568).
  const rewrites: ChainRecord[] = [];
  for (const row of rows) {
    const finding = all.get(row.id);
    if (!finding || missing.has(row.id)) continue;
    known.set(row.id, finding);
    const chain = findingChain(known, finding);
    const decision = decide(chain.length, policy);
    const record =
      chain.length >= CHAIN_REWRITE_AT
        ? withRewrites(
            chainRecord(row.repair_task_id ?? "", finding, chain, policy, decide),
            rewrites,
            options.rewriteRepeat,
          )
        : null;
    const battery =
      decision === "rewrite" && record ? batteryOf(known, record).map((f) => f.id) : [];
    // Only a finding the run gave a corrective counts as a rewrite for the later ones.
    if (record && rewritesSymbol(record) && row.repair_task_id) rewrites.push(record);
    steps.push({
      findingId: row.id,
      taskId: row.repair_task_id,
      chain: chain.map((f) => f.id),
      family: finding.family,
      decision,
      battery,
      rewrites: record?.rewrites ?? 0,
      repeat: record?.repeat ?? "none",
    });
  }
  return { runId, steps, missingBodies: [...missing] };
}

/** One finding chain a run recorded under `chains/`, with what its correctives and battery did. */
export interface ChainCost {
  file: string | null;
  /** Every file of a chain across files (#2334), oldest first. */
  files?: string[];
  symbol: string;
  /** The chain's family (#2048), which keys it with the file in place of the symbol; or null. */
  family: string | null;
  /** The longest chain a corrective's record names, and its finding ids. */
  length: number;
  findings: string[];
  /** Each corrective of the chain's findings: the record's decision (a patch without one). */
  tasks: {
    taskId: string;
    decision: "rewrite" | "patch";
    tokens: number;
    costUsd: number | null;
  }[];
  /** Battery runs that held a case of the chain, their cases and outcomes, and reopens. */
  battery: {
    runs: number;
    cases: number;
    reproduced: number;
    refuted: number;
    inconclusive: number;
    reopened: number;
  };
  /** What the chain's correctives used: tokens, and dollars when every attempt has a price. */
  tokens: number;
  costUsd: number | null;
}

/**
 * The finding chains a run recorded (`chains/tasks/`, `chains/battery/`, #1959) for the round
 * report (#1981): per file and symbol, the chain length, each corrective's decision and cost, and
 * the battery's results. Empty for a run without chain records.
 */
export function chainCosts(store: WorkflowStore, runId: string): ChainCost[] {
  const records: ChainRecord[] = [];
  const batteries: BatteryRecord[] = [];
  for (const artifact of store.artifacts(runId)) {
    if (artifact.kind !== CHAIN_KIND) continue;
    try {
      const record = JSON.parse(store.readArtifact(runId, artifact.id));
      if (artifact.logical_path.startsWith(CHAIN_TASKS_DIR)) records.push(record as ChainRecord);
      else if (artifact.logical_path.startsWith(CHAIN_BATTERY_DIR))
        batteries.push(record as BatteryRecord);
    } catch {}
  }
  if (!records.length) return [];
  const repairs = new Map(store.findings(runId).map((f) => [f.id, f.repair_task_id]));
  const stages = new Map(store.steps(runId).map((s) => [s.id, s.stage_id]));
  const attempts = store.attempts(runId);
  const usage = (taskId: string): { tokens: number; costUsd: number | null } => {
    let tokens = 0;
    let costUsd: number | null = 0;
    for (const attempt of attempts) {
      if (stages.get(attempt.step_id) !== `task-${taskId}`) continue;
      tokens += attempt.used_tokens ?? 0;
      const cost = attempt.model_id === null ? 0 : store.attemptCostUsd(runId, attempt.id);
      costUsd = cost === null || costUsd === null ? null : costUsd + cost;
    }
    return { tokens, costUsd };
  };
  const key = (file: string | null, symbol: string) => `${file ?? ""}\0${symbol}`;
  // A chain across files groups by its oldest file (#2334).
  const fileOf = (record: ChainRecord) => record.files?.[0] ?? record.file;
  // A family chain spans symbols: its records group by file and family (#2048).
  const groupKey = (record: ChainRecord) =>
    record.family
      ? `${fileOf(record) ?? ""}\0family\0${record.family}`
      : key(fileOf(record), record.symbol);
  const groups = new Map<string, ChainRecord[]>();
  for (const record of records)
    groups.set(groupKey(record), [...(groups.get(groupKey(record)) ?? []), record]);
  return [...groups.values()].map((group): ChainCost => {
    const longest = group.reduce((a, b) => (b.length > a.length ? b : a));
    const first = group[0] as ChainRecord;
    const decisions = new Map<string, "rewrite" | "patch">();
    for (const record of group)
      for (const link of record.chain) {
        const taskId = repairs.get(link.id);
        if (taskId && !decisions.has(taskId)) decisions.set(taskId, "patch");
      }
    for (const record of group) decisions.set(record.taskId, record.decision);
    const tasks = [...decisions].map(([taskId, decision]) => ({
      taskId,
      decision,
      ...usage(taskId),
    }));
    const symbols = new Set(group.flatMap((r) => [r.symbol, ...(r.symbols ?? [])]));
    const files = [...new Set(group.flatMap((r) => r.files ?? [r.file]))];
    const own = batteries
      .map((b) => ({
        decision: b.decision,
        cases: b.cases.filter((c) =>
          first.family
            ? files.includes(c.file) && symbols.has(c.symbol)
            : files.includes(c.file) && c.symbol === first.symbol,
        ),
      }))
      .filter((b) => b.cases.length);
    const cases = own.flatMap((b) => b.cases);
    return {
      file: fileOf(first),
      ...(files.length > 1 ? { files: files.filter((f): f is string => f !== null) } : {}),
      symbol: first.symbol,
      family: first.family ?? null,
      length: longest.length,
      findings: longest.chain.map((f) => f.id),
      tasks,
      battery: {
        runs: own.length,
        cases: cases.length,
        reproduced: cases.filter((c) => c.status === "reproduced").length,
        refuted: cases.filter((c) => c.status === "refuted").length,
        inconclusive: cases.filter((c) => c.status === "inconclusive").length,
        reopened: own.filter((b) => b.decision === "reopen").length,
      },
      tokens: tasks.reduce((sum, t) => sum + t.tokens, 0),
      costUsd: tasks.some((t) => t.costUsd === null)
        ? null
        : tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
    };
  });
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
  adaptive: AdaptiveFirstByteRule | null = adaptiveDeadline,
): FirstByteBoundary[] {
  return replayFirstBytes(store, [runId], limit, adaptive).get(runId) ?? [];
}

/**
 * The adaptive first-response deadline of a recorded call that ran under one (#1766), from the
 * history of the calls before it; `FirstByteHistory.deadline` unless a test passes another.
 */
export type AdaptiveFirstByteRule = (
  history: FirstByteHistory,
  ceilingMs: number,
  model: string,
  call: CallTiming,
) => number;
/**
 * The current rule over the call's recorded inputs (`deadlineInputs`, #2283). A call recorded
 * before them is decided over the trace's history, but never below the deadline it passed under:
 * the executor's history also held the machine-wide shared answers (#1880) and the ones its
 * process started with, which a trace does not keep (R73 flatelens: a 194 s answer under a
 * recorded 290,666 ms deadline replayed against 180,000 ms).
 */
const adaptiveDeadline: AdaptiveFirstByteRule = (history, ceilingMs, model, call) =>
  call.deadlineInputs
    ? firstByteDeadline(ceilingMs, call.deadlineInputs, call.promptChars)
    : Math.max(history.deadline(ceilingMs, model, call), call.limitMs ?? 0);

/**
 * `replayFirstByte` for several runs of one workspace. A call that recorded an adaptive deadline
 * (`limitMs`) is decided by `adaptive` over a history of every earlier call of the trace, in the
 * order their attempts started, as the executor seeds its history from the workspace's usage
 * records (the default rule reads the call's recorded `deadlineInputs` instead, #2283); the other
 * calls by `limit`. With `adaptive` null every call takes `limit`, as before
 * #2041. Each call's prompt size is in its timing from #2041 on; older calls replay without it.
 */
export function replayFirstBytes(
  store: WorkflowStore,
  runIds: readonly string[],
  limit: FirstByteLimit = providerFirstByteMs,
  adaptive: AdaptiveFirstByteRule | null = adaptiveDeadline,
): Map<string, FirstByteBoundary[]> {
  const history = new FirstByteHistory();
  const calls = runIds
    .flatMap((runId) => recordedCalls(store, runId).map((recorded) => ({ runId, ...recorded })))
    .sort((a, b) => a.startedAt - b.startedAt);
  const boundaries = new Map<string, FirstByteBoundary[]>(runIds.map((runId) => [runId, []]));
  for (const { runId, attemptId, model, call, index, estimated } of calls) {
    // A refused call (a 429, say) answered before any deadline; it is the retry ladder's, not this.
    if (call.status !== undefined) continue;
    const limitMs =
      adaptive && call.limitMs !== undefined
        ? adaptive(history, providerFirstByteMs(call.provider, call), model, call)
        : limit(call.provider, call);
    history.record(model, call);
    const replayed =
      call.firstByteMs !== null ? call.firstByteMs > limitMs : call.durationMs >= limitMs;
    boundaries.get(runId)?.push({
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
    });
  }
  return boundaries;
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
  /** The sibling model the replayed `next-model` rung takes, from the recorded decision (#2271). */
  replayedModel?: string;
  /** A stalled ladder that ran out: what its `provider_stall` park would do, in shadow (#2271). */
  park?: StallPark["decision"];
}

/**
 * Walks the recovery ladder again over each stage's recorded attempts: an attempt whose last model
 * call got no first response is a stall, as is one whose turn lost its answer (`lostAnswer` in its
 * usage, #1957); one that completed ends the ladder. The route comes from
 * the run's routing record, the effort from the attempt's usage. The effects table is not in a
 * trace, so an attempt that changed a file is one with a `pre_image` tool phase, which the tool
 * policy emits as it prepares each file effect: the scheduler keeps the provider wait for such an
 * attempt instead of climbing, and the next attempt starts the ladder again.
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
  const events = store.events(runId, 0, 1_000_000);
  const taken = new Map(
    events.flatMap((event) =>
      event.type === "attempt.recovery"
        ? [[event.payload.attemptId, event.payload.rung] as const]
        : [],
    ),
  );
  const changed = new Set(
    events.flatMap((event) =>
      event.type === "tool.phase" && event.payload.phase === "pre_image"
        ? [event.payload.attemptId]
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
  const parks = new Map<string, number>();
  const boundaries: StallLadderBoundary[] = [];
  for (const attempt of attempts) {
    const stage = store.rootStage(runId, attempt.step_id);
    const usageArtifact = store.latestArtifact(runId, `attempts/${attempt.id}/usage.json`);
    const usage = usageArtifact
      ? (JSON.parse(store.readArtifact(runId, usageArtifact.id)) as {
          profileId?: string;
          effort?: string;
          calls?: CallTiming[];
          lostAnswer?: unknown;
        })
      : {};
    const key = `${stage}:${usage.profileId ?? ""}`;
    if (attempt.status === "completed") {
      ladders.delete(key);
      parks.delete(key);
      continue;
    }
    const last = usage.calls?.at(-1);
    // A stall, or a turn that finished with no usable answer (#1957), which climbs the same way.
    const stalled = !!last && last.firstByteMs === null && last.status === undefined;
    if (attempt.status !== "failed" || (!stalled && usage.lostAnswer === undefined)) continue;
    const entry =
      (stage ? routing.stages?.[stage] : undefined) ??
      (usage.profileId ? routing.profiles?.[usage.profileId] : undefined);
    const models = entry ? [entry.model, ...(entry.fallback ?? [])] : [attempt.model_id];
    const effort = (usage.effort ?? entry?.effort) as RouteEffort | undefined;
    if (changed.has(attempt.id)) {
      ladders.delete(key);
      boundaries.push({
        attemptId: attempt.id,
        stage,
        model: attempt.model_id,
        recorded: taken.get(attempt.id) ?? "none",
        replayed: "none",
      });
      continue;
    }
    const current = ladders.get(key);
    // The siblings the scheduler saw at this stall, so a replay takes the same derived fallback.
    const siblings = readFallback(store, runId, attempt.id)?.siblings;
    const next = rule(current, {
      model: attempt.model_id,
      models,
      fallbackIndex: Math.max(0, models.indexOf(attempt.model_id)),
      effort,
      ...(siblings ? { siblings } : {}),
    });
    ladders.set(key, next ?? undefined);
    // As the scheduler: a ladder that ran out on a stall stops for the circuit and parks.
    const tries = !next && current && stalled ? (parks.get(key) ?? 0) + 1 : 0;
    if (tries) parks.set(key, tries);
    boundaries.push({
      attemptId: attempt.id,
      stage,
      model: attempt.model_id,
      recorded: taken.get(attempt.id) ?? "none",
      replayed: next?.rung ?? "none",
      ...(next?.model ? { replayedModel: next.model } : {}),
      ...(tries ? { park: stallParkDecision(tries) } : {}),
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
): {
  attemptId: string;
  model: string;
  startedAt: number;
  call: CallTiming;
  index: number;
  estimated: boolean;
}[] {
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
    return calls.map((call, index) => ({
      attemptId: attempt.id,
      model: attempt.model_id,
      startedAt: attempt.started_at,
      call,
      index,
      estimated,
    }));
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
  /** The dollar forecast at the measured ratio, and the dollar notice, at this start (#2186). */
  advice: CostView["advice"];
  forecastNotice: string | null;
  replayed: "pass" | "park";
  /** Each feature's token range in the estimate the current code makes at this start (#1806). */
  estimate: { featureId: string; low: number; high: number }[];
  /** The initiative's token range and expected tokens in that estimate (#2043); null without one. */
  tokens: { low: number; high: number; expected: number } | null;
  /** The token pool's forecast the current code makes at this start, and its notice (#2042). */
  pool: Pick<
    TokenPoolView,
    "limitTokens" | "usedTokens" | "forecastTokens" | "advice" | "suggestedTokens" | "notice"
  > | null;
  /**
   * The plan charge at this start (#2100, #2056): what the pool holds with open runs at their
   * limits and with each run that has a sized plan at its plan's need, and the share gate's
   * verdict with the charge for the boundary's feature (at a moment, the first ready feature
   * without a run; null when none). Null without an open run with a sized plan.
   */
  planCharge: {
    limitCommittedTokens: number;
    planCommittedTokens: number;
    releasedTokens: number;
    runs: { featureId: string; usedTokens: number; limitTokens: number; chargeTokens: number }[];
    /**
     * The dollar side (#2124): the task-call rate, what the dollar budget holds with open runs at
     * their caps and with priced runs at their plan's tokens at that rate, and each priced run's
     * amounts. Null without a dollar budget.
     */
    usd: {
      taskRate: number | null;
      limitCommittedUsd: number;
      planCommittedUsd: number;
      releasedUsd: number;
      runs: { featureId: string; limitUsd: number; chargeUsd: number | null }[];
    } | null;
    featureId: string | null;
    replayed: "pass" | "park" | null;
  } | null;
  /**
   * The `initiative-dollar-share` would-stop the current code records at this start (whatever the
   * mode), next to what the initiative spent in the end, so the corpus can judge it: dollars that
   * were never short make it a false would-stop (#2099). Null when the feature is not short.
   */
  shareWouldStop: {
    summary: string;
    spareUsd: number | null;
    lowUsd: number | null;
    measuredFeatures: number;
    finalUsd: number | null;
  } | null;
  /**
   * The `initiative-dollar-cap` would-stop the current code records at this start (#2218): the
   * initiative would pause because no dollars left after the open runs' needs pay for the
   * feature's low, next to the final spend so the corpus can judge it. Null when they do.
   */
  capWouldStop: {
    summary: string;
    leftUsd: number;
    lowUsd: number;
    openNeedUsd: number;
    suggestedUsd: number;
    finalUsd: number | null;
  } | null;
  /**
   * The `initiative-time-share` would-stop the current code records at this start (#2413): the
   * shared time left after the other waiting features' lows is below the feature's low at the
   * pace. Its promotion cites replayed starts whose features did not stop on their deadlines.
   */
  timeWouldStop: {
    summary: string;
    availableMs: number;
    lowMs: number;
    tokensPerMinute: number;
    suggestedTimeMs: number;
  } | null;
}

/**
 * One park of a feature on the token pool, and whether the host would extend the pool inside the
 * dollar cap (#2042): `recorded` is what the park recorded (`hold` before #2042), `replayed` what
 * the current rule decides on the recorded inputs, with the pool it would grow to.
 */
export interface PoolGrowthBoundary {
  featureId: string;
  seq: number;
  recorded: "extend" | "hold";
  replayed: "extend" | "hold";
  limitTokens: number;
  toTokens: number | null;
}

/** The pool-growth rule: `poolGrowthOf` unless a test replays an older one. */
export type PoolGrowthRule = (
  view: ShareGateRecord["view"],
  feature: ShareGateRecord["feature"],
  limitTokens: number,
) => { wouldExtend: boolean; toTokens: number | null } | null;

export interface InitiativeReplay {
  initiativeId: string;
  shareGate: ShareGateBoundary[];
  /** Features the recording started that the current gate parks on the recorded inputs. */
  newShareStops: number;
  /** Every token park with the host's pool extension decided again (#2042). */
  poolGrowth: PoolGrowthBoundary[];
  /** Parks whose pool extension the current rule decides differently from the recording. */
  newPoolGrowth: number;
  /** Feature runs whose growth bounds `initiative-pool-growth` decides again (#2280). */
  poolBounds: PoolBoundBoundary[];
  /** Runs it would record a would-stop for that the recording has none of. */
  newPoolBoundStops: number;
  /** Feature runs whose own plan needed more than their ceiling, the plan-time share gate decided again (#2488). */
  planShare: PlanShareBoundary[];
  /** Runs the current plan-time share gate decides differently from their record. */
  newPlanShare: number;
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

/**
 * The token pool's limit when the share-gate event at `seq` was recorded: from the record itself
 * from #2042 on; before it the limit an extension after it raised (`budget.extended` events'
 * `previous`), else the initiative's settings or its approved plan revision's budget.
 */
function poolLimitAt(store: WorkflowStore, initiativeId: string, seq: number): number | null {
  const db = store.connection;
  const extended = db
    .query(
      "SELECT payload_json FROM initiative_events WHERE initiative_id=? AND type='budget.extended' AND seq>? ORDER BY seq LIMIT 1",
    )
    .get(initiativeId, seq) as { payload_json: string } | null;
  const previous = extended
    ? (JSON.parse(extended.payload_json) as { previous?: { maxTotalTokens?: number } }).previous
    : undefined;
  if (previous?.maxTotalTokens) return previous.maxTotalTokens;
  const row = db
    .query("SELECT settings_json, approved_plan_revision FROM initiatives WHERE id=?")
    .get(initiativeId) as { settings_json: string; approved_plan_revision: number | null } | null;
  if (!row) return null;
  const settings = JSON.parse(row.settings_json) as { budget?: { maxTotalTokens?: number } | null };
  if (settings.budget?.maxTotalTokens) return settings.budget.maxTotalTokens;
  if (row.approved_plan_revision === null) return null;
  const revision = db
    .query("SELECT budget_json FROM initiative_revisions WHERE initiative_id=? AND revision=?")
    .get(initiativeId, row.approved_plan_revision) as { budget_json: string } | null;
  return revision
    ? ((JSON.parse(revision.budget_json) as { maxTotalTokens?: number }).maxTotalTokens ?? null)
    : null;
}

/**
 * Every recorded park of the trace's initiatives on the token pool, decided again by `rule`
 * (`poolGrowthOf`): would the host extend the pool inside the dollar cap (#2042). A record from
 * #2042 on holds the decision's inputs (limits, used tokens, the pool's forecast) and what it
 * decided; an older park is decided on its limit from `poolLimitAt`, without a token forecast or
 * a measured dollar rate, and recorded as `hold`, which it was.
 */
export function replayPoolGrowth(
  store: WorkflowStore,
  rule: PoolGrowthRule = poolGrowthOf,
): Pick<InitiativeReplay, "initiativeId" | "poolGrowth" | "newPoolGrowth">[] {
  const rows = store.connection
    .query(
      "SELECT initiative_id, seq, payload_json FROM initiative_events WHERE type='feature.share_gate' ORDER BY initiative_id, seq",
    )
    .all() as { initiative_id: string; seq: number; payload_json: string }[];
  const byInitiative = new Map<string, PoolGrowthBoundary[]>();
  for (const row of rows) {
    const record = JSON.parse(row.payload_json) as ShareGateRecord;
    if (record.verdict !== "park") continue;
    const limitTokens =
      record.view.budget.pool?.limitTokens ??
      record.view.budget.limits?.maxTotalTokens ??
      poolLimitAt(store, row.initiative_id, row.seq);
    if (limitTokens === null) continue;
    const decision = rule(record.view, record.feature, limitTokens);
    if (!decision && !record.poolGrowth) continue;
    const boundaries = byInitiative.get(row.initiative_id) ?? [];
    boundaries.push({
      featureId: record.featureId,
      seq: row.seq,
      recorded: record.poolGrowth?.wouldExtend ? "extend" : "hold",
      replayed: decision?.wouldExtend ? "extend" : "hold",
      limitTokens,
      toTokens: decision?.toTokens ?? null,
    });
    byInitiative.set(row.initiative_id, boundaries);
  }
  return [...byInitiative].map(([initiativeId, poolGrowth]) => ({
    initiativeId,
    poolGrowth,
    newPoolGrowth: poolGrowth.filter((b) => b.replayed !== b.recorded).length,
  }));
}

/**
 * One plan-time share gate decided again (#2488): a feature run whose own plan sizing needed more
 * than its ceiling. `recorded` is what the run's record says (`extend` for a host extension or a
 * would-extend, `hold` for a would-stop, `none` before #2488 recorded the gate); `replayed` is
 * what `rule` decides on the same inputs.
 */
export interface PlanShareBoundary {
  featureId: string;
  runId: string;
  recorded: "extend" | "hold" | "none";
  replayed: "extend" | "hold" | "none";
  needTokens: number;
  ceilingTokens: number;
  /** The pool and the run's ceiling it would grow to; null when it would not. */
  toTokens: number | null;
  toCeilingTokens: number | null;
  suggestedTokens: number | null;
}

/**
 * Every plan-time share gate of the trace's initiatives decided again by `rule`
 * (`planShareDecision`, #2488). A run with a recorded gate replays its `inputs`. A run before
 * #2488 whose latest plan sizing went on above its ceiling (`split-feature`) is decided on the
 * share gate its feature passed to start (the pool, the dollars and the waiting features, its own
 * feature taken out of them), its plan (`plannedRunTokens`) and the ceiling the sizing read; what
 * the other runs used is the pool's used tokens at that gate. R80 deltaglue's cli replays as an
 * extension inside the $30 cap.
 */
export function replayPlanShare(
  store: WorkflowStore,
  rule: (inputs: PlanShareInputs) => PlanShareDecision = planShareDecision,
): { initiativeId: string; planShare: PlanShareBoundary[]; newPlanShare: number }[] {
  const db = store.connection;
  const events = db
    .query(
      "SELECT initiative_id, seq, type, payload_json FROM initiative_events WHERE type IN ('feature.share_gate', 'feature.run_linked', 'decision.would_extend', 'decision.would_stop', 'budget.extended') ORDER BY initiative_id, seq",
    )
    .all() as { initiative_id: string; seq: number; type: string; payload_json: string }[];
  const byInitiative = new Map<string, PlanShareBoundary[]>();
  const gates = new Map<string, ShareGateRecord>();
  const recorded = new Map<string, { kind: "extend" | "hold"; inputs: PlanShareInputs }>();
  const starts: {
    initiativeId: string;
    featureId: string;
    runId: string;
    gate: ShareGateRecord | null;
  }[] = [];
  for (const row of events) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (row.type === "feature.share_gate") {
      const record = payload as unknown as ShareGateRecord;
      if (record.verdict === "pass") gates.set(`${row.initiative_id}:${record.featureId}`, record);
      continue;
    }
    if (row.type === "feature.run_linked") {
      const featureId = String(payload.featureId);
      starts.push({
        initiativeId: row.initiative_id,
        featureId,
        runId: String(payload.runId),
        gate: gates.get(`${row.initiative_id}:${featureId}`) ?? null,
      });
      continue;
    }
    const planShare =
      (row.type === "decision.would_extend" && payload.reason === "plan-share") ||
      (row.type === "decision.would_stop" && payload.reason === "initiative-plan-share") ||
      (row.type === "budget.extended" && payload.gate === "plan-share");
    if (planShare && payload.inputs && typeof payload.runId === "string")
      recorded.set(payload.runId, {
        kind: row.type === "decision.would_stop" ? "hold" : "extend",
        inputs: payload.inputs as PlanShareInputs,
      });
  }
  const settings = (id: string): RunPolicy["sizing"] => {
    const row = db.query("SELECT settings_json FROM initiatives WHERE id=?").get(id) as {
      settings_json: string;
    } | null;
    return row
      ? (JSON.parse(row.settings_json) as { basePolicy?: RunPolicy }).basePolicy?.sizing
      : undefined;
  };
  for (const start of starts) {
    const own = recorded.get(start.runId);
    const inputs = own?.inputs ?? earlierPlanShare(store, start, settings(start.initiativeId));
    if (!inputs) continue;
    const decision = rule(inputs);
    const boundaries = byInitiative.get(start.initiativeId) ?? [];
    boundaries.push({
      featureId: start.featureId,
      runId: start.runId,
      recorded: own?.kind ?? "none",
      replayed: !decision.over ? "none" : decision.wouldExtend ? "extend" : "hold",
      needTokens: decision.needTokens,
      ceilingTokens: inputs.ceilingTokens,
      toTokens: decision.toTokens,
      toCeilingTokens: decision.ceilingTokens,
      suggestedTokens: decision.suggestedTokens,
    });
    byInitiative.set(start.initiativeId, boundaries);
  }
  return [...byInitiative].map(([initiativeId, planShare]) => ({
    initiativeId,
    planShare,
    // Runs the current rule decides differently from their record; one before #2488 counts when
    // the rule would act on it.
    newPlanShare: planShare.filter((b) => b.replayed !== b.recorded).length,
  }));
}

/**
 * The plan-time share gate's inputs for a run recorded before #2488, or null when its latest plan
 * sizing fits its ceiling or its feature's start gate holds no pool (see `replayPlanShare`).
 */
function earlierPlanShare(
  store: WorkflowStore,
  start: { featureId: string; runId: string; gate: ShareGateRecord | null },
  base: RunPolicy["sizing"],
): PlanShareInputs | null {
  if (!start.gate) return null;
  const latest = store
    .artifacts(start.runId)
    .filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-"))
    .at(-1);
  if (!latest) return null;
  const report = JSON.parse(store.readArtifact(start.runId, latest.id)) as {
    decision?: string;
    maxRunTokens?: number | null;
    budgetBefore?: number;
  };
  const plan = plannedRunTokens(store, start.runId);
  if (report.decision !== "split-feature" || typeof report.maxRunTokens !== "number" || !plan)
    return null;
  const view = start.gate.view;
  const pool = shareGatePool(view);
  if (!pool) return null;
  return {
    runId: start.runId,
    featureId: start.featureId,
    usedTokens: 0,
    limitTokens: report.budgetBefore ?? report.maxRunTokens,
    ceilingTokens: report.maxRunTokens,
    baseCeilingTokens: base?.maxRunTokens ?? null,
    plan,
    planRatio: view.budget.planCharge?.ratio ?? null,
    // The gate counted no run of the feature yet: its whole need joins the waiting features.
    heldTokens: 0,
    othersUsedTokens: pool.usedTokens,
    pool: { ...pool, waiting: pool.waiting.filter((f) => f.id !== start.featureId) },
  };
}

/** One share gate whose recorded shared time the time-pool growth decides again (#2346). */
export interface TimeGrowthBoundary {
  featureId: string;
  seq: number;
  /** Whether a `time-pool` would-extend was recorded for this time and token limit. */
  recorded: "extend" | "hold";
  replayed: "extend" | "hold";
  limitMs: number;
  forecastMs: number | null;
  toMs: number | null;
}

/**
 * Every recorded share gate of the trace's initiatives with a shared time (#2336 on), decided again
 * by `rule` (`timePoolExtensionDecision`): would the host extend the shared active time while the
 * token pool and the dollar cap have room (#2346). A gate is `extend` as recorded when a `time-pool`
 * `decision.would_extend` for its time and token limit came before it, or after it for its own
 * feature before the next gate (the gate's own record; the event is once per limit).
 */
export function replayTimePoolGrowth(
  store: WorkflowStore,
  rule: (inputs: TimePoolGrowthInputs) => TimePoolExtension = timePoolExtensionDecision,
): { initiativeId: string; timeGrowth: TimeGrowthBoundary[]; newTimeGrowth: number }[] {
  const rows = store.connection
    .query(
      "SELECT initiative_id, seq, type, payload_json FROM initiative_events WHERE type IN ('feature.share_gate', 'decision.would_extend') ORDER BY initiative_id, seq",
    )
    .all() as { initiative_id: string; seq: number; type: string; payload_json: string }[];
  const recorded = rows
    .filter((r) => r.type === "decision.would_extend")
    .map((r) => ({
      initiativeId: r.initiative_id,
      seq: r.seq,
      ...(JSON.parse(r.payload_json) as {
        reason?: string;
        key?: string;
        featureId?: string | null;
      }),
    }))
    .filter((p) => p.reason === "time-pool");
  const gateSeqs = rows.filter((r) => r.type === "feature.share_gate");
  /** The seq of the initiative's next share gate: what the gate's own record came before. */
  const nextGate = (row: { initiative_id: string; seq: number }): number =>
    gateSeqs.find((g) => g.initiative_id === row.initiative_id && g.seq > row.seq)?.seq ??
    Number.POSITIVE_INFINITY;
  const byInitiative = new Map<string, TimeGrowthBoundary[]>();
  for (const row of rows) {
    if (row.type !== "feature.share_gate") continue;
    const record = JSON.parse(row.payload_json) as ShareGateRecord;
    const inputs = timeGrowthInputs(record.view);
    if (!inputs) continue;
    const decision = rule(inputs);
    const key = `time-pool-${inputs.limitMs}-${inputs.limitTokens}`;
    const boundaries = byInitiative.get(row.initiative_id) ?? [];
    boundaries.push({
      featureId: record.featureId,
      seq: row.seq,
      recorded: recorded.some(
        (e) =>
          e.initiativeId === row.initiative_id &&
          e.key === key &&
          (e.seq < row.seq || (e.featureId === record.featureId && e.seq < nextGate(row))),
      )
        ? "extend"
        : "hold",
      replayed: decision.wouldExtend ? "extend" : "hold",
      limitMs: inputs.limitMs,
      forecastMs: inputs.forecastMs,
      toMs: decision.toMs,
    });
    byInitiative.set(row.initiative_id, boundaries);
  }
  return [...byInitiative].map(([initiativeId, timeGrowth]) => ({
    initiativeId,
    timeGrowth,
    newTimeGrowth: timeGrowth.filter((b) => b.replayed !== b.recorded).length,
  }));
}

/** One feature run whose recorded growth bounds `initiative-pool-growth` decides again (#2280). */
export interface PoolBoundBoundary {
  featureId: string;
  runId: string;
  /** The `feature.share_gate` pass the run started on. */
  seq: number;
  /** Whether the run recorded an `initiative-pool-growth` would-stop. */
  recorded: boolean;
  /** Whether the reason would stop, and the first bound above what the pool or ceiling held. */
  wouldStop: boolean;
  over: PoolBoundDecision["over"];
  holdTokens: number;
  holdUsd: number | null;
}

/**
 * Every feature run of the trace's initiatives with its recorded growth bounds (`initiative-growth`
 * revisions' sizing, `auto-extend` revisions' hard ceilings) decided again by `rule`
 * (`poolBoundDecision`, the `initiative-pool-growth` shadow reason, #2280), against the pool less
 * what the other runs had used at the run's start gate and the dollar ceiling less what they had
 * spent. The others only use more later, so a bound above that is above the pool whatever they
 * did; an owner's extension raises the pool and the ceiling from the revision it precedes. One
 * boundary per run that would stop or recorded a would-stop; `newPoolBoundStops` counts the runs
 * that would stop and recorded none.
 */
export function replayPoolBounds(
  store: WorkflowStore,
  rule: (inputs: PoolBoundInputs) => PoolBoundDecision = poolBoundDecision,
): { initiativeId: string; poolBounds: PoolBoundBoundary[]; newPoolBoundStops: number }[] {
  const db = store.connection;
  const runs = db
    .query(
      "SELECT initiative_id, feature_id, run_id, created_at FROM initiative_runs ORDER BY initiative_id, created_at",
    )
    .all() as { initiative_id: string; feature_id: string; run_id: string; created_at: number }[];
  const gates = db
    .query(
      "SELECT initiative_id, seq, at, payload_json FROM initiative_events WHERE type='feature.share_gate' ORDER BY initiative_id, seq",
    )
    .all() as { initiative_id: string; seq: number; at: number; payload_json: string }[];
  const extensions = db
    .query(
      "SELECT initiative_id, at, payload_json FROM initiative_events WHERE type='budget.extended' ORDER BY initiative_id, seq",
    )
    .all() as { initiative_id: string; at: number; payload_json: string }[];
  const byInitiative = new Map<string, PoolBoundBoundary[]>();
  for (const run of runs) {
    const gate = gates
      .filter((g) => g.initiative_id === run.initiative_id && g.at <= run.created_at)
      .map((g) => ({ ...g, record: JSON.parse(g.payload_json) as ShareGateRecord }))
      .filter((g) => g.record.featureId === run.feature_id && g.record.verdict === "pass")
      .at(-1);
    const budget = gate?.record.view.budget as
      | (ShareGateRecord["view"]["budget"] & {
          used?: { tokens: number };
          cost?: { ceilingUsd: number | null; capUsd: number | null; spentUsd: number };
        })
      | undefined;
    const gateLimit = budget?.pool?.limitTokens ?? budget?.limits?.maxTotalTokens;
    if (!gate || !budget?.used || gateLimit === undefined) continue;
    const othersUsedTokens = budget.used.tokens;
    const othersSpentUsd = budget.cost?.spentUsd ?? 0;
    /** The pool and the ceiling at `at`: the gate's, raised by the extensions recorded since. */
    const limitsAt = (at: number): { limitTokens: number; ceilingUsd: number | null } => {
      let limitTokens = gateLimit;
      let ceilingUsd = budget.cost?.ceilingUsd ?? null;
      const capUsd = budget.cost?.capUsd ?? null;
      for (const e of extensions) {
        if (e.initiative_id !== run.initiative_id || e.at < gate.at || e.at > at) continue;
        const p = JSON.parse(e.payload_json) as {
          next?: { maxTotalTokens?: number };
          nextCostUsd?: number | null;
        };
        limitTokens = Math.max(limitTokens, p.next?.maxTotalTokens ?? 0);
        if (ceilingUsd !== null && capUsd && p.nextCostUsd)
          ceilingUsd = Math.max(ceilingUsd, (ceilingUsd * p.nextCostUsd) / capUsd);
      }
      return { limitTokens, ceilingUsd };
    };
    const recorded = store
      .eventsOfType(run.run_id, "decision.would_stop")
      .some(
        (e) => e.type === "decision.would_stop" && e.payload.reason === "initiative-pool-growth",
      );
    let first: PoolBoundBoundary | null = null;
    for (const artifact of store.artifacts(run.run_id)) {
      if (artifact.kind !== "policy-revision") continue;
      let record: {
        kind?: string;
        hardCeiling?: number;
        next?: {
          sizing?: { maxRunTokens?: number; extendToTokens?: number; maxRunCostUsd?: number };
        };
      };
      try {
        record = JSON.parse(store.readArtifact(run.run_id, artifact.id));
      } catch {
        continue;
      }
      const tokens: RunBound[] = [];
      const usd: RunBound[] = [];
      if (record.kind === "initiative-growth") {
        const sizing = record.next?.sizing ?? {};
        if (typeof sizing.maxRunTokens === "number")
          tokens.push({ kind: "maxRunTokens", value: sizing.maxRunTokens });
        if (typeof sizing.extendToTokens === "number")
          tokens.push({ kind: "extendToTokens", value: sizing.extendToTokens });
        if (typeof sizing.maxRunCostUsd === "number")
          usd.push({ kind: "maxRunCostUsd", value: sizing.maxRunCostUsd });
      } else if (record.kind === "auto-extend" && typeof record.hardCeiling === "number")
        tokens.push({ kind: "hardCeiling", value: record.hardCeiling });
      else continue;
      const decision = rule({
        runId: run.run_id,
        featureId: run.feature_id,
        // `SELECT *` carries the row's time; `ArtifactRow` does not type it.
        ...limitsAt((artifact as { created_at?: number }).created_at ?? Number.MAX_SAFE_INTEGER),
        othersUsedTokens,
        othersSpentUsd,
        tokens,
        usd,
      });
      if (!decision.wouldStop) continue;
      first = {
        featureId: run.feature_id,
        runId: run.run_id,
        seq: gate.seq,
        recorded,
        wouldStop: true,
        over: decision.over,
        holdTokens: decision.holdTokens,
        holdUsd: decision.holdUsd,
      };
      break;
    }
    const boundaries = byInitiative.get(run.initiative_id) ?? [];
    if (first) boundaries.push(first);
    else if (recorded)
      boundaries.push({
        featureId: run.feature_id,
        runId: run.run_id,
        seq: gate.seq,
        recorded,
        wouldStop: false,
        over: [],
        holdTokens: 0,
        holdUsd: null,
      });
    byInitiative.set(run.initiative_id, boundaries);
  }
  return [...byInitiative].map(([initiativeId, poolBounds]) => ({
    initiativeId,
    poolBounds,
    newPoolBoundStops: poolBounds.filter((b) => b.wouldStop && !b.recorded).length,
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
  options: {
    gate?: ShareGate;
    priceSamples?: PriceSamples;
    historyTrace?: HistoryTrace;
    /**
     * Rewinds the shared budget and each run's budget inputs too (the default): an extension made
     * after a start is undone for it, and a run counts the tokens and dollars of the attempts it
     * had finished and its policy then (#2042, #2061). `false` replays every start on the final
     * budget, usage and run caps, as the corpus did before #2061: R60 wheeltags then read its
     * runs' final spend and grown caps and parked four starts on $0.00.
     */
    budgetAtStart?: boolean;
    /**
     * Further moments (epoch ms) to rewind to and compute the view at, between starts: each is a
     * boundary with an empty `featureId` that never parks (#2042).
     */
    moments?: number[];
    /** Sets the initiative's `sizing.recencyHalfLife`, to backtest the weighting (#2150). */
    recencyHalfLife?: number;
    /**
     * Sets entries of the initiative's base policy `stopModes`, to replay a round at the mode it
     * ran in: a round before #2245 held open runs at their limits (`initiative-plan-charge` in
     * shadow), and a replay without this entry takes the current default.
     */
    stopModes?: RunPolicy["stopModes"];
  } = {},
): Omit<
  InitiativeReplay,
  | "shareGate"
  | "newShareStops"
  | "poolGrowth"
  | "newPoolGrowth"
  | "poolBounds"
  | "newPoolBoundStops"
  | "planShare"
  | "newPlanShare"
>[] {
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
  return ids.map((id) =>
    replayStarts(path, id, gate, options.priceSamples, historyTrace, {
      budgetAtStart: options.budgetAtStart !== false,
      moments: options.moments ?? [],
      ...(options.recencyHalfLife ? { recencyHalfLife: options.recencyHalfLife } : {}),
      ...(options.stopModes ? { stopModes: options.stopModes } : {}),
    }),
  );
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
  {
    budgetAtStart,
    moments,
    recencyHalfLife,
    stopModes,
  }: {
    budgetAtStart: boolean;
    moments: number[];
    recencyHalfLife?: number;
    stopModes?: RunPolicy["stopModes"];
  },
): Omit<
  InitiativeReplay,
  | "shareGate"
  | "newShareStops"
  | "poolGrowth"
  | "newPoolGrowth"
  | "poolBounds"
  | "newPoolBoundStops"
  | "planShare"
  | "newPlanShare"
> {
  const { store, workspace, dispose } = openTrace(path);
  const histories = new Map<string, ReturnType<typeof openTrace>>();
  try {
    const db = store.connection;
    const row = db
      .query("SELECT settings_json, decompose_run_id FROM initiatives WHERE id=?")
      .get(initiativeId) as { settings_json: string; decompose_run_id: string | null };
    const settings = JSON.parse(row.settings_json) as {
      basePolicy?: {
        sizing?: { historyStores?: string[]; recencyHalfLife?: number };
        stopModes?: RunPolicy["stopModes"];
      };
    };
    const missingHistory: string[] = [];
    if (recencyHalfLife || stopModes) {
      settings.basePolicy = {
        ...settings.basePolicy,
        ...(recencyHalfLife ? { sizing: { ...settings.basePolicy?.sizing, recencyHalfLife } } : {}),
        ...(stopModes ? { stopModes: { ...settings.basePolicy?.stopModes, ...stopModes } } : {}),
      };
      db.run("UPDATE initiatives SET settings_json=? WHERE id=?", [
        JSON.stringify(settings),
        initiativeId,
      ]);
    }
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
    const policies = new Map(runIds.map((runId) => [runId, runPolicyAt(store, runId)]));
    const activeTimes = new Map(runIds.map((runId) => [runId, runActiveAt(store, runId)]));
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
    const points = [
      ...links,
      ...moments.map((at) => ({ feature_id: "", run_id: "", created_at: at })),
    ].sort((a, b) => a.created_at - b.created_at);
    for (const link of points.reverse()) {
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
        // The shared budget as it stood then: an extension made later is undone (#2042).
        const extended = !budgetAtStart
          ? null
          : (db
              .query(
                "SELECT payload_json FROM initiative_events WHERE initiative_id=? AND type='budget.extended' AND at>=? ORDER BY seq LIMIT 1",
              )
              .get(initiativeId, t) as { payload_json: string } | null);
        if (extended) {
          const event = JSON.parse(extended.payload_json) as {
            previous?: Record<string, number>;
            previousCostUsd?: number | null;
          };
          const current = JSON.parse(
            (
              db.query("SELECT settings_json FROM initiatives WHERE id=?").get(initiativeId) as {
                settings_json: string;
              }
            ).settings_json,
          ) as { budget?: unknown; costBudget?: { maxCostUsd: number } | null };
          if (event.previous) current.budget = event.previous;
          if (typeof event.previousCostUsd === "number" && current.costBudget)
            current.costBudget = { ...current.costBudget, maxCostUsd: event.previousCostUsd };
          db.run("UPDATE initiatives SET settings_json=? WHERE id=?", [
            JSON.stringify(current),
            initiativeId,
          ]);
        }
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
          // The run's tokens, dollars and policy as they stood then, not at its end (#2061).
          const policyAt = policies.get(runId);
          const activeAt = activeTimes.get(runId);
          if (budgetAtStart && policyAt && activeAt)
            rewindRunBudget(db, runId, t, policyAt, activeAt(t));
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
        const whole = initiatives.estimate(initiativeId);
        const short = feature ? dollarShortfall(view, feature) : null;
        const park = feature ? dollarCapPark(view, feature) : null;
        const timeShort = feature ? timeShortfall(view, feature) : null;
        const estimate = (whole?.features ?? []).map((f) => ({
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
          advice: cost.advice ?? null,
          forecastNotice: cost.forecastNotice,
          replayed: feature && gate(view, feature) ? "park" : "pass",
          estimate,
          tokens: whole ? { ...whole.tokens, expected: whole.expectedTokens } : null,
          pool: view.budget.pool && {
            limitTokens: view.budget.pool.limitTokens,
            usedTokens: view.budget.pool.usedTokens,
            forecastTokens: view.budget.pool.forecastTokens,
            advice: view.budget.pool.advice,
            suggestedTokens: view.budget.pool.suggestedTokens,
            notice: view.budget.pool.notice,
          },
          planCharge: replayPlanCharge(view, feature, gate),
          shareWouldStop: short
            ? {
                summary: short,
                spareUsd: shareSpareUsd(view, link.feature_id),
                lowUsd: feature?.needUsd?.low ?? null,
                measuredFeatures: cost.measuredFeatures,
                finalUsd: finalUsd > 0 ? Math.round(finalUsd * 100) / 100 : null,
              }
            : null,
          capWouldStop: park
            ? {
                summary: park.summary,
                leftUsd: park.leftUsd,
                lowUsd: park.lowUsd,
                openNeedUsd: park.openNeedUsd,
                suggestedUsd: park.suggestedUsd,
                finalUsd: finalUsd > 0 ? Math.round(finalUsd * 100) / 100 : null,
              }
            : null,
          timeWouldStop: timeShort
            ? {
                summary: timeShort.summary,
                availableMs: timeShort.availableMs,
                lowMs: timeShort.needMs.low,
                tokensPerMinute: timeShort.tokensPerMinute,
                suggestedTimeMs: timeShort.suggestedTimeMs,
              }
            : null,
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

/**
 * The plan charge of a rewound start (#2100): the view's `budget.planCharge` with the share gate
 * asked again on the charged view (`planChargedGate`) for `feature`, or, at a moment, for the
 * first ready feature without a run.
 */
function replayPlanCharge(
  view: InitiativeView,
  feature: FeatureView | undefined,
  gate: ShareGate,
): InitiativeStartBoundary["planCharge"] {
  const charge = view.budget.planCharge;
  if (!charge) return null;
  const target = feature ?? view.features.find((f) => f.state === "ready" && f.share !== null);
  const charged = planChargedGate(view) ?? view;
  const own = target && charged.features.find((f) => f.id === target.id);
  return {
    limitCommittedTokens: charge.limitCommittedTokens,
    planCommittedTokens: charge.planCommittedTokens,
    releasedTokens: charge.releasedTokens,
    runs: charge.runs.map(({ featureId, usedTokens, limitTokens, chargeTokens }) => ({
      featureId,
      usedTokens,
      limitTokens,
      chargeTokens,
    })),
    usd: charge.usd
      ? {
          ...charge.usd,
          runs: charge.runs.map((r) => ({
            featureId: r.featureId,
            limitUsd: r.limitUsd ?? 0,
            chargeUsd: r.chargeUsd ?? null,
          })),
        }
      : null,
    featureId: target?.id ?? null,
    replayed: target
      ? gate(charged, { ...target, share: own?.share ?? null })
        ? "park"
        : "pass"
      : null,
  };
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
          // A task split into row slices (#2455) is decided on its rows, as it was recorded.
          replayed:
            decide(
              task.cases ?? 0,
              report.testTaskLimit ?? null,
              task.estimate,
              cap,
              true,
              task.rowsTask ?? null,
            ) ||
            (task.rowVolume?.mode === "on" &&
              rowVolumePrice(task.rowVolume.chars, task.rowVolume.rows, cap).slices > 1)
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
  until = to,
): ForecastDecision => {
  const within = artifacts.filter((a) => a.created_at >= from && a.created_at < to);
  if (within.some((a) => a.kind === "cost-forecast")) return "stop";
  // The recorded run grew if its cap rose while the attempt ran, by whichever host growth: the
  // forecast is checked again on later calls of the attempt, after a parallel attempt may have
  // started, and a token growth raises the cap with the tokens. R60 wheeltags names grew on its
  // forecast 2.7 s into an attempt, 2.6 s after the next one started, and base's auto-growth took
  // its cap from $3.18 to $4.78 1.3 s into the attempt the replay grows at (#1937).
  const during = artifacts.filter(
    (a) => a.created_at >= from && a.created_at < Math.max(to, until),
  );
  if (during.some((a) => a.kind === "policy-revision" && raisesCap(a.content))) return "grow";
  return "pass";
};

/** Whether a policy revision is the host's growth of the cost cap. */
function raisesCap(content: string | null): boolean {
  const body = JSON.parse(content ?? "{}") as {
    kind?: string;
    approvedBy?: string;
    previous?: { maxCostUsd?: unknown };
    next?: { maxCostUsd?: unknown };
  };
  if (body.kind === "forecast-growth") return true;
  const before = body.previous?.maxCostUsd;
  const after = body.next?.maxCostUsd;
  return (
    body.approvedBy === "sizing" &&
    typeof before === "number" &&
    typeof after === "number" &&
    after > before
  );
}

/**
 * A run's policy at any moment: the policy it started with, then each revision's own limits
 * forward. Undoing `previous` backwards from the final policy went wrong where a revision was
 * written from a stale copy and its `previous` undid an earlier growth (#1704). `revisions` are
 * newest first.
 */
function policyAtOf(
  final: RunPolicy,
  revisions: readonly Pick<RevisionRecord, "createdAt" | "previous" | "next">[],
): (t: number) => RunPolicy {
  let initial: Record<string, unknown> = { ...final };
  for (const revision of revisions) initial = { ...initial, ...revision.previous };
  return (t) => {
    let policy = initial;
    for (const revision of [...revisions].reverse()) {
      if (revision.createdAt > t) break;
      policy = { ...policy, ...revision.next };
    }
    return PolicySchema.parse(policy);
  };
}

/** `policyAtOf` from a run's recorded policy revisions, read before any rewind removes them. */
function runPolicyAt(store: WorkflowStore, runId: string): (t: number) => RunPolicy {
  const revisions = (
    store.connection
      .query(
        "SELECT created_at, inline_content AS content FROM artifacts WHERE run_id=? AND kind='policy-revision'",
      )
      .all(runId) as { created_at: number; content: string | null }[]
  )
    .map((a) => {
      const body = JSON.parse(a.content ?? "{}") as {
        previous?: Record<string, unknown>;
        next?: Record<string, unknown>;
      };
      return { createdAt: a.created_at, previous: body.previous ?? {}, next: body.next ?? {} };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return policyAtOf(PolicySchema.parse(JSON.parse(store.run(runId).policy_json)), revisions);
}

/**
 * A run's active time at any moment, read before a replay removes its later events (#2417): the
 * `activeMs` its `budget.updated` events recorded, from 0 at its creation to its stored total at
 * its last update, interpolated between two of them. The run row keeps only the final total, and
 * the events come only with a reservation, so a moment between two reads the time in between.
 */
function runActiveAt(store: WorkflowStore, runId: string): (t: number) => number {
  const run = store.run(runId);
  const points = [
    { at: run.created_at, ms: 0 },
    ...(store.connection
      .query(
        "SELECT at, json_extract(payload_json, '$.activeMs') AS ms FROM events WHERE run_id=? AND type='budget.updated' AND json_extract(payload_json, '$.activeMs') IS NOT NULL ORDER BY seq",
      )
      .all(runId) as { at: number; ms: number }[]),
    { at: Math.max(run.updated_at, run.created_at), ms: run.active_ms },
  ];
  return (t) => {
    const next = points.findIndex((p) => p.at > t);
    if (next === -1) return run.active_ms;
    const after = points[next];
    const before = points[next - 1];
    if (!after || !before) return 0;
    const span = after.at - before.at;
    const share = span > 0 ? (t - before.at) / span : 1;
    return Math.round(before.ms + Math.max(0, after.ms - before.ms) * share);
  };
}

/**
 * A run's budget inputs as they stood at `t`, for a replay that rewound its attempts there (#2061):
 * the tokens and dollars of the attempts that had finished by then, the agent calls started by
 * then, its active time then (`runActiveAt`), and its policy then. The stored totals and the
 * policy are the run's final ones; an initiative view replayed on them sees every later spend and
 * cap growth. With the final active time and calls, R76 schemamask's view at generation's start
 * counted 14.0M ms used of the 18M shared time and 101 calls instead of the 9.4M and 70 its
 * recorded gate read, and the replay parked generation and validate on a time share of 0 ms that
 * the round never had (#2417).
 */
function rewindRunBudget(
  db: Database,
  runId: string,
  t: number,
  policyAt: (t: number) => RunPolicy,
  activeMs: number,
): void {
  db.run(
    `UPDATE runs SET
      token_usage=(SELECT COALESCE(SUM(used_tokens), 0) FROM attempts WHERE run_id=? AND ended_at<=?),
      agent_calls=(SELECT COUNT(*) FROM attempts WHERE run_id=? AND model_id IS NOT NULL AND started_at<=?),
      active_ms=?, estimated_cost_microusd=NULL, policy_json=? WHERE id=?`,
    [runId, t, runId, t, activeMs, canonical(policyAt(t)), runId],
  );
}

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
  | "findingChains"
  | "newChainDecisions"
  | "repeatedFailures"
  | "newRepeatStops"
  | "requestConflicts"
  | "newConflictDecisions"
  | "hostApply"
  | "newApplyDecisions"
  | "misquoteFixes"
  | "newMisquoteFixes"
  | "rowRestores"
  | "newRowRestores"
  | "edgeProbes"
  | "newEdgeDecisions"
  | "integrity"
  | "newIntegrityFindings"
  | "caseWalks"
  | "newCaseRefusals"
  | "testCaps"
  | "newTestCapRefusals"
  | "reviewGates"
  | "newGateRepairs"
  | "convergenceGates"
  | "newConvergenceVerdicts"
  | "evidenceDecisions"
  | "newEvidenceDecisions"
  | "correctiveScopes"
  | "newScopeStops"
  | "newUnownedDecisions"
  | "conflictFinishes"
  | "newConflictFinishes"
  | "correctiveDefers"
  | "newDeferDecisions"
  | "baselineFailures"
  | "newBaselineDecisions"
  | "baselineSignatures"
  | "newSignatureDecisions"
  | "sourceDefects"
  | "newSourceDefectRoutes"
  | "activeTimes"
  | "newActiveTimes"
  | "cleanPaceChanges"
  | "unselectedTests"
  | "newUnselectedStops"
  | "attemptCheckpoints"
  | "newWouldFinishes"
  | "rowBlocks"
  | "newRowBlockDrifts"
  | "newRowBlockMoves"
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
      "SELECT rowid AS r, id, step_id, model_id, reserved_tokens, started_at, ended_at FROM attempts WHERE run_id=? AND model_id IS NOT NULL ORDER BY started_at, rowid",
    )
    .all(runId) as {
    r: number;
    id: string;
    step_id: string;
    model_id: string;
    reserved_tokens: number;
    started_at: number;
    ended_at: number | null;
  }[];
  if (!priced.length) return null;
  const capped =
    final.maxCostUsd !== null || revisions.some((r) => typeof r.previous.maxCostUsd === "number");
  if (!capped) return null;
  const finalUsd = store.costUsage(runId).spentUsd;
  const policyAt = policyAtOf(final, revisions);
  const rewind = runRewinder(store, runId);
  // An attempt's reservation grows before each of its calls (`expandReservation`), and each raise
  // is checked with the spend, the open reservations and the policy of that moment. Each raise
  // emits `budget.updated` with the run's open reservation total after it. Read before a rewind
  // drops the events.
  const raises = (
    db
      .query(
        "SELECT at, payload_json FROM events WHERE run_id=? AND type='budget.updated' ORDER BY seq",
      )
      .all(runId) as { at: number; payload_json: string }[]
  ).flatMap((e) => {
    const total = (JSON.parse(e.payload_json) as { reservedTokens?: unknown }).reservedTokens;
    return typeof total === "number" ? [{ at: e.at, total }] : [];
  });
  // Each attempt's forecast check at its start and its cost-cap check, from the latest moment back
  // to the earliest, so every rewind only removes what came after it.
  const moments = priced
    .flatMap((attempt, index) => {
      const ended = attempt.ended_at ?? Number.POSITIVE_INFINITY;
      // The last raise while the attempt ran: it held its largest reservation then, and the event's
      // total is exactly what the run's open attempts held. Without one it reserved its largest at
      // its start.
      const raise = raises.findLast(
        (e) => e.at >= attempt.started_at && e.at <= ended && e.total >= attempt.reserved_tokens,
      );
      return [
        { index, at: raise?.at ?? attempt.started_at, total: raise?.total ?? null, cost: true },
        { index, at: attempt.started_at, total: null, cost: false },
      ];
    })
    .sort((a, b) => b.at - a.at || b.index - a.index || Number(b.cost) - Number(a.cost));
  const boundaries: ReplayBoundary[] = [];
  const costCap: (CostCapBoundary & { index: number })[] = [];
  for (const moment of moments) {
    const attempt = priced[moment.index];
    if (!attempt) continue;
    const t = moment.at;
    db.transaction(() => {
      rewind(t, attempt);
      db.run(
        "UPDATE runs SET policy_json=?, estimated_cost_microusd=NULL, status='running' WHERE id=?",
        [canonical(policyAt(t)), runId],
      );
    })();
    const policy = policyAt(t);
    if (moment.cost) {
      // The attempt's largest reservation against the cost cap, as `reserve` or the raise to it
      // in `expandReservation` checked it. At a raise the other open attempts held the event's
      // total less this attempt's tokens; the trace keeps only their largest reservations, so
      // they are scaled down to that total for the check and restored after it.
      const others = db
        .query(
          "SELECT id, reserved_tokens AS tokens FROM attempts WHERE run_id=? AND id<>? AND usage_complete=0 AND model_id IS NOT NULL",
        )
        .all(runId, attempt.id) as { id: string; tokens: number }[];
      const held = others.reduce((sum, a) => sum + a.tokens, 0);
      const left =
        moment.total === null ? held : Math.max(0, moment.total - attempt.reserved_tokens);
      if (held > left)
        for (const a of others)
          db.run("UPDATE attempts SET reserved_tokens=? WHERE run_id=? AND id=?", [
            Math.floor((a.tokens * left) / held),
            runId,
            a.id,
          ]);
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
        costCap.push({
          index: moment.index,
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
      // A growth the check writes is undone before the next check.
      db.transaction(() => {
        if (held > left)
          for (const a of others)
            db.run("UPDATE attempts SET reserved_tokens=? WHERE run_id=? AND id=?", [
              a.tokens,
              runId,
              a.id,
            ]);
        db.run("DELETE FROM artifacts WHERE run_id=? AND created_at>?", [runId, t]);
        db.run("UPDATE runs SET policy_json=? WHERE id=?", [canonical(policy), runId]);
      })();
      continue;
    }
    const next = priced[moment.index + 1]?.started_at ?? Number.POSITIVE_INFINITY;
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
      recorded: decisionOf(artifacts, t, next, attempt.ended_at ?? next),
      replayed,
      projectedUsd: forecast?.projectedUsd ?? null,
      ceilingUsd: forecast?.ceilingUsd ?? null,
      spentUsd: forecast?.spentUsd ?? null,
    });
  }
  costCap.sort((a, b) => a.index - b.index);
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
    costCap: costCap.map(({ index: _, ...b }) => b),
    newCostStops: costCap.filter((b) => b.replayed === "stop").length,
  };
}

/** Replays the forecast gate of every run in the trace at `path` with a dollar cap. */
export function replayTrace(
  path: string,
  options: {
    firstByteLimit?: FirstByteLimit;
    /** The adaptive deadline's rule (#2041); null replays every call on `firstByteLimit`. */
    adaptiveFirstByte?: AdaptiveFirstByteRule | null;
    shareGate?: ShareGate;
    callRate?: CallRate;
    testSplit?: TestSplitRule;
    stallRule?: StallRule;
    priceSamples?: PriceSamples;
    historyTrace?: HistoryTrace;
    policyRefusal?: PolicyRefusalRule;
    chainRule?: ChainRule;
    batteryRule?: BatteryRule;
    familyRule?: FamilyRule;
    /** Decides each chain record's count of earlier rewrites again (#2568). */
    rewriteRepeatRule?: RewriteRepeatRule;
    repeatRule?: RepeatRule;
    requestConflictRule?: RequestConflictRule;
    hostApplyRule?: HostApplyRule;
    poolGrowthRule?: PoolGrowthRule;
    misquoteFixRule?: MisquoteFixRule;
    /** Decides each recorded row restore again (#2522); the current rule by default. */
    rowRestoreRule?: RowRestoreRule;
    edgeRule?: EdgeRule;
    edgeCrashRule?: EdgeCrashRule;
    integrityRule?: IntegrityRule;
    caseWalkRule?: CaseWalkRule;
    testCapRule?: TestCapRule;
    reviewGateRule?: ReviewGateRule;
    convergenceGateRule?: ConvergenceGateRule;
    evidenceRule?: EvidenceRule;
    scopeRule?: ScopeRule;
    unownedRule?: UnownedRule;
    conflictFinishRule?: ConflictFinishRule;
    correctiveDeferRule?: CorrectiveDeferRule;
    /** Decides each recorded baseline failure again (#2215); the current rule by default. */
    baselineFailureRule?: BaselineFailureRule;
    /** Decides each recorded baseline comparison again (#2295); the current rule by default. */
    baselineSignatureRule?: BaselineSignatureRule;
    sourceDefectRule?: SourceDefectRule;
    /** Picks the pace of each sizing report's active time again (#2336); the current rule by default. */
    activePace?: ActivePaceRule;
    /** Decides each attempt checkpoint's would-finish again (#2470); the current rule by default. */
    checkpointRule?: CheckpointRule;
    /** Decides each recorded row block comparison again (#2486); the current rule by default. */
    rowBlockRule?: RowBlockRule;
    /** Places each recorded file row against its block again (#2503); the current rule by default. */
    rowMoveRule?: RowMoveRule;
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
    // Growth bounds are read before the forecast replay rewinds each run's policy revisions.
    const bounds = replayPoolBounds(store);
    // Plan sizings are read before the forecast replay rewinds each run's artifacts (#2488).
    const plans = replayPlanShare(store);
    // Call timings are read before the forecast replay rewinds each run's attempts.
    const timings = replayFirstBytes(
      store,
      runIds,
      options.firstByteLimit,
      options.adaptiveFirstByte === undefined ? adaptiveDeadline : options.adaptiveFirstByte,
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
    const chains = new Map(
      runIds.map((runId) => [
        runId,
        replayFindingChains(store, runId, {
          ...(options.chainRule ? { chain: options.chainRule } : {}),
          ...(options.batteryRule ? { battery: options.batteryRule } : {}),
          ...(options.familyRule ? { family: options.familyRule } : {}),
          ...(options.rewriteRepeatRule ? { rewriteRepeat: options.rewriteRepeatRule } : {}),
        }),
      ]),
    );
    const repeats = new Map(
      runIds.map((runId) => [runId, replayRepeatedFailures(store, runId, options.repeatRule)]),
    );
    const requests = new Map(
      runIds.map((runId) => [
        runId,
        replayRequestConflicts(store, runId, options.requestConflictRule),
      ]),
    );
    const applies = new Map(
      runIds.map((runId) => [runId, replayHostApply(store, runId, options.hostApplyRule)]),
    );
    const misquotes = new Map(
      runIds.map((runId) => [runId, replayMisquoteFixes(store, runId, options.misquoteFixRule)]),
    );
    const restores = new Map(
      runIds.map((runId) => [runId, replayRowRestores(store, runId, options.rowRestoreRule)]),
    );
    const edges = new Map(
      runIds.map((runId) => [
        runId,
        replayEdgeProbes(store, runId, options.edgeRule, options.edgeCrashRule),
      ]),
    );
    const scans = new Map(
      runIds.map((runId) => [runId, replayIntegrity(store, runId, options.integrityRule)]),
    );
    const walks = new Map(
      runIds.map((runId) => [runId, replayCaseWalks(store, runId, options.caseWalkRule)]),
    );
    const caps = new Map(
      runIds.map((runId) => [runId, replayTestCaps(store, runId, options.testCapRule)]),
    );
    const reviews = new Map(
      runIds.map((runId) => [runId, replayReviewGates(store, runId, options.reviewGateRule)]),
    );
    const converges = new Map(
      runIds.map((runId) => [
        runId,
        replayConvergenceGates(store, runId, options.convergenceGateRule),
      ]),
    );
    const evidence = new Map(
      runIds.map((runId) => [runId, replayEvidenceDecisions(store, runId, options.evidenceRule)]),
    );
    const scopes = new Map(
      runIds.map((runId) => [
        runId,
        replayCorrectiveScopes(store, runId, options.scopeRule, options.unownedRule),
      ]),
    );
    const finishes = new Map(
      runIds.map((runId) => [
        runId,
        replayConflictFinishes(store, runId, options.conflictFinishRule),
      ]),
    );
    const defers = new Map(
      runIds.map((runId) => [
        runId,
        replayCorrectiveDefers(store, runId, options.correctiveDeferRule),
      ]),
    );
    const baselines = new Map(
      runIds.map((runId) => [
        runId,
        replayBaselineFailures(store, runId, options.baselineFailureRule),
      ]),
    );
    const signatures = new Map(
      runIds.map((runId) => [
        runId,
        replayBaselineSignatures(store, runId, options.baselineSignatureRule),
      ]),
    );
    const routes = new Map(
      runIds.map((runId) => [runId, replaySourceDefects(store, runId, options.sourceDefectRule)]),
    );
    const paces = new Map(
      runIds.map((runId) => [runId, replayActiveTimes(store, runId, options.activePace)]),
    );
    const unselected = new Map(
      runIds.map((runId) => [runId, replayUnselectedTestRuns(store, runId)]),
    );
    const checkpoints = new Map(
      runIds.map((runId) => [
        runId,
        replayAttemptCheckpoints(store, runId, options.checkpointRule),
      ]),
    );
    const rowBlockReplays = new Map(
      runIds.map((runId) => [
        runId,
        replayRowBlocks(store, runId, options.rowBlockRule, options.rowMoveRule),
      ]),
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
      const findingChains = chains.get(runId) ?? [];
      const repeatedFailures = repeats.get(runId) ?? [];
      const requestConflicts = requests.get(runId) ?? [];
      const hostApply = applies.get(runId) ?? [];
      const misquoteFixes = misquotes.get(runId) ?? [];
      const rowRestores = restores.get(runId) ?? [];
      const edgeProbes = edges.get(runId) ?? [];
      const integrity = scans.get(runId) ?? [];
      const caseWalks = walks.get(runId) ?? [];
      const testCaps = caps.get(runId) ?? [];
      const reviewGates = reviews.get(runId) ?? [];
      const convergenceGates = converges.get(runId) ?? [];
      const evidenceDecisions = evidence.get(runId) ?? [];
      const correctiveScopes = scopes.get(runId) ?? [];
      const conflictFinishes = finishes.get(runId) ?? [];
      const correctiveDefers = defers.get(runId) ?? [];
      const baselineFailures = baselines.get(runId) ?? [];
      const baselineSignatures = signatures.get(runId) ?? [];
      const sourceDefects = routes.get(runId) ?? [];
      const activeTimes = paces.get(runId) ?? [];
      const unselectedTests = unselected.get(runId) ?? [];
      const attemptCheckpoints = checkpoints.get(runId) ?? [];
      const rowBlocks = rowBlockReplays.get(runId) ?? [];
      if (
        !replay.boundaries.length &&
        !firstByte.length &&
        !testSplits.length &&
        !stallLadder.length &&
        !policyRefusals.length &&
        !findingChains.length &&
        !repeatedFailures.length &&
        !requestConflicts.length &&
        !hostApply.length &&
        !misquoteFixes.length &&
        !rowRestores.length &&
        !edgeProbes.length &&
        !integrity.length &&
        !caseWalks.length &&
        !testCaps.length &&
        !reviewGates.length &&
        !convergenceGates.length &&
        !evidenceDecisions.length &&
        !correctiveScopes.length &&
        !conflictFinishes.length &&
        !correctiveDefers.length &&
        !baselineFailures.length &&
        !baselineSignatures.length &&
        !sourceDefects.length &&
        !activeTimes.length &&
        !unselectedTests.length &&
        !attemptCheckpoints.length &&
        !rowBlocks.length
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
        findingChains,
        newChainDecisions: findingChains.filter((b) => b.replayed !== b.recorded).length,
        repeatedFailures,
        newRepeatStops: newRepeatStops(repeatedFailures),
        requestConflicts,
        newConflictDecisions: requestConflicts.filter((b) => b.replayed !== b.recorded).length,
        hostApply,
        newApplyDecisions: hostApply.filter((b) => b.replayed !== b.recorded).length,
        misquoteFixes,
        newMisquoteFixes: misquoteFixes.filter((b) => b.replayed !== b.recorded).length,
        rowRestores,
        newRowRestores: rowRestores.reduce(
          (n, b) => n + b.replayed.filter((r) => !b.recorded.includes(r)).length,
          0,
        ),
        edgeProbes,
        newEdgeDecisions: edgeProbes.filter(
          (b) => b.replayed !== b.recorded || b.crashReplayed !== b.crashRecorded,
        ).length,
        integrity,
        newIntegrityFindings: integrity.reduce(
          (n, b) => n + b.replayed.filter((f) => !b.recorded.includes(f)).length,
          0,
        ),
        caseWalks,
        newCaseRefusals: caseWalks.reduce(
          (n, b) => n + b.replayed.filter((f) => !b.recorded.includes(f)).length,
          0,
        ),
        testCaps,
        newTestCapRefusals: testCaps.reduce(
          (n, b) => n + b.replayed.filter((f) => !b.recorded.includes(f)).length,
          0,
        ),
        reviewGates,
        newGateRepairs: reviewGates.reduce(
          (n, b) => n + b.replayed.filter((f) => !b.recorded.includes(f)).length,
          0,
        ),
        convergenceGates,
        newConvergenceVerdicts: convergenceGates.reduce(
          (n, b) =>
            n +
            b.replayed.filter((v) => b.recorded.find((r) => r.id === v.id)?.verdict !== v.verdict)
              .length,
          0,
        ),
        evidenceDecisions,
        newEvidenceDecisions: evidenceDecisions.filter((b) => b.replayed !== b.recorded).length,
        correctiveScopes,
        newScopeStops: correctiveScopes.filter(
          (b) => b.replayed === "refuse" && b.recorded === "fits",
        ).length,
        newUnownedDecisions: correctiveScopes.filter(
          (b) => b.unownedRecorded !== null && b.unownedReplayed !== b.unownedRecorded,
        ).length,
        conflictFinishes,
        newConflictFinishes: conflictFinishes.filter((b) => b.replayed !== b.recorded).length,
        correctiveDefers,
        newDeferDecisions: correctiveDefers.filter((b) => b.replayed !== b.recorded).length,
        baselineFailures,
        newBaselineDecisions: baselineFailures.filter((b) => b.replayed !== b.recorded).length,
        baselineSignatures,
        newSignatureDecisions: baselineSignatures.filter((b) => b.replayed !== b.recorded).length,
        sourceDefects,
        newSourceDefectRoutes: sourceDefects.filter((b) => b.replayed !== b.recorded).length,
        activeTimes,
        newActiveTimes: activeTimes.filter((b) => b.replayed.after !== b.recorded.after).length,
        cleanPaceChanges: activeTimes.filter((b) => b.clean && b.clean.after !== b.recorded.after)
          .length,
        unselectedTests,
        newUnselectedStops: unselectedTests.filter((b) => !b.recorded).length,
        attemptCheckpoints,
        newWouldFinishes: attemptCheckpoints.filter((b) => b.replayed && !b.recorded).length,
        rowBlocks,
        newRowBlockDrifts: rowBlocks.reduce(
          (n, b) => n + b.replayed.filter((r) => !b.recorded.includes(r)).length,
          0,
        ),
        newRowBlockMoves: rowBlocks.reduce((n, b) => {
          if (!b.moves) return n;
          const recorded = [...b.moves.recorded.added, ...b.moves.recorded.duplicated];
          const replayed = [...b.moves.replayed.added, ...b.moves.replayed.duplicated];
          return n + replayed.filter((line) => !recorded.includes(line)).length;
        }, 0),
      });
    }
    const gates = replayShareGate(store, options.shareGate);
    const pools = replayPoolGrowth(store, options.poolGrowthRule);
    const initiatives = [
      ...new Set([...starts.map((i) => i.initiativeId), ...gates.map((i) => i.initiativeId)]),
    ].map((initiativeId): InitiativeReplay => {
      const gate = gates.find((i) => i.initiativeId === initiativeId);
      const pool = pools.find((i) => i.initiativeId === initiativeId);
      return {
        initiativeId,
        shareGate: gate?.shareGate ?? [],
        newShareStops: gate?.newShareStops ?? 0,
        poolGrowth: pool?.poolGrowth ?? [],
        newPoolGrowth: pool?.newPoolGrowth ?? 0,
        poolBounds: bounds.find((i) => i.initiativeId === initiativeId)?.poolBounds ?? [],
        newPoolBoundStops:
          bounds.find((i) => i.initiativeId === initiativeId)?.newPoolBoundStops ?? 0,
        planShare: plans.find((i) => i.initiativeId === initiativeId)?.planShare ?? [],
        newPlanShare: plans.find((i) => i.initiativeId === initiativeId)?.newPlanShare ?? 0,
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

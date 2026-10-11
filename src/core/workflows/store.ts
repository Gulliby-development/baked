import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { writeViaTemp } from "./atomic-write.js";
import { WorkflowFault } from "./errors.js";
import type { PastRun } from "./estimate.js";
import { migration001 } from "./migrations/001.js";
import { migration002 } from "./migrations/002.js";
import { migration003 } from "./migrations/003.js";
import { migration004 } from "./migrations/004.js";
import { migration005 } from "./migrations/005.js";
import { migration006 } from "./migrations/006.js";
import { migration007 } from "./migrations/007.js";
import { migration008 } from "./migrations/008.js";
import {
  type AgentProfile,
  type CommandIdentity,
  EventSchema,
  type Reason,
  type RunPolicy,
  type RunSnapshot,
  type RunState,
  SafeId,
  type StageState,
  type TaskGraph,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "./schemas.js";
import { type RuntimeState, RuntimeStateSchema, type Snapshot } from "./types.js";
import type { WorkflowV2 } from "./v2/definition.js";

export const newId = (): string => randomUUID();
export interface RunRow {
  id: string;
  feature_id: string;
  parent_run_id: string | null;
  status: RunState;
  reason: Reason;
  revision: number;
  event_seq: number;
  stage_id: string | null;
  input_hash: string;
  approval_digest: string | null;
  definition_json: string;
  profiles_json: string;
  policy_json: string;
  input_manifest_json: string;
  repair_rounds: number;
  convergence_rounds: number;
  corrective_tasks: number;
  agent_calls: number;
  token_usage: number;
  active_ms: number;
  estimated_cost_microusd: number | null;
  /** Absent in a database a read-only reader left on migration 006. */
  project_id?: string | null;
  created_at: number;
  updated_at: number;
}
export interface ArtifactRow {
  run_id: string;
  id: string;
  kind: string;
  logical_path: string;
  revision: number;
  content_hash: string;
  byte_length: number;
  inline_content: string | null;
  blob_path: string | null;
}
export interface TaskRow {
  id: string;
  definition_json: string;
  status:
    | "pending"
    | "running"
    | "implemented"
    | "verified"
    | "blocked"
    | "failed"
    | "cancelled"
    | "invalidated"
    | "interrupted";
  generation: number;
  snapshot_id: string | null;
}
export interface RequestRow {
  id: string;
  kind: "approval" | "clarification" | "manual_evidence" | "recovery" | "checkpoint" | "delivery";
  status: string;
  digest: string;
  body_json: string;
  answer_json: string | null;
  actor: string | null;
}
/** A pending request of any run, or a blocked run, as `attention()` lists it. */
export interface AttentionRow {
  run_id: string;
  feature_id: string;
  status: RunState;
  /** Null for a blocked run. */
  request_id: string | null;
  /** The request kind, or the reason of a blocked run. */
  kind: string;
  /** Null for a blocked run. */
  body_json: string | null;
  created_at: number;
}
export interface EffectRow {
  id: string;
  attempt_id: string;
  kind: "file_patch" | "artifact_write" | "command" | "delivery";
  status: "prepared" | "applied" | "unknown" | "reconciled" | "failed";
  intent_json: string;
  before_hash: string | null;
  after_hash: string | null;
}
/**
 * A lease resource: the run that executes, the project's mutation lease, or the mutation lease of
 * one Git worktree (`worktree:` and its path relative to the project root).
 */
export type LeaseResource = "execution" | "mutation" | `worktree:${string}`;
export interface LeaseRow {
  resource: LeaseResource;
  owner_id: string;
  owner_epoch: number;
  run_id: string | null;
  expires_at: number;
  process_identity_json: string;
}
export interface EvidenceRow {
  id: string;
  kind: string;
  snapshot_id: string;
  artifact_id: string;
  validity: string;
}
export interface FindingRow {
  id: string;
  fingerprint: string;
  body_json: string;
  status: "open" | "confirmed" | "refuted" | "resolved" | "inconclusive";
  repair_task_id: string | null;
}
export interface CheckDetailRow {
  check_id: string;
  status: string;
  exit_code: number | null;
  reason: string;
  duration_ms: number;
  validity: string;
  artifact_id: string;
}
export interface StepRow {
  id: string;
  stage_id: string;
  parent_step_id: string | null;
  generation: number;
  status: StageState;
}
export interface AttemptRow {
  id: string;
  step_id: string;
  /** The model the attempt ran on; null for host attempts. */
  model_id: string | null;
  status: string;
  reserved_tokens: number;
  used_tokens: number | null;
  usage_complete: number;
  input_hash: string;
  started_at: number;
}
type EventInput = WorkflowEvent extends infer E
  ? E extends WorkflowEvent
    ? { type: E["type"]; payload: E["payload"] }
    : never
  : never;

const MIGRATIONS = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
  { version: 4, sql: migration004 },
  { version: 5, sql: migration005 },
  { version: 6, sql: migration006 },
  { version: 7, sql: migration007 },
  { version: 8, sql: migration008 },
] as const;

export class WorkflowStore {
  private readonly db: Database;
  readonly path: string;
  /** Observes appended events; invoked before the surrounding transaction commits. */
  onEvent: ((event: WorkflowEvent) => void) | null = null;
  /** Further observers of appended events, called like `onEvent`; see `observe`. */
  private readonly observers = new Set<(event: WorkflowEvent) => void>();
  constructor(
    readonly workspace: string,
    readonly readonly = false,
  ) {
    this.path = workspacePath(workspace, ".baked/workflows.sqlite");
    if (readonly && !existsSync(this.path))
      throw new WorkflowFault("NOT_FOUND", "No workflow database in this workspace");
    if (!readonly) mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path, { readonly, create: !readonly, strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      if (!readonly) this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const table = this.db
        .query("SELECT name FROM sqlite_master WHERE name='schema_migrations'")
        .get();
      if (!table) {
        if (readonly)
          throw new WorkflowFault("VERSION_UNSUPPORTED", "Missing workflow migration metadata");
        this.transaction(() => this.applyMigrations(0));
      }
      const applied = this.db
        .query<{ version: number; checksum: string }, []>(
          "SELECT version,checksum FROM schema_migrations ORDER BY version",
        )
        .all();
      // Every applied migration must be one this build knows, unchanged and in order.
      if (
        applied.length === 0 ||
        applied.length > MIGRATIONS.length ||
        applied.some(
          (row, i) => row.version !== i + 1 || row.checksum !== hashBytes(MIGRATIONS[i]?.sql ?? ""),
        )
      )
        throw new WorkflowFault(
          "VERSION_UNSUPPORTED",
          "Workflow schema version or checksum mismatch. Preserve the database and use a compatible reader.",
        );
      // A reader opened for status or export tolerates an older schema; only a writer upgrades it.
      if (applied.length < MIGRATIONS.length && !readonly)
        this.transaction(() => this.applyMigrations(applied.length));
      const integrity = this.db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
      if (integrity?.quick_check !== "ok")
        throw new WorkflowFault("STORAGE_CORRUPT", "Workflow database integrity check failed");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /**
   * What runs spent, per stage and per task; the input of the spend estimator. With an ID, only
   * that run (the one being shown reads its own spend fresh).
   */
  history(only?: string): PastRun[] {
    const runs = this.db
      .query<
        {
          id: string;
          workflow_id: string | null;
          status: string;
          token_usage: number;
          agent_calls: number;
          active_ms: number;
        },
        []
      >(
        "SELECT id,json_extract(definition_json,'$.id') AS workflow_id,status,token_usage,agent_calls,active_ms FROM runs WHERE status<>'created' ORDER BY created_at DESC LIMIT 200",
      )
      .all()
      .filter((r) => only === undefined || r.id === only);
    const byRun = new Map<string, PastRun>(
      runs.map((r) => [
        r.id,
        {
          runId: r.id,
          workflowId: r.workflow_id,
          status: r.status,
          tokens: r.token_usage,
          calls: r.agent_calls,
          activeMs: r.active_ms,
          taskCount: 0,
          stageTokens: {},
          taskTokens: 0,
        },
      ]),
    );
    // Child steps (tasks, review dimensions, skeptics) belong to the stage of their parent step.
    for (const row of this.db
      .query<{ run_id: string; stage: string; leaf: string; tokens: number }, []>(
        `SELECT a.run_id AS run_id, COALESCE(p.stage_id, s.stage_id) AS stage, s.stage_id AS leaf,
           SUM(CASE WHEN a.usage_complete=1 THEN COALESCE(a.used_tokens,0) ELSE 0 END) AS tokens
         FROM attempts a JOIN steps s ON s.run_id=a.run_id AND s.id=a.step_id
         LEFT JOIN steps p ON p.run_id=s.run_id AND p.id=s.parent_step_id
         WHERE a.model_id IS NOT NULL GROUP BY a.run_id, stage, leaf`,
      )
      .all()) {
      const past = byRun.get(row.run_id);
      if (!past) continue;
      past.stageTokens[row.stage] = (past.stageTokens[row.stage] ?? 0) + row.tokens;
      if (row.leaf.startsWith("task-")) past.taskTokens += row.tokens;
    }
    for (const row of this.db
      .query<{ run_id: string; n: number }, []>(
        "SELECT run_id, COUNT(*) AS n FROM tasks WHERE status<>'invalidated' GROUP BY run_id",
      )
      .all()) {
      const past = byRun.get(row.run_id);
      if (past) past.taskCount = row.n;
    }
    return [...byRun.values()];
  }
  /** Runs past creation, newest first, with their policy; the input of project memory. */
  pastRuns(limit = 30): { id: string; status: string; policy_json: string }[] {
    return this.db
      .query<{ id: string; status: string; policy_json: string }, [number]>(
        "SELECT id,status,policy_json FROM runs WHERE status<>'created' ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit);
  }
  private applyMigrations(from: number): void {
    for (const migration of MIGRATIONS.slice(from)) {
      this.db.exec(migration.sql);
      this.db.run("INSERT INTO schema_migrations VALUES (?,?,?)", [
        migration.version,
        hashBytes(migration.sql),
        Date.now(),
      ]);
    }
  }
  close(): void {
    this.db.close();
  }
  /** The connection, for records kept next to runs in the same database (initiatives). */
  get connection(): Database {
    return this.db;
  }
  /** The schema version this database is at. A reader may be opened on an older one. */
  schemaVersion(): number {
    return (
      this.db
        .query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations")
        .get()?.v ?? 0
    );
  }
  transaction<T>(action: () => T): T {
    return this.db.transaction(action).immediate();
  }
  readTransaction<T>(action: () => T): T {
    return this.db.transaction(action).deferred();
  }
  run(id: string): RunRow {
    SafeId.parse(id);
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(id);
    if (!row) throw new WorkflowFault("NOT_FOUND", `Unknown run ${id}`);
    return row;
  }
  state(id: string): RuntimeState {
    const artifact = this.latestArtifact(id, "internal/state.json");
    if (!artifact) throw new WorkflowFault("ARTIFACT_MISSING", "Run state artifact missing");
    return RuntimeStateSchema.parse(JSON.parse(this.readArtifact(id, artifact.id)));
  }
  snapshot(id: string): RunSnapshot {
    return this.db.transaction(() => this.readSnapshot(id)).deferred();
  }
  private readSnapshot(id: string): RunSnapshot {
    const row = this.run(id);
    const projection = this.latestArtifact(id, "internal/projection.json");
    const state = projection?.inline_content
      ? (JSON.parse(projection.inline_content) as Pick<
          RuntimeState,
          "workspaceHash" | "verificationState"
        >)
      : this.state(id);
    return {
      runId: id,
      featureId: row.feature_id,
      status: row.status,
      reason: row.reason,
      revision: row.revision,
      eventSeq: row.event_seq,
      stageId: row.stage_id,
      approvalDigest: row.approval_digest,
      inputHash: row.input_hash,
      workspaceHash: state.workspaceHash,
      tokenUsage: row.token_usage,
      activeMs: row.active_ms,
      estimatedCostUsd:
        row.estimated_cost_microusd === null ? null : row.estimated_cost_microusd / 1e6,
      verificationState: state.verificationState,
      pendingRequestIds: this.requests(id)
        .filter((r) => r.status === "pending")
        .map((r) => r.id),
      ...(row.project_id ? { projectId: row.project_id } : {}),
    };
  }
  /** The latest runs of a project, newest first; none in a database older than migration 007. */
  /** How many runs are in each state, for overviews that do not need the runs themselves. */
  statusCounts(): Partial<Record<RunState, number>> {
    const counts: Partial<Record<RunState, number>> = {};
    for (const row of this.db
      .query<{ status: RunState; n: number }, []>(
        "SELECT status, COUNT(*) AS n FROM runs GROUP BY status",
      )
      .all())
      counts[row.status] = row.n;
    return counts;
  }
  projectRuns(projectId: string, limit = 20): RunSnapshot[] {
    const columns = this.db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('runs')")
      .all();
    if (!columns.some((c) => c.name === "project_id")) return [];
    return this.db
      .query<{ id: string }, [string, number]>(
        "SELECT id FROM runs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
      )
      .all(projectId, limit)
      .map((r) => this.snapshot(r.id));
  }
  list(
    limit: number,
    featureId?: string,
    status?: RunState,
    cursor?: string,
  ): { items: RunSnapshot[]; cursor?: string } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new WorkflowFault("INVALID_DEFINITION", "limit must be 1..100");
    const after = cursor ? this.run(cursor) : null;
    const rows = this.db
      .query<
        RunRow,
        [
          string | null,
          string | null,
          RunState | null,
          RunState | null,
          number | null,
          number | null,
          string | null,
          number,
        ]
      >(
        "SELECT * FROM runs WHERE (? IS NULL OR feature_id=?) AND (? IS NULL OR status=?) AND (? IS NULL OR (created_at,id)<(?,?)) ORDER BY created_at DESC,id DESC LIMIT ?",
      )
      .all(
        featureId ?? null,
        featureId ?? null,
        status ?? null,
        status ?? null,
        after?.created_at ?? null,
        after?.created_at ?? null,
        cursor ?? null,
        limit + 1,
      );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => this.snapshot(r.id)),
      ...(rows.length > limit ? { cursor: page.at(-1)?.id } : {}),
    };
  }
  previousCommand(commandId: string, body: unknown): RunSnapshot | undefined {
    SafeId.parse(commandId);
    const row = this.db
      .query<{ request_hash: string; result_json: string }, [string]>(
        "SELECT request_hash,result_json FROM commands WHERE id=?",
      )
      .get(commandId);
    if (!row) return undefined;
    if (row.request_hash !== hashJson(body))
      throw new WorkflowFault(
        "COMMAND_CONFLICT",
        "Command ID was already used for different input",
      );
    return JSON.parse(row.result_json) as RunSnapshot;
  }
  saveCommand(commandId: string, body: unknown, result: RunSnapshot): void {
    this.db.run("INSERT INTO commands VALUES (?,?,?,?,?)", [
      commandId,
      result.runId,
      hashJson(body),
      canonical(result),
      Date.now(),
    ]);
  }
  command(runId: string, command: CommandIdentity, body: unknown, action: () => void): RunSnapshot {
    return this.transaction(() => {
      const previous = this.previousCommand(command.commandId, body);
      if (previous) return previous;
      this.bump(runId, command.expectedRevision);
      action();
      const snapshot = this.snapshot(runId);
      this.saveCommand(command.commandId, body, snapshot);
      return snapshot;
    });
  }
  bump(runId: string, expected: number): void {
    const update = this.db.run(
      "UPDATE runs SET revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      [Date.now(), runId, expected],
    );
    if (update.changes !== 1)
      throw new WorkflowFault("REVISION_CONFLICT", "Run revision changed", {
        expected,
        actual: this.run(runId).revision,
      });
  }
  create(
    id: string,
    featureId: string,
    definition: WorkflowDefinition | WorkflowV2,
    profiles: AgentProfile[],
    policy: RunPolicy,
    state: RuntimeState,
    parent: string | null = null,
    projectId: string | null = null,
  ): void {
    SafeId.parse(id);
    SafeId.parse(featureId);
    this.db.run("INSERT OR IGNORE INTO features VALUES (?,?,?)", [
      featureId,
      `specs/${featureId}`,
      Date.now(),
    ]);
    this.db.run(
      "INSERT INTO runs (id,feature_id,parent_run_id,project_id,status,definition_json,profiles_json,policy_json,input_manifest_json,input_hash,created_at,updated_at) VALUES (?,?,?,?,'created',?,?,?,?,?,?,?)",
      [
        id,
        featureId,
        parent,
        projectId,
        canonical(definition),
        canonical(profiles),
        canonical(policy),
        canonical(state.manifest),
        hashJson(state.manifest),
        Date.now(),
        Date.now(),
      ],
    );
    this.saveState(id, state);
    this.emit(id, {
      type: "run.created",
      payload: {
        featureId,
        inputHash: hashJson(state.manifest),
        ...(projectId ? { projectId } : {}),
      },
    });
  }
  saveState(id: string, state: RuntimeState): void {
    RuntimeStateSchema.parse(state);
    this.artifact(id, "state", "internal/state.json", canonical(state));
    this.artifact(
      id,
      "state",
      "internal/projection.json",
      canonical({ workspaceHash: state.workspaceHash, verificationState: state.verificationState }),
    );
    this.db.run("UPDATE runs SET input_manifest_json=?,input_hash=? WHERE id=?", [
      canonical(state.manifest),
      hashJson(state.manifest),
      id,
    ]);
  }
  transition(id: string, status: RunState, reason: Reason = "none"): void {
    const row = this.run(id);
    this.bump(id, row.revision);
    this.db.run("UPDATE runs SET status=?,reason=?,updated_at=? WHERE id=?", [
      status,
      reason,
      Date.now(),
      id,
    ]);
    this.emit(id, {
      type: "run.state_changed",
      payload: { from: row.status, to: status, reason, revision: row.revision + 1 },
    });
  }
  setApproval(id: string, digest: string | null): void {
    this.db.run("UPDATE runs SET approval_digest=? WHERE id=?", [digest, id]);
  }
  /** Replaces a started run's definition; only an applied definition revision (V2-11) does this. */
  setDefinition(id: string, definition: unknown): void {
    this.db.run("UPDATE runs SET definition_json=? WHERE id=?", [canonical(definition), id]);
  }
  setPolicy(id: string, policy: RunPolicy): void {
    this.db.run("UPDATE runs SET policy_json=? WHERE id=?", [canonical(policy), id]);
  }
  emit(runId: string, event: EventInput): WorkflowEvent {
    const seq = this.run(runId).event_seq + 1;
    const value = EventSchema.parse({
      schemaVersion: 1,
      eventId: newId(),
      runId,
      seq,
      at: new Date().toISOString(),
      ...event,
    });
    this.db.run("INSERT INTO events VALUES (?,?,?,?,?,?)", [
      runId,
      seq,
      value.eventId,
      value.type,
      Date.parse(value.at),
      canonical(value.payload),
    ]);
    this.db.run("UPDATE runs SET event_seq=? WHERE id=?", [seq, runId]);
    this.onEvent?.(value);
    for (const observer of this.observers) observer(value);
    return value;
  }
  /** Adds an observer of appended events next to `onEvent`; the returned function removes it. */
  observe(observer: (event: WorkflowEvent) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  events(id: string, after = 0, limit = 200): WorkflowEvent[] {
    return this.db
      .query<
        { id: string; seq: number; at: number; type: string; payload_json: string },
        [string, number, number]
      >("SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(id, after, limit)
      .map((r) =>
        EventSchema.parse({
          schemaVersion: 1,
          eventId: r.id,
          runId: id,
          seq: r.seq,
          at: new Date(r.at).toISOString(),
          type: r.type,
          payload: JSON.parse(r.payload_json),
        }),
      );
  }
  artifacts(id: string): ArtifactRow[] {
    return this.db
      .query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at,id")
      .all(id);
  }
  latestArtifact(id: string, path: string): ArtifactRow | null {
    return this.db
      .query<ArtifactRow, [string, string]>(
        "SELECT * FROM artifacts WHERE run_id=? AND logical_path=? ORDER BY revision DESC LIMIT 1",
      )
      .get(id, path);
  }
  artifact(id: string, kind: string, path: string, content: string): ArtifactRow {
    const bytes = Buffer.byteLength(content);
    if (bytes > 10 * 1024 * 1024)
      throw new WorkflowFault("BUDGET_EXHAUSTED", "Artifact exceeds 10 MiB cap");
    const total =
      this.db
        .query<{ bytes: number }, [string]>(
          "SELECT COALESCE(SUM(byte_length),0) AS bytes FROM artifacts WHERE run_id=?",
        )
        .get(id)?.bytes ?? 0;
    if (total + bytes > 100 * 1024 * 1024)
      throw new WorkflowFault("BUDGET_EXHAUSTED", "Run evidence exceeds 100 MiB cap");
    const hash = hashBytes(content);
    let blob: string | null = null;
    if (bytes > 256 * 1024) {
      blob = join(".baked", "workflow-runs", id, "blobs", hash);
      const target = workspacePath(this.workspace, blob.replaceAll("\\", "/"));
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) {
        writeViaTemp(target, content, { flag: "wx", flush: true, mode: 0o600 });
      }
    }
    const row: ArtifactRow = {
      run_id: id,
      id: newId(),
      kind,
      logical_path: path,
      revision: (this.latestArtifact(id, path)?.revision ?? 0) + 1,
      content_hash: hash,
      byte_length: bytes,
      inline_content: blob ? null : content,
      blob_path: blob,
    };
    this.db.run("INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?)", [
      id,
      row.id,
      kind,
      path,
      row.revision,
      hash,
      bytes,
      row.inline_content,
      blob,
      Date.now(),
    ]);
    if (kind !== "state")
      this.emit(id, { type: "artifact.committed", payload: { artifactId: row.id, kind, hash } });
    return row;
  }
  readArtifact(runId: string, id: string): string {
    const row = this.db
      .query<ArtifactRow, [string, string]>("SELECT * FROM artifacts WHERE run_id=? AND id=?")
      .get(runId, id);
    if (!row) throw new WorkflowFault("ARTIFACT_MISSING", `Missing artifact ${id}`);
    let content: string;
    try {
      content =
        row.inline_content ??
        readFileSync(
          workspacePath(this.workspace, (row.blob_path ?? "").replaceAll("\\", "/")),
          "utf8",
        );
    } catch {
      throw new WorkflowFault("ARTIFACT_MISSING", `Missing blob for ${id}`);
    }
    if (hashBytes(content) !== row.content_hash)
      throw new WorkflowFault("ARTIFACT_MISSING", `Artifact hash mismatch ${id}`);
    return content;
  }
  putSnapshot(runId: string, files: Record<string, string>): Snapshot {
    const hash = hashJson(files);
    const existing = this.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM workspace_snapshots WHERE run_id=? AND manifest_hash=?",
      )
      .get(runId, hash);
    const id = existing?.id ?? newId();
    if (!existing)
      this.db.run("INSERT INTO workspace_snapshots VALUES (?,?,?,?,NULL,?)", [
        runId,
        id,
        hash,
        canonical(files),
        Date.now(),
      ]);
    return { id, hash, files };
  }
  /** The file manifest of one stored workspace snapshot, or null when the run has no such snapshot. */
  snapshotFiles(runId: string, snapshotId: string): Record<string, string> | null {
    const row = this.db
      .query<{ manifest_json: string }, [string, string]>(
        "SELECT manifest_json FROM workspace_snapshots WHERE run_id=? AND id=?",
      )
      .get(runId, snapshotId);
    return row ? (JSON.parse(row.manifest_json) as Record<string, string>) : null;
  }
  request(runId: string, kind: RequestRow["kind"], digest: string, body: unknown): string {
    const id = newId();
    this.db.run(
      "INSERT INTO requests (run_id,id,kind,status,digest,body_json) VALUES (?,?,?,'pending',?,?)",
      [runId, id, kind, digest, canonical(body)],
    );
    this.emit(runId, { type: "request.created", payload: { requestId: id, kind, digest } });
    return id;
  }
  requests(id: string): RequestRow[] {
    return this.db
      .query<RequestRow, [string]>("SELECT * FROM requests WHERE run_id=? ORDER BY rowid")
      .all(id);
  }
  decideRequest(
    runId: string,
    id: string,
    status: "accepted" | "rejected" | "superseded",
    answer: unknown,
    automatic = false,
  ): void {
    const actor = automatic
      ? "auto-approval"
      : status === "superseded"
        ? "system-invalidation"
        : "user";
    const result = this.db.run(
      "UPDATE requests SET status=?,answer_json=?,actor=?,decided_at=? WHERE run_id=? AND id=? AND status='pending'",
      [status, canonical(answer), actor, Date.now(), runId, id],
    );
    if (result.changes !== 1)
      throw new WorkflowFault("STALE_DECISION", "Request is no longer pending");
    this.emit(runId, { type: "request.decided", payload: { requestId: id, status, actor } });
  }
  /**
   * Everything that waits for a person across all runs, oldest first: every pending request of a
   * run that can still act on it, and every blocked run. Requests have no timestamp of their own,
   * so a request is dated by its `request.created` event and a blocked run by its last change.
   */
  attention(): AttentionRow[] {
    return this.db
      .query<AttentionRow, []>(
        `SELECT q.run_id AS run_id, r.feature_id AS feature_id, r.status AS status,
           q.id AS request_id, q.kind AS kind, q.body_json AS body_json,
           COALESCE((SELECT e.at FROM events e WHERE e.run_id=q.run_id AND e.type='request.created'
             AND json_extract(e.payload_json,'$.requestId')=q.id), r.updated_at) AS created_at
         FROM requests q JOIN runs r ON r.id=q.run_id
         WHERE q.status='pending' AND r.status NOT IN ('cancelled','failed')
         UNION ALL
         SELECT id, feature_id, status, NULL, reason, NULL, updated_at FROM runs WHERE status='blocked'
         ORDER BY created_at, run_id, request_id`,
      )
      .all();
  }
  /**
   * The attention rows nobody announced yet, each marked announced in the same transaction, so of
   * several processes sharing the database exactly one announces a request. A blocked run is keyed
   * by the event that blocked it, so a run blocked again later is announced again.
   */
  claimAttention(): AttentionRow[] {
    const blockedBy = this.db.query<{ seq: number | null }, [string]>(
      "SELECT MAX(seq) AS seq FROM events WHERE run_id=? AND type='run.state_changed'",
    );
    return this.transaction(() =>
      this.attention().filter((row) => {
        const key = row.request_id
          ? `request:${row.request_id}`
          : `blocked:${row.run_id}:${String(blockedBy.get(row.run_id)?.seq ?? 0)}`;
        return (
          this.db.run("INSERT OR IGNORE INTO attention_notices VALUES (?,?)", [key, Date.now()])
            .changes === 1
        );
      }),
    );
  }
  tasks(runId: string): TaskRow[] {
    return this.db
      .query<TaskRow, [string]>("SELECT * FROM tasks WHERE run_id=? ORDER BY rowid")
      .all(runId);
  }
  /**
   * Stores the task graph. With `invalidate`, every task is invalidated except those in `keep`,
   * which stay implemented on the snapshot they were implemented on; their check gates are the
   * caller's to clear, so their task checks run again.
   */
  syncTasks(
    runId: string,
    graph: TaskGraph,
    invalidate = false,
    keep: ReadonlySet<string> = new Set(),
  ): void {
    if (invalidate) {
      const previous = this.findings(runId);
      if (previous.length)
        this.artifact(
          runId,
          "revision-history",
          `revisions/${newId()}/findings.json`,
          canonical(previous),
        );
      this.db.run("DELETE FROM findings WHERE run_id=?", [runId]);
      for (const task of this.tasks(runId))
        if (!graph.tasks.some((t) => t.id === task.id))
          this.taskStatus(runId, task.id, "cancelled");
    }
    const rows = new Map(this.tasks(runId).map((row) => [row.id, row]));
    for (const task of graph.tasks) {
      this.db.run(
        "INSERT INTO tasks (run_id,id,definition_json,definition_hash,status,updated_at) VALUES (?,?,?,?,'pending',?) ON CONFLICT(run_id,id) DO UPDATE SET definition_json=excluded.definition_json,definition_hash=excluded.definition_hash",
        [runId, task.id, canonical(task), hashJson(task), Date.now()],
      );
      const kept = keep.has(task.id) ? rows.get(task.id)?.snapshot_id : null;
      if (invalidate && kept) this.taskStatus(runId, task.id, "implemented", kept);
      else if (invalidate) this.taskStatus(runId, task.id, "invalidated");
    }
    this.db.run("DELETE FROM task_dependencies WHERE run_id=?", [runId]);
    for (const task of graph.tasks)
      for (const dep of task.dependsOn)
        this.db.run("INSERT INTO task_dependencies VALUES (?,?,?)", [runId, task.id, dep]);
  }
  taskStatus(
    runId: string,
    id: string,
    status: TaskRow["status"],
    snapshotId: string | null = null,
  ): void {
    const row = this.tasks(runId).find((t) => t.id === id);
    if (!row) throw new WorkflowFault("NOT_FOUND", `Task ${id} missing`);
    const generation = row.generation + (status === "invalidated" ? 1 : 0);
    this.db.run(
      "UPDATE tasks SET status=?,generation=?,snapshot_id=?,updated_at=? WHERE run_id=? AND id=?",
      [status, generation, snapshotId, Date.now(), runId, id],
    );
    this.emit(runId, {
      type: "task.state_changed",
      payload: { taskId: id, from: row.status, to: status, generation },
    });
  }
  /** The stage of a step's top-level ancestor: the definition stage a child step belongs to. */
  rootStage(runId: string, stepId: string): string | null {
    let id: string | null = stepId;
    for (let depth = 0; id && depth < 16; depth++) {
      const row: { stage_id: string; parent_step_id: string | null } | null = this.db
        .query<{ stage_id: string; parent_step_id: string | null }, [string, string]>(
          "SELECT stage_id,parent_step_id FROM steps WHERE run_id=? AND id=?",
        )
        .get(runId, id);
      if (!row) return null;
      if (!row.parent_step_id) return row.stage_id;
      id = row.parent_step_id;
    }
    return null;
  }
  beginStep(runId: string, stageId: string, parent: string | null = null): string {
    const generation =
      (this.db
        .query<{ n: number | null }, [string, string]>(
          "SELECT MAX(generation) AS n FROM steps WHERE run_id=? AND stage_id=?",
        )
        .get(runId, stageId)?.n ?? -1) + 1;
    const id = newId();
    this.db.run(
      "INSERT INTO steps (run_id,id,stage_id,parent_step_id,generation,status,input_hash) VALUES (?,?,?,?,?,'running',?)",
      [runId, id, stageId, parent, generation, this.run(runId).input_hash],
    );
    if (!parent) this.db.run("UPDATE runs SET stage_id=? WHERE id=?", [stageId, runId]);
    this.emit(runId, { type: "stage.started", payload: { stepId: id, stageId, generation } });
    return id;
  }
  /**
   * A step and attempt outside the workflow definition for actions taken after a run ended (Git
   * delivery), so their effects join the run's journal. The run's current stage is not changed.
   */
  beginExternalAttempt(runId: string, stageId: string): { stepId: string; attemptId: string } {
    const generation =
      (this.db
        .query<{ n: number | null }, [string, string]>(
          "SELECT MAX(generation) AS n FROM steps WHERE run_id=? AND stage_id=?",
        )
        .get(runId, stageId)?.n ?? -1) + 1;
    const stepId = newId();
    const attemptId = newId();
    const inputHash = this.run(runId).input_hash;
    this.db.run(
      "INSERT INTO steps (run_id,id,stage_id,parent_step_id,generation,status,input_hash) VALUES (?,?,?,NULL,?,'running',?)",
      [runId, stepId, stageId, generation, inputHash],
    );
    this.emit(runId, { type: "stage.started", payload: { stepId, stageId, generation } });
    this.db.run(
      "INSERT INTO attempts (run_id,id,step_id,ordinal,model_id,status,input_hash,reserved_tokens,started_at) VALUES (?,?,?,1,NULL,'running',?,0,?)",
      [runId, attemptId, stepId, inputHash, Date.now()],
    );
    this.emit(runId, { type: "attempt.started", payload: { attemptId, stepId, modelId: null } });
    return { stepId, attemptId };
  }
  finishStep(
    runId: string,
    id: string,
    status: StageState,
    artifactId: string | null = null,
  ): void {
    this.db.run("UPDATE steps SET status=?,output_artifact_id=? WHERE run_id=? AND id=?", [
      status,
      artifactId,
      runId,
      id,
    ]);
    this.emit(runId, { type: "stage.finished", payload: { stepId: id, status, artifactId } });
  }
  steps(runId: string): StepRow[] {
    return this.db
      .query<StepRow, [string]>(
        "SELECT id,stage_id,parent_step_id,generation,status FROM steps WHERE run_id=? ORDER BY rowid",
      )
      .all(runId);
  }
  /** Runs with an attempt that started at or after `since`, newest first. */
  runIdsWithAttemptsSince(since: number): string[] {
    return this.db
      .query<{ run_id: string }, [number]>(
        "SELECT run_id FROM attempts WHERE started_at>=? GROUP BY run_id ORDER BY MAX(started_at) DESC",
      )
      .all(since)
      .map((row) => row.run_id);
  }
  attempts(runId: string): AttemptRow[] {
    return this.db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id=?").all(runId);
  }
  /**
   * The token count the run may not pass without a decision, or null without soft checkpoints.
   * Each accepted checkpoint moves the next one a full interval beyond what had been used.
   */
  checkpointBoundary(runId: string, policy: RunPolicy): number | null {
    const interval = policy.checkpointTokens;
    if (!interval) return null;
    let boundary = interval;
    for (const request of this.requests(runId))
      if (request.kind === "checkpoint" && request.status === "accepted") {
        const body = JSON.parse(request.body_json) as {
          usedTokens?: number;
          projectedTokens?: number;
        };
        // Past the step that triggered it, so a step larger than the interval still fits next time.
        boundary = Math.max(boundary, body.projectedTokens ?? body.usedTokens ?? 0) + interval;
      }
    return boundary;
  }
  private assertBelowCheckpoint(runId: string, policy: RunPolicy, projected: number): void {
    const boundary = this.checkpointBoundary(runId, policy);
    if (boundary !== null && projected > boundary)
      throw new WorkflowFault(
        "CHECKPOINT_REACHED",
        `The next step would pass the token checkpoint at ${boundary}`,
        { reason: "checkpoint", boundary, projected, interval: policy.checkpointTokens },
      );
  }
  reserve(
    runId: string,
    stepId: string,
    modelId: string | null,
    tokens: number,
    policy: RunPolicy,
  ): string {
    return this.transaction(() => {
      const row = this.run(runId);
      const reserved = this.attempts(runId)
        .filter((a) => !a.usage_complete)
        .reduce((n, a) => n + a.reserved_tokens, 0);
      if (
        row.agent_calls >= policy.maxAgentCalls ||
        row.token_usage + reserved + tokens > policy.maxTotalTokens ||
        row.active_ms >= policy.maxActiveMs
      )
        throw new WorkflowFault("BUDGET_EXHAUSTED", "Run agent/token/time budget exhausted");
      this.assertBelowCheckpoint(runId, policy, row.token_usage + reserved + tokens);
      const id = newId();
      const ordinal = this.attempts(runId).filter((a) => a.step_id === stepId).length + 1;
      this.db.run(
        "INSERT INTO attempts (run_id,id,step_id,ordinal,model_id,status,input_hash,reserved_tokens,started_at) VALUES (?,?,?,?,?,'running',?,?,?)",
        [runId, id, stepId, ordinal, modelId, row.input_hash, tokens, Date.now()],
      );
      if (modelId) this.db.run("UPDATE runs SET agent_calls=agent_calls+1 WHERE id=?", [runId]);
      this.emit(runId, { type: "attempt.started", payload: { attemptId: id, stepId, modelId } });
      return id;
    });
  }
  /**
   * An attempt the host makes without a model, such as undoing the run's own file edits. It
   * reserves nothing and is not limited by the budget, so a run that stopped on its budget can
   * still restore the workspace.
   */
  beginHostAttempt(runId: string, stepId: string): string {
    return this.transaction(() => {
      const id = newId();
      const ordinal = this.attempts(runId).filter((a) => a.step_id === stepId).length + 1;
      this.db.run(
        "INSERT INTO attempts (run_id,id,step_id,ordinal,model_id,status,input_hash,reserved_tokens,started_at) VALUES (?,?,?,?,NULL,'running',?,0,?)",
        [runId, id, stepId, ordinal, this.run(runId).input_hash, Date.now()],
      );
      this.emit(runId, {
        type: "attempt.started",
        payload: { attemptId: id, stepId, modelId: null },
      });
      return id;
    });
  }
  finishAttempt(
    runId: string,
    id: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    usedTokens: number | null,
  ): void {
    const update = this.db.run(
      "UPDATE attempts SET status=?,used_tokens=?,usage_complete=?,ended_at=? WHERE run_id=? AND id=? AND status='running'",
      [status, usedTokens, usedTokens === null ? 0 : 1, Date.now(), runId, id],
    );
    if (update.changes !== 1)
      throw new WorkflowFault("REVISION_CONFLICT", "Attempt no longer running");
    this.db.run("UPDATE runs SET token_usage=token_usage+? WHERE id=?", [usedTokens ?? 0, runId]);
    this.emit(runId, {
      type: "attempt.finished",
      payload: { attemptId: id, status, usageComplete: usedTokens !== null, usedTokens },
    });
  }
  /**
   * Persist the tokens a running attempt has spent so far. The executor calls it after every
   * model step, so an attempt that fails, is cancelled or hits a cap still ends with its spend.
   */
  recordAttemptUsage(runId: string, attemptId: string, usedTokens: number): void {
    this.db.run("UPDATE attempts SET used_tokens=? WHERE run_id=? AND id=? AND status='running'", [
      Math.max(0, Math.ceil(usedTokens)),
      runId,
      attemptId,
    ]);
  }
  /** Tokens an executor recorded for the attempt so far, or null when none reported any. */
  recordedUsage(runId: string, attemptId: string): number | null {
    return this.attempts(runId).find((a) => a.id === attemptId)?.used_tokens ?? null;
  }
  /**
   * Tokens of the run's hard cap still free for one attempt: the limit less the counted spend
   * and the reservations of every other attempt whose usage is not final.
   */
  remainingTokens(runId: string, policy: RunPolicy, attemptId?: string): number {
    const run = this.run(runId);
    const reserved = this.attempts(runId)
      .filter((a) => !a.usage_complete && a.id !== attemptId)
      .reduce((sum, a) => sum + a.reserved_tokens, 0);
    return Math.max(0, policy.maxTotalTokens - run.token_usage - reserved);
  }
  expandReservation(runId: string, attemptId: string, tokens: number, policy: RunPolicy): void {
    this.transaction(() => {
      const run = this.run(runId);
      const reserved = this.attempts(runId)
        .filter((a) => !a.usage_complete && a.id !== attemptId)
        .reduce((sum, a) => sum + a.reserved_tokens, 0);
      if (run.status !== "running")
        throw new WorkflowFault("CAPABILITY_DENIED", "Run is no longer executing");
      if (run.token_usage + reserved + tokens > policy.maxTotalTokens)
        throw new WorkflowFault(
          "BUDGET_EXHAUSTED",
          "Next model step exceeds remaining token budget",
          {
            usedTokens: run.token_usage,
            reservedTokens: reserved,
            requestedTokens: tokens,
            maxTotalTokens: policy.maxTotalTokens,
          },
        );
      this.assertBelowCheckpoint(runId, policy, run.token_usage + reserved + tokens);
      this.db.run(
        "UPDATE attempts SET reserved_tokens=MAX(reserved_tokens,?) WHERE run_id=? AND id=? AND status='running'",
        [tokens, runId, attemptId],
      );
      this.emit(runId, {
        type: "budget.updated",
        payload: {
          usedTokens: run.token_usage,
          reservedTokens: reserved + tokens,
          activeMs: run.active_ms,
          estimatedCostUsd: null,
        },
      });
    });
  }
  addActiveTime(runId: string, ms: number): void {
    this.db.run("UPDATE runs SET active_ms=active_ms+? WHERE id=?", [
      Math.max(0, Math.ceil(ms)),
      runId,
    ]);
  }
  addRound(runId: string, kind: "repair" | "convergence", count: number): void {
    const column = kind === "repair" ? "repair_rounds" : "convergence_rounds";
    this.db.run(
      `UPDATE runs SET ${column}=${column}+1,corrective_tasks=corrective_tasks+? WHERE id=?`,
      [count, runId],
    );
  }
  evidence(runId: string): EvidenceRow[] {
    return this.db.query<EvidenceRow, [string]>("SELECT * FROM evidence WHERE run_id=?").all(runId);
  }
  addEvidence(
    runId: string,
    kind: "command" | "read" | "diff" | "review" | "manual",
    snapshotId: string,
    artifactId: string,
    attemptId: string | null = null,
  ): string {
    const id = newId();
    this.db.run("INSERT INTO evidence VALUES (?,?,?,?,?,?,'current',?)", [
      runId,
      id,
      kind,
      snapshotId,
      artifactId,
      attemptId,
      Date.now(),
    ]);
    return id;
  }
  checkResult(
    runId: string,
    checkId: string,
    evidenceId: string,
    status: "passed" | "failed" | "inconclusive",
    exit: number | null,
    reason: string,
    duration: number,
  ): void {
    this.db.run("INSERT INTO check_results VALUES (?,?,?,?,?,?,?,?)", [
      runId,
      newId(),
      checkId,
      evidenceId,
      status,
      exit,
      reason,
      duration,
    ]);
    this.emit(runId, { type: "check.finished", payload: { checkId, evidenceId, status } });
  }
  checks(runId: string): {
    check_id: string;
    evidence_id: string;
    status: string;
    snapshot_id: string;
    validity: string;
  }[] {
    return this.db
      .query<
        {
          check_id: string;
          evidence_id: string;
          status: string;
          snapshot_id: string;
          validity: string;
        },
        [string]
      >(
        "SELECT c.check_id,c.evidence_id,c.status,e.snapshot_id,e.validity FROM check_results c JOIN evidence e ON c.run_id=e.run_id AND c.evidence_id=e.id WHERE c.run_id=? ORDER BY c.rowid",
      )
      .all(runId);
  }
  /** Check results with their evidence artifact, oldest first. */
  checkDetails(runId: string): CheckDetailRow[] {
    return this.db
      .query<CheckDetailRow, [string]>(
        "SELECT c.check_id,c.status,c.exit_code,c.reason,c.duration_ms,e.validity,e.artifact_id FROM check_results c JOIN evidence e ON c.run_id=e.run_id AND c.evidence_id=e.id WHERE c.run_id=? ORDER BY c.rowid",
      )
      .all(runId);
  }
  invalidateEvidence(
    runId: string,
    snapshotId: string,
    reason: "input_changed" | "source_changed" | "evidence_missing" | "redacted",
  ): void {
    this.db.run("UPDATE evidence SET validity=? WHERE run_id=? AND snapshot_id=?", [
      reason === "redacted" || reason === "evidence_missing" ? "invalid" : "stale",
      runId,
      snapshotId,
    ]);
    this.emit(runId, { type: "snapshot.invalidated", payload: { snapshotId, reason } });
  }
  findings(runId: string): FindingRow[] {
    return this.db
      .query<FindingRow, [string]>("SELECT * FROM findings WHERE run_id=? ORDER BY rowid")
      .all(runId);
  }
  addFinding(
    runId: string,
    finding: { id: string },
    fingerprint: string,
    artifactId: string,
  ): string {
    const existing = this.findings(runId).find((f) => f.fingerprint === fingerprint);
    if (existing) {
      this.db.run(
        "UPDATE findings SET status='open',body_json=?,repair_task_id=NULL WHERE run_id=? AND id=?",
        [canonical({ ...finding, id: existing.id }), runId, existing.id],
      );
      this.emit(runId, {
        type: "finding.recorded",
        payload: { findingId: existing.id, artifactId },
      });
      return existing.id;
    }
    this.db.run(
      "INSERT INTO findings (run_id,id,fingerprint,body_json,status,created_at) VALUES (?,?,?,?,'open',?)",
      [runId, finding.id, fingerprint, canonical(finding), Date.now()],
    );
    this.emit(runId, { type: "finding.recorded", payload: { findingId: finding.id, artifactId } });
    return finding.id;
  }
  findingStatus(
    runId: string,
    id: string,
    status: FindingRow["status"],
    taskId: string | null = null,
  ): void {
    this.db.run(
      "UPDATE findings SET status=?,repair_task_id=COALESCE(?,repair_task_id) WHERE run_id=? AND id=?",
      [status, taskId, runId, id],
    );
  }
  criterion(
    runId: string,
    snapshotId: string,
    result: {
      criterionId: string;
      verdict: "pass" | "fail" | "inconclusive" | "deferred";
      evidenceIds: string[];
      explanation: string;
    },
  ): void {
    this.db.run("INSERT OR REPLACE INTO criterion_results VALUES (?,?,?,?,?,?)", [
      runId,
      result.criterionId,
      snapshotId,
      result.verdict,
      canonical(result.evidenceIds),
      result.explanation,
    ]);
    this.emit(runId, {
      type: "criterion.assessed",
      payload: { criterionId: result.criterionId, snapshotId, verdict: result.verdict },
    });
  }
  /** The most recent applied publication of a workspace file by any run, with that run's status. */
  lastPublication(path: string): { runId: string; status: string; afterHash: string } | null {
    return (
      this.db
        .query<{ runId: string; status: string; afterHash: string }, [string]>(
          `SELECT e.run_id AS runId, r.status AS status, e.after_hash AS afterHash
             FROM effects e JOIN runs r ON r.id = e.run_id
            WHERE e.kind = 'artifact_write' AND e.status IN ('applied','reconciled')
              AND e.after_hash IS NOT NULL AND json_extract(e.intent_json, '$.path') = ?
              AND json_extract(e.intent_json, '$.root') IS NULL
            ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
        )
        .get(path) ?? null
    );
  }
  prepareEffect(
    runId: string,
    attemptId: string,
    kind: EffectRow["kind"],
    intent: unknown,
    before: string | null,
    after: string | null,
  ): string {
    const id = newId();
    this.db.run("INSERT INTO effects VALUES (?,?,?,?,'prepared',?,?,?,?)", [
      runId,
      id,
      attemptId,
      kind,
      canonical(intent),
      before,
      after,
      Date.now(),
    ]);
    return id;
  }
  effects(runId: string): EffectRow[] {
    return this.db
      .query<EffectRow, [string]>("SELECT * FROM effects WHERE run_id=? ORDER BY rowid")
      .all(runId);
  }
  finishFileEffect(runId: string, id: string, afterHash: string | null): void {
    this.db.run("UPDATE effects SET after_hash=? WHERE run_id=? AND id=? AND kind='file_patch'", [
      afterHash,
      runId,
      id,
    ]);
    this.effectStatus(runId, id, "applied");
  }
  recordProcess(runId: string, effectId: string, pid: number, scope?: string): void {
    const effect = this.effects(runId).find((e) => e.id === effectId);
    if (effect?.kind !== "command")
      throw new WorkflowFault("NOT_FOUND", "Command intent missing before spawn");
    this.db.run("UPDATE effects SET intent_json=? WHERE run_id=? AND id=?", [
      canonical({
        ...JSON.parse(effect.intent_json),
        pid,
        spawnedAt: Date.now(),
        ...(scope ? { scope } : {}),
      }),
      runId,
      effectId,
    ]);
  }
  effectStatus(runId: string, id: string, status: Exclude<EffectRow["status"], "prepared">): void {
    this.db.run("UPDATE effects SET status=? WHERE run_id=? AND id=?", [status, runId, id]);
    this.emit(runId, { type: "effect.reconciled", payload: { effectId: id, status } });
  }
  lease(resource: LeaseRow["resource"]): LeaseRow | null {
    return this.db
      .query<LeaseRow, [string]>("SELECT * FROM workspace_leases WHERE resource=?")
      .get(resource);
  }
  /** Every lease row, in resource order. */
  leases(): LeaseRow[] {
    return this.db.query<LeaseRow, []>("SELECT * FROM workspace_leases ORDER BY resource").all();
  }
  putLease(lease: LeaseRow): void {
    this.db.run("INSERT OR REPLACE INTO workspace_leases VALUES (?,?,?,?,?,?)", [
      lease.resource,
      lease.owner_id,
      lease.owner_epoch,
      lease.run_id,
      lease.expires_at,
      lease.process_identity_json,
    ]);
  }
  releaseLease(resource: LeaseRow["resource"], owner: string, epoch: number): void {
    this.db.run("DELETE FROM workspace_leases WHERE resource=? AND owner_id=? AND owner_epoch=?", [
      resource,
      owner,
      epoch,
    ]);
  }
  collectGarbage(before: string, dryRun: boolean): { runIds: string[]; bytes: number } {
    const date = Date.parse(before);
    if (!Number.isFinite(date))
      throw new WorkflowFault("INVALID_DEFINITION", "Expected an ISO date for retention");
    const threshold = Math.min(date, Date.now() - 30 * 24 * 3600 * 1000);
    const rows = this.db
      .query<{ id: string; bytes: number }, [number]>(
        "SELECT r.id,COALESCE((SELECT SUM(byte_length) FROM artifacts a WHERE a.run_id=r.id),0) AS bytes FROM runs r WHERE r.status IN ('completed','failed','cancelled') AND r.updated_at<? AND NOT EXISTS(SELECT 1 FROM runs child WHERE child.parent_run_id=r.id) AND NOT EXISTS(SELECT 1 FROM workspace_leases l WHERE l.run_id=r.id) AND NOT EXISTS(SELECT 1 FROM initiative_runs i WHERE i.run_id=r.id) AND NOT EXISTS(SELECT 1 FROM initiatives n WHERE n.decompose_run_id=r.id)",
      )
      .all(threshold);
    if (!dryRun)
      for (const row of rows) {
        const directory = workspacePath(
          this.workspace,
          `.baked/workflow-runs/${SafeId.parse(row.id)}`,
        );
        this.transaction(() => {
          for (const table of [
            "criterion_results",
            "check_results",
            "findings",
            "evidence",
            "effects",
            "attempts",
            "steps",
            "task_dependencies",
            "tasks",
            "requests",
            "events",
            "commands",
            "artifacts",
            "workspace_snapshots",
          ])
            this.db.run(`DELETE FROM ${table} WHERE run_id=?`, [row.id]);
          this.db.run("DELETE FROM runs WHERE id=?", [row.id]);
        });
        SafeId.parse(row.id);
        rmSync(directory, {
          recursive: true,
          force: true,
        });
      }
    return { runIds: rows.map((r) => r.id), bytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
  }
  redact(runId: string, artifactId: string, reason: string): void {
    if (!reason.trim())
      throw new WorkflowFault("INVALID_DEFINITION", "Redaction reason is required");
    const target = this.artifacts(runId).find((a) => a.id === artifactId);
    if (!target || target.kind === "state")
      throw new WorkflowFault("INVALID_DEFINITION", "Select a content artifact for redaction");
    this.transaction(() => {
      const state = this.state(runId);
      this.artifact(
        runId,
        "redaction",
        `redactions/${artifactId}.json`,
        canonical({ artifactId, hash: target.content_hash, reason }),
      );
      for (const e of this.evidence(runId).filter((e) => e.artifact_id === artifactId))
        this.invalidateEvidence(runId, e.snapshot_id, "redacted");
      // Explicit redaction is the sole content-mutation exception. The original hash and
      // metadata remain, so ordinary reads fail integrity validation after redaction.
      if (target.inline_content !== null) {
        this.db.exec("DROP TRIGGER artifacts_no_update");
        this.db.run("UPDATE artifacts SET inline_content='[redacted]' WHERE run_id=? AND id=?", [
          runId,
          artifactId,
        ]);
        this.db.exec(
          "CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;",
        );
      }
      state.verificationState = "invalid";
      this.saveState(runId, state);
      this.bump(runId, this.run(runId).revision);
    });
    if (target.blob_path) {
      const path = workspacePath(this.workspace, target.blob_path.replaceAll("\\", "/"));
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

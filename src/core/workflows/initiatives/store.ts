import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonical, hashJson } from "../../specs/hash.js";
import { WorkflowFault } from "../errors.js";
import { PolicySchema, SafeId } from "../schemas.js";
import { newId, type WorkflowStore } from "../store.js";
import { IssueSourceSchema } from "../types.js";
import { HOST_AUTO_APPROVAL_CEILING } from "../v2/definition.js";
import { FeatureKey, InitiativeId, type InitiativePlan, InitiativePlanSchema } from "./plan.js";

/** The workflow schema version that adds initiatives (migration 004). */
export const INITIATIVES_SCHEMA_VERSION = 4;

export const InitiativeStatus = z.enum([
  "decomposing",
  "awaiting_approval",
  "active",
  "paused",
  "completed",
  "refused",
]);
export type InitiativeStatus = z.infer<typeof InitiativeStatus>;

export const BudgetLimitsSchema = z
  .object({
    maxTotalTokens: z.number().int().min(1000),
    maxAgentCalls: z.number().int().min(1),
    maxActiveMs: z.number().int().min(1000),
  })
  .strict();

/** The tolerance band of a dollar cap, as in a run policy (`costTolerance`). */
export const CostToleranceSchema = z.union([z.enum(["auto", "off"]), z.number().min(0).max(0.5)]);

/**
 * The initiative's dollar budget across its runs (#1317): the cap feature runs share, and how far
 * past it the initiative may go (`auto` takes 10% to 30% by the number of features).
 */
export const CostBudgetSchema = z
  .object({
    maxCostUsd: z.number().positive(),
    costTolerance: CostToleranceSchema.default("off"),
  })
  .strict();

/** Fixed when the initiative starts; part of every split approval digest. */
export const InitiativeSettingsSchema = z
  .object({
    /** The workflow each feature runs. */
    workflowId: SafeId,
    /** The policy of a feature run before its budget share is applied. */
    basePolicy: PolicySchema,
    /** The shared budget; null derives it per plan revision (see `planBudget`). */
    budget: BudgetLimitsSchema.nullable(),
    /** The dollar budget; null (the default) leaves dollars to each run's own `maxCostUsd`. */
    costBudget: CostBudgetSchema.nullable().default(null),
    /**
     * Tiered approval. When set, each feature run gets auto approval limited to its approved
     * boundary paths with these task and file bounds; null (the default) sends every feature spec
     * approval to a person.
     */
    featureAutoApproval: z
      .object({
        maxTasks: z.number().int().min(1).max(HOST_AUTO_APPROVAL_CEILING.maxTasks),
        maxFiles: z.number().int().min(1).max(HOST_AUTO_APPROVAL_CEILING.maxFiles),
      })
      .strict()
      .nullable(),
    /**
     * The confirmation hash of a v2 feature workflow's own auto approval limits, given by the user
     * at start and passed to every feature run. Null when the workflow has none.
     */
    autoApprovalConfirmation: z.string().length(64).nullable().default(null),
    model: z.string().min(1).nullable(),
    ownerLabel: z.string().min(1).max(200),
    /**
     * The GitHub issue of each feature, by feature ID: its runs start from it and their delivery
     * closes it. Kept beside the plan, so the plan and its digest stay the decomposer's.
     */
    featureIssues: z.record(FeatureKey, IssueSourceSchema).default({}),
    /**
     * Holds the next feature start while the low end of the estimate is above the shared budget
     * (#1312), so a person raises the budget or trims the split before more of it is spent. Off by
     * default: the budget share check alone stops an initiative only when the budget is used up.
     */
    forecastStop: z.boolean().default(false),
    /**
     * Keeps the decomposer's features as it split them. Off by default: small siblings (one or
     * two boundary paths, same dependencies) are merged into one feature (#1352).
     */
    keepFeatures: z.boolean().default(false),
    /**
     * Has the decomposer split a feature that holds more than a third of the critical path, or say
     * why it stays whole (#1522). Off by default.
     */
    splitCriticalPath: z.boolean().default(false),
  })
  .strict();
export type InitiativeSettings = z.infer<typeof InitiativeSettingsSchema>;
export type BudgetLimitsValue = z.infer<typeof BudgetLimitsSchema>;
export type CostBudgetValue = z.infer<typeof CostBudgetSchema>;
export type CostToleranceValue = z.infer<typeof CostToleranceSchema>;

export interface InitiativeRow {
  id: string;
  title: string;
  prompt: string;
  status: InitiativeStatus;
  reason: string;
  revision: number;
  event_seq: number;
  plan_revision: number;
  approved_plan_revision: number | null;
  approval_digest: string | null;
  settings_json: string;
  decompose_run_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface PlanRevisionRow {
  initiative_id: string;
  revision: number;
  plan_json: string;
  budget_json: string;
  digest: string;
  source: "decomposer" | "user";
  edit_json: string | null;
  created_at: number;
}
export interface InitiativeRequestRow {
  initiative_id: string;
  id: string;
  kind: "split_approval";
  status: "pending" | "accepted" | "rejected" | "superseded";
  plan_revision: number;
  digest: string;
  answer_json: string | null;
  actor: string | null;
  created_at: number;
  decided_at: number | null;
}
export interface InitiativeRunRow {
  initiative_id: string;
  feature_id: string;
  run_id: string;
  plan_revision: number;
  feature_digest: string;
  origin: "start" | "rebase" | "replan";
  superseded_at: number | null;
  superseded_reason: string | null;
  created_at: number;
}
export interface InitiativeEvent {
  seq: number;
  type: string;
  at: number;
  payload: unknown;
}

/** Initiative records, kept in the workflow database next to the runs they link. */
export class InitiativeStore {
  constructor(readonly runs: WorkflowStore) {}
  private get db(): Database {
    return this.runs.connection;
  }
  /** A reader opened on a database written before initiatives existed sees none. */
  available(): boolean {
    return this.runs.schemaVersion() >= INITIATIVES_SCHEMA_VERSION;
  }
  transaction<T>(action: () => T): T {
    return this.runs.transaction(action);
  }
  get(id: string): InitiativeRow {
    InitiativeId.parse(id);
    const row = this.available()
      ? this.db.query<InitiativeRow, [string]>("SELECT * FROM initiatives WHERE id=?").get(id)
      : null;
    if (!row) throw new WorkflowFault("NOT_FOUND", `Unknown initiative ${id}`);
    return row;
  }
  exists(id: string): boolean {
    return (
      this.available() &&
      this.db.query<{ id: string }, [string]>("SELECT id FROM initiatives WHERE id=?").get(id) !==
        null
    );
  }
  list(): InitiativeRow[] {
    if (!this.available()) return [];
    return this.db
      .query<InitiativeRow, []>("SELECT * FROM initiatives ORDER BY updated_at DESC, id")
      .all();
  }
  settings(row: InitiativeRow): InitiativeSettings {
    return InitiativeSettingsSchema.parse(JSON.parse(row.settings_json));
  }
  /** The initiative whose split this run is decomposing, if it is linked to one. */
  decompositionOfRun(runId: string): InitiativeRow | null {
    if (!this.available()) return null;
    return this.db
      .query<InitiativeRow, [string]>("SELECT * FROM initiatives WHERE decompose_run_id=? LIMIT 1")
      .get(runId);
  }
  create(row: {
    id: string;
    title: string;
    prompt: string;
    status: InitiativeStatus;
    settings: InitiativeSettings;
    decomposeRunId: string | null;
  }): void {
    const now = Date.now();
    this.db.run(
      "INSERT INTO initiatives (id,title,prompt,status,settings_json,decompose_run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        row.id,
        row.title,
        row.prompt,
        row.status,
        canonical(InitiativeSettingsSchema.parse(row.settings)),
        row.decomposeRunId,
        now,
        now,
      ],
    );
    this.emit(row.id, "initiative.created", {
      status: row.status,
      decomposeRunId: row.decomposeRunId,
    });
  }
  /** Optimistic concurrency: every mutation bumps the revision it expects. */
  bump(id: string, expected: number): void {
    const update = this.db.run(
      "UPDATE initiatives SET revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      [Date.now(), id, expected],
    );
    if (update.changes !== 1)
      throw new WorkflowFault("REVISION_CONFLICT", "Initiative revision changed", {
        expected,
        actual: this.get(id).revision,
      });
  }
  setStatus(id: string, status: InitiativeStatus, reason = ""): void {
    const row = this.get(id);
    if (row.status === status && row.reason === reason) return;
    this.bump(id, row.revision);
    this.db.run("UPDATE initiatives SET status=?,reason=?,updated_at=? WHERE id=?", [
      status,
      reason,
      Date.now(),
      id,
    ]);
    this.emit(id, "status.changed", { from: row.status, to: status, reason });
  }
  setTitle(id: string, title: string): void {
    this.db.run("UPDATE initiatives SET title=? WHERE id=?", [title, id]);
  }
  setSettings(id: string, settings: InitiativeSettings): void {
    this.db.run("UPDATE initiatives SET settings_json=? WHERE id=?", [
      canonical(InitiativeSettingsSchema.parse(settings)),
      id,
    ]);
  }
  addRevision(
    id: string,
    plan: InitiativePlan,
    budget: BudgetLimitsValue,
    digest: string,
    source: PlanRevisionRow["source"],
    edit: unknown,
  ): number {
    const revision = this.get(id).plan_revision + 1;
    this.db.run("INSERT INTO initiative_revisions VALUES (?,?,?,?,?,?,?,?)", [
      id,
      revision,
      canonical(InitiativePlanSchema.parse(plan)),
      canonical(budget),
      digest,
      source,
      edit === null ? null : canonical(edit),
      Date.now(),
    ]);
    this.db.run("UPDATE initiatives SET plan_revision=?,updated_at=? WHERE id=?", [
      revision,
      Date.now(),
      id,
    ]);
    this.emit(id, "plan.revised", { revision, digest, source, edit });
    return revision;
  }
  revision(id: string, revision: number): PlanRevisionRow {
    const row = this.db
      .query<PlanRevisionRow, [string, number]>(
        "SELECT * FROM initiative_revisions WHERE initiative_id=? AND revision=?",
      )
      .get(id, revision);
    if (!row) throw new WorkflowFault("NOT_FOUND", `Unknown plan revision ${revision}`);
    return row;
  }
  revisions(id: string): PlanRevisionRow[] {
    return this.db
      .query<PlanRevisionRow, [string]>(
        "SELECT * FROM initiative_revisions WHERE initiative_id=? ORDER BY revision",
      )
      .all(id);
  }
  plan(row: PlanRevisionRow): InitiativePlan {
    return InitiativePlanSchema.parse(JSON.parse(row.plan_json));
  }
  approve(id: string, revision: number, digest: string): void {
    this.db.run(
      "UPDATE initiatives SET approved_plan_revision=?,approval_digest=?,updated_at=? WHERE id=?",
      [revision, digest, Date.now(), id],
    );
  }
  request(id: string, planRevision: number, digest: string): string {
    const requestId = newId();
    this.db.run(
      "INSERT INTO initiative_requests (initiative_id,id,kind,status,plan_revision,digest,created_at) VALUES (?,?,'split_approval','pending',?,?,?)",
      [id, requestId, planRevision, digest, Date.now()],
    );
    this.emit(id, "request.created", { requestId, kind: "split_approval", planRevision, digest });
    return requestId;
  }
  requests(id: string): InitiativeRequestRow[] {
    return this.db
      .query<InitiativeRequestRow, [string]>(
        "SELECT * FROM initiative_requests WHERE initiative_id=? ORDER BY created_at, rowid",
      )
      .all(id);
  }
  decide(
    id: string,
    requestId: string,
    status: "accepted" | "rejected" | "superseded",
    answer: unknown,
  ): void {
    const actor = status === "superseded" ? "system-invalidation" : "user";
    const result = this.db.run(
      "UPDATE initiative_requests SET status=?,answer_json=?,actor=?,decided_at=? WHERE initiative_id=? AND id=? AND status='pending'",
      [status, canonical(answer), actor, Date.now(), id, requestId],
    );
    if (result.changes !== 1)
      throw new WorkflowFault("STALE_DECISION", "Request is no longer pending");
    this.emit(id, "request.decided", { requestId, status, actor });
  }
  link(
    id: string,
    featureId: string,
    runId: string,
    planRevision: number,
    featureDigest: string,
    origin: InitiativeRunRow["origin"],
  ): void {
    this.db.run(
      "INSERT INTO initiative_runs (initiative_id,feature_id,run_id,plan_revision,feature_digest,origin,created_at) VALUES (?,?,?,?,?,?,?)",
      [id, featureId, runId, planRevision, featureDigest, origin, Date.now()],
    );
    this.emit(id, "feature.run_linked", { featureId, runId, origin, planRevision });
  }
  links(id: string): InitiativeRunRow[] {
    return this.db
      .query<InitiativeRunRow, [string]>(
        "SELECT * FROM initiative_runs WHERE initiative_id=? ORDER BY created_at, rowid",
      )
      .all(id);
  }
  /** The initiative whose feature a run currently stands for, or null for any other run. */
  initiativeOfRun(runId: string): string | null {
    if (!this.available()) return null;
    return (
      this.db
        .query<{ initiative_id: string }, [string]>(
          "SELECT initiative_id FROM initiative_runs WHERE run_id=? AND superseded_at IS NULL LIMIT 1",
        )
        .get(runId)?.initiative_id ?? null
    );
  }
  /** The run that currently stands for a feature: its newest link that is not superseded. */
  current(id: string, featureId: string): InitiativeRunRow | null {
    return (
      this.db
        .query<InitiativeRunRow, [string, string]>(
          "SELECT * FROM initiative_runs WHERE initiative_id=? AND feature_id=? AND superseded_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(id, featureId) ?? null
    );
  }
  supersede(id: string, runId: string, reason: string): void {
    const result = this.db.run(
      "UPDATE initiative_runs SET superseded_at=?,superseded_reason=? WHERE initiative_id=? AND run_id=? AND superseded_at IS NULL",
      [Date.now(), reason, id, runId],
    );
    if (result.changes === 1) this.emit(id, "feature.run_superseded", { runId, reason });
  }
  emit(id: string, type: string, payload: unknown): void {
    const update = this.db.run(
      "UPDATE initiatives SET event_seq=event_seq+1,updated_at=? WHERE id=?",
      [Date.now(), id],
    );
    if (update.changes !== 1) throw new WorkflowFault("NOT_FOUND", `Unknown initiative ${id}`);
    const seq = this.get(id).event_seq;
    this.db.run("INSERT INTO initiative_events VALUES (?,?,?,?,?)", [
      id,
      seq,
      type,
      Date.now(),
      canonical(payload ?? null),
    ]);
  }
  events(id: string, after = 0, limit = 200): InitiativeEvent[] {
    return this.db
      .query<
        { seq: number; type: string; at: number; payload_json: string },
        [string, number, number]
      >(
        "SELECT seq,type,at,payload_json FROM initiative_events WHERE initiative_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(id, after, limit)
      .map((row) => ({
        seq: row.seq,
        type: row.type,
        at: row.at,
        payload: JSON.parse(row.payload_json) as unknown,
      }));
  }
  /** The payloads of the events of `type`, oldest first. */
  eventsOfType(id: string, type: string): unknown[] {
    return this.db
      .query<{ payload_json: string }, [string, string]>(
        "SELECT payload_json FROM initiative_events WHERE initiative_id=? AND type=? ORDER BY seq",
      )
      .all(id, type)
      .map((row) => JSON.parse(row.payload_json) as unknown);
  }
  /** A stored result for a repeated command ID; a different body under the same ID is refused. */
  previousCommand<T>(commandId: string, body: unknown): T | undefined {
    SafeId.parse(commandId);
    const row = this.db
      .query<{ request_hash: string; result_json: string }, [string]>(
        "SELECT request_hash,result_json FROM initiative_commands WHERE id=?",
      )
      .get(commandId);
    if (!row) return undefined;
    if (row.request_hash !== hashJson(body))
      throw new WorkflowFault(
        "COMMAND_CONFLICT",
        "Command ID was already used for different input",
      );
    return JSON.parse(row.result_json) as T;
  }
  saveCommand(commandId: string, initiativeId: string, body: unknown, result: unknown): void {
    this.db.run("INSERT INTO initiative_commands VALUES (?,?,?,?,?)", [
      commandId,
      initiativeId,
      hashJson(body),
      canonical(result),
      Date.now(),
    ]);
  }
}

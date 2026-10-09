import { z } from "zod";
import { renderSpec } from "../specs/render.js";
import { workspacePath } from "../specs/validate.js";
import { BUDGET_PRESETS, type BudgetPresetId, budgetUsage } from "./budget.js";
import { fileHash } from "./effects.js";
import {
  compareWithActual,
  type Projection,
  project,
  readHistory,
  type SavedEstimate,
  type StageProgress,
  type StartEstimate,
} from "./estimate.js";
import type {
  RunPolicy,
  RunSnapshot,
  StageState,
  WorkflowDefinition,
  WorkflowEvent,
} from "./schemas.js";
import type { NativeWorkflowService } from "./service.js";
import type { RunRow, StepRow, WorkflowStore } from "./store.js";

const RECENT_EVENTS = 40;
const OUTPUT_TAIL_LINES = 40;
const MAX_CHANGED_FILES = 300;

export const BudgetPreset = z.enum(BUDGET_PRESETS);
export type { BudgetPresetId };
export interface StartRunInput {
  workflowId: string;
  featureId: string;
  prompt: string;
  model: string;
  budget: BudgetPresetId;
}
export interface WorkflowInfo {
  /** Range shown on the new-run form, from this project's finished runs or generic ranges. */
  estimate: StartEstimate;
  enabled: boolean;
  defaultWorkflow: string;
  workflows: string[];
  policy: RunPolicy;
  presets: Record<
    BudgetPresetId,
    {
      maxTotalTokens: number;
      maxAgentCalls: number;
      maxActiveMs: number;
      /** Set for the checkpoint preset: no token cap, a pause every this many tokens. */
      checkpointTokens?: number | null;
    }
  >;
}

export interface StageView {
  id: string;
  kind: string;
  status: StageState;
  generation: number;
}
export interface BudgetView {
  tokens: number;
  /** Reserved by failed or interrupted attempts whose usage is unknown; counts against the limit. */
  heldTokens: number;
  /** Reserved by attempts that are still running. */
  inFlightTokens: number;
  maxTokens: number;
  calls: number;
  maxCalls: number;
  activeMs: number;
  maxActiveMs: number;
  repairRounds: number;
  maxRepairRounds: number;
  /** Soft checkpoint interval and the token count of the next pause, when the run uses them. */
  checkpointTokens?: number | null;
  nextCheckpoint?: number | null;
}
export interface CriterionView {
  id: string;
  text: string;
  method: string;
  verdict: string | null;
  evidenceIds: string[];
}
export interface RunDetails {
  title: string | null;
  prompt: string;
  specMarkdown: string | null;
  plan: string | null;
  criteria: CriterionView[];
  /** Latest runtime error message recorded for the run, if any. */
  lastError: string | null;
}

export interface FileChange {
  path: string;
  /** "code" for agent edits, "spec" for published spec/plan/tasks documents. */
  source: "code" | "spec";
  action: "created" | "modified" | "deleted";
  edits: number;
  /** Last journal status; anything but applied/reconciled needs attention. */
  status: string;
  /** The file no longer matches what the run last wrote (edited outside the run). */
  drifted: boolean;
}
export interface CheckDetail {
  checkId: string;
  status: string;
  validity: string;
  exitCode: number | null;
  reason: string;
  durationMs: number;
  runs: number;
  outputTail: string | null;
}

export interface EstimateView {
  /** What was expected when the run was created; absent for runs created before estimates existed. */
  saved: SavedEstimate | null;
  /** Re-estimate for a run that is not finished. */
  projection: Projection | null;
  /** Saved estimate against actual usage, for a completed run. */
  comparison: { verdict: "below" | "within" | "above"; text: string } | null;
}
export function savedEstimate(store: WorkflowStore, runId: string): SavedEstimate | null {
  const artifact = store.latestArtifact(runId, "estimates/start.json");
  if (!artifact) return null;
  try {
    return JSON.parse(store.readArtifact(runId, artifact.id)) as SavedEstimate;
  } catch {
    return null;
  }
}
function estimateOf(store: WorkflowStore, row: RunRow, stages: StageView[]): EstimateView {
  const saved = savedEstimate(store, row.id);
  const usage = budgetUsage(store, row);
  const terminal = ["completed", "failed", "cancelled"].includes(row.status);
  const comparison =
    saved && row.status === "completed" ? compareWithActual(saved, row.token_usage) : null;
  if (terminal) return { saved, projection: null, comparison };
  const tasks = store.tasks(row.id).filter((t) => t.status !== "invalidated");
  const progress: StageProgress[] = stages.map((stage) => ({
    id: stage.id,
    status:
      stage.status === "completed" || stage.status === "skipped"
        ? "done"
        : stage.id === row.stage_id && row.status !== "created"
          ? "running"
          : "pending",
  }));
  const policy = JSON.parse(row.policy_json) as RunPolicy;
  return {
    saved,
    comparison,
    projection: project({
      history: readHistory(store).filter((r) => r.runId !== row.id),
      stages: progress,
      spentTokens: usage.tokens + usage.heldTokens,
      activeMs: row.active_ms,
      maxTokens: policy.maxTotalTokens,
      tasks: tasks.length
        ? {
            total: tasks.length,
            done: tasks.filter((t) => ["implemented", "verified"].includes(t.status)).length,
          }
        : null,
      runningStageSpent: row.stage_id
        ? (store.history(row.id)[0]?.stageTokens[row.stage_id] ?? 0)
        : 0,
    }),
  };
}

// Changes whenever anything the panel renders can change, including active time which has no event.
function stampOf(row: RunRow): string {
  return `${row.event_seq}:${row.active_ms}:${row.token_usage}:${row.revision}`;
}
function stagesOf(row: RunRow, steps: StepRow[]): StageView[] {
  const definition = JSON.parse(row.definition_json) as WorkflowDefinition;
  return definition.stages.map((stage) => {
    const latest = steps
      .filter((s) => s.stage_id === stage.id && s.parent_step_id === null)
      .reduce<StepRow | null>((a, b) => (!a || b.generation >= a.generation ? b : a), null);
    return {
      id: stage.id,
      kind: stage.kind,
      status: latest?.status ?? "pending",
      generation: latest?.generation ?? 0,
    };
  });
}
function budgetOf(store: WorkflowStore, row: RunRow): BudgetView {
  const policy = JSON.parse(row.policy_json) as RunPolicy;
  const usage = budgetUsage(store, row);
  return {
    tokens: usage.tokens,
    heldTokens: usage.heldTokens,
    inFlightTokens: usage.inFlightTokens,
    maxTokens: policy.maxTotalTokens,
    calls: usage.calls,
    maxCalls: policy.maxAgentCalls,
    activeMs: usage.activeMs,
    maxActiveMs: policy.maxActiveMs,
    repairRounds: row.repair_rounds,
    maxRepairRounds: policy.maxRepairRounds,
    checkpointTokens: policy.checkpointTokens ?? null,
    nextCheckpoint: store.checkpointBoundary(row.id, policy),
  };
}
function lastErrorOf(store: WorkflowStore, runId: string): string | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith("errors/"))
    .at(-1);
  if (!latest) return null;
  try {
    return store.readArtifact(runId, latest.id).trim().split("\n")[0]?.slice(0, 300) ?? null;
  } catch {
    return null;
  }
}
function detailsOf(store: WorkflowStore, runId: string): RunDetails {
  const state = store.state(runId);
  return {
    title: state.spec?.title ?? null,
    prompt: state.prompt,
    specMarkdown: state.spec ? renderSpec(state.spec) : null,
    plan: state.plan,
    lastError: lastErrorOf(store, runId),
    criteria:
      state.spec?.criteria.map((c) => {
        const result = state.convergence?.coverage.find((r) => r.criterionId === c.id);
        return {
          id: c.id,
          text: `Given ${c.given}; when ${c.when}; then ${c.then}`,
          method: c.method,
          verdict: result?.verdict ?? null,
          evidenceIds: result?.evidenceIds ?? [],
        };
      }) ?? [],
  };
}
function changesOf(store: WorkflowStore, runId: string): FileChange[] {
  const byPath = new Map<string, FileChange & { before: string | null; after: string | null }>();
  for (const effect of store.effects(runId)) {
    if (effect.kind === "command") continue;
    const { path } = JSON.parse(effect.intent_json) as { path?: string };
    if (!path) continue;
    const known = byPath.get(path);
    const entry = known ?? {
      path,
      source: effect.kind === "file_patch" ? ("code" as const) : ("spec" as const),
      action: "modified" as const,
      edits: 0,
      status: effect.status,
      drifted: false,
      before: effect.before_hash,
      after: effect.after_hash,
    };
    entry.edits++;
    entry.status = effect.status;
    entry.after = effect.after_hash;
    byPath.set(path, entry);
  }
  return [...byPath.values()].slice(0, MAX_CHANGED_FILES).map(({ before, after, ...change }) => {
    const settled = change.status === "applied" || change.status === "reconciled";
    let current: string | null = null;
    try {
      current = fileHash(workspacePath(store.workspace, change.path));
    } catch {
      current = null;
    }
    return {
      ...change,
      action: before === null ? "created" : after === null && settled ? "deleted" : "modified",
      drifted: settled && current !== after,
    };
  });
}
function checkDetailsOf(store: WorkflowStore, runId: string): CheckDetail[] {
  const rows = store.checkDetails(runId);
  const latest = new Map<string, CheckDetail>();
  for (const row of rows) {
    let outputTail: string | null = null;
    if (row.status !== "passed")
      try {
        const body = JSON.parse(store.readArtifact(runId, row.artifact_id)) as { output?: string };
        outputTail =
          body.output?.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n") ?? null;
      } catch {
        outputTail = null; // Redacted or missing evidence keeps the result without output.
      }
    latest.set(row.check_id, {
      checkId: row.check_id,
      status: row.status,
      validity: row.validity,
      exitCode: row.exit_code,
      reason: row.reason,
      durationMs: row.duration_ms,
      runs: (latest.get(row.check_id)?.runs ?? 0) + 1,
      outputTail,
    });
  }
  return [...latest.values()];
}
function recentEvents(store: WorkflowStore, row: RunRow): WorkflowEvent[] {
  return store.events(row.id, Math.max(0, row.event_seq - RECENT_EVENTS), RECENT_EVENTS);
}

export function readWorkflowView(service: NativeWorkflowService, runId: string) {
  const store = service.store;
  return store.readTransaction(() => {
    const row = store.run(runId);
    const stages = stagesOf(row, store.steps(runId));
    return {
      stamp: stampOf(row),
      estimate: estimateOf(store, row, stages),
      snapshot: store.snapshot(runId),
      details: detailsOf(store, runId),
      stages,
      budget: budgetOf(store, row),
      tasks: store.tasks(runId),
      checks: store.checks(runId),
      checkDetails: checkDetailsOf(store, runId),
      changes: changesOf(store, runId),
      configuredChecks: (JSON.parse(row.policy_json) as RunPolicy).checks.map((c) => c.id),
      findings: store.findings(runId),
      requests: store.requests(runId),
      events: recentEvents(store, row),
    };
  });
}
export type WorkflowView = ReturnType<typeof readWorkflowView>;

/** Returns null when nothing visible changed since `stamp`, so polling stays cheap. */
export function readWorkflowViewIfChanged(
  service: NativeWorkflowService,
  runId: string,
  stamp: string | null,
): WorkflowView | null {
  if (stamp !== null && stampOf(service.store.run(runId)) === stamp) return null;
  return readWorkflowView(service, runId);
}

export interface RunSummary {
  snapshot: RunSnapshot;
  title: string | null;
  stage: { index: number; total: number; id: string | null };
  tasks: { done: number; total: number };
  pendingKind: string | null;
  budget: BudgetView;
  createdAt: number;
  updatedAt: number;
}
export function readWorkflowSummaries(service: NativeWorkflowService, limit: number): RunSummary[] {
  const store = service.store;
  return store.readTransaction(() =>
    store.list(limit).items.map((snapshot) => {
      const row = store.run(snapshot.runId);
      const stages = stagesOf(row, store.steps(snapshot.runId));
      const tasks = store.tasks(snapshot.runId).filter((t) => t.status !== "invalidated");
      let title: string | null = null;
      try {
        title = store.state(snapshot.runId).spec?.title ?? null;
      } catch {
        // A run without state still lists; its title is unknown.
      }
      return {
        snapshot,
        title,
        stage: {
          index: Math.max(
            0,
            stages.findIndex((s) => s.id === snapshot.stageId),
          ),
          total: stages.length,
          id: snapshot.stageId,
        },
        tasks: {
          done: tasks.filter((t) => t.status === "implemented" || t.status === "verified").length,
          total: tasks.length,
        },
        pendingKind:
          store.requests(snapshot.runId).find((r) => r.status === "pending")?.kind ?? null,
        budget: budgetOf(store, row),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
  );
}

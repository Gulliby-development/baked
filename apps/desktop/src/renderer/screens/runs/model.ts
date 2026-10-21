import { canExtendRun } from "../../../../../../src/core/workflows/extendable.js";
import type { RunSnapshot, RunState } from "../../../shared/api.js";
import type { WorkflowEvent } from "../../client/runs.js";

/**
 * Pure view-model of a workflow run: what the event log, the run's artifacts and its snapshot say,
 * shaped for the run screens. Nothing here fetches; `load.ts` gathers the inputs.
 */

/** `spec.json` (SpecSchema), the fields the screens read. */
export interface Spec {
  title: string;
  problem: string;
  outcome: string;
  inScope: string[];
  outOfScope: string[];
  requirements: { id: string; text: string; priority: string; verification: string }[];
  criteria: {
    id: string;
    requirementIds: string[];
    given: string;
    when: string;
    then: string;
    method: "automated" | "manual" | "post-release";
  }[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  /** `content` is set when the plan fixed the file's whole content and the host writes it. */
  writes: { path: string; action: string; content?: string }[];
  checkIds: string[];
  origin: string;
  rows?: string[];
  /** The file mode names a harness and data file; the inline mode writes into `test` (#1763). */
  rowTest?: {
    mode?: "inline";
    framework: "bun" | "pytest" | "go" | "junit" | "rust" | "xunit";
    package?: string;
    harness?: string;
    test: string;
    data?: string;
  };
}
/** Whether the host writes the task's files with no agent (`hostWritten` in task-graph.ts). */
export const hostWritten = (task: Pick<Task, "writes">): boolean =>
  task.writes.length > 0 &&
  task.writes.every((w) => w.action !== "delete" && w.content !== undefined);
/** `tasks.json` (TaskGraphSchema). */
export interface TaskGraph {
  tasks: Task[];
}

export interface Finding {
  id: string;
  kind: string;
  severity: string;
  file: string | null;
  claim: string;
  impact: string;
  suggestedFix: string;
  criterionIds: string[];
}
/** A review artifact (ReviewSchema); findings point at the review that recorded them. */
export interface Review {
  verdict: string;
  coverage: { criterionId: string; verdict: string; explanation: string }[];
  findings: Finding[];
}

/** `estimates/start.json` (SavedEstimate). */
export interface SavedEstimate {
  tokens: { low: number; high: number };
  maxTokens: number;
  workflowId?: string;
  costUsd?: { low: number; high: number } | null;
}

// ---------------------------------------------------------------------------------------------
// Event replay

export type StageStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "skipped"
  | "invalidated";

export interface TaskTrace {
  status: string;
  generation: number;
  /** Writer slot while the task runs, counted from 0. */
  slot: number | null;
  changedAt: string;
}

export interface WriterSlot {
  index: number;
  current: string | null;
  /** Tasks this writer finished, oldest first. */
  done: string[];
}

export interface ActivityLine {
  seq: number;
  at: string;
  text: string;
  tone: "ok" | "warn" | "err" | "info" | "";
}

export interface RunTrace {
  lastSeq: number;
  lastAt: string | null;
  stages: Map<string, { status: StageStatus; generation: number }>;
  /** Stage IDs in the order they first started. */
  stageOrder: string[];
  tasks: Map<string, TaskTrace>;
  /** Writer columns: every slot that ever held a task. */
  writers: WriterSlot[];
  /** Task IDs in the order they were integrated (implemented or verified). */
  integrated: string[];
  checks: Map<string, { status: string; runs: number; at: string }>;
  gates: Map<string, { status: string; mode: string; attempts: number; flaky: boolean }>;
  acceptance: Map<string, { phase: string; detail: string | null }>;
  criteria: Map<string, string>;
  /** Latest finding records: finding ID to the review artifact that holds it. */
  findings: Map<string, string>;
  requests: Map<string, { kind: string; status: string }>;
  models: Set<string>;
  activity: ActivityLine[];
  /** Stop reasons in shadow or advisory mode that would have stopped the run, by reason. */
  wouldStop: Map<string, { mode: "shadow" | "advisory"; count: number; summary: string }>;
  /** Step ID to stage ID, and attempt ID to stage ID, for events that name only the step. */
  steps: Map<string, string>;
  attempts: Map<string, string>;
}

const DONE_TASK = new Set(["implemented", "verified"]);

export const stageLabel = (id: string): string =>
  id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

const REQUEST_TEXT: Record<string, string> = {
  approval: "Waiting for approval",
  clarification: "Questions wait for answers",
  manual_evidence: "A criterion needs a manual observation",
  recovery: "An effect needs a recovery decision",
  checkpoint: "Paused at a budget checkpoint",
  convergence: "Repairs stopped: accept the findings, repair once more or stop",
  delivery: "A delivery plan waits for approval",
};
const STATE_TEXT: Partial<Record<RunState, string>> = {
  running: "Run is running",
  paused: "Run paused",
  blocked: "Run blocked",
  completed: "Run completed",
  failed: "Run failed",
  cancelled: "Run cancelled",
};

export function emptyTrace(): RunTrace {
  return {
    lastSeq: 0,
    lastAt: null,
    stages: new Map(),
    stageOrder: [],
    tasks: new Map(),
    writers: [],
    integrated: [],
    checks: new Map(),
    gates: new Map(),
    acceptance: new Map(),
    criteria: new Map(),
    findings: new Map(),
    requests: new Map(),
    models: new Set(),
    activity: [],
    wouldStop: new Map(),
    steps: new Map(),
    attempts: new Map(),
  };
}

/**
 * Replays events into a trace. Events at or below the trace's last sequence are skipped, so the
 * same events can arrive twice (page then stream) without counting twice.
 */
export function replay(events: readonly WorkflowEvent[], trace = emptyTrace()): RunTrace {
  const { steps, attempts } = trace;
  for (const event of events) {
    if (event.seq <= trace.lastSeq) continue;
    trace.lastSeq = event.seq;
    trace.lastAt = event.at;
    const line = (text: string, tone: ActivityLine["tone"] = ""): void => {
      trace.activity.push({ seq: event.seq, at: event.at, text, tone });
    };
    switch (event.type) {
      case "run.created":
        line("Run created");
        break;
      case "run.rerouted": {
        const { runModel, changes } = event.payload;
        line(
          runModel.from === runModel.to
            ? `Routes changed (${changes.length})`
            : `Switched to ${runModel.to} (was ${runModel.from})`,
          "info",
        );
        break;
      }
      case "run.state_changed": {
        const { to, reason } = event.payload;
        const text = STATE_TEXT[to];
        if (text)
          line(
            reason && reason !== "none" && to !== "running"
              ? `${text}: ${reason.replaceAll("_", " ")}`
              : text,
            to === "completed" ? "ok" : to === "failed" ? "err" : to === "blocked" ? "warn" : "",
          );
        break;
      }
      case "stage.started": {
        const { stepId, stageId, generation } = event.payload;
        steps.set(stepId, stageId);
        trace.stages.set(stageId, { status: "running", generation });
        if (!trace.stageOrder.includes(stageId)) trace.stageOrder.push(stageId);
        line(`${stageLabel(stageId)} started${generation > 0 ? ` (round ${generation + 1})` : ""}`);
        break;
      }
      case "stage.finished": {
        const stageId = steps.get(event.payload.stepId);
        if (!stageId) break;
        const status = event.payload.status as StageStatus;
        const known = trace.stages.get(stageId);
        trace.stages.set(stageId, { status, generation: known?.generation ?? 0 });
        if (status === "completed") line(`${stageLabel(stageId)} finished`, "ok");
        else if (status === "failed") line(`${stageLabel(stageId)} failed`, "err");
        else if (status === "waiting") line(`${stageLabel(stageId)} waits`, "warn");
        else if (status === "skipped") line(`${stageLabel(stageId)} skipped`);
        break;
      }
      case "attempt.started": {
        const { attemptId, stepId, modelId } = event.payload;
        const stageId = steps.get(stepId) ?? stepId;
        attempts.set(attemptId, stageId);
        if (modelId) {
          trace.models.add(modelId);
          line(`${stageLabel(stageId)} by ${modelId}`, "info");
        }
        break;
      }
      case "attempt.finished":
        if (event.payload.status === "failed")
          line(
            `${stageLabel(attempts.get(event.payload.attemptId) ?? "An")} attempt failed`,
            "err",
          );
        break;
      case "attempt.advisory": {
        const stageId = attempts.get(event.payload.attemptId);
        const attempt = stageId ? `the ${stageLabel(stageId)} attempt` : "an attempt";
        line(
          `Progress watcher ${event.payload.action === "stopped" ? "stopped" : "warned"} ${attempt}: ${event.payload.detail}`,
          event.payload.action === "stopped" ? "warn" : "info",
        );
        break;
      }
      case "task.state_changed":
        applyTask(
          trace,
          event.payload.taskId,
          event.payload.to,
          event.payload.generation,
          event.at,
        );
        if (event.payload.to === "running") line(`${event.payload.taskId} started`);
        else if (DONE_TASK.has(event.payload.to))
          line(`${event.payload.taskId} ${event.payload.to}`, "ok");
        else if (event.payload.to === "failed" || event.payload.to === "blocked")
          line(`${event.payload.taskId} ${event.payload.to}`, "err");
        else if (event.payload.to === "interrupted" && event.payload.cause)
          line(
            `${event.payload.taskId} interrupted: ${event.payload.cause.replaceAll("_", " ")}${event.payload.detail ? ` (${event.payload.detail})` : ""}`,
            "warn",
          );
        break;
      case "check.finished": {
        const { checkId, status } = event.payload;
        const known = trace.checks.get(checkId);
        trace.checks.set(checkId, { status, runs: (known?.runs ?? 0) + 1, at: event.at });
        line(
          `Check ${checkId} ${status}`,
          status === "passed" ? "ok" : status === "failed" ? "err" : "warn",
        );
        break;
      }
      case "gate.finished": {
        const { gateId, status, mode, attempts: tries, flaky } = event.payload;
        trace.gates.set(gateId, { status, mode, attempts: tries, flaky });
        line(
          `Gate ${gateId} ${status}${mode === "advisory" ? " (advisory)" : ""}`,
          status === "passed" ? "ok" : status === "failed" ? "err" : "warn",
        );
        break;
      }
      case "wait.progress": {
        const { stageId, pending, deadline, intervalSeconds } = event.payload;
        line(
          pending.length
            ? `${stageLabel(stageId)} waits for ${pending.join(", ")} until ${new Date(deadline).toLocaleTimeString()}, every ${intervalSeconds}s`
            : `${stageLabel(stageId)}: its gates pass`,
          pending.length ? "info" : "ok",
        );
        break;
      }
      case "acceptance.phase":
        trace.acceptance.set(event.payload.gateId, {
          phase: event.payload.phase,
          detail: event.payload.detail,
        });
        line(`Acceptance ${event.payload.gateId}: ${event.payload.phase.replaceAll("_", " ")}`);
        break;
      case "criterion.assessed":
        trace.criteria.set(event.payload.criterionId, event.payload.verdict);
        break;
      case "finding.recorded":
        if (!trace.findings.has(event.payload.findingId))
          line(`Finding ${event.payload.findingId} recorded`, "warn");
        trace.findings.set(event.payload.findingId, event.payload.artifactId);
        break;
      case "request.created":
        trace.requests.set(event.payload.requestId, {
          kind: event.payload.kind,
          status: "pending",
        });
        line(REQUEST_TEXT[event.payload.kind] ?? `Request ${event.payload.kind}`, "warn");
        break;
      case "request.decided": {
        const known = trace.requests.get(event.payload.requestId);
        trace.requests.set(event.payload.requestId, {
          kind: known?.kind ?? "request",
          status: event.payload.status,
        });
        if (event.payload.status !== "superseded")
          line(
            `${known ? stageLabel(known.kind.replaceAll("_", " ")) : "Request"} ${event.payload.status}${event.payload.actor === "auto-approval" ? " automatically" : ""}`,
            event.payload.status === "accepted" ? "ok" : "warn",
          );
        break;
      }
      case "decision.would_stop": {
        const { reason, mode, summary } = event.payload;
        const count = (trace.wouldStop.get(reason)?.count ?? 0) + 1;
        trace.wouldStop.set(reason, { mode, count, summary });
        if (mode === "advisory") line(`Would stop (advisory): ${summary}`, "warn");
        break;
      }
      case "tool.finished":
        if (event.payload.status === "deadline")
          line(`Tool ${event.payload.tool} did not return in time`, "warn");
        else if (event.payload.tool === "run_probe")
          line(`Probe ran (${(event.payload.durationMs / 1000).toFixed(1)} s)`);
        break;
      default:
        break;
    }
  }
  return trace;
}

function applyTask(
  trace: RunTrace,
  taskId: string,
  to: string,
  generation: number,
  at: string,
): void {
  const known = trace.tasks.get(taskId);
  let slot = known?.slot ?? null;
  if (to === "running" && slot === null) {
    const free = trace.writers.find((w) => w.current === null);
    const writer = free ?? { index: trace.writers.length, current: null, done: [] };
    if (!free) trace.writers.push(writer);
    writer.current = taskId;
    slot = writer.index;
  } else if (to !== "running" && slot !== null) {
    const writer = trace.writers[slot];
    if (writer) {
      writer.current = null;
      if (DONE_TASK.has(to)) writer.done.push(taskId);
    }
    slot = null;
  }
  if (DONE_TASK.has(to) && !trace.integrated.includes(taskId)) trace.integrated.push(taskId);
  if (!DONE_TASK.has(to)) {
    const index = trace.integrated.indexOf(taskId);
    if (index >= 0) trace.integrated.splice(index, 1);
  }
  trace.tasks.set(taskId, { status: to, generation, slot, changedAt: at });
}

// ---------------------------------------------------------------------------------------------
// Derived views

export type PipelineState = "done" | "current" | "waiting" | "failed" | "skipped" | "pending";
export interface PipelineStage {
  id: string;
  label: string;
  state: PipelineState;
}

/**
 * The stage pipeline: the definition's stages in order, plus stages the events name that the
 * definition (read today, possibly changed since the run started) no longer has.
 */
export function pipeline(
  definition: readonly string[] | null,
  trace: RunTrace,
  current: { stageId: string | null; status: RunState },
): PipelineStage[] {
  const ids = [...(definition ?? [])];
  for (const id of trace.stageOrder) if (!ids.includes(id)) ids.push(id);
  if (current.stageId && !ids.includes(current.stageId)) ids.push(current.stageId);
  const currentIndex = current.stageId ? ids.indexOf(current.stageId) : -1;
  return ids.map((id, index) => {
    const seen = trace.stages.get(id)?.status;
    let state: PipelineState = "pending";
    if (seen === "completed") state = "done";
    else if (seen === "skipped") state = "skipped";
    else if (seen === "failed") state = "failed";
    if (id === current.stageId && current.status !== "completed") {
      state =
        current.status === "waiting" || current.status === "blocked" || current.status === "paused"
          ? "waiting"
          : current.status === "failed" || current.status === "cancelled"
            ? "failed"
            : "current";
    } else if (current.status === "completed" && state === "pending" && seen === undefined) {
      state = "skipped";
    } else if (state === "pending" && currentIndex > index && seen !== undefined) {
      state = "done";
    }
    return { id, label: stageLabel(id), state };
  });
}

export function stageProgress(stages: readonly PipelineStage[], stageId: string | null) {
  const index = stageId ? stages.findIndex((s) => s.id === stageId) : -1;
  return { index: index >= 0 ? index + 1 : 0, total: stages.length };
}

export interface TaskCount {
  done: number;
  total: number;
}
export function taskCount(graph: TaskGraph | null, trace: RunTrace): TaskCount {
  const ids = graph
    ? graph.tasks.map((t) => t.id)
    : [...trace.tasks.keys()].filter((id) => trace.tasks.get(id)?.status !== "invalidated");
  return {
    total: ids.length,
    done: ids.filter((id) => DONE_TASK.has(trace.tasks.get(id)?.status ?? "")).length,
  };
}

export type TaskState = "done" | "running" | "ready" | "waiting" | "failed" | "blocked";
export function taskState(task: Task, trace: RunTrace): TaskState {
  const status = trace.tasks.get(task.id)?.status ?? "pending";
  if (DONE_TASK.has(status)) return "done";
  if (status === "running") return "running";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "blocked" || status === "interrupted") return "blocked";
  return task.dependsOn.every((d) => DONE_TASK.has(trace.tasks.get(d)?.status ?? ""))
    ? "ready"
    : "waiting";
}

/** Tasks grouped by dependency depth: level 0 has no dependencies. */
export function taskLevels(graph: TaskGraph): Task[][] {
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const task = byId.get(id);
    if (!task || path.has(id)) return 0;
    path.add(id);
    const d = task.dependsOn.reduce(
      (max, dep) => (byId.has(dep) ? Math.max(max, visit(dep, path) + 1) : max),
      0,
    );
    path.delete(id);
    depth.set(id, d);
    return d;
  };
  const levels: Task[][] = [];
  for (const task of graph.tasks) {
    const d = visit(task.id, new Set());
    levels[d] = [...(levels[d] ?? []), task];
  }
  return levels.filter((level) => level !== undefined);
}

/** Tasks that can start next, in graph order: not started and every dependency integrated. */
export function nextTasks(graph: TaskGraph, trace: RunTrace): string[] {
  return graph.tasks.filter((t) => taskState(t, trace) === "ready").map((t) => t.id);
}

export interface Refetch {
  status: boolean;
  artifacts: boolean;
  usage: boolean;
}
const ARTIFACT_KINDS = new Set([
  "spec",
  "plan",
  "tasks",
  "estimate",
  "routing",
  "acceptance",
  "acceptance-rows",
  "gates",
  "report",
]);
/** What to read again after live events: the snapshot, the artifacts, the usage report. */
export function refetchFor(events: readonly WorkflowEvent[]): Refetch {
  const result: Refetch = { status: false, artifacts: false, usage: false };
  for (const event of events) {
    switch (event.type) {
      case "run.state_changed":
      case "run.rerouted":
      case "request.created":
      case "request.decided":
      case "budget.updated":
      case "stage.started":
      case "snapshot.invalidated":
        result.status = true;
        break;
      case "artifact.committed":
        if (ARTIFACT_KINDS.has(event.payload.kind)) result.artifacts = true;
        break;
      case "finding.recorded":
        result.artifacts = true;
        break;
      case "attempt.finished":
        result.usage = true;
        break;
      default:
        break;
    }
  }
  return result;
}

/** The latest revision of each logical path. */
export function latestByPath<T extends { path: string; revision: number }>(
  entries: readonly T[],
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const entry of entries) {
    const known = latest.get(entry.path);
    if (!known || entry.revision >= known.revision) latest.set(entry.path, entry);
  }
  return latest;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export const STATUS_TEXT: Record<RunState, string> = {
  created: "created",
  running: "running",
  waiting: "waiting for you",
  paused: "paused",
  blocked: "blocked",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};
export const STATUS_TONE: Record<RunState, "ok" | "warn" | "err" | "info" | ""> = {
  created: "",
  running: "info",
  waiting: "warn",
  paused: "",
  blocked: "warn",
  completed: "ok",
  failed: "err",
  cancelled: "",
};

/**
 * Whether the run screen opens its budget and activity panels on its own: a blocked run the
 * service would extend (`canExtendRun`: stopped on its budget, or blocked for another reason with
 * its spent and reserved cost near the cap), or one stopped by its provider.
 */
export function budgetPanelNeeded(
  run: Pick<
    RunSnapshot,
    "status" | "reason" | "estimatedCostUsd" | "reservedCostUsd" | "maxCostUsd"
  >,
): boolean {
  return (
    run.status === "blocked" &&
    (canExtendRun(run) ||
      run.reason === "provider_account" ||
      run.reason === "provider_policy" ||
      run.reason === "provider_unavailable")
  );
}

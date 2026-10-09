import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSnapshot, WorkflowEvent } from "../../core/workflows/schemas.js";
import type { Check } from "../../core/workflows/types.js";
import type { BudgetView, StageView } from "../../core/workflows/view.js";

export type Tone = "online" | "offline" | "warning" | "error" | "info" | "idle";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const isTerminal = (status: string): boolean => TERMINAL.has(status);

export function statusTone(status: RunSnapshot["status"]): Tone {
  switch (status) {
    case "running":
      return "info";
    case "waiting":
    case "blocked":
      return "warning";
    case "completed":
      return "online";
    case "failed":
      return "error";
    case "paused":
    case "created":
      return "idle";
    case "cancelled":
      return "offline";
  }
}
export function statusGlyph(status: RunSnapshot["status"], needsUser: boolean): string {
  if (needsUser) return "⚑";
  return (
    {
      created: "○",
      running: "⟳",
      waiting: "⚑",
      paused: "‖",
      blocked: "!",
      completed: "✓",
      failed: "✗",
      cancelled: "–",
    } as const
  )[status];
}

const STAGE_LABELS: Record<string, string> = {
  research: "Research",
  specify: "Specify",
  plan: "Plan",
  analyze: "Analyze",
  approve: "Approve",
  "task-graph": "Implement",
  checks: "Checks",
  review: "Review",
  converge: "Converge",
  learn: "Learn",
};
export const stageLabel = (kind: string): string => STAGE_LABELS[kind] ?? kind;
export function stageGlyph(
  stage: StageView,
  current: boolean,
  runStatus: RunSnapshot["status"] = "running",
): string {
  if (stage.status === "completed" || stage.status === "skipped") return "✓";
  if (stage.status === "failed") return "✗";
  if (stage.status === "waiting" || (current && stage.kind === "approve")) return "⚑";
  if (current && (runStatus === "paused" || runStatus === "blocked")) return "‖";
  if (stage.status === "running" || current) return "▶";
  if (stage.status === "interrupted" || stage.status === "invalidated") return "↺";
  return "·";
}

const REASONS: Record<string, string> = {
  clarification: "the agents need answers to open questions",
  approval: "the spec, plan and tasks wait for your approval",
  manual_evidence: "a criterion needs a manual observation from you",
  user_pause: "paused by you",
  owner_lost: "the process that ran it stopped",
  input_changed: "instructions or configuration changed since approval",
  workspace_busy: "another run or edit holds the workspace",
  budget_exhausted: "the token, call or time budget is used up",
  no_progress: "repairs stopped making progress",
  verification_failed: "checks or reviews did not pass",
  provider_unavailable: "the model provider is unavailable",
  tool_denied: "a tool call was denied by policy",
  storage_failure: "workflow storage failed",
  invalid_output: "a model returned output that failed validation",
  interrupted_effect: "an interrupted command needs recovery",
  dependency_failed: "a dependency did not complete",
};
export const reasonText = (reason: string): string => REASONS[reason] ?? reason;

/** One sentence for "what is happening" and an optional one for "what you can do". */
export function headline(
  snapshot: RunSnapshot,
  stages: StageView[],
  driving: boolean,
  budget: BudgetView | null = null,
): { now: string; next: string | null } {
  const stage = stages.find((s) => s.id === snapshot.stageId);
  const at = stage ? stageLabel(stage.kind) : (snapshot.stageId ?? "start");
  switch (snapshot.status) {
    case "created":
      return { now: "Created, not started yet.", next: "Press R to start." };
    case "running":
      return driving
        ? { now: `Working on ${at}.`, next: null }
        : {
            now: `Marked running at ${at}, but this window is not executing it.`,
            next: "If no other BAKED window runs it, press P: pausing releases the workspace.",
          };
    case "waiting":
      return {
        now: `Waiting at ${at}: ${reasonText(snapshot.reason)}.`,
        next: "Press Enter to open the decision.",
      };
    case "paused":
      return { now: `Paused at ${at}.`, next: "Press R to resume." };
    case "blocked":
      if (snapshot.reason === "budget_exhausted")
        return {
          now: `Blocked at ${at}: ${budget ? budgetLimitText(budget) : reasonText(snapshot.reason)}.`,
          next: `F forks a new run with the same limits and fresh counters${stage && ["research", "specify", "plan", "analyze"].includes(stage.kind) ? " (it starts again from Research)" : ""}. For broad requests, narrow the description or start a new run with the extended budget. C cancels.`,
        };
      return {
        now: `Blocked at ${at}: ${reasonText(snapshot.reason)}.`,
        next: "Press R to retry, F to fork, or C to cancel.",
      };
    case "completed":
      return { now: "Completed. All required criteria are verified.", next: null };
    case "failed":
      return {
        now: `Failed at ${at}: ${reasonText(snapshot.reason)}.`,
        next: "Press F to fork a new run from its artifacts.",
      };
    case "cancelled":
      return { now: "Cancelled.", next: "Press F to fork a new run from its artifacts." };
  }
}

/** Which limit stopped the run, with the numbers that explain it. */
export function budgetLimitText(budget: BudgetView): string {
  if (budget.calls >= budget.maxCalls) return `all ${budget.maxCalls} agent calls are used`;
  if (budget.activeMs >= budget.maxActiveMs)
    return `the active time limit of ${formatDuration(budget.maxActiveMs)} is reached`;
  const taken = budget.tokens + budget.heldTokens + budget.inFlightTokens;
  return `the next agent step needs more tokens than remain: ${formatTokens(taken)} of ${formatTokens(budget.maxTokens)} are used or held, ${formatTokens(Math.max(0, budget.maxTokens - taken))} left`;
}
export interface RunAction {
  key: string;
  label: string;
  action: "resume" | "pause" | "cancel" | "fork" | "decide";
}
export function runActions(snapshot: RunSnapshot): RunAction[] {
  const actions: RunAction[] = [];
  const s = snapshot.status;
  if (snapshot.pendingRequestIds.length)
    actions.push({ key: "Enter", label: "decide", action: "decide" });
  if (
    s === "created" ||
    s === "paused" ||
    (s === "blocked" && snapshot.reason !== "budget_exhausted")
  )
    actions.push({
      key: "R",
      label: s === "created" ? "start" : s === "blocked" ? "retry" : "resume",
      action: "resume",
    });
  if (s === "running") actions.push({ key: "P", label: "pause", action: "pause" });
  if (s === "blocked" || isTerminal(s)) actions.push({ key: "F", label: "fork", action: "fork" });
  if (!isTerminal(s)) actions.push({ key: "C", label: "cancel", action: "cancel" });
  return actions;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Human-readable activity line, or null for events that are noise in a feed. */
export function eventText(event: WorkflowEvent, stages: StageView[]): string | null {
  const kindOf = (stageId: string): string =>
    stageLabel(stages.find((s) => s.id === stageId)?.kind ?? stageId);
  switch (event.type) {
    case "run.created":
      return `Run created for ${event.payload.featureId}`;
    case "run.state_changed":
      if (event.payload.from === event.payload.to) return null;
      return `Run ${event.payload.from} → ${event.payload.to}${event.payload.reason !== "none" ? ` (${reasonText(event.payload.reason)})` : ""}`;
    case "stage.started":
      return `${kindOf(event.payload.stageId)} started${event.payload.generation > 0 ? ` (round ${event.payload.generation + 1})` : ""}`;
    case "stage.finished":
      return event.payload.status === "completed" ? null : `Stage step ${event.payload.status}`;
    case "attempt.started":
      return event.payload.modelId ? `Agent call on ${event.payload.modelId}` : null;
    case "attempt.finished":
      return event.payload.status === "completed" ? null : `Agent call ${event.payload.status}`;
    case "task.state_changed":
      return `Task ${event.payload.taskId}: ${event.payload.from} → ${event.payload.to}`;
    case "check.finished":
      return `Check ${event.payload.checkId} ${event.payload.status}`;
    case "finding.recorded":
      return "Review recorded a finding";
    case "criterion.assessed":
      return `Criterion ${event.payload.criterionId}: ${event.payload.verdict}`;
    case "request.created":
      return `Needs you: ${event.payload.kind.replace("_", " ")}`;
    case "request.decided":
      return `Decision ${event.payload.status}${event.payload.actor === "system-invalidation" ? " (superseded)" : ""}`;
    case "effect.reconciled":
      return `Effect ${event.payload.status}`;
    case "snapshot.invalidated":
      return `Evidence invalidated: ${event.payload.reason.replace("_", " ")}`;
    case "artifact.committed":
    case "budget.updated":
      return null;
  }
}

/** The latest model seen in agent attempts, for "who is working" display. */
export function lastModel(events: WorkflowEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "attempt.started" && e.payload.modelId) return e.payload.modelId;
  }
  return null;
}

const HINTS: [RegExp, string][] = [
  [/Workflows are disabled/i, "Open /workflow and press E to enable workflows for this project."],
  [/Select a model/i, "Close the panel, press Ctrl+L to pick a model, then try again."],
  [
    /at least one mandatory command check/i,
    "Add checks (typecheck, lint, tests) to workflows.policy.checks in .baked/config.json.",
  ],
  [
    /budget exhausted|exceeds remaining token budget/i,
    "Fork the run (F) to continue with a fresh budget.",
  ],
  [/Unknown run/i, "The run no longer exists. Pick another one from the list."],
  [
    /WORKSPACE_BUSY|already executing|workspace is busy/i,
    "Another run or edit holds the workspace. Wait or pause it first.",
  ],
  [
    /digest does not match|stale|Published artifact changed/i,
    "The files changed after the request was made. Re-open the decision to review the latest version.",
  ],
];
export function errorHint(message: string): string | null {
  return HINTS.find(([re]) => re.test(message))?.[1] ?? null;
}

const CYRILLIC: Record<string, string> = Object.fromEntries(
  "\u0430:a \u0431:b \u0432:v \u0433:g \u0434:d \u0435:e \u0451:e \u0436:zh \u0437:z \u0438:i \u0439:y \u043a:k \u043b:l \u043c:m \u043d:n \u043e:o \u043f:p \u0440:r \u0441:s \u0442:t \u0443:u \u0444:f \u0445:h \u0446:ts \u0447:ch \u0448:sh \u0449:sch \u044a: \u044b:y \u044c: \u044d:e \u044e:yu \u044f:ya \u0456:i \u0457:yi \u0454:ye \u0491:g"
    .split(" ")
    .map((pair) => pair.split(":") as [string, string]),
);
/** A SafeId-compatible feature id derived from free text; Cyrillic is transliterated. */
export function featureSlug(text: string): string {
  const ascii = [...text.toLowerCase()]
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return ascii || `feature-${Date.now().toString(36)}`;
}
export const isFeatureId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id);

/** Checks proposed when enabling workflows, taken from the project's own package scripts. */
export function detectChecks(workspace: string): Check[] {
  const file = join(workspace, "package.json");
  if (!existsSync(file)) return [];
  let scripts: Record<string, unknown> = {};
  try {
    scripts =
      (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> }).scripts ??
      {};
  } catch {
    return [];
  }
  const runner =
    existsSync(join(workspace, "bun.lock")) || existsSync(join(workspace, "bun.lockb"))
      ? "bun"
      : existsSync(join(workspace, "pnpm-lock.yaml"))
        ? "pnpm"
        : existsSync(join(workspace, "yarn.lock"))
          ? "yarn"
          : "npm";
  const wanted: [string, string, number][] = [
    ["typecheck", "typecheck", 120000],
    ["lint", "lint", 120000],
    ["tests", "test", 600000],
  ];
  return wanted
    .filter(([, script]) => typeof scripts[script] === "string")
    .map(([id, script, timeoutMs]) => ({
      id,
      executable: runner,
      args: ["run", script],
      cwd: ".",
      timeoutMs,
      required: true,
      scope: "feature" as const,
      envNames: [],
      writes: [],
    }));
}

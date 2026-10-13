import { type BudgetLimits, proposeExtension } from "../../core/workflows/budget.js";
import { rangeText, type StartEstimate } from "../../core/workflows/estimate.js";
import { detectGates } from "../../core/workflows/gates.js";
import type { RunSnapshot, WorkflowEvent } from "../../core/workflows/schemas.js";
import type { Check } from "../../core/workflows/types.js";
import type {
  BudgetPresetId,
  BudgetView,
  EstimateView,
  StageView,
  WorkflowInfo,
} from "../../core/workflows/view.js";

export { featureSlug, isFeatureId } from "../../core/workflows/feature-id.js";

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
  report: "Report",
  wait: "Wait",
};
export const stageLabel = (kind: string): string => STAGE_LABELS[kind] ?? kind;
/**
 * A stage's entry in the run's stage row: glyph, name and round, plus the contract the current
 * stage is making (the desktop conveyor shows the same).
 */
export function stageText(stage: StageView, current: boolean, glyph: string): string {
  const round = stage.generation > 0 ? `×${stage.generation + 1}` : "";
  const label = `${glyph} ${stageLabel(stage.kind)}${round}`;
  return current ? `[${label}${stage.produces ? ` → ${stage.produces}` : ""}]` : label;
}

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
  step_stalled: "an agent call made no progress and was stopped",
  input_changed: "instructions or configuration changed since approval",
  workspace_busy: "another run or edit holds the workspace",
  budget_exhausted: "the token, call or time budget is used up",
  checkpoint: "the run reached a token checkpoint and waits for you to continue",
  no_progress: "repairs stopped making progress",
  verification_failed: "checks or reviews did not pass",
  provider_unavailable: "the model provider is unavailable",
  provider_account:
    "the model provider refused the account: add credits, fix the API key or switch the run to another model",
  tool_denied: "a tool call was denied by policy",
  storage_failure: "workflow storage failed",
  invalid_output: "a model returned output that failed validation",
  host_state: "the host's own state was stale or incomplete (not a model's output)",
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
        ? {
            now:
              stage?.kind === "wait"
                ? `Waiting at ${at}: polling its gates, no model calls.`
                : `Working on ${at}.`,
            next: null,
          }
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
          next: `${budget && extensionFor(budget) ? `Press B to raise the limits (${extensionText(budget)}) and continue from this stage. ` : ""}F forks a new run with the same limits and fresh counters${stage && ["research", "specify", "plan", "analyze"].includes(stage.kind) ? " (it starts again from Research)" : ""}. For broad requests, narrow the description first. C cancels.`,
        };
      if (snapshot.reason === "provider_account" || snapshot.reason === "provider_unavailable")
        return {
          now: `Blocked at ${at}: ${reasonText(snapshot.reason)}.${snapshot.autoRetry ? ` Retrying by itself at ${new Date(snapshot.autoRetry.at).toLocaleTimeString()} (${snapshot.autoRetry.attempt} of ${snapshot.autoRetry.of}).` : ""}`,
          next: "Press R to retry once the provider works again, or M to continue on this tab's model (Ctrl+L picks another); completed work stays. F forks, C cancels.",
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
  action:
    | "resume"
    | "pause"
    | "cancel"
    | "fork"
    | "discard-worktree"
    | "decide"
    | "extend"
    | "undo"
    | "reroute";
}
/** The limits one "raise" decision would set, from the numbers the run screen already has. */
export function extensionFor(budget: BudgetView): BudgetLimits | null {
  return proposeExtension(
    {
      maxTotalTokens: budget.maxTokens,
      maxAgentCalls: budget.maxCalls,
      maxActiveMs: budget.maxActiveMs,
    },
    budget,
  );
}
export function extensionText(budget: BudgetView): string {
  const next = extensionFor(budget);
  if (!next) return "no limit can be raised further";
  return [
    next.maxTotalTokens > budget.maxTokens &&
      `tokens ${formatTokens(budget.maxTokens)} → ${formatTokens(next.maxTotalTokens)}`,
    next.maxAgentCalls > budget.maxCalls && `calls ${budget.maxCalls} → ${next.maxAgentCalls}`,
    next.maxActiveMs > budget.maxActiveMs &&
      `time ${formatDuration(budget.maxActiveMs)} → ${formatDuration(next.maxActiveMs)}`,
  ]
    .filter(Boolean)
    .join(", ");
}
/**
 * The run screen's actions. `switchTo` is the model a stopped run can move to (the tab's model
 * when it differs from the run model); null hides the action. `worktree` is true while the run's
 * worktree is still on disk.
 */
export function runActions(
  snapshot: RunSnapshot,
  budget: BudgetView | null = null,
  switchTo: string | null = null,
  worktree = false,
): RunAction[] {
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
  if (
    s === "blocked" &&
    snapshot.reason === "budget_exhausted" &&
    (!budget || extensionFor(budget))
  )
    actions.push({ key: "B", label: "raise limits", action: "extend" });
  if (switchTo && (s === "created" || s === "paused" || s === "blocked" || s === "waiting"))
    actions.push({ key: "M", label: "switch model", action: "reroute" });
  if (s === "blocked" || isTerminal(s)) actions.push({ key: "F", label: "fork", action: "fork" });
  if (worktree && isTerminal(s))
    actions.push({ key: "D", label: "discard worktree", action: "discard-worktree" });
  // Undo needs the run's leases, so it is offered only while nothing executes the run.
  if (s !== "created" && s !== "running")
    actions.push({ key: "U", label: "undo edits", action: "undo" });
  if (!isTerminal(s)) actions.push({ key: "C", label: "cancel", action: "cancel" });
  return actions;
}

/** How the start estimate compares with a budget preset, for the new-run form. */
export function estimateFit(
  estimate: StartEstimate,
  preset: WorkflowInfo["presets"][BudgetPresetId] | undefined,
): { text: string; warn: boolean } {
  const base = estimate.label;
  if (!preset) return { text: base, warn: false };
  if (preset.checkpointTokens)
    return {
      text: `${base}. This preset has no token cap; you decide at every ${formatTokens(preset.checkpointTokens)}.`,
      warn: false,
    };
  if (estimate.tokens.low > preset.maxTotalTokens)
    return {
      text: `${base}. Even the low end is above this budget (${formatTokens(preset.maxTotalTokens)}): pick a larger one.`,
      warn: true,
    };
  if (estimate.tokens.high > preset.maxTotalTokens)
    return {
      text: `${base}. The high end is above this budget (${formatTokens(preset.maxTotalTokens)}); the run may stop for more.`,
      warn: true,
    };
  return { text: `${base}. It fits this budget.`, warn: false };
}

/** Lines for the run overview: expectation, burn rate, where the budget ends, and the final check. */
export function estimateLines(
  estimate: EstimateView | null,
  stages: StageView[],
): { text: string; tone: "muted" | "warn" }[] {
  if (!estimate) return [];
  const out: { text: string; tone: "muted" | "warn" }[] = [];
  const name = (id: string): string =>
    stageLabel(stages.find((stage) => stage.id === id)?.kind ?? id);
  const p = estimate.projection;
  if (p) {
    out.push({ text: p.label, tone: "muted" });
    if (p.tokensPerMinute)
      out.push({
        text: `Burn rate ${formatTokens(p.tokensPerMinute)} tokens per active minute${p.minutesLeft !== null ? `; the remaining budget lasts about ${formatDuration(p.minutesLeft * 60000)} at that rate` : ""} (estimate)`,
        tone: "muted",
      });
    if (p.exhaustsAt.typical || p.exhaustsAt.high)
      out.push({
        text: p.exhaustsAt.typical
          ? `Forecast: at the typical cost the budget runs out during ${name(p.exhaustsAt.typical)}`
          : `Forecast: the budget should last at the typical cost; at the high end it runs out during ${name(p.exhaustsAt.high ?? "")}`,
        tone: "warn",
      });
  }
  if (estimate.comparison) out.push({ text: estimate.comparison.text, tone: "muted" });
  else if (!p && estimate.saved)
    out.push({
      text: `Estimated ${rangeText(estimate.saved.tokens)} at the start (estimate)`,
      tone: "muted",
    });
  return out;
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
    case "run.rerouted":
      return event.payload.runModel.from === event.payload.runModel.to
        ? `Routes changed: ${event.payload.changes.length} stage or profile route(s)`
        : `Switched to ${event.payload.runModel.to} (was ${event.payload.runModel.from})`;
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
      return `Decision ${event.payload.status}${event.payload.actor === "system-invalidation" ? " (superseded)" : event.payload.actor === "auto-approval" ? " (auto approval)" : ""}`;
    case "effect.reconciled":
      return `Effect ${event.payload.status}`;
    case "snapshot.invalidated":
      return `Evidence invalidated: ${event.payload.reason.replace("_", " ")}`;
    case "transition.taken":
      return event.payload.outcome === "passed"
        ? null
        : `${kindOf(event.payload.from)} ${event.payload.outcome.replace("_", " ")}: back to ${kindOf(event.payload.to)}`;
    case "gate.finished":
      return event.payload.status === "passed"
        ? null
        : `Gate ${event.payload.gateId} ${event.payload.status}${event.payload.mode === "advisory" ? " (advisory)" : ""}${event.payload.flaky ? " (flaky)" : ""}`;
    case "wait.progress":
      return event.payload.pending.length
        ? `Waiting for ${event.payload.pending.join(", ")} until ${clockTime(event.payload.deadline)} (every ${event.payload.intervalSeconds}s)`
        : "Wait gates pass";
    case "acceptance.phase":
      return `AI walk-through ${event.payload.gateId}: ${event.payload.phase.replace("_", " ")}${event.payload.detail ? ` (${event.payload.detail.slice(0, 120)})` : ""}`;
    case "artifact.committed":
    case "budget.updated":
    case "tool.started":
      return null;
    case "tool.finished":
      // Only a call that hit its deadline is worth a line; the rest is evidence for attribution.
      return event.payload.status === "deadline"
        ? `Tool ${event.payload.tool} did not return in time and was abandoned`
        : null;
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
  [
    /Workflows are turned off/i,
    "Open /workflow and press E to turn workflows back on for this project.",
  ],
  [/Select a model/i, "Close the panel, press Ctrl+L to pick a model, then try again."],
  [
    /at least one mandatory command check/i,
    "Add checks (typecheck, lint, tests) to workflows.policy.checks in .baked/config.json.",
  ],
  [
    /budget exhausted|exceeds remaining token budget/i,
    "Raise the limits (B) to continue from where it stopped, or fork the run (F) with a fresh budget.",
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

/** Checks proposed when enabling workflows: the preselected detections for every ecosystem found. */
export function detectChecks(workspace: string): Check[] {
  return detectGates(workspace)
    .filter((suggestion) => suggestion.preselected)
    .map((suggestion) => suggestion.check);
}

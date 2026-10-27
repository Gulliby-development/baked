import {
  type BudgetLimits,
  proposeCostCap,
  proposeExtension,
} from "../../core/workflows/budget.js";
import { rangeText, type StartEstimate } from "../../core/workflows/estimate.js";
import { canExtendRun } from "../../core/workflows/extendable.js";
import { detectGates } from "../../core/workflows/gates.js";
import { reasonText } from "../../core/workflows/reasons.js";
import type { HostRemedy, Remedy } from "../../core/workflows/remedies-model.js";
import { canRepairRun, repairText } from "../../core/workflows/repairable.js";
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

export { reasonText };

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
      if (snapshot.reason === "provider")
        return {
          now: `Waiting at ${at}: ${reasonText(snapshot.reason)}.${snapshot.providerWait ? ` Next probe at ${new Date(snapshot.providerWait.retryAt).toLocaleTimeString()}.` : ""}`,
          next: "Recovery is automatic. P pauses, C cancels.",
        };
      return {
        now: `Waiting at ${at}: ${reasonText(snapshot.reason)}.`,
        next: "Press Enter to open the decision.",
      };
    case "paused":
      return { now: `Paused at ${at}.`, next: "Press R to resume." };
    case "blocked":
      if (canRepairRun(snapshot) && snapshot.repairBlock)
        return {
          now: `Blocked at ${at}: ${repairText(snapshot.repairBlock)}`,
          next: `${formatTokens(snapshot.tokenUsage)} tokens spent. Press O to grant one more repair and continue, F to fork, or C to cancel.`,
        };
      if (snapshot.reason === "budget_exhausted")
        return {
          now: `Blocked at ${at}: ${budget ? budgetLimitText(budget) : reasonText(snapshot.reason)}.`,
          next: `${budget && canExtend(budget) ? `Press B to raise the limits (${extensionText(budget)}) and continue from this stage. ` : ""}F forks a new run with the same limits and fresh counters${stage && ["research", "specify", "plan", "analyze"].includes(stage.kind) ? " (it starts again from Research)" : ""}. For broad requests, narrow the description first. C cancels.`,
        };
      if (snapshot.reason === "input_changed")
        return {
          now: `Blocked at ${at}: files the run accepted changed since approval.`,
          next: "Press A to keep the changes, or restore the files and press R. F forks, C cancels.",
        };
      if (snapshot.reason === "provider_account" || snapshot.reason === "provider_unavailable")
        return {
          now: `Blocked at ${at}: ${reasonText(snapshot.reason)}.${snapshot.autoRetry ? ` Retrying by itself at ${new Date(snapshot.autoRetry.at).toLocaleTimeString()} (${snapshot.autoRetry.attempt} of ${snapshot.autoRetry.of}).` : ""}`,
          next: `${raiseText(snapshot, budget)}Press R to retry once the provider works again, or M to continue on this tab's model (Ctrl+L picks another); completed work stays. F forks, C cancels.`,
        };
      if (snapshot.reason === "provider_policy")
        return {
          now: `Blocked at ${at}: ${reasonText(snapshot.reason)}.`,
          next: "Press M to continue on this tab's model (Ctrl+L picks another); completed work stays. R tries the same model once more. F forks, C cancels.",
        };
      if (snapshot.reason === "host_error")
        return {
          now: `Blocked at ${at}: BAKED failed internally; this is not a model problem.`,
          next: `Press R to resume once. If it stops the same way, export the run (/workflow export ${snapshot.runId} --destination DIR) and report the export. C cancels.`,
        };
      return {
        now: `Blocked at ${at}: ${reasonText(snapshot.reason)}.`,
        next: `${raiseText(snapshot, budget)}Press R to retry, F to fork, or C to cancel.`,
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

/** A dollar amount: cents below $100, whole dollars above. */
export function usd(value: number): string {
  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}
const limitsOfView = (budget: BudgetView): BudgetLimits => ({
  maxTotalTokens: budget.maxTokens,
  maxAgentCalls: budget.maxCalls,
  maxActiveMs: budget.maxActiveMs,
});
/** The cost cap one "raise" decision would set; null when the run has none. */
export function costCapFor(budget: BudgetView): number | null {
  const cost = budget.cost;
  if (!cost) return null;
  return proposeCostCap(
    cost.maxCostUsd,
    cost.spentUsd + cost.reservedUsd,
    limitsOfView(budget),
    budget,
  );
}
/** The cap as the run holds to it: with a tolerance band, the ceiling and the cap it extends. */
export function capText(cost: NonNullable<BudgetView["cost"]>): string {
  return cost.ceilingUsd !== undefined
    ? `${usd(cost.ceilingUsd)} ceiling (the ${usd(cost.maxCostUsd)} cap and its tolerance)`
    : `${usd(cost.maxCostUsd)} cap`;
}
/** Which limit stopped the run, with the numbers that explain it. */
export function budgetLimitText(budget: BudgetView): string {
  if (budget.calls >= budget.maxCalls) return `all ${budget.maxCalls} agent calls are used`;
  if (budget.activeMs >= budget.maxActiveMs)
    return `the active time limit of ${formatDuration(budget.maxActiveMs)} is reached`;
  const cost = budget.cost;
  if (cost?.forecastUsd !== undefined)
    return `the run is forecast to cost about ${usd(cost.forecastUsd)}, above its ${capText(cost)}, with ${usd(cost.spentUsd + cost.reservedUsd)} spent; raise the cap to finish it, or resume to spend on to it`;
  const cap = costCapFor(budget);
  if (cost && cap !== null && cap > cost.maxCostUsd)
    return `the next agent step would pass the ${cost.ceilingUsd !== undefined ? "cost ceiling" : "cost cap"}: about ${usd(cost.spentUsd + cost.reservedUsd)} of ${usd(cost.ceilingUsd ?? cost.maxCostUsd)} is spent or reserved`;
  const taken = budget.tokens + budget.heldTokens + budget.inFlightTokens;
  return `the next agent step needs more tokens than remain: ${formatTokens(taken)} of ${formatTokens(budget.maxTokens)} are used or held, ${formatTokens(Math.max(0, budget.maxTokens - taken))} left`;
}
export interface RunAction {
  key: string;
  label: string;
  action:
    | "resume"
    | "accept-workspace"
    | "pause"
    | "cancel"
    | "fork"
    | "discard-worktree"
    | "decide"
    | "repair"
    | "extend"
    | "undo"
    | "reroute"
    | "checks"
    | "reviews"
    | "export-package"
    | HostRemedy;
}
/** The limits one "raise" decision would set, from the numbers the run screen already has. */
export function extensionFor(budget: BudgetView): BudgetLimits | null {
  return proposeExtension(limitsOfView(budget), budget);
}
/** Whether a "raise" decision would raise any limit, the cost cap included. */
export function canExtend(budget: BudgetView): boolean {
  const cap = costCapFor(budget);
  return extensionFor(budget) !== null || (cap !== null && cap > (budget.cost?.maxCostUsd ?? cap));
}
/**
 * Whether the run screen offers B: the service would extend the run (`canExtendRun`, spent plus
 * reserved cost against the cap) and a raise would change a limit.
 */
export function offersExtend(snapshot: RunSnapshot, budget: BudgetView | null): boolean {
  return canExtendRun(snapshot) && (!budget || canExtend(budget));
}
/** The B hint for a run blocked for another reason with its cost cap nearly spent. */
function raiseText(snapshot: RunSnapshot, budget: BudgetView | null): string {
  if (!offersExtend(snapshot, budget)) return "";
  return `Its cost cap is nearly spent: press B to raise the limits${budget ? ` (${extensionText(budget)})` : ""} and continue from this stage. `;
}
export function extensionText(budget: BudgetView): string {
  const next = extensionFor(budget);
  const cap = costCapFor(budget);
  const costText =
    budget.cost && cap !== null && cap > budget.cost.maxCostUsd
      ? `cost cap ${usd(budget.cost.maxCostUsd)} → ${usd(cap)}`
      : null;
  if (!next) return costText ?? "no limit can be raised further";
  return [
    costText,
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
  remedies: readonly Remedy[] = [],
): RunAction[] {
  const actions: RunAction[] = [];
  const s = snapshot.status;
  if (snapshot.pendingRequestIds.length)
    actions.push({ key: "Enter", label: "decide", action: "decide" });
  // A corrective's block on files it may not write: the act the host would take (#2155).
  if (s === "blocked")
    for (const remedy of remedies) {
      const files = remedy.paths?.slice(0, 2).join(", ") ?? "";
      if (remedy.action === "route")
        actions.push({
          key: "T",
          label: `correct ${remedy.owner ?? "owner"} first`,
          action: "route",
        });
      else if (remedy.action === "widen")
        actions.push({
          key: "W",
          label: `let ${remedy.taskId ?? "it"} write ${files}`,
          action: "widen",
        });
      else if (remedy.action === "upstream")
        actions.push({ key: "Q", label: `ask ${remedy.owner ?? "upstream"}`, action: "upstream" });
    }
  if (
    s === "created" ||
    s === "paused" ||
    (s === "blocked" && snapshot.reason !== "budget_exhausted" && !canRepairRun(snapshot))
  )
    actions.push({
      key: "R",
      label: s === "created" ? "start" : s === "blocked" ? "retry" : "resume",
      action: "resume",
    });
  if (canRepairRun(snapshot))
    actions.push({ key: "O", label: "one more repair", action: "repair" });
  // Keeps the files a person changed outside the run instead of restoring them.
  if (s === "blocked" && snapshot.reason === "input_changed")
    actions.push({ key: "A", label: "accept changes", action: "accept-workspace" });
  if (s === "running") actions.push({ key: "P", label: "pause", action: "pause" });
  if (offersExtend(snapshot, budget))
    actions.push({ key: "B", label: "raise limits", action: "extend" });
  if (switchTo && (s === "created" || s === "paused" || s === "blocked" || s === "waiting"))
    actions.push({ key: "M", label: "switch model", action: "reroute" });
  if (s === "blocked" || isTerminal(s)) actions.push({ key: "F", label: "fork", action: "fork" });
  // A delivered run's pull request checks; the read says when the run was not delivered.
  if (s === "completed") actions.push({ key: "K", label: "PR checks", action: "checks" });
  if (s === "completed") actions.push({ key: "V", label: "PR reviews", action: "reviews" });
  if (worktree && isTerminal(s))
    actions.push({ key: "D", label: "discard worktree", action: "discard-worktree" });
  // Undo needs the run's leases, so it is offered only while nothing executes the run.
  if (s !== "created" && s !== "running")
    actions.push({ key: "U", label: "undo edits", action: "undo" });
  if (!isTerminal(s)) actions.push({ key: "C", label: "cancel", action: "cancel" });
  // The accepted spec, plan and tasks as an SDD package another harness reads (#2207).
  if (snapshot.approvalDigest !== null)
    actions.push({ key: "E", label: "export package", action: "export-package" });
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
    // A shadow would-stop is for the round report and status counts, not the person's feed.
    case "decision.would_stop":
      return event.payload.mode === "advisory"
        ? `Would stop (advisory): ${event.payload.summary}`
        : null;
    case "decision.would_resume":
      return event.payload.mode === "advisory"
        ? `Would resume (advisory): ${event.payload.summary}`
        : null;
    case "attempt.recovery":
      return `Stalled agent call, recovery: ${event.payload.detail}`;
    case "attempt.advisory":
      return `Progress watcher ${event.payload.action === "stopped" ? "stopped the agent call" : "warned the agent"}: ${event.payload.detail}`;
    case "task.state_changed":
      return `Task ${event.payload.taskId}: ${event.payload.from} → ${event.payload.to}${event.payload.cause ? ` (${event.payload.cause.replaceAll("_", " ")}${event.payload.detail ? `: ${event.payload.detail}` : ""})` : ""}`;
    case "check.finished":
      return `Check ${event.payload.checkId} ${event.payload.status}`;
    case "finding.recorded":
      return "Review recorded a finding";
    case "criterion.assessed":
      return `Criterion ${event.payload.criterionId}: ${event.payload.verdict}`;
    case "request.created":
      return `Needs you: ${event.payload.kind.replace("_", " ")}`;
    case "request.decided":
      return `Decision ${event.payload.status}${event.payload.actor === "system-invalidation" ? " (superseded)" : event.payload.actor === "auto-approval" ? " (auto approval)" : event.payload.actor === "host-release" ? " (released by the initiative)" : ""}`;
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
    case "tool.phase":
      return null;
    case "tool.finished":
      // Only a call that hit its deadline is worth a line; the rest is evidence for attribution.
      if (event.payload.status === "deadline")
        return `Tool ${event.payload.tool} did not return in time and was abandoned`;
      // A repair probe is worth a line: it shows how a repair task isolated its failure.
      return event.payload.tool === "run_probe"
        ? `Probe ran (${formatDuration(event.payload.durationMs)})`
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

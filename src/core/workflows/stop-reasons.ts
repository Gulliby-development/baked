import { z } from "zod";
import { WorkflowFault } from "./errors.js";
import type { RunPolicy } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

/**
 * How a stop reason acts (#1714). `enforce` stops the run or declines the approval. `shadow`
 * computes the decision, records a `decision.would_stop` event and goes on; `advisory` does the
 * same and the run screens show it to the person, who is not asked to act. A new or changed
 * reason ships in `shadow` and moves to `enforce` in a PR of its own after bench rounds with no
 * false would-stop, so its first false positive costs a record and not a parked run.
 */
export const STOP_MODES = ["shadow", "advisory", "enforce"] as const;
export type StopMode = (typeof STOP_MODES)[number];

interface StopReason {
  /** What the reason guards, for status and the run screens. */
  label: string;
  /**
   * The modes a policy may give the reason. A hard limit on money, tokens, time or storage that
   * the person set is only enforced: a shadow mode would spend past it.
   */
  modes: readonly StopMode[];
  /** The mode without a `stopModes` entry in the policy. */
  defaultMode: StopMode;
}

const ENFORCED = ["enforce"] as const;
/** A reason that records what it would do and is not enforced yet: its promotion adds `enforce`. */
const NOT_ENFORCED = ["shadow", "advisory"] as const;

/**
 * Every reason the host stops a run on (`BUDGET_EXHAUSTED` faults, made by `stopFault`) or
 * declines an auto-approval for. `tests/stop-reasons.test.ts` fails on a stopping fault made
 * outside `stopFault`, so a new stop site has to register here.
 */
export const STOP_REASONS = {
  "cost-forecast": {
    label: "The run's cost forecast passes its cap",
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  "approval-scope": {
    label: "The plan has more tasks or files than auto-approval allows",
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  "check-config-approval": {
    label:
      "A plan edits a linter, formatter or type checker config that auto-approval did not keep with a person before",
    // Shadow by default (#2221): tsconfig and biome were always enforced; every other check
    // config of `CHECK_CONFIGS` records a would-stop until two bench rounds show none false, and
    // `stopModes: { "check-config-approval": "enforce" }` keeps them with a person now.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  "initiative-forecast": {
    label: "An initiative's cost or token forecast passes its budget",
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  "initiative-dollar-share": {
    label: "An initiative's spare dollars are below a starting feature's priced low estimate",
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  "initiative-plan-charge": {
    label:
      "An initiative's token pool holds an open feature run with a sized plan at its plan's need instead of its run limit",
    // Shadow by default (#2100, #2056): the charge can start a feature sooner or park one whose
    // plan prices above its run limit, so it records `decision.would_release` first.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  repeated_failure: {
    label: "A corrective's required checks fail exactly as the corrective's before it",
    // Shadow only until two bench rounds show no false would-stop (#1996); its promotion is a
    // pull request of its own that adds `enforce` and blocks the chain before the next session.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  corrective_scope: {
    label: "A corrective cannot write a file its own failing check names",
    // Shadow only until two bench rounds show no false would-stop (#2094); its promotion blocks
    // the corrective at creation and before a resumed session, at 0 tokens.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  corrective_unowned_file: {
    label:
      "A corrective's evidence names a file it may not write: route to its owner, widen, park for an upstream change or block",
    // Shadow by default (#2133): the host's decision (`hostDecision` in corrective-scope.ts) is
    // recorded as a would-stop on a corrective's blocked or failed result and before each of its
    // sessions. `stopModes: { corrective_unowned_file: "enforce" }` acts on it; making that the
    // default is a pull request of its own after two bench rounds with no false would-stop.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  upstream_symbol: {
    label:
      "A released planned-ahead feature's spec names a symbol of an upstream feature that the accepted upstream code does not have",
    // Shadow only until two bench rounds show no false would-stop (#2135); its promotion sends
    // the feature back to specify at release, before any implementer starts.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  repeat_without_change: {
    label: "A finding comes back after its corrective changed no file",
    // Shadow only until two bench rounds show no false would-stop (#2137); its promotion asks for
    // an owner or scope decision instead of opening another corrective of the same finding.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  cost: {
    label: "Spent and reserved dollars reach the cost cap",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "run-budget": {
    label: "The run's token, call or active-time budget is used up",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  budget_exhausted: {
    label: "A task is stopped by the run budget before its first edit",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  attempt_cap: {
    label: "An attempt reaches its token cap without a result",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  context_window: {
    label: "The required context exceeds the model's window",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  deadline: {
    label: "The run's active deadline passes",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "evidence-size": {
    label: "An artifact or the run's evidence passes its size cap",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "walkthrough-steps": {
    label: "A walk-through passes its step limit",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "budget-share": {
    label: "An initiative has no budget share left for a feature",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
} as const satisfies Record<string, StopReason>;

export type StopReasonId = keyof typeof STOP_REASONS;
const STOP_REASON_IDS = Object.keys(STOP_REASONS) as [StopReasonId, ...StopReasonId[]];
export const StopReasonIdSchema = z.enum(STOP_REASON_IDS);

/** A policy's `stopModes`: only modes a reason allows. Absent keeps every default. */
export const StopModesSchema = z
  .partialRecord(StopReasonIdSchema, z.enum(STOP_MODES))
  .superRefine((modes, ctx) => {
    for (const [id, mode] of Object.entries(modes) as [StopReasonId, StopMode][])
      if (!(STOP_REASONS[id].modes as readonly StopMode[]).includes(mode))
        ctx.addIssue({
          code: "custom",
          path: [id],
          message: (STOP_REASONS[id].modes as readonly StopMode[]).includes("enforce")
            ? `${id} is a hard limit and can only be enforced`
            : `${id} records what it would stop in shadow or advisory mode and cannot be enforced yet`,
        });
  });

/**
 * The mode of a reason under a policy. `costForecast: "advise"` (an initiative's feature runs,
 * #1659) is the advisory forecast; an explicit `stopModes` entry wins.
 */
export function stopMode(
  policy: Pick<RunPolicy, "stopModes" | "costForecast">,
  id: StopReasonId,
): StopMode {
  const explicit = policy.stopModes?.[id];
  if (explicit) return explicit;
  if (id === "cost-forecast" && policy.costForecast === "advise") return "advisory";
  return STOP_REASONS[id].defaultMode;
}

/** The fault that stops a run on a registered reason, as `details.reason`. */
export function stopFault(
  id: StopReasonId,
  message: string,
  details: Record<string, unknown> = {},
): WorkflowFault {
  return new WorkflowFault("BUDGET_EXHAUSTED", message, { reason: id, ...details });
}

export interface WouldStop {
  reason: StopReasonId;
  mode: Exclude<StopMode, "enforce">;
  /** One record per key and reason: a forecast is checked before every attempt. */
  key: string;
  /** What `enforce` would have done, in the words of its stop. */
  summary: string;
  inputs: Record<string, unknown>;
}

/**
 * Records that a reason in `shadow` or `advisory` would have stopped the run, once per key.
 * Returns whether it was recorded now.
 */
export function recordWouldStop(store: WorkflowStore, runId: string, stop: WouldStop): boolean {
  const seen = store
    .eventsOfType(runId, "decision.would_stop")
    .some(
      (e) =>
        e.type === "decision.would_stop" &&
        e.payload.reason === stop.reason &&
        e.payload.key === stop.key,
    );
  if (seen) return false;
  store.emit(runId, {
    type: "decision.would_stop",
    payload: {
      reason: stop.reason,
      mode: stop.mode,
      key: stop.key.slice(0, 200),
      summary: stop.summary.slice(0, 1000),
      inputs: stop.inputs,
    },
  });
  return true;
}

export interface WouldStopSummary {
  reason: StopReasonId;
  label: string;
  mode: Exclude<StopMode, "enforce">;
  count: number;
  /** The latest would-stop of the reason. */
  last: { at: string; summary: string };
}

/** The run's would-stop records by reason, for `workflow status` and the run view. */
export function wouldStopSummary(store: WorkflowStore, runId: string): WouldStopSummary[] {
  const byReason = new Map<StopReasonId, WouldStopSummary>();
  for (const event of store.eventsOfType(runId, "decision.would_stop")) {
    if (event.type !== "decision.would_stop") continue;
    const { reason, mode, summary } = event.payload;
    const entry = byReason.get(reason);
    byReason.set(reason, {
      reason,
      label: STOP_REASONS[reason].label,
      mode,
      count: (entry?.count ?? 0) + 1,
      last: { at: event.at, summary },
    });
  }
  return [...byReason.values()];
}

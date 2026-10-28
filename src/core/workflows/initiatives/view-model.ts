/**
 * What the terminal UI shows and offers for initiatives, derived from `InitiativeView` only. The
 * rules for which command is available mirror the checks in `InitiativeService`; the service
 * stays the authority and its refusal text is what a person sees when the view is stale.
 */
import { z } from "zod";
import { WorkflowFault } from "../errors.js";
import { type ExtendAmounts, extendSuggestion, type RecoveryAdvice } from "../remedies.js";
import { canRepairRun, repairText } from "../repairable.js";
import { newId } from "../store.js";
import { DRIVABLE_NEXT } from "./drive-state.js";
import {
  canExtendBudget,
  canReplanFeature,
  costText,
  parseBudgetText,
  parseSplitParts,
  splitEditable,
} from "./forms.js";
import { FEATURE_SIZES, type FeatureSize, type SplitEdit, SplitEditSchema } from "./plan.js";
import type { FeatureView, InitiativeService, InitiativeView, PendingDecision } from "./service.js";

/** One row of the initiative list. */
export interface InitiativeSummary {
  initiativeId: string;
  title: string;
  status: InitiativeView["status"];
  /** Mandatory features with an accepted result, of all mandatory features. */
  accepted: number;
  total: number;
  tokensUsed: number;
  tokensLimit: number;
  /** The initiative's dollars in one line (`costText`); null without a cap or spending. */
  cost: string | null;
  /** Decisions waiting for a person: the split approval and the decisions of feature runs. */
  pending: number;
  /** Features that cannot continue now, plus a blocked next step of the initiative itself. */
  blockers: number;
  /** True when ready work waits for a drive (`drive.state` idle, #2024). */
  idle: boolean;
  /**
   * True when a person has something to do: a decision, a blocker, a paused initiative or an idle
   * one to continue.
   */
  needsYou: boolean;
  next: string;
}

const TERMINAL: readonly InitiativeView["status"][] = ["completed", "refused"];
export const initiativeIsTerminal = (view: Pick<InitiativeView, "status">): boolean =>
  TERMINAL.includes(view.status);

/** Why the initiative or one of its features cannot continue, in words, without duplicates. */
export function initiativeBlockers(
  view: InitiativeView,
  render: (message: string, advice?: RecoveryAdvice) => string = (message) => message,
): string[] {
  const blockers = view.features
    .filter((f) => f.state === "blocked" || f.state === "failed")
    .map((f) => `${f.id}: ${render(f.blockers.join("; ") || f.state, f.recovery)}`);
  const next = render(view.next.message, view.next.recovery);
  if (view.next.kind === "blocked" && !blockers.some((b) => next.includes(b)))
    blockers.unshift(next);
  return blockers;
}

/**
 * The critical path of the split in one line (#1551): its features, their share of the work, and
 * the most the split can gain over one feature at a time. Null with fewer than two features.
 */
export function criticalPathText(
  view: Pick<InitiativeView, "criticalPath" | "features" | "parallelRuns">,
): string | null {
  const path = view.criticalPath;
  if (!path || view.features.length < 2) return null;
  const gain =
    view.parallelRuns > 1
      ? ` · at most ${path.speedup.toFixed(2)}x faster than one feature at a time with ${view.parallelRuns} at once (plan width ${path.width})`
      : "";
  const kept = path.chain ? ` · kept: ${path.chain}` : "";
  return `Critical path: ${path.features.join(" -> ")} (${path.features.length} of ${view.features.length} features, ${Math.round(path.workShare * 100)}% of the work)${gain}${kept}`;
}

export function summarizeInitiative(
  view: InitiativeView,
  render: (message: string, advice?: RecoveryAdvice) => string = (message) => message,
): InitiativeSummary {
  const mandatory = view.features.filter((f) => f.mandatory);
  const blockers = initiativeIsTerminal(view) ? [] : initiativeBlockers(view, render);
  return {
    initiativeId: view.initiativeId,
    title: view.title,
    status: view.status,
    accepted: mandatory.filter((f) => f.state === "accepted").length,
    total: mandatory.length,
    tokensUsed: view.budget.used.tokens,
    tokensLimit: view.budget.limits.maxTotalTokens,
    cost: costText(view.budget.cost),
    pending: view.pendingDecisions.length,
    blockers: blockers.length,
    idle: view.drive?.state === "idle",
    needsYou:
      !initiativeIsTerminal(view) &&
      (view.pendingDecisions.length > 0 ||
        blockers.length > 0 ||
        view.status === "paused" ||
        view.drive?.state === "idle"),
    next: render(view.next.message, view.next.recovery),
  };
}

/** Initiatives that need a person first, then open ones, then finished; stable inside each. */
export function orderInitiatives(views: InitiativeView[]): InitiativeView[] {
  const rank = (view: InitiativeView): number =>
    summarizeInitiative(view).needsYou ? 0 : initiativeIsTerminal(view) ? 2 : 1;
  return views
    .map((view, index) => ({ view, index }))
    .sort((a, b) => rank(a.view) - rank(b.view) || a.index - b.index)
    .map(({ view }) => view);
}

/** The pending approval of the latest split revision, when one waits for a person. */
export function pendingSplitApproval(view: InitiativeView): PendingDecision | null {
  if (view.status !== "awaiting_approval") return null;
  return view.pendingDecisions.find((d) => d.scope === "initiative") ?? null;
}

export const InitiativeActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approve"),
      expectedRevision: z.number().int().min(0),
      requestId: z.string().min(1),
      digest: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("pause"), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("resume"), expectedRevision: z.number().int().min(0) }).strict(),
  z
    .object({
      kind: z.literal("replan"),
      expectedRevision: z.number().int().min(0),
      featureId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reroute"),
      expectedRevision: z.number().int().min(0),
      model: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reject"),
      expectedRevision: z.number().int().min(0),
      requestId: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit"),
      expectedRevision: z.number().int().min(0),
      edit: SplitEditSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("extend"),
      expectedRevision: z.number().int().min(0),
      maxTotalTokens: z.number().int().min(1).optional(),
      maxAgentCalls: z.number().int().min(1).optional(),
      maxActiveMs: z.number().int().min(1).optional(),
      maxCostUsd: z.number().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("repair"),
      runId: z.string(),
      expectedRevision: z.number().int().min(0),
    })
    .strict(),
  z.object({ kind: z.literal("drive") }).strict(),
]);
/** A command of the TUI, bound to the revision of the view the person saw. */
export type InitiativeAction = z.infer<typeof InitiativeActionSchema>;

export interface InitiativeActionOption {
  key: string;
  label: string;
  action: InitiativeAction;
  /** Set when the action needs a Y/N confirmation first; the question to ask. */
  confirm: string | null;
  /**
   * Set when the action needs text first, such as a reason or a new title: the question, a
   * placeholder, the starting text, and how the text becomes the command. `build` throws a
   * `WorkflowFault` with the words to show when the text does not fit.
   */
  input?: {
    question: string;
    placeholder: string;
    initial: string;
    build(text: string): InitiativeAction;
  };
}

const required = (text: string, message: string): string => {
  const value = text.trim();
  if (!value) throw new WorkflowFault("INVALID_DEFINITION", message);
  return value;
};

/**
 * The commands the core accepts for this view right now. `driving` says whether this process is
 * already advancing the initiative; `feature` is the feature selected in the detail view; `model`
 * is the chat tab's model, offered as the initiative's new model when it differs.
 */
export function initiativeActions(
  view: InitiativeView,
  driving: boolean,
  feature: FeatureView | null = null,
  model: string | null = null,
): InitiativeActionOption[] {
  const options: InitiativeActionOption[] = [];
  const expectedRevision = view.revision;
  const split = pendingSplitApproval(view);
  if (split)
    options.push({
      key: "A",
      label: "approve split",
      action: {
        kind: "approve",
        expectedRevision,
        requestId: split.requestId,
        digest: split.digest,
      },
      confirm: `Approve plan revision ${view.planRevision} (${view.features.length} features)? Feature runs start in dependency order. Y confirms; N keeps it waiting.`,
    });
  if (view.status === "paused")
    options.push({
      key: "R",
      label: "resume",
      action: { kind: "resume", expectedRevision },
      confirm: null,
    });
  if (
    (view.status === "active" || view.status === "decomposing") &&
    !driving &&
    DRIVABLE_NEXT.includes(view.next.kind)
  )
    options.push({ key: "C", label: "continue", action: { kind: "drive" }, confirm: null });
  if (view.status === "active" || view.status === "decomposing")
    options.push({
      key: "P",
      label: "pause",
      action: { kind: "pause", expectedRevision },
      confirm: null,
    });
  if (split)
    options.push({
      key: "N",
      label: "reject split",
      action: { kind: "reject", expectedRevision, requestId: split.requestId, reason: "rejected" },
      confirm: null,
      input: {
        question: `Why reject plan revision ${view.planRevision}? The initiative waits until you edit the split.`,
        placeholder: "e.g. api and storage belong in one feature",
        initial: "",
        build: (text) => ({
          kind: "reject",
          expectedRevision,
          requestId: split.requestId,
          reason: required(text, "A rejection needs a reason"),
        }),
      },
    });
  if (feature && splitEditable(view)) {
    const edit = (value: SplitEdit): InitiativeAction => ({
      kind: "edit",
      expectedRevision,
      edit: value,
    });
    options.push(
      {
        key: "E",
        label: "rename",
        action: edit({ op: "rename", featureId: feature.id, title: feature.title }),
        confirm: null,
        input: {
          question: `New title of feature ${feature.id}:`,
          placeholder: feature.title,
          initial: feature.title,
          build: (text) =>
            edit({
              op: "rename",
              featureId: feature.id,
              title: required(text, "Give the feature a title"),
            }),
        },
      },
      {
        key: "S",
        label: "split",
        action: edit({ op: "split", featureId: feature.id, into: [] }),
        confirm: null,
        input: {
          question: `Split ${feature.id} into parts, "id: title" separated by ";". Each part keeps its scope and contract.`,
          placeholder: `${feature.id}-a: First part; ${feature.id}-b: Second part`,
          initial: "",
          build: (text) =>
            edit({ op: "split", featureId: feature.id, into: parseSplitParts(text) }),
        },
      },
      {
        key: "G",
        label: "merge",
        action: edit({ op: "merge", featureIds: [feature.id] }),
        confirm: null,
        input: {
          question: `Merge ${feature.id} with which features? IDs separated by commas; the merged feature keeps the ID ${feature.id}.`,
          placeholder: view.features
            .filter((f) => f.id !== feature.id)
            .slice(0, 2)
            .map((f) => f.id)
            .join(", "),
          initial: "",
          build: (text) => {
            const others = text
              .split(/[,\s]+/)
              .map((id) => id.trim())
              .filter((id) => id && id !== feature.id);
            if (!others.length)
              throw new WorkflowFault("INVALID_DEFINITION", "Name at least one feature to merge");
            return edit({ op: "merge", featureIds: [feature.id, ...others], id: feature.id });
          },
        },
      },
      {
        key: "W",
        label: "workflow",
        action: edit({ op: "workflow", featureId: feature.id, workflow: feature.workflowId }),
        confirm: null,
        input: {
          question: `Workflow of feature ${feature.id} (now ${feature.workflowId}). A feature others depend on needs one that writes a spec, such as sdd.`,
          placeholder: feature.workflowId,
          initial: feature.workflowId,
          build: (text) =>
            edit({
              op: "workflow",
              featureId: feature.id,
              workflow: required(text, "Name a workflow"),
            }),
        },
      },
      {
        key: "Z",
        label: "size",
        action: edit({ op: "size", featureId: feature.id, size: feature.size }),
        confirm: null,
        input: {
          question: `Size of feature ${feature.id}: small, medium or large (now ${feature.size}). Its budget share follows it.`,
          placeholder: feature.size,
          initial: feature.size,
          build: (text) => {
            const size = text.trim().toLowerCase();
            if (!FEATURE_SIZES.includes(size as FeatureSize))
              throw new WorkflowFault("INVALID_DEFINITION", "Size is small, medium or large");
            return edit({ op: "size", featureId: feature.id, size: size as FeatureSize });
          },
        },
      },
      {
        key: "D",
        label: "remove",
        action: edit({ op: "remove", featureId: feature.id }),
        confirm: `Remove ${feature.id} from the split? Features that depend on it lose that dependency. Y confirms; N keeps it.`,
      },
    );
  }
  if (!initiativeIsTerminal(view) && feature?.repairRun && canRepairRun(feature.repairRun))
    options.push({
      key: "O",
      label: "one more repair",
      action: {
        kind: "repair",
        runId: feature.repairRun.runId,
        expectedRevision: feature.repairRun.revision,
      },
      confirm: `${repairText(feature.repairRun.repairBlock)} ${feature.repairRun.tokenUsage} tokens spent. Grant one more repair? Y confirms; N keeps it blocked.`,
    });
  if (feature && canReplanFeature(view, feature))
    options.push({
      key: "X",
      label: "re-plan feature",
      action: { kind: "replan", expectedRevision, featureId: feature.id },
      confirm: `Re-plan ${feature.id}? Its current run ${feature.runId} is superseded and the feature runs again from research; results of other features stay. Y confirms; N keeps it.`,
    });
  const running = view.features.some((f) => f.runStatus === "running");
  if (
    model &&
    model !== "none" &&
    model !== view.model &&
    !driving &&
    !running &&
    !initiativeIsTerminal(view)
  )
    options.push({
      key: "M",
      label: "switch model",
      action: { kind: "reroute", expectedRevision, model },
      confirm: `Switch initiative ${view.initiativeId} from ${view.model ?? "the default model"} to ${model} and continue? Features started from now on use it, and its stopped runs move to it; finished work stays. Y confirms; N keeps the current model.`,
    });
  if (canExtendBudget(view)) {
    const { limits, cost } = view.budget;
    // The amounts the block or the token forecast suggest, so Enter applies them (#2042).
    const suggested = extendSuggestion(
      view.next.recovery,
      view.budget.pool?.suggestedTokens,
      view.budget.time?.suggestedMs,
      view.budget.calls?.suggestedCalls,
    );
    options.push({
      key: "B",
      label: "extend budget",
      action: { kind: "extend", expectedRevision },
      confirm: null,
      input: {
        question: `Raise the shared budget: tokens [calls [time]] [$dollars], such as 8M 400 4h $40; - keeps a limit. Now ${limits.maxTotalTokens} tokens, ${limits.maxAgentCalls} calls, ${Math.round(limits.maxActiveMs / 60_000)}m${cost?.capUsd ? `, $${cost.capUsd.toFixed(2)}` : ""}.`,
        placeholder: `${Math.ceil((limits.maxTotalTokens * 1.5) / 1_000_000)}M`,
        initial: suggestedText(suggested, limits),
        build: (text) => {
          const raised = parseBudgetText(text);
          if (!Object.keys(raised).length)
            throw new WorkflowFault("INVALID_DEFINITION", "Give at least one new limit");
          return { kind: "extend", expectedRevision, ...raised };
        },
      },
    });
  }
  return options;
}

/**
 * The B form's prefilled answer from a suggestion: `33100000`, `- 600`, `- - 540m`, `- $31.50`,
 * or empty.
 */
function suggestedText(
  suggested: ExtendAmounts | null,
  limits: { maxTotalTokens: number; maxAgentCalls: number; maxActiveMs: number },
): string {
  const tokens =
    suggested?.tokens && suggested.tokens > limits.maxTotalTokens ? suggested.tokens : null;
  const calls = suggested?.calls && suggested.calls > limits.maxAgentCalls ? suggested.calls : null;
  const time = suggested?.timeMs && suggested.timeMs > limits.maxActiveMs ? suggested.timeMs : null;
  if (!tokens && !calls && !time && !suggested?.usd) return "";
  return [
    tokens ? String(tokens) : "-",
    ...(calls || time ? [calls ? String(calls) : "-"] : []),
    ...(time ? [`${Math.ceil(time / 60_000)}m`] : []),
    ...(suggested?.usd ? [`$${suggested.usd.toFixed(2)}`] : []),
  ].join(" ");
}

/**
 * Executes a TUI command through the initiative service. Approve, resume and reroute only record
 * the decision; the caller drives the initiative afterwards, as `baked workflow initiative approve`,
 * `resume` and `reroute --resume` do.
 */
export async function applyInitiativeAction(
  initiatives: InitiativeService,
  id: string,
  input: unknown,
): Promise<{ view: InitiativeView; drive: boolean }> {
  const action = InitiativeActionSchema.parse(input);
  if (action.kind === "drive") return { view: initiatives.view(id), drive: true };
  const command = { commandId: newId(), expectedRevision: action.expectedRevision };
  switch (action.kind) {
    case "approve":
      return {
        view: await initiatives.approve(id, command, {
          requestId: action.requestId,
          digest: action.digest,
        }),
        drive: true,
      };
    case "repair":
      if (!initiatives.view(id).features.some((f) => f.runId === action.runId && f.repairRun))
        throw new WorkflowFault("STALE_DECISION", "This feature no longer offers another repair");
      await initiatives.workflows.repair(action.runId, command);
      return { view: initiatives.view(id), drive: true };
    case "resume":
      return { view: await initiatives.resume(id, command), drive: true };
    case "pause":
      return { view: await initiatives.pause(id, command), drive: false };
    case "replan":
      return { view: await initiatives.replan(id, command, action.featureId), drive: false };
    case "reroute":
      return {
        view: await initiatives.reroute(id, command, { model: action.model, resume: true }),
        drive: true,
      };
    case "reject":
      return {
        view: await initiatives.reject(id, command, {
          requestId: action.requestId,
          reason: action.reason,
        }),
        drive: false,
      };
    case "edit":
      return { view: await initiatives.edit(id, command, action.edit), drive: false };
    case "extend": {
      const { kind: _kind, expectedRevision: _revision, ...limits } = action;
      return { view: await initiatives.extendBudget(id, command, limits), drive: false };
    }
  }
}

/** What the worker returns to the initiative screen. */
export interface InitiativeListView {
  initiatives: InitiativeView[];
  /** Initiatives this worker is advancing right now. */
  driving: string[];
  /** The last drive error of an initiative in this worker, by initiative ID. */
  errors: Record<string, string>;
}

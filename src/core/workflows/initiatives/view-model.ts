/**
 * What the terminal UI shows and offers for initiatives, derived from `InitiativeView` only. The
 * rules for which command is available mirror the checks in `InitiativeService`; the service
 * stays the authority and its refusal text is what a person sees when the view is stale.
 */
import { z } from "zod";
import { newId } from "../store.js";
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
  /** Decisions waiting for a person: the split approval and the decisions of feature runs. */
  pending: number;
  /** Features that cannot continue now, plus a blocked next step of the initiative itself. */
  blockers: number;
  /** True when a person has something to do: a decision, a blocker or a paused initiative. */
  needsYou: boolean;
  next: string;
}

const TERMINAL: readonly InitiativeView["status"][] = ["completed", "refused"];
export const initiativeIsTerminal = (view: Pick<InitiativeView, "status">): boolean =>
  TERMINAL.includes(view.status);

/** Why the initiative or one of its features cannot continue, in words, without duplicates. */
export function initiativeBlockers(view: InitiativeView): string[] {
  const blockers = view.features
    .filter((f) => f.state === "blocked" || f.state === "failed")
    .map((f) => `${f.id}: ${f.blockers.join("; ") || f.state}`);
  if (view.next.kind === "blocked" && !blockers.some((b) => view.next.message.includes(b)))
    blockers.unshift(view.next.message);
  return blockers;
}

export function summarizeInitiative(view: InitiativeView): InitiativeSummary {
  const mandatory = view.features.filter((f) => f.mandatory);
  const blockers = initiativeIsTerminal(view) ? [] : initiativeBlockers(view);
  return {
    initiativeId: view.initiativeId,
    title: view.title,
    status: view.status,
    accepted: mandatory.filter((f) => f.state === "accepted").length,
    total: mandatory.length,
    tokensUsed: view.budget.used.tokens,
    tokensLimit: view.budget.limits.maxTotalTokens,
    pending: view.pendingDecisions.length,
    blockers: blockers.length,
    needsYou:
      !initiativeIsTerminal(view) &&
      (view.pendingDecisions.length > 0 || blockers.length > 0 || view.status === "paused"),
    next: view.next.message,
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
}

const CONTINUABLE: readonly InitiativeView["next"]["kind"][] = [
  "decompose",
  "finish_decompose",
  "start",
  "rebase",
  "drive",
  "complete",
];

/**
 * The commands the core accepts for this view right now. `driving` says whether this process is
 * already advancing the initiative; `feature` is the feature selected in the detail view.
 */
export function initiativeActions(
  view: InitiativeView,
  driving: boolean,
  feature: FeatureView | null = null,
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
    CONTINUABLE.includes(view.next.kind)
  )
    options.push({ key: "C", label: "continue", action: { kind: "drive" }, confirm: null });
  if (view.status === "active" || view.status === "decomposing")
    options.push({
      key: "P",
      label: "pause",
      action: { kind: "pause", expectedRevision },
      confirm: null,
    });
  if (
    feature?.runId &&
    view.approvedPlanRevision !== null &&
    (view.status === "active" || view.status === "paused")
  )
    options.push({
      key: "X",
      label: "re-plan feature",
      action: { kind: "replan", expectedRevision, featureId: feature.id },
      confirm: `Re-plan ${feature.id}? Its current run ${feature.runId} is superseded and the feature runs again from research; results of other features stay. Y confirms; N keeps it.`,
    });
  return options;
}

/**
 * Executes a TUI command through the initiative service. Approve and resume only record the
 * decision; the caller drives the initiative afterwards, as `baked workflow initiative approve`
 * and `resume` do.
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
    case "resume":
      return { view: await initiatives.resume(id, command), drive: true };
    case "pause":
      return { view: await initiatives.pause(id, command), drive: false };
    case "replan":
      return { view: await initiatives.replan(id, command, action.featureId), drive: false };
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

import type {
  FeatureState,
  InitiativeFeature,
  InitiativeListItem,
  InitiativeStatus,
  InitiativeView,
  StartInitiativeBody,
} from "../../client/insights.js";
import { featureSlug } from "../start/logic.js";

/** How the Initiatives screen shows statuses; the core stays the authority on what they mean. */

export type Tone = "ok" | "warn" | "err" | "busy" | "muted";

const STATUS: Record<InitiativeStatus, { label: string; tone: Tone }> = {
  decomposing: { label: "splitting", tone: "busy" },
  awaiting_approval: { label: "approve split", tone: "warn" },
  active: { label: "active", tone: "busy" },
  paused: { label: "paused", tone: "warn" },
  completed: { label: "completed", tone: "ok" },
  refused: { label: "refused", tone: "err" },
};

export function initiativeStatus(status: InitiativeStatus): { label: string; tone: Tone } {
  return STATUS[status] ?? { label: status, tone: "muted" };
}

/** The second line of a list item: its status and what happens next. */
export function initiativeLine(item: InitiativeListItem): string {
  const { label } = initiativeStatus(item.status);
  const features = `${item.features} feature${item.features === 1 ? "" : "s"}`;
  if (item.status === "completed" || item.status === "refused") return label;
  if (item.status === "awaiting_approval") return `${label} · ${item.features} proposed`;
  if (item.features === 0) return label;
  return `${label} · ${features}`;
}

export interface FeatureRow {
  mark: string;
  tone: Tone;
  label: string;
  /** Text of the link to the feature's run; null when it has none. */
  link: string | null;
}

const WAITING: readonly FeatureState[] = ["proposed", "waiting", "ready", "stale", "paused"];

export function featureRow(feature: InitiativeFeature): FeatureRow {
  const link = feature.runId ? "Run" : null;
  switch (feature.state) {
    case "accepted":
      return { mark: "✓", tone: "ok", label: "done", link };
    case "in_progress":
      return {
        mark: "⟳",
        tone: "busy",
        label: feature.runStatus ? `in progress · ${feature.runStatus}` : "in progress",
        link,
      };
    case "needs_decision":
      return { mark: "⚑", tone: "warn", label: "needs decision", link: feature.runId && "Decide" };
    case "blocked":
    case "failed":
      return {
        mark: "!",
        tone: "err",
        label: feature.blockers[0] ?? feature.state,
        link,
      };
    case "waiting":
      return {
        mark: "·",
        tone: "muted",
        label:
          feature.dependsOn.length > 0 ? `waits for ${feature.dependsOn.join(", ")}` : "waiting",
        link,
      };
    default:
      return { mark: "·", tone: "muted", label: feature.state.replace("_", " "), link };
  }
}

export interface FeatureCounts {
  done: number;
  inProgress: number;
  needsDecision: number;
  blocked: number;
  waiting: number;
  total: number;
}

export function featureCounts(view: Pick<InitiativeView, "features">): FeatureCounts {
  const count = (states: readonly FeatureState[]): number =>
    view.features.filter((f) => states.includes(f.state)).length;
  return {
    done: count(["accepted"]),
    inProgress: count(["in_progress"]),
    needsDecision: count(["needs_decision"]),
    blocked: count(["blocked", "failed"]),
    waiting: count(WAITING),
    total: view.features.length,
  };
}

/** The pending split approval of an initiative, when one waits for a person. */
export function splitApproval(view: InitiativeView) {
  if (view.status !== "awaiting_approval") return null;
  return view.pendingDecisions.find((d) => d.scope === "initiative") ?? null;
}

/**
 * Whether the initiative can switch to another model now (`POST /v1/initiatives/:id/reroute`):
 * it is not finished, the backend reports its model, and no feature run is executing.
 */
export function canSwitchModel(view: InitiativeView): boolean {
  return (
    view.model !== undefined &&
    view.status !== "completed" &&
    view.status !== "refused" &&
    !view.features.some((f) => f.runStatus === "running")
  );
}

/** An initiative holds this many features at least and at most (`MIN_FEATURES`, `MAX_FEATURES`). */
export const MIN_FEATURES = 3;
export const MAX_FEATURES = 12;

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Initiative and feature IDs: lowercase letters, digits and `-`, at most 40 characters. */
export const isInitiativeKey = (id: string): boolean => KEY.test(id);

/** An initiative ID derived from the request text; empty when the text has no usable words. */
export function suggestInitiativeId(text: string): string {
  return featureSlug(text).slice(0, 40).replace(/-+$/, "");
}

const finished = (view: Pick<InitiativeView, "status">): boolean =>
  view.status === "completed" || view.status === "refused";

/**
 * Whether the split can be edited (merge, split, remove, rename): while it waits for approval, or
 * while an approved initiative is paused.
 */
export function canEditSplit(
  view: Pick<InitiativeView, "status" | "approvedPlanRevision">,
): boolean {
  if (view.status === "awaiting_approval") return true;
  return (
    view.status === "paused" &&
    view.approvedPlanRevision !== null &&
    view.approvedPlanRevision !== undefined
  );
}

/** Whether removing one feature keeps the split at the minimum size. */
export function canRemoveFeature(view: InitiativeView): boolean {
  return canEditSplit(view) && view.features.length - 1 >= MIN_FEATURES;
}

/** Whether splitting a feature into two parts stays within the maximum size. */
export function canSplitFeature(view: InitiativeView): boolean {
  return canEditSplit(view) && view.features.length + 1 <= MAX_FEATURES;
}

/** Why the selected features cannot be merged, or null when they can. */
export function mergeProblem(
  view: InitiativeView,
  selected: readonly string[],
  into: { id: string; title: string },
): string | null {
  if (!canEditSplit(view)) return "The split cannot be edited now.";
  if (selected.length < 2) return "Select two or more features to merge.";
  if (view.features.length - selected.length + 1 < MIN_FEATURES)
    return `An initiative needs at least ${MIN_FEATURES} features.`;
  const id = into.id.trim();
  if (id && !isInitiativeKey(id))
    return "The ID takes lowercase letters, digits and -, at most 40 characters.";
  if (id && view.features.some((f) => f.id === id && !selected.includes(f.id)))
    return `Another feature is already called ${id}.`;
  return null;
}

export interface SplitRow {
  id: string;
  title: string;
}

/** Why the parts cannot replace `featureId`, or null when they can. */
export function splitProblem(
  view: InitiativeView,
  featureId: string,
  rows: readonly SplitRow[],
): string | null {
  if (rows.length < 2) return "Split a feature into two or more parts.";
  if (view.features.length - 1 + rows.length > MAX_FEATURES)
    return `An initiative holds at most ${MAX_FEATURES} features.`;
  const others = new Set(view.features.map((f) => f.id).filter((id) => id !== featureId));
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const id = row.id.trim();
    const n = i + 1;
    if (!isInitiativeKey(id))
      return `Part ${n}: the ID takes lowercase letters, digits and -, at most 40 characters.`;
    if (!row.title.trim()) return `Part ${n} needs a title.`;
    if (row.title.trim().length > 200) return `Part ${n}: the title is longer than 200 characters.`;
    if (others.has(id)) return `Another feature is already called ${id}.`;
    if (seen.has(id)) return `Two parts are called ${id}.`;
    seen.add(id);
  }
  return null;
}

/**
 * Whether a feature's run can be replaced by a new one under the approved plan: the split is
 * approved, the initiative is active or paused, and the feature's run is not executing.
 */
export function canReplanFeature(view: InitiativeView, feature: InitiativeFeature): boolean {
  return (
    feature.runId !== null &&
    view.approvedPlanRevision !== null &&
    view.approvedPlanRevision !== undefined &&
    (view.status === "active" || view.status === "paused") &&
    feature.runStatus !== "running"
  );
}

/** Whether the shared budget can be raised: any initiative that has not finished. */
export const canExtendBudget = (view: Pick<InitiativeView, "status">): boolean => !finished(view);

/** A count typed in a budget field: digits with optional `,` or `_`, and a `k` or `M` suffix. */
export function parseCount(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text.trim().replace(/[,_\s](?=\d)/g, ""));
  if (!match?.[1]) return null;
  const scale = match[2]?.toLowerCase() === "k" ? 1e3 : match[2]?.toLowerCase() === "m" ? 1e6 : 1;
  const value = Math.round(Number(match[1]) * scale);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** The text fields of a shared budget; time is in minutes. */
export interface BudgetFields {
  tokens: string;
  calls: string;
  minutes: string;
}

export interface BudgetLimits {
  tokens: number;
  calls: number;
  timeMs: number;
}

/** The limits of the fields, or why they are invalid. Every field must be set. */
export function parseBudget(
  fields: BudgetFields,
): { ok: true; limits: BudgetLimits } | { ok: false; error: string } {
  const tokens = parseCount(fields.tokens);
  const calls = parseCount(fields.calls);
  const minutes = parseCount(fields.minutes);
  if (tokens === null) return { ok: false, error: "Tokens: a whole number above 0, like 6M." };
  if (calls === null) return { ok: false, error: "Agent calls: a whole number above 0." };
  if (minutes === null) return { ok: false, error: "Time: whole minutes above 0." };
  return { ok: true, limits: { tokens, calls, timeMs: minutes * 60_000 } };
}

/** The budget fields filled with the initiative's current limits. */
export function budgetFields(view: Pick<InitiativeView, "budget">): BudgetFields {
  const { maxTotalTokens, maxAgentCalls, maxActiveMs } = view.budget.limits;
  return {
    tokens: String(maxTotalTokens),
    calls: String(maxAgentCalls),
    minutes: String(Math.ceil(maxActiveMs / 60_000)),
  };
}

/**
 * The raised limits to send, or why the fields cannot be sent: limits only go up, and at least one
 * must change.
 */
export function budgetExtension(
  view: Pick<InitiativeView, "budget">,
  fields: BudgetFields,
): { ok: true; limits: Partial<BudgetLimits> } | { ok: false; error: string } {
  const parsed = parseBudget(fields);
  if (!parsed.ok) return parsed;
  const current = view.budget.limits;
  const { tokens, calls, timeMs } = parsed.limits;
  // Minutes round the current time limit up, so an unchanged field is not a lower limit.
  const sameTime = fields.minutes.trim() === budgetFields(view).minutes;
  if (tokens < current.maxTotalTokens || calls < current.maxAgentCalls)
    return { ok: false, error: "Limits can only go up." };
  if (!sameTime && timeMs < current.maxActiveMs)
    return { ok: false, error: "Limits can only go up." };
  const limits: Partial<BudgetLimits> = {
    ...(tokens > current.maxTotalTokens ? { tokens } : {}),
    ...(calls > current.maxAgentCalls ? { calls } : {}),
    ...(!sameTime && timeMs > current.maxActiveMs ? { timeMs } : {}),
  };
  if (Object.keys(limits).length === 0) return { ok: false, error: "Raise at least one limit." };
  return { ok: true, limits };
}

/** The fields of the New initiative form. */
export interface StartFields {
  prompt: string;
  initiativeId: string;
  workflow: string;
  /** Empty uses the project's default model. */
  model: string;
  /** Null lets the core size the shared budget from the policy. */
  budget: BudgetFields | null;
  tiered: { maxTasks: string; maxFiles: string } | null;
}

/** The body of `POST /v1/initiatives` for the form, or the first reason it cannot be sent. */
export function startBody(
  fields: StartFields,
): { ok: true; body: StartInitiativeBody } | { ok: false; error: string } {
  const prompt = fields.prompt.trim();
  if (!prompt) return { ok: false, error: "Describe what the initiative should deliver." };
  const initiativeId = fields.initiativeId.trim();
  if (!isInitiativeKey(initiativeId))
    return {
      ok: false,
      error: "Initiative ID: lowercase letters, digits and -, at most 40 characters.",
    };
  const body: StartInitiativeBody = { initiativeId, prompt };
  if (fields.workflow) body.workflow = fields.workflow;
  if (fields.model.trim()) body.model = fields.model.trim();
  if (fields.budget) {
    const parsed = parseBudget(fields.budget);
    if (!parsed.ok) return parsed;
    body.budget = parsed.limits;
  }
  if (fields.tiered) {
    const maxTasks = parseCount(fields.tiered.maxTasks);
    const maxFiles = parseCount(fields.tiered.maxFiles);
    if (maxTasks === null || maxFiles === null)
      return { ok: false, error: "Tiered approval: max tasks and max files above 0." };
    body.tieredApproval = { maxTasks, maxFiles };
  }
  return { ok: true, body };
}

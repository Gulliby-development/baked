import type {
  FeatureState,
  InitiativeEstimate,
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

/**
 * Whether the backend moves an initiative on its own: while it splits or runs, the screen reads
 * it again every few seconds, as the terminal UI does. A split waiting for approval, a paused,
 * completed or refused initiative changes only through the person.
 */
export const initiativeIsLive = (status: InitiativeStatus): boolean =>
  status === "decomposing" || status === "active";

/** How often a live initiative and the list are read again. */
export const INITIATIVE_REFRESH_MS = 2000;

/**
 * The status shown on the initiative: a split the person rejected waits for their edits, not for
 * an approval, until an edit proposes a new revision.
 */
export function detailStatus(view: Pick<InitiativeView, "status" | "pendingDecisions">): {
  label: string;
  tone: Tone;
} {
  if (
    view.status === "awaiting_approval" &&
    !view.pendingDecisions.some((d) => d.scope === "initiative")
  )
    return { label: "split rejected", tone: "warn" };
  return initiativeStatus(view.status);
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

/** A dollar amount typed in a field, with an optional leading `$`; null unless above 0. */
export function parseUsd(text: string): number | null {
  const match = /^\$?\s*(\d+(?:\.\d{1,2})?)$/.exec(text.trim());
  const value = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The initiative's dollars in one line, as the terminal shows them: spent of the cap (and its
 * ceiling with a tolerance), what is left and the forecast; null without a cap and spending.
 */
export function costLine(view: Pick<InitiativeView, "budget">): string | null {
  const cost = view.budget.cost;
  if (!cost) return null;
  if (cost.capUsd === null) return cost.spentUsd > 0 ? `${usd(cost.spentUsd)} spent` : null;
  const ceiling =
    cost.ceilingUsd !== null && cost.ceilingUsd > cost.capUsd
      ? ` (ceiling ${usd(cost.ceilingUsd)})`
      : "";
  return [
    `${usd(cost.spentUsd)} of ${usd(cost.capUsd)}${ceiling}`,
    `${usd(cost.remainingUsd ?? 0)} left`,
    ...(cost.forecastUsd !== null ? [`forecast ${usd(cost.forecastUsd)}`] : []),
  ].join(" · ");
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
  dollars = "",
):
  | { ok: true; limits: Partial<BudgetLimits> & { costUsd?: number } }
  | { ok: false; error: string } {
  const parsed = parseBudget(fields);
  if (!parsed.ok) return parsed;
  const cap = view.budget.cost?.capUsd ?? null;
  const usdValue = dollars.trim() ? parseUsd(dollars) : null;
  if (dollars.trim() && usdValue === null)
    return { ok: false, error: "Dollar cap: an amount above 0, like 40." };
  if (usdValue !== null && cap !== null && usdValue < cap)
    return { ok: false, error: "Limits can only go up." };
  const current = view.budget.limits;
  const { tokens, calls, timeMs } = parsed.limits;
  // Minutes round the current time limit up, so an unchanged field is not a lower limit.
  const sameTime = fields.minutes.trim() === budgetFields(view).minutes;
  if (tokens < current.maxTotalTokens || calls < current.maxAgentCalls)
    return { ok: false, error: "Limits can only go up." };
  if (!sameTime && timeMs < current.maxActiveMs)
    return { ok: false, error: "Limits can only go up." };
  const limits: Partial<BudgetLimits> & { costUsd?: number } = {
    ...(usdValue !== null && usdValue !== cap ? { costUsd: usdValue } : {}),
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
  /** A dollar cap feature runs share; empty or absent sets none. */
  budgetUsd?: string;
  tiered: { maxTasks: string; maxFiles: string } | null;
  /** Hold feature starts while the forecast is over the shared budget. */
  forecastStop?: boolean;
  /** Keep the decomposer's small features apart. */
  keepFeatures?: boolean;
  /** Ask the decomposer to split a feature that dominates the critical path. */
  splitCriticalPath?: boolean;
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
  if (fields.budgetUsd?.trim()) {
    const value = parseUsd(fields.budgetUsd);
    if (value === null) return { ok: false, error: "Dollar cap: an amount above 0, like 40." };
    body.budgetUsd = value;
  }
  if (fields.tiered) {
    const maxTasks = parseCount(fields.tiered.maxTasks);
    const maxFiles = parseCount(fields.tiered.maxFiles);
    if (maxTasks === null || maxFiles === null)
      return { ok: false, error: "Tiered approval: max tasks and max files above 0." };
    body.tieredApproval = { maxTasks, maxFiles };
  }
  if (fields.forecastStop) body.forecastStop = true;
  if (fields.keepFeatures) body.keepFeatures = true;
  if (fields.splitCriticalPath) body.splitCriticalPath = true;
  return { ok: true, body };
}

/**
 * The board's columns: features grouped by how many steps of dependencies come before them, so
 * a column runs once the columns to its left are done. Features keep their split order inside a
 * column; a dependency the split does not have counts as done.
 */
export function featureSteps<F extends Pick<InitiativeFeature, "id" | "dependsOn">>(
  features: readonly F[],
): F[][] {
  const byId = new Map(features.map((f) => [f.id, f] as const));
  const step = new Map<string, number>();
  const stepOf = (feature: F, seen: Set<string>): number => {
    const known = step.get(feature.id);
    if (known !== undefined) return known;
    // A cycle cannot pass the core's validation; this only keeps a bad view from looping.
    if (seen.has(feature.id)) return 0;
    seen.add(feature.id);
    const before = feature.dependsOn
      .map((id) => byId.get(id))
      .filter((f): f is F => f !== undefined)
      .map((f) => stepOf(f, seen) + 1);
    const value = Math.max(0, ...before);
    step.set(feature.id, value);
    return value;
  };
  const columns: F[][] = [];
  for (const feature of features) {
    const index = stepOf(feature, new Set());
    const column = columns[index] ?? [];
    column.push(feature);
    columns[index] = column;
  }
  return columns.filter((column) => column.length > 0);
}

/** The workflow a feature runs: its own, or the initiative's on an older backend. */
export const featureWorkflow = (
  view: Pick<InitiativeView, "workflowId">,
  feature: Pick<InitiativeFeature, "workflowId">,
): string => feature.workflowId ?? view.workflowId ?? "sdd";

/** Whether the backend reports per-feature workflows and sizes, so they can be changed. */
export const configurableFeatures = (view: Pick<InitiativeView, "features">): boolean =>
  view.features.length > 0 && view.features.every((f) => f.size !== undefined);

/** The workflows a feature can run: they start without problems and change files. */
export function featureWorkflowChoices<D extends { problems: string[]; writes: boolean }>(
  definitions: readonly D[],
): D[] {
  return definitions.filter((d) => d.problems.length === 0 && d.writes);
}

/** Whether other features of the split build on this one, so it needs a workflow with a spec. */
export const hasDependents = (
  view: Pick<InitiativeView, "features">,
  feature: Pick<InitiativeFeature, "id">,
): boolean => view.features.some((f) => f.dependsOn.includes(feature.id));

/** What the coordinator gets when a person starts an initiative from this screen. */
/** What an estimate's basis means, for the line under it. */
export function estimateBasisText(estimate: InitiativeEstimate): string {
  switch (estimate.basis) {
    case "measured":
      return "Measured: every feature is accepted, so this is what the initiative used.";
    case "calibrated":
      return "Re-forecast from the accepted features: the rest are scaled by how far those were from their forecast.";
    case "initiative-history":
      return "From finished feature runs of earlier initiatives in this project.";
    case "workflow-history":
      return "From earlier runs of each feature's workflow in this project.";
    case "history":
      return "From earlier runs in this project.";
    default:
      return "Generic ranges: this project has no finished runs to measure yet.";
  }
}

/** The estimate against the shared budget, with its tone. */
export function estimateFit(estimate: InitiativeEstimate): { text: string; tone: Tone } {
  const margin = Math.round(estimate.margin * 100);
  if (estimate.budget.fits === "yes")
    return { text: `Fits the shared budget with a ${margin}% margin`, tone: "ok" };
  if (estimate.budget.fits === "maybe")
    return { text: `May not fit the shared budget with a ${margin}% margin`, tone: "warn" };
  return { text: "Does not fit the shared budget", tone: "err" };
}

export const COORDINATOR_INITIATIVE_PREFIX = "Plan this as an initiative: ";

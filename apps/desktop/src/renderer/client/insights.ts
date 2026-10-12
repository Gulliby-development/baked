import { ApiError, call } from "./api.js";

/**
 * Initiatives and usage over `/v1/initiatives` and `/v1/usage`, which `baked serve` gained after
 * the first desktop release. An older backend answers 404; screens check `isMissingEndpoint` and
 * show "Needs a newer BAKED" instead of an error. Shapes mirror `src/core/workflows/initiatives/`
 * and `src/core/workflows/usage.ts`; only the fields the screens read are declared.
 */

export type InitiativeStatus =
  | "decomposing"
  | "awaiting_approval"
  | "active"
  | "paused"
  | "completed"
  | "refused";

export type FeatureState =
  | "proposed"
  | "waiting"
  | "ready"
  | "in_progress"
  | "needs_decision"
  | "paused"
  | "blocked"
  | "failed"
  | "stale"
  | "accepted";

export interface InitiativeNext {
  kind: string;
  featureId: string | null;
  runId: string | null;
  message: string;
}

/** One item of `GET /v1/initiatives`, as `baked workflow initiative list` prints it. */
export interface InitiativeListItem {
  initiativeId: string;
  title: string;
  status: InitiativeStatus;
  features: number;
  next: InitiativeNext;
}

export interface PendingDecision {
  scope: "initiative" | "feature" | "decompose";
  featureId: string | null;
  runId: string | null;
  requestId: string;
  kind: string;
  digest: string;
}

export interface UsageTotals {
  tokens: number;
  calls: number;
  activeMs: number;
}

export interface InitiativeFeature {
  id: string;
  title: string;
  mandatory: boolean;
  dependsOn: string[];
  state: FeatureState;
  runId: string | null;
  runStatus: string | null;
  blockers: string[];
  pendingRequests: PendingDecision[];
  usage: UsageTotals;
  /** What the feature owns and the contract it provides; absent on older backends. */
  boundary?: { scope: string; paths: string[] };
  contract?: string;
}

/** `GET /v1/initiatives/:id`, as `baked workflow initiative show` prints it. */
export interface InitiativeView {
  initiativeId: string;
  title: string;
  status: InitiativeStatus;
  reason: string;
  revision: number;
  planRevision: number;
  /** The plan revision the split approval accepted; null before it. Absent on older backends. */
  approvedPlanRevision?: number | null;
  /** The workflow each feature run uses; absent on older backends. */
  workflowId?: string;
  /** Tiered approval of feature runs; null when every run waits for a person. */
  featureAutoApproval?: TieredApproval | null;
  /** The model feature runs start with; null uses the default model. Absent on older backends. */
  model?: string | null;
  goals: string[];
  features: InitiativeFeature[];
  pendingDecisions: PendingDecision[];
  budget: {
    limits: { maxTotalTokens: number; maxAgentCalls: number; maxActiveMs: number };
    used: UsageTotals;
    /** What later feature runs can still get; absent on older backends. */
    remaining?: UsageTotals;
  };
  next: InitiativeNext;
}

/** Feature runs within these limits are approved without a person. */
export interface TieredApproval {
  maxTasks: number;
  maxFiles: number;
}

/** `POST /v1/initiatives`: a request the core splits into features for one approval. */
export interface StartInitiativeBody {
  initiativeId: string;
  prompt: string;
  workflow?: string;
  model?: string;
  /** The shared budget; all three limits or none (then it follows from the policy). */
  budget?: { tokens: number; calls: number; timeMs: number };
  tieredApproval?: TieredApproval;
}

/** One new feature of a split (`POST /v1/initiatives/:id/split`). */
export interface SplitPart {
  id: string;
  title: string;
  scope?: string;
  paths?: string[];
  contract?: string;
}

/** Raised limits of the shared budget (`POST /v1/initiatives/:id/extend`). */
export interface BudgetExtension {
  tokens?: number;
  calls?: number;
  timeMs?: number;
}

export type UsageDimension = "model" | "stage" | "day";
/**
 * Token and cost figures of `GET /v1/usage` (totals and every group). Backends before the cost
 * estimate (API PR #93) report only `tokens` and `cacheReadTokens`; the rest is then absent.
 */
export interface UsageFigures {
  attempts: number;
  tokens: number;
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache; absent on older backends. */
  cacheWriteTokens?: number;
  /** Input tokens, cache reads included. */
  inputTokens?: number;
  outputTokens?: number;
  /** Estimated from the price table; leaves out `unpricedTokens`. */
  costUsd?: number;
  /** Tokens of attempts without per-step usage or a known price. */
  unpricedTokens?: number;
}

export interface UsageGroup extends UsageFigures {
  /** The group's values joined with " / ", in `groupBy` order. */
  key: string;
  /** The group's value per dimension; absent on older backends. */
  keys?: Partial<Record<UsageDimension, string>>;
  runs: number;
}

/** `GET /v1/usage?days=&groupBy=&model=&stage=`: every attempt started in the window, grouped. */
export interface UsageSummary extends Omit<UsageFigures, "tokens"> {
  /** The same as `totalTokens`; absent on older backends. */
  tokens?: number;
  days: number;
  since: number;
  /** One or two dimensions; a single string on older backends. */
  groupBy: UsageDimension[] | UsageDimension;
  filters?: { model?: string; stage?: string };
  runs: number;
  totalTokens: number;
  groups: UsageGroup[];
}

export interface UsageQuery {
  days: number;
  groupBy: readonly UsageDimension[];
  /** A model ID, or `(host)` for host attempts. */
  model?: string | null;
  /** A stage ID as the backend records it (`plan`, `task-T001`). */
  stage?: string | null;
}

export interface AttemptUsageRow {
  attemptId: string;
  stage: string;
  /** Host attempts (checks, publication) run without a model. */
  model: string | null;
  status: string;
  usedTokens: number | null;
  cacheReadTokens: number | null;
  /** Input tokens written to the prompt cache; absent on older backends. */
  cacheWriteTokens?: number | null;
  /** Input tokens, cache reads included; null without per-step usage, absent on older backends. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Estimated cost; 0 for host attempts, null when it cannot be priced, absent on older backends. */
  costUsd?: number | null;
}

/** `GET /v1/workflow/runs/:id/usage`, as `baked workflow usage RUN_ID` prints it. */
export interface RunUsageReport {
  runId: string;
  totalTokens: number;
  attempts: AttemptUsageRow[];
}

/** The query string of a usage summary request. */
export function usageQuery(query: UsageQuery): string {
  const params = new URLSearchParams({
    days: String(query.days),
    groupBy: query.groupBy.join(","),
  });
  if (query.model) params.set("model", query.model);
  if (query.stage) params.set("stage", query.stage);
  return params.toString();
}

/** The Markdown of an export answer; an older backend ignores `format` and answers JSON. */
function markdownOf(answer: unknown): string | null {
  return answer !== null &&
    typeof answer === "object" &&
    "markdown" in answer &&
    typeof answer.markdown === "string"
    ? answer.markdown
    : null;
}

/** True when the backend is too old to have the endpoint that was called. */
export function isMissingEndpoint(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** True when the backend refused the query: one from before two-dimension grouping and filters. */
export function isRejectedQuery(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

const initiativePath = (id: string, action?: string): string =>
  `/v1/initiatives/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
const command = (view: Pick<InitiativeView, "revision">) => ({
  commandId: crypto.randomUUID(),
  expectedRevision: view.revision,
});

type Ref = Pick<InitiativeView, "initiativeId" | "revision">;
const post = (key: string, view: Ref, action: string, body: object = {}) =>
  call<InitiativeView>(key, "POST", initiativePath(view.initiativeId, action), {
    ...command(view),
    ...body,
  });

export const insights = {
  initiatives: async (key: string): Promise<InitiativeListItem[]> =>
    (await call<{ initiatives: InitiativeListItem[] }>(key, "GET", "/v1/initiatives")).initiatives,
  initiative: (key: string, id: string) => call<InitiativeView>(key, "GET", initiativePath(id)),
  pauseInitiative: (key: string, view: Pick<InitiativeView, "initiativeId" | "revision">) =>
    call<InitiativeView>(key, "POST", initiativePath(view.initiativeId, "pause"), command(view)),
  resumeInitiative: (key: string, view: Pick<InitiativeView, "initiativeId" | "revision">) =>
    call<InitiativeView>(key, "POST", initiativePath(view.initiativeId, "resume"), command(view)),
  approveSplit: (
    key: string,
    view: Pick<InitiativeView, "initiativeId" | "revision">,
    decision: Pick<PendingDecision, "requestId" | "digest">,
  ) =>
    call<InitiativeView>(key, "POST", initiativePath(view.initiativeId, "approve"), {
      ...command(view),
      requestId: decision.requestId,
      digest: decision.digest,
    }),
  /**
   * Moves the initiative to `model`: features started later use it, its stopped runs are switched,
   * and blocked rerouted runs and a paused initiative continue in the background.
   */
  rerouteInitiative: (
    key: string,
    view: Pick<InitiativeView, "initiativeId" | "revision">,
    model: string,
  ) =>
    call<InitiativeView>(key, "POST", initiativePath(view.initiativeId, "reroute"), {
      ...command(view),
      model,
      resume: true,
    }),
  /** Starts an initiative; the core splits the request in the background (202). */
  startInitiative: (key: string, body: StartInitiativeBody) =>
    call<InitiativeView>(key, "POST", "/v1/initiatives", {
      commandId: crypto.randomUUID(),
      ...body,
    }),
  /** Merges two or more features of an editable split into one. */
  mergeFeatures: (
    key: string,
    view: Ref,
    features: readonly string[],
    into: { id?: string; title?: string } = {},
  ) => post(key, view, "merge", { features, ...into }),
  splitFeature: (key: string, view: Ref, feature: string, parts: readonly SplitPart[]) =>
    post(key, view, "split", { feature, parts }),
  removeFeature: (key: string, view: Ref, feature: string) =>
    post(key, view, "remove", { feature }),
  renameFeature: (key: string, view: Ref, feature: string, title: string) =>
    post(key, view, "rename", { feature, title }),
  /** Supersedes a feature's run with a new one under the approved plan. */
  replanFeature: (key: string, view: Ref, feature: string) =>
    post(key, view, "replan", { feature }),
  rejectSplit: (
    key: string,
    view: Ref,
    decision: Pick<PendingDecision, "requestId">,
    reason: string,
  ) => post(key, view, "reject", { requestId: decision.requestId, reason }),
  /** Raises limits of the shared budget; a limit can only go up. */
  extendBudget: (key: string, view: Ref, limits: BudgetExtension) =>
    post(key, view, "extend", { ...limits }),
  usage: (key: string, query: UsageQuery) =>
    call<UsageSummary>(key, "GET", `/v1/usage?${usageQuery(query)}`),
  runUsage: (key: string, runId: string) =>
    call<RunUsageReport>(key, "GET", `/v1/workflow/runs/${encodeURIComponent(runId)}/usage`),
  /** The summary as a Markdown document to share; null from a backend without the export. */
  usageMarkdown: async (key: string, query: UsageQuery): Promise<string | null> =>
    markdownOf(await call<unknown>(key, "GET", `/v1/usage?${usageQuery(query)}&format=md`)),
  runUsageMarkdown: async (key: string, runId: string): Promise<string | null> =>
    markdownOf(
      await call<unknown>(
        key,
        "GET",
        `/v1/workflow/runs/${encodeURIComponent(runId)}/usage?format=md`,
      ),
    ),
};

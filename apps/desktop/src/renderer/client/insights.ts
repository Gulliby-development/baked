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
}

/** `GET /v1/initiatives/:id`, as `baked workflow initiative show` prints it. */
export interface InitiativeView {
  initiativeId: string;
  title: string;
  status: InitiativeStatus;
  reason: string;
  revision: number;
  planRevision: number;
  goals: string[];
  features: InitiativeFeature[];
  pendingDecisions: PendingDecision[];
  budget: {
    limits: { maxTotalTokens: number; maxAgentCalls: number; maxActiveMs: number };
    used: UsageTotals;
  };
  next: InitiativeNext;
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
  usage: (key: string, query: UsageQuery) =>
    call<UsageSummary>(key, "GET", `/v1/usage?${usageQuery(query)}`),
  runUsage: (key: string, runId: string) =>
    call<RunUsageReport>(key, "GET", `/v1/workflow/runs/${encodeURIComponent(runId)}/usage`),
};

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

export type UsageGroupBy = "model" | "stage" | "day";

export interface UsageGroup {
  key: string;
  runs: number;
  attempts: number;
  tokens: number;
  cacheReadTokens: number;
  /** Proposed: output tokens of the group. Current servers do not report it. */
  outputTokens?: number;
  /** Proposed: estimated cost of the group in USD. Current servers do not report it. */
  costUsd?: number;
}

/** `GET /v1/usage?days=&groupBy=`: every attempt started in the window, grouped. */
export interface UsageSummary {
  days: number;
  since: number;
  groupBy: UsageGroupBy;
  runs: number;
  attempts: number;
  totalTokens: number;
  cacheReadTokens: number;
  groups: UsageGroup[];
}

export interface AttemptUsageRow {
  attemptId: string;
  stage: string;
  /** Host attempts (checks, publication) run without a model. */
  model: string | null;
  status: string;
  usedTokens: number | null;
  cacheReadTokens: number | null;
  /** Proposed: output tokens of the attempt. Current servers do not report it. */
  outputTokens?: number | null;
}

/** `GET /v1/workflow/runs/:id/usage`, as `baked workflow usage RUN_ID` prints it. */
export interface RunUsageReport {
  runId: string;
  totalTokens: number;
  attempts: AttemptUsageRow[];
}

/** True when the backend is too old to have the endpoint that was called. */
export function isMissingEndpoint(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
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
  usage: (key: string, days: number, groupBy: UsageGroupBy) =>
    call<UsageSummary>(key, "GET", `/v1/usage?days=${days}&groupBy=${groupBy}`),
  runUsage: (key: string, runId: string) =>
    call<RunUsageReport>(key, "GET", `/v1/workflow/runs/${encodeURIComponent(runId)}/usage`),
};

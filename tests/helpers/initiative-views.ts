import type { FeatureView, InitiativeView } from "../../src/core/workflows/initiatives/service.js";

/** A feature of a synthetic initiative view; fields default to a ready feature without a run. */
export function featureView(id: string, extra: Partial<FeatureView> = {}): FeatureView {
  return {
    id, title: `Feature ${id}`, mandatory: true, dependsOn: [], boundary: { scope: id, paths: [`${id}.txt`] },
    contract: `${id}.txt exists`, workflowId: "sdd", size: "medium", share: null, runFeatureId: `big_${id}`, state: "ready", runId: null, runStatus: null, runReason: null,
    pinned: [], contractHash: null, blockers: [], pendingRequests: [], usage: { tokens: 0, calls: 0, activeMs: 0 }, runIds: [], ...extra,
  };
}

/** A synthetic initiative view: active, plan revision 1 approved, one ready feature. */
export function initiativeView(extra: Partial<InitiativeView> = {}): InitiativeView {
  return {
    initiativeId: "big", title: "A big request", status: "active", reason: "", revision: 3, eventSeq: 9, planRevision: 1,
    approvedPlanRevision: 1, approvalDigest: "d".repeat(64), planDigest: "d".repeat(64), goals: [], completionCriteria: [],
    workflowId: "sdd", model: null, featureAutoApproval: null, parallelRuns: 1, decompose: null, features: [featureView("core")], pendingDecisions: [],
    budget: {
      limits: { maxTotalTokens: 400000, maxAgentCalls: 80, maxActiveMs: 3600000 }, used: { tokens: 12000, calls: 3, activeMs: 60000 },
      reserved: { tokens: 0, calls: 0, activeMs: 0 }, remaining: { tokens: 388000, calls: 77, activeMs: 3540000 },
      unstartedFeatures: 1, nextShare: null, rule: "",
    },
    next: { kind: "start", featureId: "core", runId: null, message: "Start feature core" },
    ...extra,
  };
}

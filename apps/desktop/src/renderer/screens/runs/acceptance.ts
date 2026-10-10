import type { RunRequest } from "../../client/runs.js";
import type { Review, RunTrace, Spec } from "./model.js";

/** A step an AI acceptance walk-through recorded (`WalkStep` in acceptance-gate.ts). */
export interface WalkStep {
  stepId: string;
  action: string;
  observation: string;
  expectationIds: string[];
  /** Terminal lines, or the browser's page snapshot, when the step was recorded. */
  frame: string;
  url?: string;
}
/** `acceptance/GATE/ATTEMPT/walk.json`. */
export interface WalkRecord {
  gateId: string;
  attemptId: string | null;
  walk: {
    expectations: {
      expectationId: string;
      verdict: string;
      stepIds: string[];
      explanation: string;
    }[];
  } | null;
  steps: WalkStep[];
  violations: string[];
  problems: string[];
  failure: string | null;
  verdict: string | null;
}
/** An AI acceptance gate from the run's frozen `definition/gates.json`. */
export interface AcceptanceGate {
  id: string;
  type: string;
  acceptance?: {
    driver: "browser" | "terminal";
    scenario: { title: string; steps: string[]; expectations: string[] };
    capabilities?: { outboundHosts: string[]; listenPorts: number[] };
  };
}
/** The body of an acceptance test decision (an approval request with `acceptance`). */
export interface AcceptanceDecision {
  requestId: string;
  digest: string;
  gateId: string;
  scenario: string;
  verdict: string;
  testPath: string;
  testContent: string;
  stableRuns: number;
}

export type Verdict = "pass" | "fail" | "inconclusive" | "deferred" | "manual" | "pending";

export interface GateCriterion {
  key: string;
  /** "AC-001" for a spec criterion, "E1" for an expectation of an acceptance scenario. */
  label: string;
  text: string;
  verdict: Verdict;
  note: string | null;
  steps: WalkStep[];
  /** The gate the expectation belongs to, for AI acceptance expectations. */
  gateId: string | null;
  url: string | null;
  /** A pending manual evidence request for this criterion. */
  manualRequestId: string | null;
}

export interface GateView {
  criteria: GateCriterion[];
  passed: number;
  total: number;
  /** Driver and network grants of the run's AI acceptance gates, as one line. */
  setup: string | null;
  decisions: AcceptanceDecision[];
}

const parse = <T>(json: string | null): T | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

const VERDICTS = new Set(["pass", "fail", "inconclusive", "deferred"]);
const verdictOf = (value: string | undefined): Verdict =>
  value && VERDICTS.has(value) ? (value as Verdict) : "pending";

/**
 * Criteria with verdicts and evidence: the spec's acceptance criteria with the latest assessed
 * verdicts, then the expectations of each AI acceptance gate with the steps its walk cited.
 */
export function gateView(input: {
  spec: Spec | null;
  trace: RunTrace;
  reviews: readonly Review[];
  walks: readonly WalkRecord[];
  gates: readonly AcceptanceGate[];
  requests: readonly RunRequest[];
}): GateView {
  const { spec, trace, reviews, walks, gates, requests } = input;
  const pending = requests.filter((r) => r.status === "pending");
  const manual = new Map<string, string>();
  for (const request of pending.filter((r) => r.kind === "manual_evidence")) {
    const body = parse<{ criterionId?: string }>(request.body_json);
    if (body?.criterionId) manual.set(body.criterionId, request.request_id);
  }
  const explanations = new Map<string, string>();
  for (const review of reviews)
    for (const row of review.coverage) explanations.set(row.criterionId, row.explanation);

  const criteria: GateCriterion[] = (spec?.criteria ?? []).map((c) => {
    const manualRequestId = manual.get(c.id) ?? null;
    const assessed = verdictOf(trace.criteria.get(c.id));
    return {
      key: c.id,
      label: c.id,
      text: `Given ${c.given}, when ${c.when}, then ${c.then}`,
      verdict: manualRequestId && assessed === "pending" ? "manual" : assessed,
      note: explanations.get(c.id) ?? (c.method === "manual" ? "Checked by a person" : null),
      steps: [],
      gateId: null,
      url: null,
      manualRequestId,
    };
  });

  const latestWalk = new Map<string, WalkRecord>();
  for (const walk of walks) latestWalk.set(walk.gateId, walk);
  for (const gate of gates) {
    const scenario = gate.acceptance?.scenario;
    if (gate.type !== "ai-acceptance" || !scenario) continue;
    const walk = latestWalk.get(gate.id);
    const steps = new Map((walk?.steps ?? []).map((s) => [s.stepId, s]));
    scenario.expectations.forEach((text, index) => {
      const id = `E${index + 1}`;
      const result = walk?.walk?.expectations.find((e) => e.expectationId === id);
      const cited = (result?.stepIds ?? []).flatMap((s) => {
        const step = steps.get(s);
        return step ? [step] : [];
      });
      criteria.push({
        key: `${gate.id}:${id}`,
        label: `${scenario.title} · ${id}`,
        text,
        verdict: verdictOf(result?.verdict),
        note: result?.explanation ?? walk?.failure ?? null,
        steps: cited,
        gateId: gate.id,
        url: cited.findLast((s) => s.url)?.url ?? null,
        manualRequestId: null,
      });
    });
  }

  const decisions: AcceptanceDecision[] = pending.flatMap((request) => {
    if (request.kind !== "approval") return [];
    const body = parse<{ acceptance?: Omit<AcceptanceDecision, "requestId" | "digest"> }>(
      request.body_json,
    );
    return body?.acceptance
      ? [{ ...body.acceptance, requestId: request.request_id, digest: request.digest ?? "" }]
      : [];
  });

  const acceptanceGates = gates.filter((g) => g.type === "ai-acceptance" && g.acceptance);
  const setup = acceptanceGates.length
    ? acceptanceGates
        .map((g) => {
          const caps = g.acceptance?.capabilities;
          const hosts = caps?.outboundHosts.length
            ? caps.outboundHosts.join(", ")
            : "localhost only";
          return `${g.acceptance?.driver === "browser" ? "browser" : "terminal"} · outbound: ${hosts}`;
        })
        .join("; ")
    : null;

  return {
    criteria,
    passed: criteria.filter((c) => c.verdict === "pass").length,
    total: criteria.length,
    setup,
    decisions,
  };
}

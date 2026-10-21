import { decidedChecks } from "../verification/host-passed.js";
import type { WorkflowStore } from "./store.js";
import { runUsage } from "./usage.js";
import { parseRunDefinition } from "./v2/runtime.js";
import { readRoutingSummary } from "./view.js";

/**
 * Two runs side by side: an A/B of one feature run with two routing maps. Everything comes from
 * the store, so any two runs of the project compare, finished or not.
 */

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];

export interface ComparedRun {
  runId: string;
  featureId: string;
  workflowId: string | null;
  status: string;
  reason: string;
  /** The effective model of each routing target (run, role, stage, profile). */
  routes: { target: string; model: string }[];
  tokens: number;
  costUsd: number | null;
  activeMs: number;
  agentCalls: number;
  repairRounds: number;
  reviewRounds: number;
  correctiveTasks: number;
  stages: { stage: string; attempts: number; tokens: number }[];
  /** Tokens per model, most first. */
  models: { model: string; tokens: number }[];
  /** The latest result of each check. */
  checks: { passed: number; failed: number };
  /** Review findings by severity; refuted ones are left out. */
  findings: Record<Severity, number>;
  /** Findings still open or confirmed when the run stopped. */
  openFindings: number;
  /** Findings the run was accepted with. */
  limitations: number;
}

export interface RunComparison {
  a: ComparedRun;
  b: ComparedRun;
  sameFeature: boolean;
  sameWorkflow: boolean;
  /** Routing targets whose model differs, with each side's model (null: not routed there). */
  routeDifferences: { target: string; a: string | null; b: string | null }[];
  /** Tokens per stage on both sides, in the order the stages first appear. */
  stages: { stage: string; a: number | null; b: number | null }[];
  /** B minus A. */
  delta: { tokens: number; costUsd: number | null; activeMs: number };
}

function compared(store: WorkflowStore, runId: string): ComparedRun {
  return store.readTransaction(() => {
    const run = store.run(runId);
    const snapshot = store.snapshot(runId);
    const workflowId = (() => {
      try {
        return parseRunDefinition(run.definition_json).definition.id;
      } catch {
        return null;
      }
    })();
    const usage = runUsage(store, runId);
    const latest = new Map<string, string>();
    for (const row of decidedChecks(store, runId, store.checkDetails(runId)))
      latest.set(row.check_id, row.status);
    const findings: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    let openFindings = 0;
    for (const row of store.findings(runId)) {
      if (row.status === "refuted") continue;
      const severity = (() => {
        try {
          return (JSON.parse(row.body_json) as { severity?: string }).severity;
        } catch {
          return undefined;
        }
      })();
      if (severity && (SEVERITIES as readonly string[]).includes(severity))
        findings[severity as Severity] += 1;
      if (row.status === "open" || row.status === "confirmed") openFindings += 1;
    }
    return {
      runId,
      featureId: run.feature_id,
      workflowId,
      status: snapshot.status,
      reason: snapshot.reason,
      routes: (readRoutingSummary(store, runId)?.effective ?? []).map((r) => ({
        target: r.target,
        model: r.model,
      })),
      tokens: snapshot.tokenUsage,
      costUsd: snapshot.estimatedCostUsd,
      activeMs: snapshot.activeMs,
      agentCalls: run.agent_calls,
      repairRounds: run.repair_rounds,
      reviewRounds: run.review_rounds ?? 0,
      correctiveTasks: run.corrective_tasks,
      stages: usage.stages.map((s) => ({ stage: s.stage, attempts: s.attempts, tokens: s.tokens })),
      models: usage.models.map((m) => ({ model: m.model, tokens: m.tokens })),
      checks: {
        passed: [...latest.values()].filter((s) => s === "passed").length,
        failed: [...latest.values()].filter((s) => s !== "passed").length,
      },
      findings,
      openFindings,
      limitations: snapshot.limitations.count,
    };
  });
}

export function compareRuns(store: WorkflowStore, runA: string, runB: string): RunComparison {
  const a = compared(store, runA);
  const b = compared(store, runB);
  const routeOf = (run: ComparedRun) => new Map(run.routes.map((r) => [r.target, r.model]));
  const routesA = routeOf(a);
  const routesB = routeOf(b);
  const targets = [...new Set([...routesA.keys(), ...routesB.keys()])];
  const stageNames = [...new Set([...a.stages, ...b.stages].map((s) => s.stage))];
  const tokensOf = (run: ComparedRun, stage: string) =>
    run.stages.find((s) => s.stage === stage)?.tokens ?? null;
  return {
    a,
    b,
    sameFeature: a.featureId === b.featureId,
    sameWorkflow: a.workflowId === b.workflowId,
    routeDifferences: targets
      .map((target) => ({ target, a: routesA.get(target) ?? null, b: routesB.get(target) ?? null }))
      .filter((d) => d.a !== d.b),
    stages: stageNames.map((stage) => ({ stage, a: tokensOf(a, stage), b: tokensOf(b, stage) })),
    delta: {
      tokens: b.tokens - a.tokens,
      costUsd: a.costUsd === null || b.costUsd === null ? null : b.costUsd - a.costUsd,
      activeMs: b.activeMs - a.activeMs,
    },
  };
}

const count = (n: number): string => n.toLocaleString("en-US");
const usd = (n: number | null): string => (n === null ? "unknown" : `$${n.toFixed(2)}`);
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
const signed = (n: number, text: string): string => (n > 0 ? `+${text}` : text);
const percent = (from: number, to: number): string =>
  from === 0 ? "" : ` (${signed(to - from, `${Math.round(((to - from) / from) * 100)}%`)})`;
const findingText = (run: ComparedRun): string => {
  const parts = SEVERITIES.filter((s) => run.findings[s]).map((s) => `${run.findings[s]} ${s}`);
  return parts.length ? `${parts.join(", ")}; ${run.openFindings} open` : "none";
};
const cell = (text: string): string => text.replaceAll("|", "\\|");

/** The comparison as Markdown: what differs in routing, then the outcome and its cost. */
export function comparisonMarkdown(c: RunComparison): string {
  const { a, b } = c;
  const out = [`# Run comparison: ${a.runId} (A) and ${b.runId} (B)`, ""];
  if (!c.sameFeature)
    out.push(`A and B are different features (${a.featureId}, ${b.featureId}).`, "");
  if (!c.sameWorkflow)
    out.push(
      `A and B ran different workflows (${a.workflowId ?? "unknown"}, ${b.workflowId ?? "unknown"}).`,
      "",
    );
  out.push("## Routing", "");
  if (c.routeDifferences.length) {
    out.push("| Target | A | B |", "| --- | --- | --- |");
    for (const d of c.routeDifferences)
      out.push(
        `| ${cell(d.target)} | ${cell(d.a ?? "not routed")} | ${cell(d.b ?? "not routed")} |`,
      );
  } else out.push("Both runs used the same models.");
  out.push(
    "",
    "## Result",
    "",
    "| | A | B | B - A |",
    "| --- | --- | --- | --- |",
    `| Status | ${a.status}${a.reason !== "none" ? ` (${a.reason})` : ""} | ${b.status}${b.reason !== "none" ? ` (${b.reason})` : ""} | |`,
    `| Tokens | ${count(a.tokens)} | ${count(b.tokens)} | ${signed(c.delta.tokens, count(c.delta.tokens))}${percent(a.tokens, b.tokens)} |`,
    `| Estimated cost | ${usd(a.costUsd)} | ${usd(b.costUsd)} | ${c.delta.costUsd === null ? "" : signed(c.delta.costUsd, usd(c.delta.costUsd))} |`,
    `| Active time | ${minutes(a.activeMs)} | ${minutes(b.activeMs)} | ${signed(c.delta.activeMs, minutes(c.delta.activeMs))} |`,
    `| Agent calls | ${a.agentCalls} | ${b.agentCalls} | ${signed(b.agentCalls - a.agentCalls, String(b.agentCalls - a.agentCalls))} |`,
    `| Repair rounds | ${a.repairRounds} | ${b.repairRounds} | |`,
    `| Review rounds | ${a.reviewRounds} | ${b.reviewRounds} | |`,
    `| Checks passed / failed | ${a.checks.passed} / ${a.checks.failed} | ${b.checks.passed} / ${b.checks.failed} | |`,
    `| Review findings | ${findingText(a)} | ${findingText(b)} | |`,
    `| Accepted limitations | ${a.limitations} | ${b.limitations} | |`,
    "",
    "## Tokens by stage",
    "",
    "| Stage | A | B |",
    "| --- | --- | --- |",
    ...c.stages.map(
      (s) =>
        `| ${cell(s.stage)} | ${s.a === null ? "" : count(s.a)} | ${s.b === null ? "" : count(s.b)} |`,
    ),
  );
  return `${out.join("\n")}\n`;
}

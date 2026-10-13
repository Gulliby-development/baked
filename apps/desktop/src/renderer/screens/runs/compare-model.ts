import type { ComparedRun, RunComparison } from "../../client/runs.js";
import { tokens, usd } from "../../format.js";

/** One row of the comparison table: a label, both sides and B minus A when it means something. */
export interface CompareRow {
  label: string;
  a: string;
  b: string;
  delta: string;
  /** Which side did better on this row, when lower or higher is clearly better. */
  better: "a" | "b" | null;
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
/** B minus A with its sign: "+12k", "-$0.40", "0". */
const diff = (n: number, format: (abs: number) => string): string =>
  `${n > 0 ? "+" : n < 0 ? "-" : ""}${format(Math.abs(n))}`;
const lower = (a: number, b: number): "a" | "b" | null => (a === b ? null : a < b ? "a" : "b");

const findingText = (run: ComparedRun): string => {
  const parts = (["critical", "high", "medium", "low"] as const)
    .filter((s) => run.findings[s])
    .map((s) => `${run.findings[s]} ${s}`);
  return parts.length ? `${parts.join(", ")} (${run.openFindings} open)` : "none";
};

const statusText = (run: ComparedRun): string =>
  run.reason !== "none" ? `${run.status} (${run.reason})` : run.status;

/** The rows of the comparison, in the order of the CLI's Markdown. */
export function compareRows(c: RunComparison): CompareRow[] {
  const { a, b, delta } = c;
  const serious = (run: ComparedRun) => run.findings.critical + run.findings.high;
  return [
    { label: "Status", a: statusText(a), b: statusText(b), delta: "", better: null },
    {
      label: "Tokens",
      a: tokens(a.tokens),
      b: tokens(b.tokens),
      delta: diff(delta.tokens, tokens),
      better: lower(a.tokens, b.tokens),
    },
    {
      label: "Estimated cost",
      a: usd(a.costUsd),
      b: usd(b.costUsd),
      delta: delta.costUsd === null ? "" : diff(delta.costUsd, usd),
      better: a.costUsd === null || b.costUsd === null ? null : lower(a.costUsd, b.costUsd),
    },
    {
      label: "Active time",
      a: minutes(a.activeMs),
      b: minutes(b.activeMs),
      delta: diff(delta.activeMs, minutes),
      better: lower(a.activeMs, b.activeMs),
    },
    {
      label: "Agent calls",
      a: String(a.agentCalls),
      b: String(b.agentCalls),
      delta: diff(b.agentCalls - a.agentCalls, String),
      better: lower(a.agentCalls, b.agentCalls),
    },
    {
      label: "Repair rounds",
      a: String(a.repairRounds),
      b: String(b.repairRounds),
      delta: "",
      better: lower(a.repairRounds, b.repairRounds),
    },
    {
      label: "Review rounds",
      a: String(a.reviewRounds ?? 0),
      b: String(b.reviewRounds ?? 0),
      delta: "",
      better: lower(a.reviewRounds ?? 0, b.reviewRounds ?? 0),
    },
    {
      label: "Checks passed / failed",
      a: `${a.checks.passed} / ${a.checks.failed}`,
      b: `${b.checks.passed} / ${b.checks.failed}`,
      delta: "",
      better: lower(a.checks.failed, b.checks.failed),
    },
    {
      label: "Review findings",
      a: findingText(a),
      b: findingText(b),
      delta: "",
      better: lower(serious(a), serious(b)),
    },
    {
      label: "Accepted limitations",
      a: String(a.limitations),
      b: String(b.limitations),
      delta: "",
      better: lower(a.limitations, b.limitations),
    },
  ];
}

/** Up to two runs picked for a comparison: picking a third drops the oldest pick. */
export function togglePick(picked: string[], runId: string): string[] {
  if (picked.includes(runId)) return picked.filter((id) => id !== runId);
  return [...picked, runId].slice(-2);
}

import type { AttentionItem, RunState } from "../../../shared/api.js";
import type { DotTone } from "../../components/ui/dot.js";
import { STATUS_TONE } from "./model.js";

/** The short badge a run gets in the sidebar when it waits for a person, by attention kind. */
const WAIT_LABEL: Record<string, string> = {
  approval: "approve",
  clarification: "answer",
  convergence: "decide",
  delivery: "deliver",
  recovery: "recover",
  acceptance: "accept",
  manual_evidence: "accept",
};

/**
 * What a run waits for from a person: the badge text of its first attention item in this project,
 * or "you" for a waiting run Needs you has not listed yet. Null when nothing waits on a person.
 */
export function runWait(
  projectKey: string,
  run: { runId: string; status: RunState },
  attention: readonly AttentionItem[],
): string | null {
  const item = attention.find((a) => a.projectKey === projectKey && a.runId === run.runId);
  if (item) return WAIT_LABEL[item.kind] ?? "you";
  return run.status === "waiting" ? "you" : null;
}

/** The sidebar dot of a run status; running shows the busy colour. */
export function runDot(status: RunState): DotTone {
  const tone = STATUS_TONE[status];
  return tone === "info" ? "busy" : tone;
}

/**
 * When the sidebar reloads the recent runs: a run started, finished or started waiting, as seen by
 * the project overview and Needs you.
 */
export function recentRunsVersion(
  projectKey: string,
  activeRuns: number,
  attention: readonly AttentionItem[],
): string {
  const waits = attention
    .filter((a) => a.projectKey === projectKey && a.runId)
    .map((a) => `${a.runId}:${a.kind}`)
    .sort();
  return `${activeRuns}|${waits.join(",")}`;
}

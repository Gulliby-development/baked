import type { WorkflowStore } from "./store.js";

/** Why a run waits, stopped or failed, in words, for every front end. */
const REASONS: Record<string, string> = {
  clarification: "the agents need answers to open questions",
  approval: "the spec, plan and tasks wait for your approval",
  manual_evidence: "a criterion needs a manual observation from you",
  user_pause: "paused by you",
  owner_lost: "the process that ran it stopped",
  input_changed: "instructions or configuration changed since approval",
  workspace_busy: "another run or edit holds the workspace",
  budget_exhausted: "the token, call or time budget is used up",
  checkpoint: "the run reached a token checkpoint and waits for you to continue",
  no_progress: "repairs stopped making progress",
  verification_failed: "checks or reviews did not pass",
  provider_unavailable: "the model provider is unavailable",
  provider_account:
    "the model provider refused the account: add credits, fix the API key or switch the run to another model",
  tool_denied: "a tool call was denied by policy",
  storage_failure: "workflow storage failed",
  invalid_output: "a model returned output that failed validation",
  host_state: "the host's own state was stale or incomplete (not a model's output)",
  interrupted_effect: "an interrupted command needs recovery",
  dependency_failed: "a dependency did not complete",
};
export const reasonText = (reason: string): string => REASONS[reason] ?? reason;

/**
 * What stopped a blocked or failed run: the error the runtime recorded when it stopped it, cut to
 * its last 2000 characters, or null when it recorded none (a budget or a pause says enough).
 */
export function stopDetail(store: WorkflowStore, runId: string): string | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "diagnostic" && a.logical_path.startsWith("errors/"))
    .at(-1);
  if (!latest) return null;
  const text = store.readArtifact(runId, latest.id).trim();
  return text.length > 2000 ? `…${text.slice(-2000)}` : text || null;
}

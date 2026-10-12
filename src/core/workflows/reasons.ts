/** Why a run waits, stopped or failed, in words, for every front end. */
const REASONS: Record<string, string> = {
  clarification: "the agents need answers to open questions",
  approval: "the spec, plan and tasks wait for your approval",
  manual_evidence: "a criterion needs a manual observation from you",
  user_pause: "paused by you",
  owner_lost: "the process that ran it stopped",
  step_stalled: "an agent call made no progress and was stopped",
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

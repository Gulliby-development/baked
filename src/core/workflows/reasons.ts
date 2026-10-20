/** Why a run waits, stopped or failed, in words, for every front end. */
const REASONS: Record<string, string> = {
  clarification: "the agents need answers to open questions",
  approval: "the spec, plan and tasks wait for your approval",
  manual_evidence: "a criterion needs a manual observation from you",
  user_pause: "paused by you",
  owner_lost: "the process that ran it stopped",
  step_stalled: "an agent call made no progress and was stopped",
  input_changed:
    "instructions or configuration changed since approval; the diagnostic names the file: accept the change, restore the file, or revise the run",
  workspace_busy: "another run or edit holds the workspace",
  budget_exhausted: "the token, call or time budget is used up",
  attempt_cap:
    "an agent used its attempt's token cap without submitting a result; the run budget is not used up, and resuming continues the task with the edits already made",
  step_cap:
    "an agent used its attempt's steps without a result being accepted; the run budget is not used up, and resuming continues the task with the edits already made",
  checkpoint: "the run reached a token checkpoint and waits for you to continue",
  no_progress: "the run stopped making progress",
  verification_failed: "checks or reviews did not pass",
  check_unavailable:
    "a required check cannot be started (its executable is missing or not runnable)",
  provider: "waiting for the model provider to answer a health probe",
  provider_unavailable: "the model provider is unavailable",
  provider_account:
    "the model provider refused the account or its CLI is missing: add credits or wait for a usage limit to reset, fix the API key, install the CLI or switch the run to another model",
  tool_denied: "a tool call was denied by policy",
  storage_failure: "workflow storage failed",
  invalid_output: "a model returned output that failed validation",
  host_state: "the host's own state was stale or incomplete (not a model's output)",
  host_error:
    "BAKED failed internally; this is not a model problem: resume once, and if it stops the same way, export the run and report it",
  interrupted_effect: "an interrupted command needs recovery",
  dependency_failed: "a dependency did not complete",
  replay_diverged:
    "a replayed run sent a model request the recording does not have; the run's diagnostic names where",
};
export const reasonText = (reason: string): string => REASONS[reason] ?? reason;

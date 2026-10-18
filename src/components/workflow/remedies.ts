import {
  errorRecovery,
  type RecoveryAdvice,
  type Remedy,
  renderRecovery,
} from "../../core/workflows/remedies.js";

function label(remedy: Remedy): string {
  const run = remedy.runId ? `run ${remedy.runId}` : "the run";
  switch (remedy.action) {
    case "resume":
      return `Open ${run} and press R to retry`;
    case "accept-workspace":
      return `Open ${run} and press A to accept changes`;
    case "reroute":
      return `Open ${run}, choose another model and press M to switch model`;
    case "extend":
      return remedy.initiativeId ? "Press B to extend budget" : "Press B to raise limits";
    case "replan":
      return "Select the initiative feature and press X to re-plan it";
    case "revise":
      return "Revise the spec or policy before retrying";
    case "fork":
      return `Open ${run} and press F to fork`;
    case "cancel":
      return `Open ${run} and press C to cancel`;
    case "pause":
      return `Open ${run} and press P to pause`;
    case "deliver":
      return `Use /workflow deliver ${remedy.runId ?? "RUN_ID"}`;
    case "recover":
      return `Open ${run} and answer its recovery decision`;
  }
}

export const tuiRecoveryText = (message: string, advice?: RecoveryAdvice | null): string =>
  renderRecovery(message, advice, label);
export const tuiErrorText = (error: unknown): string =>
  tuiRecoveryText(error instanceof Error ? error.message : String(error), errorRecovery(error));

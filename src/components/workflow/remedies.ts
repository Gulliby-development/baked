import {
  errorRecovery,
  extendSuggestion,
  type RecoveryAdvice,
  type Remedy,
  renderRecovery,
  suggestionText,
} from "../../core/workflows/remedies.js";

const files = (remedy: Remedy): string => remedy.paths?.slice(0, 3).join(", ") || "the file";

function label(remedy: Remedy): string {
  const run = remedy.runId ? `run ${remedy.runId}` : "the run";
  switch (remedy.action) {
    case "repair":
      return `Open ${run} and press O for one more repair`;
    case "resume":
      return `Open ${run} and press R to retry`;
    case "accept-workspace":
      return `Open ${run} and press A to accept changes`;
    case "reroute":
      return `Open ${run}, choose another model and press M to switch model`;
    case "extend": {
      const amount = suggestionText(
        extendSuggestion({ message: "", summary: "", remedies: [remedy] }),
      );
      if (!remedy.initiativeId)
        return amount ? `Press B to raise limits (to ${amount})` : "Press B to raise limits";
      return amount ? `Press B to extend budget (to ${amount})` : "Press B to extend budget";
    }
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
    case "route":
      return `Open ${run} and press T to correct ${remedy.owner ?? "the owner"} first`;
    case "widen":
      return `Open ${run} and press W to let ${remedy.taskId ?? "the correction"} write ${files(remedy)}`;
    case "upstream":
      return `Open ${run} and press Q to ask feature ${remedy.owner ?? "upstream"} for the change`;
  }
}

export const tuiRecoveryText = (message: string, advice?: RecoveryAdvice | null): string =>
  renderRecovery(message, advice, label);
export const tuiErrorText = (error: unknown): string =>
  tuiRecoveryText(error instanceof Error ? error.message : String(error), errorRecovery(error));

import {
  type RecoveryAdvice,
  type Remedy,
  renderRecovery,
} from "../../../../../src/core/workflows/remedies-model.js";

function label(remedy: Remedy): string {
  const run = remedy.runId ? `run ${remedy.runId}` : "the run";
  switch (remedy.action) {
    case "resume":
      return `Open ${run} and choose Retry`;
    case "accept-workspace":
      return `Open ${run} and choose Accept changes`;
    case "reroute":
      return `Open ${run} and choose Switch model`;
    case "extend":
      return "Choose Extend budget";
    case "replan":
      return "Open the initiative feature and choose Re-plan";
    case "revise":
      return "Revise the spec or policy before retrying";
    case "fork":
      return `Open ${run} and choose Fork`;
    case "cancel":
      return `Open ${run} and choose Cancel`;
    case "pause":
      return `Open ${run} and choose Pause`;
    case "deliver":
      return `Open ${run} and choose Deliver, then approve its plan in Needs you`;
    case "recover":
      return `Open ${run}'s recovery decision in Needs you`;
  }
}

export const desktopRecoveryText = (message: string, advice?: RecoveryAdvice | null): string =>
  renderRecovery(message, advice, label);

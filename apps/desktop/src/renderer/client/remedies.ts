import {
  extendSuggestion,
  RESUME_REMEDIES,
  type RecoveryAdvice,
  type Remedy,
  type ResumeRemedy,
  renderRecovery,
  suggestionText,
} from "../../../../../src/core/workflows/remedies-model.js";

const files = (remedy: Remedy): string => remedy.paths?.slice(0, 3).join(", ") || "the file";

function label(remedy: Remedy): string {
  const run = remedy.runId ? `run ${remedy.runId}` : "the run";
  switch (remedy.action) {
    case "repair":
      return `Open ${run} and choose One more repair`;
    case "resume":
      return `Open ${run} and choose Retry`;
    case "accept-workspace":
      return `Open ${run} and choose Accept changes`;
    case "reroute":
      return `Open ${run} and choose Switch model`;
    case "extend": {
      const amount = suggestionText(
        extendSuggestion({ message: "", summary: "", remedies: [remedy] }),
      );
      return amount ? `Choose Extend to ${amount}` : "Choose Extend budget";
    }
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
    case "route":
      return `Open ${run} and choose Correct ${remedy.owner ?? "the owner"} first`;
    case "widen":
      return `Open ${run} and choose Let ${remedy.taskId ?? "the correction"} write ${files(remedy)}`;
    case "upstream":
      return `Open ${run} and choose Ask feature ${remedy.owner ?? "upstream"} for the change`;
    case "accept-limitation":
      return `Open ${run} and choose Accept ${remedy.checkId ?? "the check"} as a limitation`;
  }
}

/**
 * The remedies a resume applies, as buttons: a corrective's block on files it may not write
 * (#2155) and a required check that cannot run (#2358).
 */
export const hostRemedies = (
  advice: RecoveryAdvice | null | undefined,
): (Remedy & { action: ResumeRemedy })[] =>
  (advice?.remedies ?? []).filter((r): r is Remedy & { action: ResumeRemedy } =>
    RESUME_REMEDIES.some((action) => action === r.action),
  );

export function remedyLabel(remedy: Remedy): string {
  if (remedy.action === "accept-limitation")
    return `Accept ${remedy.checkId ?? "the check"} as a limitation`;
  if (remedy.action === "route") return `Correct ${remedy.owner ?? "the owner"} first`;
  if (remedy.action === "widen") return `Let ${remedy.taskId ?? "it"} write ${files(remedy)}`;
  return `Ask feature ${remedy.owner ?? "upstream"}`;
}

export function remedyTitle(remedy: Remedy): string {
  if (remedy.action === "accept-limitation")
    return `${remedy.checkId ?? "The check"} timed out twice on the same files. Completes the run without it and lists it as a known limitation of the delivered change.`;
  const task = remedy.taskId ?? "The correction";
  if (remedy.action === "route")
    return `${task} cannot write ${files(remedy)}, which ${remedy.owner ?? "another task"} wrote. Opens a correction of ${remedy.owner ?? "that task"}; ${task} runs again after it.`;
  if (remedy.action === "widen")
    return `${task} cannot write ${files(remedy)}, which no task writes and the approved paths hold. Lets ${task} write it and runs it again.`;
  return `${task} cannot write ${files(remedy)}, which feature ${remedy.owner ?? "upstream"} owns. The run waits for that feature's change.`;
}

export const desktopRecoveryText = (message: string, advice?: RecoveryAdvice | null): string =>
  renderRecovery(message, advice, label);

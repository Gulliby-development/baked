import type { RollbackReport } from "../../client/chat.js";

const fileName = (path: string) => path.split(/[\\/]/).slice(-2).join("/");

/** The lines after the headline: files left in place and the backup tag. */
function detailLines(report: RollbackReport, action: string): string[] {
  const lines: string[] = [];
  for (const skip of report.skipped)
    lines.push(`Left ${fileName(skip.path)} as it is: ${skip.reason}.`);
  if (report.backupTag)
    lines.push(`The files from before the ${action} are in Git tag ${report.backupTag}.`);
  return lines;
}

const restoredText = (report: RollbackReport): string =>
  `restored ${report.restored.length} file(s)` +
  (report.removed.length > 0 ? `, removed ${report.removed.length}.` : ".");

/** The lines that tell what a fork did to the files, shown at the top of the new chat. */
export function forkReportLines(report: RollbackReport | undefined): string[] {
  if (!report) return ["Forked the chat. Files were left as they are."];
  return [
    `Forked at checkpoint #${report.checkpoint}: ${restoredText(report)}`,
    ...detailLines(report, "fork"),
  ];
}

/** The lines that tell what Undo or Redo did, shown above the conversation until dismissed. */
export function rewindReportLines(action: "undo" | "redo", report: RollbackReport): string[] {
  const head =
    action === "undo"
      ? `Undid the chat back to checkpoint #${report.checkpoint}: ${restoredText(report)}`
      : `Redid turn #${report.checkpoint}: ${restoredText(report)}`;
  return [head, ...detailLines(report, action)];
}

const reports = new Map<string, string[]>();

/** Keeps the fork's report for the new session's screen, which reads it once. */
export function rememberForkReport(sessionId: string, lines: string[]): void {
  reports.set(sessionId, lines);
}

export function takeForkReport(sessionId: string): string[] | null {
  const lines = reports.get(sessionId) ?? null;
  reports.delete(sessionId);
  return lines;
}

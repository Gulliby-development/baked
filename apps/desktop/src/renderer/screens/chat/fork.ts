import type { RollbackReport } from "../../client/chat.js";

/** The lines that tell what a fork did to the files, shown at the top of the new chat. */
export function forkReportLines(report: RollbackReport | undefined): string[] {
  if (!report) return ["Forked the chat. Files were left as they are."];
  const name = (path: string) => path.split(/[\\/]/).slice(-2).join("/");
  const lines = [
    `Forked at checkpoint #${report.checkpoint}: restored ${report.restored.length} file(s)` +
      (report.removed.length > 0 ? `, removed ${report.removed.length}.` : "."),
  ];
  for (const skip of report.skipped)
    lines.push(`Left ${name(skip.path)} as it is: ${skip.reason}.`);
  if (report.backupTag)
    lines.push(`The files from before the fork are in Git tag ${report.backupTag}.`);
  return lines;
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

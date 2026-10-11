import type { RollbackReport } from "../../client/runs.js";
import { Button } from "../../components/ui/button.js";
import { LABEL } from "../../lib/styles.js";

const REPORT =
  "mb-4 flex flex-col gap-[10px] rounded-base border-2 border-l-8 border-border bg-background px-[18px] py-[14px] shadow-shadow";

/** What one restore did to the file: the run created it, deleted it, or changed it. */
export function restoreLabel(restored: RollbackReport["restored"][number]): string {
  if (restored.to === null) return "removed";
  if (restored.from === null) return "recreated";
  return "restored";
}

/** The undo summary line: how many files came back and how many stayed as they are. */
export function undoSummary(report: RollbackReport): string {
  const { restored, kept } = report;
  return `${restored.length} file${restored.length === 1 ? "" : "s"} restored${kept.length ? `, ${kept.length} left in place` : ""}`;
}

/**
 * The outcome of an undo on the run screen: the `workspace-rollback` report it wrote, or a note
 * that the run had no uncommitted task edits left to undo.
 */
export function UndoReport({
  report,
  onClose,
}: {
  report: RollbackReport | null;
  onClose: () => void;
}) {
  return (
    <section
      className={`${REPORT} ${report?.kept.length ? "border-l-fill-warn" : report ? "border-l-fill-ok" : "border-l-raised"}`}
      aria-label="Undo report"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className={LABEL}>Undo</h3>
        <span className="flex-1 font-semibold">
          {report ? undoSummary(report) : "Nothing to undo: the run has no uncommitted task edits."}
        </span>
        <Button variant="secondary" size="md" onClick={onClose}>
          Dismiss
        </Button>
      </div>
      {report && (report.restored.length > 0 || report.kept.length > 0) && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
          {report.restored.map((r) => (
            <li key={`r:${r.path}`}>
              <span className="font-mono">{r.path}</span>{" "}
              <span className="text-dim-foreground">{restoreLabel(r)}</span>
              {r.keptAs && (
                <span className="text-dim-foreground">
                  {" "}
                  · run's version kept as <span className="font-mono">{r.keptAs}</span>
                </span>
              )}
            </li>
          ))}
          {report.kept.map((k) => (
            <li key={`k:${k.path}`} className="text-[var(--warn)]">
              <span className="font-mono">{k.path}</span> <span>{k.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

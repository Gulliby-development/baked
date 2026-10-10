import type { RollbackReport } from "../../client/runs.js";

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
      className={`undo-report ${report?.kept.length ? "warn" : report ? "ok" : ""}`}
      aria-label="Undo report"
      aria-live="polite"
    >
      <div className="undo-head">
        <h3 className="label">Undo</h3>
        <span className="undo-summary">
          {report ? undoSummary(report) : "Nothing to undo: the run has no uncommitted task edits."}
        </span>
        <button type="button" className="btn" onClick={onClose}>
          Dismiss
        </button>
      </div>
      {report && (report.restored.length > 0 || report.kept.length > 0) && (
        <ul className="undo-files">
          {report.restored.map((r) => (
            <li key={`r:${r.path}`}>
              <span className="mono">{r.path}</span>{" "}
              <span className="muted">{restoreLabel(r)}</span>
              {r.keptAs && (
                <span className="muted">
                  {" "}
                  · run's version kept as <span className="mono">{r.keptAs}</span>
                </span>
              )}
            </li>
          ))}
          {report.kept.map((k) => (
            <li key={`k:${k.path}`} className="kept">
              <span className="mono">{k.path}</span> <span>{k.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

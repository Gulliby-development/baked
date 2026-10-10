import { useTheme } from "../../core/theme/index.js";
import type { RollbackReport } from "../../core/workflows/rollback.js";

/** What one restore did to the file: the run created it, deleted it, or changed it. */
function restoreLabel(restored: RollbackReport["restored"][number]): string {
  if (restored.to === null) return "removed";
  if (restored.from === null) return "recreated";
  return "restored";
}

/**
 * The outcome of an undo on the run screen: the `workspace-rollback` report it wrote, or a note
 * that the run had no uncommitted task edits left to undo.
 */
export function UndoReport({ report }: { report: RollbackReport | null }) {
  const t = useTheme();
  if (!report)
    return (
      <box flexDirection="column" marginBottom={1}>
        <text fg={t.textMuted}>
          Nothing to undo: the run has no uncommitted task edits. Esc hides this.
        </text>
      </box>
    );
  const { restored, kept } = report;
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={kept.length ? t.warning : t.success} attributes={1}>
        {`Undo: ${restored.length} file${restored.length === 1 ? "" : "s"} restored${kept.length ? `, ${kept.length} left in place` : ""}`}
      </text>
      {restored.map((r) => (
        <text key={`r:${r.path}`} fg={t.textPrimary}>
          {`✓ ${r.path} · ${restoreLabel(r)}${r.keptAs ? ` · run's version kept as ${r.keptAs}` : ""}`}
        </text>
      ))}
      {kept.map((k) => (
        <text key={`k:${k.path}`} fg={t.warning}>
          {`! ${k.path} · ${k.reason}`}
        </text>
      ))}
      <text fg={t.textFaint}>Esc hides this report.</text>
    </box>
  );
}

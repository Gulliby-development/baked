import { useTheme } from "../../core/theme/index.js";
import type { Review } from "../../core/workflows/schemas.js";
import type { FindingRow } from "../../core/workflows/store.js";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
export function FindingsView({ findings }: { findings: FindingRow[] }) {
  const t = useTheme();
  if (findings.length === 0) return <text fg={t.textMuted}>No findings recorded.</text>;
  const rows = findings
    .map((row) => ({ row, finding: JSON.parse(row.body_json) as Review["findings"][number] }))
    .sort(
      (a, b) =>
        Number(["resolved", "refuted"].includes(a.row.status)) -
          Number(["resolved", "refuted"].includes(b.row.status)) ||
        SEVERITY_ORDER.indexOf(a.finding.severity) - SEVERITY_ORDER.indexOf(b.finding.severity),
    );
  return (
    <box flexDirection="column">
      {rows.map(({ row, finding }) => {
        const closed = ["resolved", "refuted"].includes(row.status);
        const color = closed
          ? t.textFaint
          : finding.severity === "critical" || finding.severity === "high"
            ? t.error
            : finding.severity === "medium"
              ? t.warning
              : t.textMuted;
        return (
          <box key={row.id} flexDirection="column" marginBottom={1}>
            <text fg={color} attributes={closed ? 0 : 1}>
              {`${closed ? "✓" : "●"} ${finding.severity.toUpperCase()} · ${row.status}${row.repair_task_id ? ` · fix ${row.repair_task_id}` : ""}`}
            </text>
            <text fg={closed ? t.textFaint : t.textPrimary}>{finding.claim}</text>
            <text fg={t.textMuted}>{finding.impact}</text>
            <text fg={t.textFaint}>{`Evidence: ${finding.evidenceIds.join(", ") || "none"}`}</text>
          </box>
        );
      })}
    </box>
  );
}

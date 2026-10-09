import { useTheme } from "../../core/theme/index.js";
import { useWorkflowBadge } from "../../hooks/useWorkflow.js";
import { useWorkflowStore } from "../../stores/workflow.js";
import { formatTokens, statusGlyph } from "./format.js";

/** One-line run status shown above the footer while the panel is closed. */
export function WorkflowIndicator({
  workspace,
  panelOpen,
}: {
  workspace: string;
  panelOpen: boolean;
}) {
  const t = useTheme();
  useWorkflowBadge(workspace, panelOpen);
  const badge = useWorkflowStore((s) => s.badge);
  if (!badge || panelOpen) return null;
  const color = badge.needsUser
    ? t.warning
    : badge.status === "completed"
      ? t.success
      : badge.status === "failed" || badge.status === "blocked"
        ? t.error
        : t.info;
  const what = badge.needsUser
    ? "needs your decision"
    : badge.status === "running"
      ? `${badge.stageId ?? "starting"} · ${formatTokens(badge.tokens)} tokens`
      : badge.status;
  return (
    <box flexDirection="row" justifyContent="center" paddingX={1} width="100%">
      <text>
        <span fg={color}>{`${statusGlyph(badge.status, badge.needsUser)} workflow `}</span>
        <span fg={t.textPrimary}>{badge.featureId}</span>
        <span fg={color}>{` · ${what}`}</span>
        <span fg={t.textFaint}>{"  — /workflow to open"}</span>
      </text>
    </box>
  );
}

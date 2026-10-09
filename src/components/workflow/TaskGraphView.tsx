import { useTheme } from "../../core/theme/index.js";
import type { TaskRow } from "../../core/workflows/store.js";
import type { Task } from "../../core/workflows/types.js";

const GLYPH: Record<TaskRow["status"], string> = {
  pending: "·",
  running: "▶",
  implemented: "◐",
  verified: "✓",
  blocked: "!",
  failed: "✗",
  cancelled: "–",
  invalidated: "↺",
};
export function TaskGraphView({ tasks }: { tasks: TaskRow[] }) {
  const t = useTheme();
  if (tasks.length === 0) return <text fg={t.textMuted}>Tasks appear after the plan stage.</text>;
  const done = tasks.filter((r) => r.status === "verified" || r.status === "implemented").length;
  return (
    <box flexDirection="column">
      <text
        fg={t.textMuted}
      >{`${done}/${tasks.length} implemented · ◐ implemented  ✓ verified  ▶ running  ! blocked`}</text>
      <box height={1} />
      {tasks.map((row) => {
        const task = JSON.parse(row.definition_json) as Task;
        const color =
          row.status === "verified"
            ? t.success
            : row.status === "running"
              ? t.brand
              : row.status === "failed" || row.status === "blocked"
                ? t.error
                : row.status === "invalidated" || row.status === "cancelled"
                  ? t.textFaint
                  : t.textPrimary;
        return (
          <box key={row.id} flexDirection="column" marginBottom={1}>
            <text fg={color} attributes={row.status === "running" ? 1 : 0}>
              {`${GLYPH[row.status]} ${row.id} ${task.title}`}
              {task.origin !== "planned" ? <span fg={t.warning}>{` (${task.origin})`}</span> : null}
            </text>
            <text fg={t.textFaint}>
              {`   ${row.status}${task.dependsOn.length ? ` · after ${task.dependsOn.join(", ")}` : ""} · criteria ${task.criterionIds.join(", ")}`}
            </text>
            <text fg={t.textMuted}>
              {task.writes
                .map(
                  (w) =>
                    `   ${w.action === "create" ? "+" : w.action === "delete" ? "-" : "~"} ${w.path}`,
                )
                .join("\n")}
            </text>
          </box>
        );
      })}
    </box>
  );
}

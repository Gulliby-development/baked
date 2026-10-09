import { TextAttributes } from "@opentui/core";
import { useEffect, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { onTaskChange, type Task } from "../../core/tools/task-list.js";
import { Spinner } from "../layout/shared.js";

const MAX_VISIBLE = 6;

interface TaskListProps {
  tasks: Task[];
  nested?: boolean;
}

function InlineSpinner({ color }: { color: string }) {
  return <Spinner inline color={color} />;
}

export function TaskList({ tasks, nested }: TaskListProps) {
  const theme = useTheme();
  const STATUS_COLORS: Record<string, string> = {
    done: theme.success,
    "in-progress": theme.brand,
    pending: theme.textMuted,
    blocked: theme.error,
  };
  const STATUS_ICONS: Record<string, string> = {
    done: "✓",
    "in-progress": "●",
    pending: "○",
    blocked: "✗",
  };
  if (tasks.length === 0) return null;

  const doneTasks = tasks.filter((t) => t.status === "done");
  const activeTasks = tasks.filter((t) => t.status === "in-progress");
  const pendingTasks = tasks.filter((t) => t.status === "pending" || t.status === "blocked");
  const nonDone = [...activeTasks, ...pendingTasks];

  const renderTask = (task: Task) => (
    <box key={String(task.id)} height={1} flexDirection="row">
      <text>
        {task.status === "in-progress" ? (
          <InlineSpinner color={STATUS_COLORS["in-progress"] ?? theme.brand} />
        ) : (
          <span fg={STATUS_COLORS[task.status]}>{STATUS_ICONS[task.status]}</span>
        )}
        <span> </span>
        <span
          fg={
            task.status === "done"
              ? theme.textMuted
              : task.status === "in-progress"
                ? theme.textPrimary
                : (STATUS_COLORS[task.status] ?? theme.textMuted)
          }
          attributes={task.status === "in-progress" ? TextAttributes.BOLD : undefined}
        >
          {task.title}
        </span>
      </text>
    </box>
  );

  if (nested) {
    return (
      <box flexDirection="column" paddingLeft={2}>
        {doneTasks.length > 0 && <text fg={theme.success}> +{String(doneTasks.length)} done</text>}
        {nonDone.slice(0, MAX_VISIBLE).map(renderTask)}
        {nonDone.length > MAX_VISIBLE && (
          <text fg={theme.textMuted}> +{String(nonDone.length - MAX_VISIBLE)} more</text>
        )}
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      border={true}
      borderColor={theme.brandDim}
      paddingX={1}
      width="100%"
    >
      <box gap={1} flexDirection="row" height={1}>
        <text fg={theme.brand} attributes={TextAttributes.BOLD}>
          {icon("plan")} Tasks
        </text>
        <text fg={theme.textSecondary}>
          {String(doneTasks.length)}/{String(tasks.length)}
        </text>
      </box>
      {doneTasks.length > 0 && <text fg={theme.success}>+{String(doneTasks.length)} done</text>}
      {nonDone.slice(0, MAX_VISIBLE).map(renderTask)}
      {nonDone.length > MAX_VISIBLE && (
        <text fg={theme.textMuted}>+{String(nonDone.length - MAX_VISIBLE)} more</text>
      )}
    </box>
  );
}

export function TaskProgress({ tabId }: { tabId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => onTaskChange(setTasks, tabId), [tabId]);

  useEffect(() => {
    if (tasks.length === 0) {
      setVisible(false);
      return;
    }
    const actionable = tasks.some((t) => t.status === "pending" || t.status === "in-progress");
    if (actionable) {
      setVisible(true);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [tasks]);

  if (!visible) return null;

  return <TaskList tasks={tasks} />;
}

export function useTaskList(tabId?: string): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => onTaskChange(setTasks, tabId), [tabId]);
  return tasks;
}

import { TextAttributes } from "@opentui/core";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import type { Task } from "../../core/tools/task-list.js";
import type { Plan, PlanStepStatus } from "../../types/index.js";
import { Spinner } from "../layout/shared.js";
import { TaskList } from "./TaskProgress.js";

const STATUS_ICONS: Record<PlanStepStatus, () => string> = {
  done: () => icon("check"),
  active: () => "",
  pending: () => icon("spinner"),
  skipped: () => icon("skip"),
};

const MAX_VISIBLE = 7;

interface Props {
  plan: Plan;
  tasks?: Task[];
}

export function PlanProgress({ plan, tasks }: Props) {
  const t = useTheme();
  const STATUS_COLORS: Record<PlanStepStatus, string> = {
    done: t.success,
    active: t.brand,
    pending: t.textMuted,
    skipped: t.textDim,
  };
  const done = plan.steps.filter((s) => s.status === "done").length;
  const allDone = done === plan.steps.length;
  const hasTasks = tasks && tasks.length > 0;

  // Show a smart window: center on the active step, or show all if they fit
  let visibleSteps = plan.steps;
  let hiddenBefore = 0;
  let hiddenAfter = 0;

  if (plan.steps.length > MAX_VISIBLE && !allDone) {
    const activeIdx = plan.steps.findIndex((s) => s.status === "active");
    const centerIdx = activeIdx >= 0 ? activeIdx : done;
    const halfWindow = Math.floor(MAX_VISIBLE / 2);
    let start = Math.max(0, centerIdx - halfWindow);
    let end = start + MAX_VISIBLE;
    if (end > plan.steps.length) {
      end = plan.steps.length;
      start = Math.max(0, end - MAX_VISIBLE);
    }
    visibleSteps = plan.steps.slice(start, end);
    hiddenBefore = start;
    hiddenAfter = plan.steps.length - end;
  }

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      border={true}
      borderColor={allDone ? t.success : t.brandAlt}
      paddingX={1}
      width="100%"
    >
      <box gap={1} flexDirection="row">
        <text fg={allDone ? t.success : t.brandAlt} attributes={TextAttributes.BOLD}>
          {icon("plan")} {plan.title}
        </text>
        <text fg={t.textMuted}>
          {String(done)}/{String(plan.steps.length)}
        </text>
      </box>
      {hiddenBefore > 0 && <text fg={t.textDim}>{String(hiddenBefore)} completed above</text>}
      {visibleSteps.map((step) => (
        <box key={step.id} flexDirection="column">
          <box gap={1} flexDirection="row">
            {step.status === "active" ? (
              <Spinner />
            ) : (
              <text fg={STATUS_COLORS[step.status]}>{STATUS_ICONS[step.status]()}</text>
            )}
            <text
              fg={step.status === "active" ? t.textPrimary : STATUS_COLORS[step.status]}
              attributes={step.status === "active" ? TextAttributes.BOLD : undefined}
            >
              {step.label}
            </text>
          </box>
          {step.status === "active" &&
            hasTasks &&
            (() => {
              const { startedAt } = step;
              const stepTasks = startedAt ? tasks.filter((t) => t.created >= startedAt) : tasks;
              return stepTasks.length > 0 ? <TaskList tasks={stepTasks} nested /> : null;
            })()}
        </box>
      ))}
      {hiddenAfter > 0 && <text fg={t.textDim}>{String(hiddenAfter)} more pending</text>}
    </box>
  );
}

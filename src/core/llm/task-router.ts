import type { TaskRouter } from "../../types/index.js";

type TaskType = "coding" | "exploration" | "webSearch" | "compact" | "default";

/**
 * Resolve which model ID to use for a given task type.
 * Used for subagent routing (compact, etc.) — NOT for the main Baked model.
 * Falls back: taskRouter[taskType] → taskRouter.default → activeModel.
 */
export function resolveTaskModel(
  taskType: TaskType,
  taskRouter: TaskRouter | undefined,
  activeModel: string,
): string {
  if (!taskRouter) return activeModel;
  const specific = taskRouter[taskType];
  if (specific) return specific;
  return taskRouter.default ?? activeModel;
}

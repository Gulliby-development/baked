import type { ToolResult } from "../../types/index.js";

type TaskStatus = "pending" | "in-progress" | "done" | "blocked";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  created: number;
  updated: number;
}

type TaskListAction = "add" | "update" | "remove" | "list" | "clear";

interface TaskListArgs {
  action: TaskListAction;
  title?: string;
  titles?: string[];
  id?: number;
  status?: TaskStatus;
  tabId?: string;
}

type TaskChangeListener = (tasks: Task[]) => void;

interface TaskScope {
  tasks: Map<number, Task>;
  nextId: number;
  listeners: Set<TaskChangeListener>;
}

const scopes = new Map<string, TaskScope>();

let activeTabId: string | null = null;

export function setActiveTaskTab(tabId: string): void {
  activeTabId = tabId;
}

export function getActiveTaskTab(): string | null {
  return activeTabId;
}

function getScope(tabId?: string): TaskScope {
  const id = tabId ?? activeTabId ?? "_default";
  let scope = scopes.get(id);
  if (!scope) {
    scope = { tasks: new Map(), nextId: 1, listeners: new Set() };
    scopes.set(id, scope);
  }
  return scope;
}

function notify(scope: TaskScope): void {
  const snapshot = Array.from(scope.tasks.values());
  for (const fn of scope.listeners) fn(snapshot);
}

export function onTaskChange(fn: TaskChangeListener, tabId?: string): () => void {
  const scope = getScope(tabId);
  scope.listeners.add(fn);
  return () => scope.listeners.delete(fn);
}

export function renderTaskList(tabId?: string): string | null {
  const scope = getScope(tabId);
  if (scope.tasks.size === 0) return null;

  const statusIcon: Record<TaskStatus, string> = {
    pending: "○",
    "in-progress": "◐",
    done: "●",
    blocked: "✗",
  };

  const lines = ["[task list — reference only, do not acknowledge or narrate]", "## Active Tasks"];
  for (const t of scope.tasks.values()) {
    lines.push(`${statusIcon[t.status]} [${String(t.id)}] ${t.title} (${t.status})`);
  }
  return lines.join("\n");
}

export function clearTasks(tabId?: string): void {
  const scope = getScope(tabId);
  scope.tasks.clear();
  scope.nextId = 1;
  notify(scope);
}

export function resetInProgressTasks(tabId?: string): void {
  const scope = getScope(tabId);
  let changed = false;
  for (const task of scope.tasks.values()) {
    if (task.status === "in-progress") {
      task.status = "pending";
      task.updated = Date.now();
      changed = true;
    }
  }
  if (changed) notify(scope);
}

export function completeInProgressTasks(tabId?: string): void {
  const scope = getScope(tabId);
  let changed = false;
  for (const task of scope.tasks.values()) {
    if (task.status === "in-progress") {
      task.status = "done";
      task.updated = Date.now();
      changed = true;
    }
  }
  if (changed) notify(scope);
}

export function disposeTaskScope(tabId: string): void {
  const scope = scopes.get(tabId);
  if (scope) {
    scope.tasks.clear();
    scope.listeners.clear();
    scopes.delete(tabId);
  }
}

export const taskListTool = {
  name: "task_list",
  description: "Session task scratchpad. Actions: add, update, remove, list, clear.",
  execute: async (args: TaskListArgs): Promise<ToolResult> => {
    const scope = getScope(args.tabId);
    try {
      switch (args.action) {
        case "add": {
          const titlesToAdd = args.titles ?? (args.title ? [args.title] : []);
          if (titlesToAdd.length === 0) {
            return {
              success: false,
              output: "title or titles required for add",
              error: "missing title",
            };
          }
          const added: string[] = [];
          const now = Date.now();
          for (const title of titlesToAdd) {
            const id = scope.nextId++;
            scope.tasks.set(id, {
              id,
              title,
              status: args.status ?? "pending",
              created: now,
              updated: now,
            });
            added.push(`#${String(id)} ${title}`);
          }
          notify(scope);
          return {
            success: true,
            output:
              added.length === 1
                ? `Task ${added[0]} added`
                : `${String(added.length)} tasks added:\n${added.join("\n")}`,
          };
        }

        case "update": {
          if (!args.id) {
            return { success: false, output: "id is required for update", error: "missing id" };
          }
          const task = scope.tasks.get(args.id);
          if (!task) {
            return {
              success: false,
              output: `Task #${String(args.id)} not found`,
              error: "not found",
            };
          }
          if (args.status) task.status = args.status;
          if (args.title) task.title = args.title;
          task.updated = Date.now();
          notify(scope);
          return {
            success: true,
            output: `Task #${String(task.id)}: ${task.title} → ${task.status}`,
          };
        }

        case "remove": {
          if (!args.id) {
            return { success: false, output: "id is required for remove", error: "missing id" };
          }
          const existed = scope.tasks.delete(args.id);
          if (!existed) {
            return {
              success: false,
              output: `Task #${String(args.id)} not found`,
              error: "not found",
            };
          }
          notify(scope);
          return { success: true, output: `Task #${String(args.id)} removed` };
        }

        case "list": {
          if (scope.tasks.size === 0) {
            return { success: true, output: "No tasks." };
          }
          const lines: string[] = [];
          for (const t of scope.tasks.values()) {
            lines.push(`#${String(t.id)} [${t.status}] ${t.title}`);
          }
          return { success: true, output: lines.join("\n") };
        }

        case "clear": {
          const count = scope.tasks.size;
          scope.tasks.clear();
          notify(scope);
          return { success: true, output: `Cleared ${String(count)} task(s).` };
        }

        default: {
          const msg = `Unknown action: ${String(args.action)}. Use: add, update, remove, list, clear.`;
          return { success: false, output: msg, error: msg };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

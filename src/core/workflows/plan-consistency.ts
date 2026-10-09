import { existsSync } from "node:fs";
import { workspacePath } from "../specs/validate.js";
import type { Spec, TaskGraph } from "./schemas.js";

/** Cross-artifact checks that analysis would otherwise spend model rounds on. */
export const PLAN_CONSISTENCY_CHECKS = [
  "every task, requirement and criterion ID named in the plan exists in the task graph or spec",
  "no task creates a file that already exists unless an earlier task deletes it",
  "tasks that write the same path are ordered by dependencies",
  "every read hint exists or is created by the task or an earlier task",
];

function ancestorsOf(graph: TaskGraph, id: string): Set<string> {
  const ancestors = new Set<string>();
  const pending = [...(graph.tasks.find((t) => t.id === id)?.dependsOn ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (ancestors.has(next)) continue;
    ancestors.add(next);
    pending.push(...(graph.tasks.find((t) => t.id === next)?.dependsOn ?? []));
  }
  return ancestors;
}

export function planConsistencyProblems(
  workspace: string,
  spec: Spec,
  plan: string,
  graph: TaskGraph,
): string[] {
  const problems: string[] = [];
  const known = new Set([
    ...graph.tasks.map((t) => t.id),
    ...spec.requirements.map((r) => r.id),
    ...spec.criteria.map((c) => c.id),
  ]);
  const named = new Set(plan.match(/\b(?:T\d{3,6}|(?:FR|NFR|SC|AC)-\d{3,6})\b/g) ?? []);
  for (const id of named)
    if (!known.has(id))
      problems.push(
        `plan names ${id}, which is not in the ${id.startsWith("T") ? "task graph" : "spec"}`,
      );

  const ancestors = new Map(graph.tasks.map((t) => [t.id, ancestorsOf(graph, t.id)]));
  const exists = (path: string): boolean => existsSync(workspacePath(workspace, path));
  for (const task of graph.tasks) {
    const earlier = graph.tasks.filter((t) => ancestors.get(task.id)?.has(t.id));
    for (const write of task.writes) {
      if (
        write.action === "create" &&
        exists(write.path) &&
        !earlier.some((t) => t.writes.some((w) => w.path === write.path && w.action === "delete"))
      )
        problems.push(`${task.id} creates ${write.path}, which already exists; use modify`);
    }
    for (const hint of task.readHints) {
      if (
        !exists(hint) &&
        ![task, ...earlier].some((t) =>
          t.writes.some((w) => w.path === hint && w.action === "create"),
        )
      )
        problems.push(`${task.id} read hint ${hint} does not exist and no earlier task creates it`);
    }
  }
  for (const [index, task] of graph.tasks.entries())
    for (const other of graph.tasks.slice(index + 1)) {
      const shared = task.writes.find((w) => other.writes.some((o) => o.path === w.path));
      if (
        shared &&
        !ancestors.get(task.id)?.has(other.id) &&
        !ancestors.get(other.id)?.has(task.id)
      )
        problems.push(
          `${task.id} and ${other.id} both write ${shared.path} without a dependency between them`,
        );
    }
  return problems;
}

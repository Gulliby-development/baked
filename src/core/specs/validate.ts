import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkflowFault } from "../workflows/errors.js";
import {
  RelativePath,
  type Spec,
  type TaskGraph,
  validateTaskGraph,
} from "../workflows/schemas.js";
import { hashBytes, hashJson } from "./hash.js";

/**
 * A path under the root to read, not write. A worktree's `node_modules` links to the working
 * copy's (a junction on Windows), so a dependency installed there resolves outside the worktree;
 * it is read in place. Every other path must stay inside the root.
 */
export function readablePath(root: string, path: string): string {
  const parts = path.split(/[\\/]/);
  if (parts[0] === "node_modules" && !parts.includes("..")) return join(root, path);
  return workspacePath(root, path);
}

export function workspacePath(workspace: string, path: string): string {
  RelativePath.parse(path);
  if (
    path
      .split("/")
      .some(
        (part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new WorkflowFault("CAPABILITY_DENIED", `Nonportable path alias: ${path}`);
  const root = realpathSync(workspace);
  const target = resolve(root, path);
  let existing = target;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  const rel = relative(root, realpathSync(existing));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new WorkflowFault("CAPABILITY_DENIED", `Path escapes workspace: ${path}`);
  // Do not follow even internal links during mutation or import publication.
  for (let part = target; part !== root && part !== dirname(part); part = dirname(part)) {
    try {
      if (lstatSync(part).isSymbolicLink())
        throw new WorkflowFault("CAPABILITY_DENIED", `Symlink path: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

export function validatePackage(
  workspace: string,
  spec: Spec,
  plan: string,
  graph: TaskGraph,
): void {
  const errors = validateTaskGraph(spec, graph);
  for (const section of ["Context", "Decisions", "Components", "Data", "Verification", "Risks"]) {
    if (!new RegExp(`^#{1,6}\\s+${section}\\s*$`, "im").test(plan))
      errors.push(`plan is missing ${section} section`);
  }
  if (!/DEC-\d{3}/.test(plan) || !spec.requirements.some((r) => plan.includes(r.id)))
    errors.push("plan decisions must reference requirements");
  if (hashJson(spec) !== graph.specHash || hashBytes(plan) !== graph.planHash)
    errors.push("spec/plan hash mismatch");
  for (const task of graph.tasks) {
    const ancestors = new Set<string>();
    const visit = (id: string): void => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      for (const dep of graph.tasks.find((t) => t.id === id)?.dependsOn ?? []) visit(dep);
    };
    for (const dep of task.dependsOn) visit(dep);
    for (const write of task.writes) {
      const path = workspacePath(workspace, write.path);
      if (
        /^(\.baked|baked|specs|\.git)(\/|$)/i.test(write.path) ||
        /(^|\/)(AGENTS\.md|CLAUDE\.md|constitution\.md|\.env(?:\..*)?)$/i.test(write.path)
      )
        errors.push(`protected write ${write.path}`);
      const creator = graph.tasks.some(
        (t) =>
          ancestors.has(t.id) &&
          t.writes.some((w) => w.path === write.path && w.action === "create"),
      );
      if (write.action !== "create" && !existsSync(path) && !creator)
        errors.push(`missing modify/delete target ${write.path}`);
    }
  }
  if (errors.length) throw new WorkflowFault("INVALID_REFERENCE", errors.join("\n"));
}

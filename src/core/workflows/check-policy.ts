import { workspacePath } from "../specs/validate.js";
import { WorkflowFault } from "./errors.js";
import type { RunPolicy, TaskGraph } from "./schemas.js";

export function validateChecks(workspace: string, policy: RunPolicy, graph?: TaskGraph): void {
  if (policy.maxCostUsd !== null)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "A dollar cap requires verified model pricing; maxCostUsd must be null",
    );
  const ids = new Set<string>();
  for (const check of policy.checks) {
    if (ids.has(check.id))
      throw new WorkflowFault("INVALID_DEFINITION", `Duplicate check ID ${check.id}`);
    ids.add(check.id);
    if (check.cwd !== ".") workspacePath(workspace, check.cwd);
    if (
      [check.executable, ...check.args].some((value) => value.includes("\0")) ||
      check.envNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    )
      throw new WorkflowFault("INVALID_DEFINITION", `Invalid process definition ${check.id}`);
    for (const output of check.writes) {
      workspacePath(workspace, output);
      if (
        /^(\.git|\.baked|baked|specs)(\/|$)|(^|\/)(AGENTS\.md|CLAUDE\.md|constitution\.md|package\.json|.*lock.*|tsconfig.*|biome.*|\.env(?:\..*)?)$/i.test(
          output,
        ) ||
        graph?.tasks.some((task) =>
          task.writes.some(
            (w) =>
              w.path.toLowerCase() === output.toLowerCase() ||
              w.path.toLowerCase().startsWith(`${output.toLowerCase()}/`),
          ),
        )
      )
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Generated output overlaps source/configuration: ${output}`,
        );
    }
  }
}

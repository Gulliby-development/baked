import { hasToolHooks } from "../hooks/index.js";
import { deriveTool } from "../tools/tool-utils.js";
import { withWorkspaceMutation } from "./leases.js";

const readOnly = new Set([
  "read",
  "grep",
  "glob",
  "list_dir",
  "navigate",
  "analyze",
  "discover_pattern",
  "bake_find",
  "bake_grep",
  "bake_impact",
  "bake_analyze",
  "bake_query",
  "fetch_page",
  "web_search",
  "baked_help",
]);
export function guardWorkspaceTools<T extends Record<string, unknown>>(
  tools: T,
  workspace: string,
): T {
  const result = { ...tools };
  for (const [name, value] of Object.entries(tools)) {
    const definition = value as { execute?: (...args: unknown[]) => unknown };
    const execute = definition.execute;
    if (!execute) continue;
    const guarded = deriveTool(definition, {
      execute: async (...args: unknown[]) => {
        if (!readOnly.has(name) || hasToolHooks(workspace))
          return withWorkspaceMutation(workspace, async () => execute(...args));
        return execute(...args);
      },
    });
    (result as Record<string, unknown>)[name] = guarded;
  }
  return result;
}

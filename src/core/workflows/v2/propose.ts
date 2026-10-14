import type { AppConfig } from "../../../types/index.js";
import { defaultWorkflowPolicy } from "../defaults.js";
import { proposeWorkflow, type WorkflowProposal } from "../preset-router.js";
import { PolicySchema } from "../schemas.js";
import { type DefinitionSummary, listDefinitions } from "./definitions.js";

/** Every workflow definition of this project, with the policy its configuration sets. */
export function projectDefinitions(workspace: string, config: AppConfig): DefinitionSummary[] {
  const policy = PolicySchema.parse(config.workflows?.policy ?? defaultWorkflowPolicy);
  return listDefinitions(workspace, policy);
}

/** The proposal for a request in this project: only workflows that can start here are proposed. */
export function proposeForWorkspace(
  workspace: string,
  config: AppConfig,
  request: string,
): WorkflowProposal {
  const available = projectDefinitions(workspace, config)
    .filter((d) => !d.problems.length)
    .map((d) => d.id);
  return proposeWorkflow(request, available, config.workflows?.defaultWorkflow ?? "sdd");
}

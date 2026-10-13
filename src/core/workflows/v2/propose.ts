import type { AppConfig } from "../../../types/index.js";
import { defaultWorkflowPolicy } from "../defaults.js";
import { proposeWorkflow, type WorkflowProposal } from "../preset-router.js";
import { PolicySchema } from "../schemas.js";
import { listDefinitions } from "./definitions.js";

/** The proposal for a request in this project: only workflows that can start here are proposed. */
export function proposeForWorkspace(
  workspace: string,
  config: AppConfig,
  request: string,
): WorkflowProposal {
  const policy = PolicySchema.parse(config.workflows?.policy ?? defaultWorkflowPolicy);
  const available = listDefinitions(workspace, policy)
    .filter((d) => !d.problems.length)
    .map((d) => d.id);
  return proposeWorkflow(request, available, config.workflows?.defaultWorkflow ?? "sdd");
}

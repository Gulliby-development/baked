import { WorkflowFault } from "./errors.js";
import type { RunState } from "./schemas.js";
export const terminalStates: readonly RunState[] = ["completed", "failed", "cancelled"];
export function assertMutable(status: RunState): void {
  if (terminalStates.includes(status))
    throw new WorkflowFault(
      "RUN_TERMINAL",
      "Terminal runs are historical. Fork this run to continue.",
    );
}

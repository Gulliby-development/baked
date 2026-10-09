import type { WorkflowErrorCode } from "./schemas.js";

export class WorkflowFault extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: WorkflowErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkflowFault";
    this.retryable = ["WORKSPACE_BUSY", "REVISION_CONFLICT"].includes(code);
  }
}

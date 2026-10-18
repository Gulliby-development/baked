import type { RecoveryAdvice } from "./remedies.js";
import type { WorkflowErrorCode } from "./schemas.js";

export class WorkflowFault extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: WorkflowErrorCode,
    message: string | RecoveryAdvice,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(typeof message === "string" ? message : message.message);
    if (typeof message !== "string") this.details.recovery = message;
    this.name = "WorkflowFault";
    this.retryable = ["WORKSPACE_BUSY", "REVISION_CONFLICT"].includes(code);
  }
}

export interface AgentExecutionResult {
  execution: "completed" | "failed" | "cancelled" | "interrupted";
  taskOutcome: "implemented" | "already_satisfied" | "reported" | "blocked" | "failed";
  summary: string;
  partialOutput: string | null;
  effectIds: string[];
  usage: { input: number; output: number } | null;
  usageComplete: boolean;
}

export function opensDependency(result: AgentExecutionResult): boolean {
  return (
    result.execution === "completed" &&
    ["implemented", "already_satisfied", "reported"].includes(result.taskOutcome)
  );
}

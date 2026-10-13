import type { ToolResult } from "../../types/index.js";

/** The `ToolResult` a chat message records for a tool's output, whatever shape the tool returned. */
export function toolResultOf(output: unknown): ToolResult {
  if (output && typeof output === "object" && "success" in output) {
    const r = output as Partial<ToolResult> & { success: boolean };
    return {
      success: r.success,
      output: typeof r.output === "string" ? r.output : "",
      ...(r.error ? { error: r.error } : {}),
      ...(r.filesEdited ? { filesEdited: r.filesEdited } : {}),
    };
  }
  if (output && typeof output === "object" && "filesEdited" in output) {
    const d = output as { filesEdited?: string[] };
    return {
      success: true,
      output: JSON.stringify(output),
      ...(d.filesEdited ? { filesEdited: d.filesEdited } : {}),
    };
  }
  return { success: true, output: typeof output === "string" ? output : JSON.stringify(output) };
}

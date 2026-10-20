import { canonical } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import { recoveryAdvice } from "./remedies.js";
import type { WorkflowStore } from "./store.js";

/** Where the stack of a `host_error` stop is kept, next to its diagnostic. */
export const HOST_ERROR_PREFIX = "host-errors/";

/**
 * A run stopped by an exception of BAKED's own code (#1653), not by a model's output: the stack is
 * kept for a report, and the advice is a plain resume (the fault may be a passing one), then an
 * export to report it. Nothing is added to the agents' prompt, since no agent made the mistake.
 */
export function recordHostError(
  store: WorkflowStore,
  runId: string,
  diagnosticId: string,
  fault: unknown,
): void {
  const stack =
    fault instanceof Error ? (fault.stack ?? `${fault.name}: ${fault.message}`) : String(fault);
  store.artifact(runId, "diagnostic", `${HOST_ERROR_PREFIX}${diagnosticId}.txt`, stack);
  store.artifact(
    runId,
    "recovery",
    `recovery/advice-${diagnosticId}.json`,
    canonical(
      recoveryAdvice(
        `BAKED failed internally; this is not a model problem. Resume the run once (\`baked workflow resume ${runId}\`). If it stops the same way, export it (\`baked workflow export ${runId} --destination DIR\`) and report the export with the stack in ${HOST_ERROR_PREFIX}${diagnosticId}.txt`,
        "BAKED failed internally; this is not a model problem. Resume once; if it stops the same way, export the run and report it.",
        { action: "resume", runId },
        { action: "cancel", runId },
      ),
    ),
  );
}

/** A SQLite failure is a host fault, never a model's invalid output. */
export function isStoreError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof WorkflowFault) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === "SQLiteError" || (typeof code === "string" && code.startsWith("SQLITE_"));
}

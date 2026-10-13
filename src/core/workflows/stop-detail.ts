import type { WorkflowStore } from "./store.js";

/**
 * What stopped a blocked or failed run: the error the runtime recorded when it stopped it, cut to
 * its last 2000 characters, or null when it recorded none (a budget or a pause says enough).
 */
export function stopDetail(store: WorkflowStore, runId: string): string | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "diagnostic" && a.logical_path.startsWith("errors/"))
    .at(-1);
  if (!latest) return null;
  const text = store.readArtifact(runId, latest.id).trim();
  return text.length > 2000 ? `…${text.slice(-2000)}` : text || null;
}

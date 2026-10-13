import type { WorkflowStore } from "./store.js";

/**
 * What stopped a blocked or failed run: the error the runtime recorded when it stopped it, cut to
 * its last 2000 characters, or null when it recorded none (a pause says enough). A run stopped on
 * its budget also names the tasks it left unfinished, so a status shows how far it got (#974).
 */
export function stopDetail(store: WorkflowStore, runId: string): string | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "diagnostic" && a.logical_path.startsWith("errors/"))
    .at(-1);
  const text = latest ? store.readArtifact(runId, latest.id).trim() : "";
  const error = text.length > 2000 ? `…${text.slice(-2000)}` : text;
  const left = store.run(runId).reason === "budget_exhausted" ? remainingTasks(store, runId) : "";
  return [error, left].filter(Boolean).join("\n") || null;
}

function remainingTasks(store: WorkflowStore, runId: string): string {
  const tasks = store.tasks(runId).filter((t) => t.status !== "invalidated");
  const open = tasks.filter((t) => t.status !== "implemented" && t.status !== "verified");
  if (!tasks.length || !open.length) return "";
  const names = open.slice(0, 10).map((t) => t.id);
  const more = open.length > names.length ? `, and ${String(open.length - names.length)} more` : "";
  return `Stopped on the budget with ${String(open.length)} of ${String(tasks.length)} tasks unfinished: ${names.join(", ")}${more}.`;
}

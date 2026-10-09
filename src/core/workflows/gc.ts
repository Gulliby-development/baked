import type { WorkflowStore } from "./store.js";
export function collectWorkflowGarbage(store: WorkflowStore, before: string, dryRun = true) {
  return store.collectGarbage(before, dryRun);
}

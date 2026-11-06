import type { WorkflowStore } from "./store.js";

/**
 * The `hostPredicate` a refusal of acceptance carries in its fault details (#2879): the run met
 * a host predicate it does not satisfy, not a model's invalid output.
 */
export const ACCEPTANCE_REFUSAL = "acceptance";

/** Where the scheduler records that a stop's diagnostic is an acceptance refusal, by its id. */
export const ACCEPTANCE_REFUSALS_DIR = "refusals/acceptance/";

/**
 * Whether the run's latest diagnostic is a refusal of acceptance. Such a stop keeps its own advice
 * (the remedy of its predicate): the repeat guard of invalid outputs, whose advice switches the
 * stage's model, does not apply to it, since no model reads a host predicate (#2879).
 */
export function acceptanceRefused(store: WorkflowStore, runId: string): boolean {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "diagnostic" && a.logical_path.startsWith("errors/"))
    .at(-1);
  return !!latest && !!store.latestArtifact(runId, `${ACCEPTANCE_REFUSALS_DIR}${latest.id}.json`);
}

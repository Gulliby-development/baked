import { hashJson } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState } from "./types.js";

/** The accepted contract of a feature: the spec of its newest approved run. */
export interface AcceptedContract {
  featureId: string;
  runId: string;
  contractHash: string;
  artifactHash: string;
  /** The run completed with current verification, so dependents may build on it. */
  completed: boolean;
}

/**
 * The newest run of a feature that has an approved spec, or null when the feature has none yet.
 * This is what readiness of a dependent feature is decided by.
 */
export function acceptedContract(store: WorkflowStore, featureId: string): AcceptedContract | null {
  let cursor: string | undefined;
  do {
    const page = store.list(100, featureId, undefined, cursor);
    for (const run of page.items) {
      const upstream = store.state(run.runId);
      if (!upstream.approvalRoot || !upstream.spec) continue;
      const artifact = store.latestArtifact(run.runId, "spec.json");
      if (!artifact)
        throw new WorkflowFault("ARTIFACT_MISSING", "Upstream accepted spec artifact missing");
      store.readArtifact(run.runId, artifact.id);
      return {
        featureId,
        runId: run.runId,
        contractHash: hashJson(upstream.spec),
        artifactHash: artifact.content_hash,
        completed: run.status === "completed" && run.verificationState === "current",
      };
    }
    cursor = page.cursor;
  } while (cursor);
  return null;
}

export function dependencyContracts(store: WorkflowStore, state: RuntimeState) {
  return (state.spec?.dependencies ?? []).map((dependency) => {
    const accepted = acceptedContract(store, dependency.featureId);
    if (!accepted)
      throw new WorkflowFault(
        "INVALID_REFERENCE",
        `No accepted dependency contract: ${dependency.featureId}`,
      );
    if (accepted.contractHash !== dependency.contractHash)
      throw new WorkflowFault("INPUT_CHANGED", `Upstream contract changed: ${dependency.featureId}`);
    return {
      featureId: dependency.featureId,
      contractHash: dependency.contractHash,
      artifactHash: accepted.artifactHash,
      runId: accepted.runId,
      completed: accepted.completed,
    };
  });
}

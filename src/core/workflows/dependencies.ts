import { hashJson } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState } from "./types.js";

export function dependencyContracts(store: WorkflowStore, state: RuntimeState) {
  return (state.spec?.dependencies ?? []).map((dependency) => {
    let cursor: string | undefined;
    do {
      const page = store.list(100, dependency.featureId, cursor);
      for (const run of page.items) {
        const upstream = store.state(run.runId);
        if (!upstream.approvalRoot || !upstream.spec) continue;
        if (hashJson(upstream.spec) !== dependency.contractHash)
          throw new WorkflowFault(
            "INPUT_CHANGED",
            `Upstream contract changed: ${dependency.featureId}`,
          );
        const artifact = store.latestArtifact(run.runId, "spec.json");
        if (!artifact)
          throw new WorkflowFault("ARTIFACT_MISSING", "Upstream accepted spec artifact missing");
        store.readArtifact(run.runId, artifact.id);
        return {
          featureId: dependency.featureId,
          contractHash: dependency.contractHash,
          artifactHash: artifact.content_hash,
          runId: run.runId,
          completed: run.status === "completed" && run.verificationState === "current",
        };
      }
      cursor = page.cursor;
    } while (cursor);
    throw new WorkflowFault(
      "INVALID_REFERENCE",
      `No accepted dependency contract: ${dependency.featureId}`,
    );
  });
}

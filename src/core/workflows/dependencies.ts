import { matchGlob } from "../platform/index.js";
import { hashJson } from "../specs/hash.js";
import { normalizePath } from "../verification/deliverable-paths.js";
import { WorkflowFault } from "./errors.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState } from "./types.js";
import { HOST_SPEC_OUTCOME } from "./v2/runtime.js";

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
      // A host-made spec no run recorded is the request restated, not a contract (#1750).
      if (!artifact && upstream.spec.outcome === HOST_SPEC_OUTCOME) continue;
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

/**
 * Whether a run's spec is a contract others can pin: a spec stage wrote it, or the run recorded
 * its host-made spec as spec.json. A light run started without a contract only restates its
 * request (#1750).
 */
export function providesContract(store: WorkflowStore, runId: string): boolean {
  const spec = store.state(runId).spec;
  if (!spec) return false;
  return spec.outcome !== HOST_SPEC_OUTCOME || store.latestArtifact(runId, "spec.json") !== null;
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
      throw new WorkflowFault(
        "INPUT_CHANGED",
        `Upstream contract changed: ${dependency.featureId}`,
      );
    return {
      featureId: dependency.featureId,
      contractHash: dependency.contractHash,
      artifactHash: accepted.artifactHash,
      runId: accepted.runId,
      completed: accepted.completed,
    };
  });
}

/**
 * A request a planned-ahead run (#1834) waits on until the initiative releases it onto its
 * dependencies' results: the host decides it, so it is never a person's to answer.
 */
export function isHostRelease(request: { kind: string; body_json: string }): boolean {
  if (request.kind !== "manual_evidence") return false;
  return (JSON.parse(request.body_json) as { hostRelease?: unknown }).hostRelease === true;
}

/**
 * Paths a planned-ahead run (#1834) may name in a read hint or `reference` although its
 * provisional base may lack them: the boundary paths of every upstream feature it pins, finished
 * or not. Their results are in its worktree before its tasks start, so a plan that reads them is
 * what the run is asked for (R60 wheeltags: 7 of 7 planned-ahead features had their first plan
 * refused for such read hints, #1932). A feature accepted after the provisional base was fixed is
 * on neither that base nor a set of unfinished features until the release (R61 manlens, #1946); one
 * already on the base has its files there anyway. Nothing for a run that is not held, so a write
 * of another feature's file is still refused. Every check of a plan against the workspace asks it.
 */
export function pathsExistLater(state: RuntimeState): (path: string) => boolean {
  const bounds = state.initiativeBounds;
  if (!state.planAhead || state.planAhead.released || !bounds) return () => false;
  // A run's feature id is `<initiative>_<feature>`, and a feature key has no underscore.
  const upstream = new Set(
    (state.hostDependencies ?? state.spec?.dependencies ?? []).map((dependency) =>
      dependency.featureId.slice(dependency.featureId.lastIndexOf("_") + 1),
    ),
  );
  const patterns = bounds.features
    .filter((feature) => feature.id !== bounds.featureId && upstream.has(feature.id))
    .flatMap((feature) => feature.paths.map(normalizePath));
  return (path) => patterns.some((pattern) => matchGlob(normalizePath(path), pattern));
}

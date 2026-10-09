import { hashJson } from "../specs/hash.js";
import { WorkflowFault } from "../workflows/errors.js";
import { CorrectionSchema, type RunPolicy } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RuntimeState } from "../workflows/types.js";
import { correctionAuthorized } from "./convergence.js";
import { validateEvidence } from "./evidence.js";
import { requiresSecurityReview } from "./findings.js";

export function assertAcceptance(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
): void {
  if (
    !state.spec ||
    !state.graph ||
    !state.rootGraph ||
    !state.snapshotId ||
    !state.convergence ||
    !state.approvalRoot ||
    store.run(runId).approval_digest !== state.approvalRoot
  )
    throw new WorkflowFault("STALE_DECISION", "Missing accepted artifacts or convergence");
  let graphHash = hashJson(state.rootGraph);
  const reconstructed = structuredClone(state.rootGraph);
  for (const correctionHash of state.correctionHashes) {
    const artifact = store
      .artifacts(runId)
      .find((a) => a.kind === "correction" && a.content_hash === correctionHash);
    if (!artifact) throw new WorkflowFault("ARTIFACT_MISSING", "Correction chain is incomplete");
    const correction = CorrectionSchema.parse(JSON.parse(store.readArtifact(runId, artifact.id)));
    if (correction.parentDigest !== state.approvalRoot || correction.parentGraphHash !== graphHash)
      throw new WorkflowFault("STALE_DECISION", "Invalid correction chain");
    const additions = correction.taskIds.map((id) => state.graph?.tasks.find((t) => t.id === id));
    for (const task of additions) {
      if (
        !task ||
        !correctionAuthorized(task, state.rootGraph) ||
        reconstructed.tasks.some((t) => t.id === task.id) ||
        task.findingIds.some((id) => !correction.findingIds.includes(id))
      )
        throw new WorkflowFault("STALE_DECISION", "Correction exceeds the approved authority");
      reconstructed.tasks.push(task);
    }
    if (hashJson(reconstructed) !== correction.newGraphHash)
      throw new WorkflowFault("STALE_DECISION", "Correction changed existing tasks");
    graphHash = correction.newGraphHash;
  }
  if (graphHash !== hashJson(state.graph))
    throw new WorkflowFault("STALE_DECISION", "Graph has no valid authorization chain");
  for (const task of state.graph.tasks) {
    const row = store.tasks(runId).find((r) => r.id === task.id);
    if (!row || !["implemented", "verified"].includes(row.status))
      throw new WorkflowFault("OUTPUT_INVALID", `Task ${task.id} is not implemented`);
  }
  for (const check of policy.checks.filter((c) => c.required)) {
    const last = store
      .checks(runId)
      .filter((c) => c.check_id === check.id && c.snapshot_id === state.snapshotId)
      .at(-1);
    if (last?.status !== "passed" || last.validity !== "current")
      throw new WorkflowFault(
        "OUTPUT_INVALID",
        `Required check ${check.id} has not passed on current sources`,
      );
    validateEvidence(store, runId, state.snapshotId, [last.evidence_id]);
  }
  const dimensions = [
    "correctness",
    ...(requiresSecurityReview(
      state.graph.tasks.flatMap((t) => t.writes.map((w) => w.path)),
      policy.forceSecurityReview,
    )
      ? ["security"]
      : []),
    ...(policy.reviewProfiles.language ? ["language"] : []),
  ];
  for (const dimension of dimensions)
    if (!state.reviews[dimension] || state.reviews[dimension]?.verdict === "inconclusive")
      throw new WorkflowFault("OUTPUT_INVALID", `Required ${dimension} review did not pass`);
  if (store.requests(runId).some((request) => request.status === "pending"))
    throw new WorkflowFault("STALE_DECISION", "Pending decisions remain");
  if (store.findings(runId).some((f) => !["refuted", "resolved"].includes(f.status)))
    throw new WorkflowFault("OUTPUT_INVALID", "Unresolved findings remain");
  for (const criterion of state.spec.criteria) {
    const result = state.convergence.coverage.find((c) => c.criterionId === criterion.id);
    if (
      criterion.method === "post-release" &&
      result?.verdict === "deferred" &&
      state.deferredCriteria.includes(criterion.id)
    )
      continue;
    if (criterion.method === "manual") {
      const manual = state.manualCriteria[criterion.id];
      if (!manual || manual.snapshotId !== state.snapshotId)
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `Missing trusted manual evidence for ${criterion.id}`,
        );
      validateEvidence(store, runId, state.snapshotId, [manual.evidenceId]);
    } else if (result?.verdict !== "pass")
      throw new WorkflowFault("OUTPUT_INVALID", `Criterion ${criterion.id} did not pass`);
    if (result?.verdict === "pass")
      validateEvidence(store, runId, state.snapshotId, result.evidenceIds);
  }
}

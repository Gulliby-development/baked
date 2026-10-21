import { hashJson } from "../specs/hash.js";
import { WorkflowFault } from "../workflows/errors.js";
import { LANGUAGE_REVIEW_PROFILE, touchesLanguageFiles } from "../workflows/language.js";
import { CorrectionSchema, type RunPolicy } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import { hasTaskGate } from "../workflows/task-graph.js";
import type { RuntimeState } from "../workflows/types.js";
import { blocksRun } from "../workflows/v2/acceptance.js";
import {
  effectiveMode,
  type Gate,
  type Stage,
  type WorkflowV2,
} from "../workflows/v2/definition.js";
import { correctionAuthorized } from "./convergence.js";
import { limitedCriteria } from "./convergence-stop.js";
import { validateEvidence } from "./evidence.js";
import { requiresSecurityReview } from "./findings.js";
import { deferredOwners } from "./initiative-ownership.js";

/**
 * The review dimensions of a v1 run: correctness, security when the change triggers it, and
 * language. The language reviewer the host added for the project's manifests runs only when the
 * change touches that language's files; one the policy names always runs.
 */
export function v1ReviewDimensions(
  state: RuntimeState,
  policy: RunPolicy,
): (keyof RunPolicy["reviewProfiles"])[] {
  const paths = state.graph?.tasks.flatMap((t) => t.writes.map((w) => w.path)) ?? [];
  const language = policy.reviewProfiles.language;
  return [
    "correctness",
    ...(requiresSecurityReview(paths, policy.forceSecurityReview) ? ["security" as const] : []),
    ...(language &&
    (language !== LANGUAGE_REVIEW_PROFILE ||
      touchesLanguageFiles([...paths, ...(state.diff?.files ?? [])]))
      ? ["language" as const]
      : []),
  ];
}

export function assertAcceptance(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
): void {
  acceptance(store, runId, state, {
    convergence: true,
    checks: policy.checks.filter((c) => c.required).map((c) => c.id),
    taskChecks: [],
    reviews: v1ReviewDimensions(state, policy),
  });
}

/**
 * Acceptance of a v2 run that writes files: the v1 predicate over what the definition produces.
 * Without a reflection stage the criteria are covered by the required command gates (automated)
 * and trusted manual evidence (manual); without a review stage no review is required. A gate the
 * run skipped by its own condition is not required.
 */
export function assertAcceptanceV2(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
  definition: WorkflowV2,
  gates: readonly Gate[],
): void {
  const required = (stage: Stage) =>
    stage.type === "check" || stage.type === "review"
      ? stage.gates.filter((binding) => {
          const gate = gates.find((g) => g.id === binding.gateId);
          return gate !== undefined && effectiveMode(binding, gate) === "required";
        })
      : [];
  const checks = definition.stages
    .filter((s) => s.type === "check")
    .flatMap((s) => required(s).map((b) => b.gateId));
  const reviews = definition.stages
    .filter((s) => s.type === "review")
    .flatMap((s) => required(s).map((b) => b.gateId))
    .filter((id) => state.gateResults[id]?.status !== "skipped");
  acceptance(store, runId, state, {
    convergence: definition.stages.some((s) => s.type === "reflection"),
    checks: [...new Set(checks)],
    taskChecks: policy.checks.filter((c) => c.required && c.scope === "task").map((c) => c.id),
    reviews: [...new Set(reviews)],
  });
}

function acceptance(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  required: { convergence: boolean; checks: string[]; taskChecks: string[]; reviews: string[] },
): void {
  if (
    !state.spec ||
    !state.graph ||
    !state.rootGraph ||
    !state.snapshotId ||
    (required.convergence && !state.convergence) ||
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
  // A static check that failed only on debt from before the run under `staticBaseline:
  // "relative"` (#1222), and a test check that collected no test in a run whose plan writes none
  // (#1864), counts as passed; the checks stage recorded which run that was.
  const debt = new Set(
    store
      .artifacts(runId)
      .filter(
        (a) =>
          a.logical_path.startsWith("checks/baseline-debt/") ||
          a.logical_path.startsWith("checks/no-tests/"),
      )
      .map(
        (a) => (JSON.parse(store.readArtifact(runId, a.id)) as { evidenceId: string }).evidenceId,
      ),
  );
  for (const checkId of required.checks) {
    const last = store
      .checks(runId)
      .filter((c) => c.check_id === checkId && c.snapshot_id === state.snapshotId)
      .at(-1);
    const passed =
      last?.status === "passed" || (last?.status === "failed" && debt.has(last.evidence_id));
    if (!last || !passed || last.validity !== "current")
      throw new WorkflowFault(
        "OUTPUT_INVALID",
        `Required check ${checkId} has not passed on current sources`,
      );
    validateEvidence(store, runId, state.snapshotId, [last.evidence_id]);
  }
  for (const task of state.graph.tasks)
    if (task.checkIds.some((id) => required.taskChecks.includes(id))) {
      const row = store.tasks(runId).find((r) => r.id === task.id);
      if (!row || !hasTaskGate(row, state.taskGates))
        throw new WorkflowFault("OUTPUT_INVALID", `Task checks of ${task.id} have not passed`);
    }
  for (const key of required.reviews)
    if (!state.reviews[key] || state.reviews[key]?.verdict === "inconclusive")
      throw new WorkflowFault("OUTPUT_INVALID", `Required ${key} review did not pass`);
  if (store.requests(runId).some(blocksRun))
    throw new WorkflowFault("STALE_DECISION", "Pending decisions remain");
  if (store.findings(runId).some((f) => !["refuted", "resolved"].includes(f.status)))
    throw new WorkflowFault("OUTPUT_INVALID", "Unresolved findings remain");
  const convergence = state.convergence;
  const limited = limitedCriteria(state);
  for (const criterion of state.spec.criteria) {
    if (!convergence) {
      // Without a reflection stage the required checks cover the automated criteria.
      if (criterion.method === "manual" && limited.has(criterion.id)) continue;
      if (criterion.method === "manual") {
        const manual = state.manualCriteria[criterion.id];
        if (!manual || manual.snapshotId !== state.snapshotId)
          throw new WorkflowFault(
            "OUTPUT_INVALID",
            `Missing trusted manual evidence for ${criterion.id}`,
          );
        validateEvidence(store, runId, state.snapshotId, [manual.evidenceId]);
      } else if (criterion.method === "automated" && required.checks.length === 0)
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `Criterion ${criterion.id} is automated but no required check covers it`,
        );
      else if (
        criterion.method === "post-release" &&
        !state.deferredCriteria.includes(criterion.id)
      )
        throw new WorkflowFault("OUTPUT_INVALID", `Criterion ${criterion.id} was not deferred`);
      continue;
    }
    const result = convergence.coverage.find((c) => c.criterionId === criterion.id);
    if (
      result?.verdict === "deferred" &&
      deferredOwners(convergence, state.initiativeBounds).has(criterion.id)
    )
      continue;
    if (
      criterion.method === "post-release" &&
      result?.verdict === "deferred" &&
      state.deferredCriteria.includes(criterion.id)
    )
      continue;
    if (criterion.method === "manual") {
      // A criterion the person could not confirm was accepted as a known limitation.
      if (limited.has(criterion.id)) continue;
      const manual = state.manualCriteria[criterion.id];
      if (!manual || manual.snapshotId !== state.snapshotId)
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `Missing trusted manual evidence for ${criterion.id}`,
        );
      validateEvidence(store, runId, state.snapshotId, [manual.evidenceId]);
    } else if (result?.verdict !== "pass" && !limited.has(criterion.id))
      // A known limitation: convergence stopped with this criterion's findings open and a
      // person (or the assume rule) accepted them; the run report lists them.
      throw new WorkflowFault("OUTPUT_INVALID", `Criterion ${criterion.id} did not pass`);
    if (result?.verdict === "pass")
      validateEvidence(store, runId, state.snapshotId, result.evidenceIds);
  }
}

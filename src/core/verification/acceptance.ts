import { hashJson } from "../specs/hash.js";
import { widenAuthorized } from "../workflows/corrective-scope.js";
import { applyReleasedCreates } from "../workflows/dependencies.js";
import { WorkflowFault } from "../workflows/errors.js";
import { LANGUAGE_REVIEW_PROFILE, touchesLanguageFiles } from "../workflows/language.js";
import { CorrectionSchema, PolicySchema, type RunPolicy } from "../workflows/schemas.js";
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
import { hostPassedChecks } from "./host-passed.js";
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
  const links = state.correctionHashes.map((correctionHash) => {
    const artifact = store
      .artifacts(runId)
      .find((a) => a.kind === "correction" && a.content_hash === correctionHash);
    if (!artifact) throw new WorkflowFault("ARTIFACT_MISSING", "Correction chain is incomplete");
    return CorrectionSchema.parse(JSON.parse(store.readArtifact(runId, artifact.id)));
  });
  // A corrective added as it was created: the writes later `host-widen` links added are left out
  // here and checked by those links (#2133).
  const widenedLater = (taskId: string, index: number): Set<string> =>
    new Set(
      links
        .slice(index + 1)
        .filter((link) => link.rule === "host-widen")
        .flatMap((link) => link.widened ?? [])
        .filter((w) => w.taskId === taskId)
        .map((w) => w.path),
    );
  let frozen: RunPolicy | undefined;
  for (const [index, correction] of links.entries()) {
    if (correction.parentDigest !== state.approvalRoot || correction.parentGraphHash !== graphHash)
      throw new WorkflowFault("STALE_DECISION", "Invalid correction chain");
    if (correction.rule === "host-release") {
      // A planned-ahead run's release turns planned creates of files it brought in into modifies
      // (#2514): the same tasks and paths, nothing added or widened, each a file the baseline
      // taken on the released base holds.
      const released = correction.released ?? [];
      const next = applyReleasedCreates(reconstructed, released);
      const baselineId = state.manifest.baselineSnapshotId;
      const baseline = (baselineId ? store.snapshotFiles(runId, baselineId) : null) ?? {};
      if (
        !state.planAhead?.released ||
        released.some((r) => !(r.path in baseline)) ||
        released.some(
          (r) =>
            !reconstructed.tasks.some(
              (t) =>
                t.id === r.taskId &&
                t.origin === "planned" &&
                correction.taskIds.includes(t.id) &&
                t.writes.some(
                  (w) => w.path === r.path && w.action === "create" && w.content === undefined,
                ),
            ),
        ) ||
        hashJson(next) !== correction.newGraphHash
      )
        throw new WorkflowFault("STALE_DECISION", "Correction exceeds the approved authority");
      reconstructed.tasks = next.tasks;
      graphHash = correction.newGraphHash;
      continue;
    }
    if (correction.rule === "host-widen") {
      frozen ??= PolicySchema.parse(JSON.parse(store.run(runId).policy_json));
      const policy = frozen;
      for (const write of correction.widened ?? []) {
        const task = reconstructed.tasks.find((t) => t.id === write.taskId);
        if (
          !task ||
          task.origin === "planned" ||
          !correction.taskIds.includes(task.id) ||
          task.writes.some((w) => w.path === write.path) ||
          !widenAuthorized(write.path, state, policy)
        )
          throw new WorkflowFault("STALE_DECISION", "Correction exceeds the approved authority");
        task.writes.push({ path: write.path, action: write.action });
      }
      if (!correction.widened?.length || hashJson(reconstructed) !== correction.newGraphHash)
        throw new WorkflowFault("STALE_DECISION", "Correction changed existing tasks");
      graphHash = correction.newGraphHash;
      continue;
    }
    const additions = correction.taskIds.map((id) => {
      const task = state.graph?.tasks.find((t) => t.id === id);
      const later = task ? widenedLater(task.id, index) : new Set<string>();
      return task && later.size
        ? { ...task, writes: task.writes.filter((w) => !later.has(w.path)) }
        : task;
    });
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
  const debt = hostPassedChecks(store, runId);
  for (const checkId of required.checks) {
    const last = store
      .checks(runId)
      .filter((c) => c.check_id === checkId && c.snapshot_id === state.snapshotId)
      .at(-1);
    // A check a person accepted as unable to run (#2358) holds with its last timeout.
    const accepted =
      last?.status === "inconclusive" &&
      last.reason === "timeout" &&
      state.acceptedCheckTimeouts.includes(checkId);
    const passed =
      last?.status === "passed" ||
      (last?.status === "failed" && debt.has(last.evidence_id)) ||
      accepted;
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

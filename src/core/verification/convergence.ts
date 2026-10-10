import { canonical, hashJson } from "../specs/hash.js";
import { WorkflowFault } from "../workflows/errors.js";
import {
  CorrectionSchema,
  type Review,
  type RunPolicy,
  type TaskGraph,
  validateTaskGraph,
} from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RuntimeState, Task } from "../workflows/types.js";

/**
 * Planned tasks a correction of `task` may write for: those of the same profile that cover one of
 * its criteria. A plan that gives tests a task of their own leaves a code fix and the test that
 * pins the old behavior in two tasks; the correction needs both files.
 */
function relatedRootTasks(task: Pick<Task, "profileId" | "criterionIds">, root: TaskGraph): Task[] {
  return root.tasks.filter(
    (base) =>
      base.profileId === task.profileId &&
      base.criterionIds.some((id) => task.criterionIds.includes(id)),
  );
}

/**
 * What a correction of `base` may write: its own files and those of the related planned tasks,
 * once each; a file the plan created is modified from then on.
 */
export function correctionWrites(
  base: Task,
  root: TaskGraph,
  expectedFiles: Record<string, string> | null | undefined,
): Task["writes"] {
  return [
    ...new Map(
      [base, ...relatedRootTasks(base, root)]
        .flatMap((task) => task.writes)
        .map((write) => [write.path, write] as const),
    ).values(),
  ].map((write) => ({
    ...write,
    action:
      write.action === "create" && expectedFiles?.[write.path] !== undefined
        ? ("modify" as const)
        : write.action,
  }));
}

export function correctionAuthorized(task: Task, root: TaskGraph): boolean {
  const related = relatedRootTasks(task, root);
  return (
    task.origin !== "planned" &&
    related.length > 0 &&
    task.writes.every((w) =>
      related.some((base) =>
        base.writes.some(
          (b) =>
            b.path === w.path &&
            (b.action === w.action || (b.action === "create" && w.action === "modify")),
        ),
      ),
    ) &&
    task.checkIds.every((id) => related.some((base) => base.checkIds.includes(id))) &&
    task.requirementIds.every((id) => related.some((base) => base.requirementIds.includes(id))) &&
    task.criterionIds.every((id) => related.some((base) => base.criterionIds.includes(id)))
  );
}

export function appendCorrections(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
  findings: Review["findings"],
  kind: "repair" | "convergence",
): void {
  if (!state.graph || !state.rootGraph || !state.spec || !state.approvalRoot)
    throw new WorkflowFault("STALE_DECISION", "Repair requires an approved root graph");
  const run = store.run(runId);
  const round = (kind === "repair" ? run.repair_rounds : run.convergence_rounds) + 1;
  const limit = kind === "repair" ? policy.maxRepairRounds : policy.maxConvergenceRounds;
  if (round > limit || run.corrective_tasks + findings.length > policy.maxCorrectiveTasks)
    throw new WorkflowFault("BUDGET_EXHAUSTED", "Reflection round/task limit reached");
  const findingSet = hashJson(
    findings
      .map((f) => ({ claim: f.claim, criteria: f.criterionIds }))
      .sort((a, b) => a.claim.localeCompare(b.claim)),
  );
  state.noProgressRounds = state.previousFindingSet === findingSet ? state.noProgressRounds + 1 : 0;
  state.previousFindingSet = findingSet;
  if (state.noProgressRounds >= 1)
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      "no_progress: consecutive reflection rounds repeat the same findings",
    );
  let next = Math.max(...state.graph.tasks.map((t) => Number(t.id.slice(1)))) + 1;
  // Findings against the same task and file become one corrective task: each task reads the
  // files again from scratch, so three failed checks of one task were three full rereads.
  const groups = new Map<string, { base: Task; findings: Review["findings"] }>();
  for (const finding of findings) {
    const predecessor = state.repairPredecessors[finding.id];
    const base =
      (predecessor && state.graph?.tasks.find((t) => t.id === predecessor)) ||
      state.rootGraph?.tasks.find(
        (t) =>
          (!finding.file || t.writes.some((w) => w.path === finding.file)) &&
          (finding.criterionIds.some((id) => t.criterionIds.includes(id)) ||
            finding.requirementIds.some((id) => t.requirementIds.includes(id))),
      );
    if (!base || (finding.file && !base.writes.some((w) => w.path === finding.file)))
      throw new WorkflowFault(
        "INPUT_CHANGED",
        "Correction requires writes outside the approved task scope",
      );
    state.repairPredecessors[finding.id] = base.id;
    const key = `${base.id}\n${finding.file ?? ""}`;
    const group = groups.get(key) ?? { base, findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  const root = state.rootGraph;
  const additions = [...groups.values()].map(({ base, findings: grouped }) => {
    const ids = grouped.map((f) => f.id);
    return {
      ...base,
      writes: correctionWrites(base, root, state.expectedFiles),
      id: `T${String(next++).padStart(3, "0")}`,
      title: `Correct ${ids.join(", ")}`,
      description: grouped
        .map(
          (finding) =>
            `${grouped.length > 1 ? `Finding ${finding.id}: ` : ""}${finding.claim}\nImpact: ${finding.impact}\nProposed fix: ${finding.suggestedFix}`,
        )
        .join("\n\n"),
      dependsOn: [],
      origin: kind,
      findingIds: ids,
      rationale: `${ids.length > 1 ? "Findings" : "Finding"} ${ids.join(", ")} against approved criteria`,
    };
  });
  const graph: TaskGraph = { ...state.graph, tasks: [...state.graph.tasks, ...additions] };
  const errors = validateTaskGraph(state.spec, graph);
  if (errors.length) throw new WorkflowFault("INVALID_REFERENCE", errors.join("\n"));
  const correction = CorrectionSchema.parse({
    schemaVersion: 1,
    parentDigest: state.approvalRoot,
    parentGraphHash: hashJson(state.graph),
    rule: "bounded-correction",
    newGraphHash: hashJson(graph),
    findingIds: findings.map((f) => f.id),
    taskIds: additions.map((t) => t.id),
    roundKind: kind,
    round,
  });
  const artifact = store.artifact(
    runId,
    "correction",
    `corrections/${kind}-${round}.json`,
    canonical(correction),
  );
  state.correctionHashes.push(artifact.content_hash);
  state.manifest.correctionHashes = [...state.correctionHashes];
  state.graph = graph;
  state.manifest.effectiveGraphHash = hashJson(graph);
  state.reviews = {};
  state.convergence = null;
  state.verificationState = "stale";
  store.syncTasks(runId, graph);
  for (const task of additions)
    for (const id of task.findingIds) store.findingStatus(runId, id, "confirmed", task.id);
  store.addRound(runId, kind, additions.length);
}

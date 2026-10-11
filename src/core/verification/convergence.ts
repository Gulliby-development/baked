import { canonical, hashJson } from "../specs/hash.js";
import { WorkflowFault } from "../workflows/errors.js";
import {
  CorrectionSchema,
  type Review,
  type RunPolicy,
  type Spec,
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

/**
 * The task checks a correction of `base` runs: its own and those of the related planned tasks. A
 * correction that may edit the test file must also run the test check, or it cannot see that its
 * fix is incomplete and the same failure comes back as no progress.
 */
export function correctionChecks(base: Task, root: TaskGraph): string[] {
  return [...new Set([base, ...relatedRootTasks(base, root)].flatMap((task) => task.checkIds))];
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

const unique = (ids: string[]): string[] => [...new Set(ids)];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Planned files a check's output names, in plan order. Linters and compilers print the paths
 * they reject, often absolute and with backslashes on Windows.
 */
export function pathsInOutput(output: string, tasks: Task[]): string[] {
  const text = output.replaceAll("\\", "/");
  const paths = unique(tasks.flatMap((t) => t.writes.map((w) => w.path)));
  return paths.filter((path) =>
    new RegExp(`(?:^|[\\s/"'(:])${escapeRegExp(path)}(?![\\w.-])`, "m").test(text),
  );
}

/**
 * Findings for a failed run-level check. Run 6931efd6: ruff flagged three test files of three
 * tasks, but the one finding (no file) went to the first task with the check, whose correction
 * could not edit the other two files. When the output names planned files, each task that
 * writes one gets its own finding on that file, so each is corrected from its owner.
 */
export function failedCheckFindings(
  check: { id: string },
  evidenceId: string,
  output: string,
  tasks: Task[],
  fallback: Pick<Review["findings"][number], "requirementIds" | "criterionIds">,
  suggestedFix: string,
  newId: () => string,
): Review["findings"] {
  const finding = (
    file: string | null,
    ids: Pick<Review["findings"][number], "requirementIds" | "criterionIds">,
  ): Review["findings"][number] => ({
    id: newId(),
    kind: "correctness",
    severity: "high",
    requirementIds: ids.requirementIds,
    criterionIds: ids.criterionIds,
    file,
    symbol: null,
    evidenceIds: [evidenceId],
    claim: `Required check ${check.id} failed`,
    impact: "Implementation cannot be accepted",
    suggestedFix,
  });
  const owners = new Map<string, { task: Task; file: string }>();
  for (const path of pathsInOutput(output, tasks)) {
    const task = tasks.find((t) => t.writes.some((w) => w.path === path));
    if (task && !owners.has(task.id)) owners.set(task.id, { task, file: path });
  }
  if (!owners.size) return [finding(null, fallback)];
  return [...owners.values()].map(({ task, file }) => finding(file, task));
}

/**
 * The planned task a finding is corrected from. A task that writes the finding's file and covers
 * one of its criteria comes first. Otherwise the task that writes the file is widened to the
 * finding's criteria that tasks of its profile cover, with the requirements those tasks map them
 * to, so the correction may also write their files: a plan can give the store to one task and the
 * criterion the store breaks to the CLI and test tasks.
 */
export function correctionBase(
  finding: Pick<Review["findings"][number], "file" | "criterionIds" | "requirementIds">,
  root: TaskGraph,
  spec: Spec,
): Task | undefined {
  const exact = root.tasks.find(
    (t) =>
      (!finding.file || t.writes.some((w) => w.path === finding.file)) &&
      (finding.criterionIds.some((id) => t.criterionIds.includes(id)) ||
        finding.requirementIds.some((id) => t.requirementIds.includes(id))),
  );
  if (exact || !finding.file) return exact;
  const owner = root.tasks.find((t) => t.writes.some((w) => w.path === finding.file));
  if (!owner) return undefined;
  const covering = (id: string) =>
    root.tasks.filter((t) => t.profileId === owner.profileId && t.criterionIds.includes(id));
  const criteria = finding.criterionIds.filter((id) => covering(id).length > 0);
  const requirements = criteria.flatMap((id) => {
    const verified = spec.criteria.find((c) => c.id === id)?.requirementIds ?? [];
    return covering(id).flatMap((t) => t.requirementIds.filter((r) => verified.includes(r)));
  });
  return {
    ...owner,
    criterionIds: unique([...owner.criterionIds, ...criteria]),
    requirementIds: unique([...owner.requirementIds, ...requirements]),
  };
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
  // Not BUDGET_EXHAUSTED: `workflow extend` raises tokens, calls and time, none of which helps.
  if (round > limit || run.corrective_tasks + findings.length > policy.maxCorrectiveTasks) {
    const setting =
      round > limit
        ? kind === "repair"
          ? "maxRepairRounds"
          : "maxConvergenceRounds"
        : "maxCorrectiveTasks";
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      `no_progress: ${findings.length} finding(s) remain after the policy's ${setting} (${round > limit ? limit : policy.maxCorrectiveTasks}). Narrow the spec or raise ${setting} with workflow revise, or fork the run.`,
      { reason: "no_progress", limit: setting },
    );
  }
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
      correctionBase(finding, state.rootGraph, state.spec);
    if (!base || (finding.file && !base.writes.some((w) => w.path === finding.file)))
      throw new WorkflowFault(
        "INPUT_CHANGED",
        "Correction requires writes outside the approved task scope",
      );
    state.repairPredecessors[finding.id] = base.id;
    const key = `${base.id}\n${finding.file ?? ""}`;
    const existing = groups.get(key);
    const group = existing
      ? {
          base: {
            ...existing.base,
            criterionIds: unique([...existing.base.criterionIds, ...base.criterionIds]),
            requirementIds: unique([...existing.base.requirementIds, ...base.requirementIds]),
          },
          findings: existing.findings,
        }
      : { base, findings: [] as Review["findings"] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  const root = state.rootGraph;
  const additions = [...groups.values()].map(({ base, findings: grouped }) => {
    const ids = grouped.map((f) => f.id);
    return {
      ...base,
      writes: correctionWrites(base, root, state.expectedFiles),
      checkIds: correctionChecks(base, root),
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

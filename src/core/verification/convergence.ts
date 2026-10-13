import { canonical, hashJson } from "../specs/hash.js";
import { WorkflowFault } from "../workflows/errors.js";
import { counterexampleOf } from "../workflows/quality/properties.js";
import {
  CorrectionSchema,
  DEFAULT_FRESH_RESTART_AFTER,
  type Review,
  type RunPolicy,
  type Spec,
  type TaskGraph,
  validateTaskGraph,
} from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RuntimeState, Task } from "../workflows/types.js";
import { findingSetHash } from "./convergence-stop.js";

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

/** Lines of a check's output that name what fails: test names and assertion messages. */
const FAILURE_LINE =
  /^\s*(?:\(fail\)|✗|✘|×|✖|FAIL|not ok|error:|AssertionError|Expected|Received|E\s{2,}|---\s*FAIL)/i;

/**
 * What fails in a check's output, normalized so two runs of the same failure compare equal:
 * the failing test names and assertion lines, without timings, durations, absolute paths and
 * line numbers. A run going from six failing tests to one changes it; the same failure does not.
 * Empty when the output names nothing recognizable.
 */
export function failureSignature(output: string): string {
  const lines = output
    .replaceAll("\\", "/")
    .split(/\r?\n/)
    .filter((line) => FAILURE_LINE.test(line))
    .map((line) =>
      line
        .replace(/\[[\d.]+\s*m?s\]/gi, "")
        .replace(/\(\d+(?:\.\d+)?\s*m?s\)/gi, "")
        .replace(/(?:[A-Za-z]:)?(?:\/[\w.@-]+)+\/([\w.-]+)/g, "$1")
        .replace(/:\d+(?::\d+)?/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  return [...new Set(lines)].sort().slice(0, 6).join(" | ").slice(0, 400);
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
    impact: `${signature ? `Implementation cannot be accepted. Failing: ${signature}` : "Implementation cannot be accepted"}${counterexample ? `. Property counterexample: ${counterexample}` : ""}`,
    suggestedFix,
  });
  const signature = failureSignature(output);
  // A failing property's shrunk input is the reproduction the correction starts from (#637).
  const counterexample = counterexampleOf(output);
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

/** A finding of a failed check run: it names the check and cites that run's evidence. */
const checkRunFinding = (finding: Pick<Review["findings"][number], "claim" | "evidenceIds">) =>
  /^Required check \S+ failed$/.test(finding.claim) && finding.evidenceIds.length > 0;

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
  // A person's "one more round" at a convergence decision raises both limits for that stage.
  const limit =
    kind === "repair"
      ? policy.maxRepairRounds
      : policy.maxConvergenceRounds + state.extraConvergenceRounds;
  const cap = policy.maxCorrectiveTasks + state.extraCorrectiveTasks;
  const findingSet = findingSetHash(findings);
  const repeats = state.previousFindingSet === findingSet ? state.noProgressRounds + 1 : 0;
  // A repair that leaves the failing output as it was may have had no way to see the cause
  // (hookdrop c325575b: a library dropped a character the code could not restore). Repeats before
  // `freshRestartAfter` get the next repair round, told to isolate the failure with run_probe
  // before editing again. At `freshRestartAfter` the correction starts from a clean context:
  // the accumulated attempts are what it would otherwise keep repeating. A repeat after that
  // stops the run. Convergence repeats go to a person first (convergenceStop), so a convergence
  // round never repeats.
  const after = kind === "repair" ? (policy.freshRestartAfter ?? DEFAULT_FRESH_RESTART_AFTER) : 0;
  const fresh = kind === "repair" && repeats === after;
  // The fresh-context attempt is the restart of a repeated failure, not another repair round, so
  // the round limit does not refuse it; the corrective task cap still applies.
  const overRounds = round > limit && !fresh;
  // Not BUDGET_EXHAUSTED: `workflow extend` raises tokens, calls and time, none of which helps.
  if (overRounds || run.corrective_tasks + findings.length > cap) {
    const setting = overRounds
      ? kind === "repair"
        ? "maxRepairRounds"
        : "maxConvergenceRounds"
      : "maxCorrectiveTasks";
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      `no_progress: ${findings.length} finding(s) remain after the policy's ${setting} (${overRounds ? limit : cap}). Narrow the spec or raise ${setting} with workflow revise, or fork the run.`,
      { reason: "no_progress", limit: setting },
    );
  }
  if (repeats > after)
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      kind === "repair"
        ? `no_progress: a correction started from a clean context left the same ${findings.length} finding(s) as the ${String(after)} repair round(s) before it. Fix the cause by hand or revise the plan, then resume.`
        : "no_progress: consecutive reflection rounds repeat the same findings",
      { reason: "no_progress", ...(kind === "repair" ? { freshRestart: true } : {}) },
    );
  state.noProgressRounds = repeats;
  state.previousFindingSet = findingSet;
  const toCorrect =
    repeats > 0 && !fresh
      ? findings.map((f) => ({
          ...f,
          suggestedFix: `${f.suggestedFix} The previous correction left this failure unchanged: isolate the cause with run_probe (a minimal program or the failing test alone) and confirm what the code or a library actually does before editing again; if the cause lies outside the files you may edit, say so in unresolved.`,
        }))
      : findings;
  let next = Math.max(...state.graph.tasks.map((t) => Number(t.id.slice(1)))) + 1;
  // Findings against the same task and file become one corrective task: each task reads the
  // files again from scratch, so three failed checks of one task were three full rereads. The
  // findings of one failing check run (they cite the same evidence) of tasks with one profile
  // become one task that may write every implicated file: one run is one failure to fix, and a
  // task per file (md-site c0456d78, four tasks for one failing test run) paid for the same
  // reading four times and left the later tasks with nothing to change.
  const groups = new Map<string, { base: Task; bases: Task[]; findings: Review["findings"] }>();
  const runGroups = new Map<string, string>();
  for (const finding of toCorrect) {
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
    const fileKey = `${base.id}\n${finding.file ?? ""}`;
    let key = fileKey;
    if (checkRunFinding(finding)) {
      const run = `${finding.evidenceIds[0]}:${base.profileId}`;
      key = groups.has(fileKey) ? fileKey : (runGroups.get(run) ?? fileKey);
      runGroups.set(run, key);
    }
    const existing = groups.get(key);
    const group = existing
      ? {
          base: {
            ...existing.base,
            criterionIds: unique([...existing.base.criterionIds, ...base.criterionIds]),
            requirementIds: unique([...existing.base.requirementIds, ...base.requirementIds]),
          },
          bases: existing.bases.some((b) => b.id === base.id)
            ? existing.bases
            : [...existing.bases, base],
          findings: existing.findings,
        }
      : { base, bases: [base], findings: [] as Review["findings"] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  const root = state.rootGraph;
  // A failure that names files of other tasks of the same profile: their owners join the group,
  // so the correction may write them and the acceptance rule still finds them related.
  for (const group of groups.values())
    for (const finding of group.findings)
      for (const path of state.repairScope?.[finding.id] ?? []) {
        const owner = root.tasks.find(
          (t) => t.profileId === group.base.profileId && t.writes.some((w) => w.path === path),
        );
        if (!owner || group.bases.some((b) => b.id === owner.id)) continue;
        group.bases.push(owner);
        group.base = {
          ...group.base,
          criterionIds: unique([...group.base.criterionIds, ...owner.criterionIds]),
          requirementIds: unique([...group.base.requirementIds, ...owner.requirementIds]),
        };
      }
  const additions = [...groups.values()].map(({ base, bases, findings: grouped }) => {
    const ids = grouped.map((f) => f.id);
    return {
      ...base,
      writes: [
        ...new Map(
          bases
            .flatMap((b) => correctionWrites(b, root, state.expectedFiles))
            .map((write) => [write.path, write] as const),
        ).values(),
      ],
      checkIds: unique(bases.flatMap((b) => correctionChecks(b, root))),
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
  // The reviews this correction supersedes, with what they reviewed, for the next round.
  if (state.expectedFiles) {
    const files = state.expectedFiles;
    state.priorReviews = Object.fromEntries(
      Object.entries(state.reviews).map(([key, review]) => [key, { review, files }]),
    );
  }
  state.reviews = {};
  state.convergence = null;
  state.verificationState = "stale";
  store.syncTasks(runId, graph);
  for (const task of additions)
    for (const id of task.findingIds) store.findingStatus(runId, id, "confirmed", task.id);
  if (fresh) {
    const account = freshAccount(store, runId, state, round, repeats, findings);
    for (const task of additions) {
      const artifact = store.artifact(
        runId,
        "diagnostic",
        `tasks/${task.id}/fresh-start.json`,
        canonical({ taskId: task.id, repeats, ...account }),
      );
      state.freshTasks[task.id] = artifact.id;
    }
  }
  store.addRound(runId, kind, additions.length);
}

/**
 * The host's account of the repair rounds a fresh-context correction replaces, from the journal:
 * each earlier corrective task, what it changed and the failures that came back. Nothing a worker
 * wrote about itself is used, so the fresh attempt does not inherit its reasoning.
 */
function freshAccount(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  round: number,
  repeats: number,
  findings: Review["findings"],
): { summary: string; attempts: { taskId: string; title: string; changed: string[] }[] } {
  const attempts: { taskId: string; title: string; changed: string[] }[] = [];
  for (let earlier = round - repeats; earlier < round; earlier++) {
    const record = store.latestArtifact(runId, `corrections/repair-${String(earlier)}.json`);
    if (!record) continue;
    const { taskIds } = JSON.parse(store.readArtifact(runId, record.id)) as { taskIds: string[] };
    for (const taskId of taskIds) {
      const diff = store.latestArtifact(runId, `tasks/${taskId}/diff.json`);
      const changed = diff
        ? (JSON.parse(store.readArtifact(runId, diff.id)) as { changed?: string[] }).changed
        : [];
      attempts.push({
        taskId,
        title: state.graph?.tasks.find((t) => t.id === taskId)?.title ?? taskId,
        changed: changed ?? [],
      });
    }
  }
  const tried = attempts
    .map(
      (a) =>
        `${a.taskId} changed ${a.changed.length ? a.changed.slice(0, 8).join(", ") : "no file"}`,
    )
    .join("; ");
  const failing = findings.map((f) => f.claim).join("; ");
  return {
    summary: `${String(attempts.length)} earlier correction(s) of this failure (${tried || "no record"}) each left it as it was: ${failing}. Their approach did not work.`,
    attempts,
  };
}

import { canonical, hashJson } from "../specs/hash.js";
import { WorkflowFault } from "../workflows/errors.js";
import { counterexampleOf } from "../workflows/quality/properties.js";
import {
  CorrectionSchema,
  DEFAULT_FRESH_RESTART_AFTER,
  DEFAULT_MAX_TASK_REPAIRS,
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
 * One write per path for a correction. The action follows the file, not the order of the merged
 * writes: a path a planned task creates is modified once the integrated change has it and created
 * while it does not. A correction that ran before the creating task got the later task's `modify`
 * and the tool policy refused every attempt (bench round 11, mdrefs T011: 1.44M tokens).
 */
export function mergeCorrectionWrites(
  writes: Task["writes"],
  expectedFiles: Record<string, string> | null | undefined,
): Task["writes"] {
  const byPath = new Map<string, Task["writes"][number]>();
  for (const write of writes) {
    const created =
      write.action === "create" ||
      (write.action === "modify" && byPath.get(write.path)?.action === "create");
    byPath.set(write.path, created ? { ...write, action: "create" } : write);
  }
  return [...byPath.values()].map((write) => ({
    ...write,
    action:
      write.action === "create" && expectedFiles?.[write.path] !== undefined
        ? ("modify" as const)
        : write.action,
  }));
}

const fileStem = (path: string): string =>
  path
    .slice(path.lastIndexOf("/") + 1)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//;
/** The stem a test file is named after (`cli_test.go`, `test_cli.py`, `cli.test.ts`, `CliTest.java`), or null for a non-test file. */
function testedStem(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const stripped = name.replace(/^test_/i, "").replace(/(?:[._-](?:test|spec)|Tests?)$/, "");
  if (stripped === name && !TEST_DIR.test(path)) return null;
  return stripped.toLowerCase();
}
/** Whether `test` is a test file of the source file `source`, by name. */
export function isTestOf(test: string, source: string): boolean {
  return testedStem(source) === null && testedStem(test) === fileStem(source);
}

/**
 * What a correction of `base` may write: its own files and those of the related planned tasks,
 * once each (see `mergeCorrectionWrites`).
 */
export function correctionWrites(
  base: Task,
  root: TaskGraph,
  expectedFiles: Record<string, string> | null | undefined,
): Task["writes"] {
  return mergeCorrectionWrites(
    [base, ...relatedRootTasks(base, root)].flatMap((task) => task.writes),
    expectedFiles,
  );
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
 * Planned files a check's output reports a failure in: the paths that start an unindented line,
 * as a compiler error (`tests/cli.test.ts(258,45): error TS2769`, `src/a.go:3:1: ...`), a test
 * runner's file header (`tests/cli.test.ts:`) or a `FAILED`/`FAIL` line. Indented lines (related
 * information, stack frames, code excerpts) only explain a failure located elsewhere.
 */
export function failingPathsInOutput(output: string, tasks: Task[]): string[] {
  const text = output.replaceAll("\\", "/");
  const paths = unique(tasks.flatMap((t) => t.writes.map((w) => w.path)));
  return paths.filter((path) =>
    new RegExp(
      `^(?:(?:FAILED|FAIL|ERROR|error)[:\\s]\\s*)?(?:[A-Za-z]:)?(?:[^\\s:()]*/)?${escapeRegExp(path)}(?:[:(]|\\s|$)`,
      "m",
    ).test(text),
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

/**
 * The first step of a correction whose finding carries a repro (#765): run it before editing,
 * so the fix starts from the failure the reviewer showed, and again after the fix.
 */
function reproStep(repro: Review["findings"][number]["repro"]): string {
  if (!repro) return "";
  const command = [repro.executable, ...repro.args].map((a) => JSON.stringify(a)).join(" ");
  return `\nReproduce first: run ${command} with run_probe before editing. The review saw it print ${JSON.stringify(repro.actual)} where the spec needs ${JSON.stringify(repro.expected)}. After the fix, run it again and confirm it prints the expected output.`;
}

/**
 * The last step of a correction for a reviewer's finding (#943): the reviewer shows one case, and
 * the same defect often sits in sibling code paths (todo-cli: `add --help` was repaired, then the
 * re-review found `tag` and `untag`, and the run stopped). One repair should cover them all.
 */
const SIBLING_STEP =
  "\nThe review shows one case. Look for the same defect in sibling code paths (other commands, options, branches or callers that share the faulty pattern) and fix every case you find, checking each one as you checked the reported one.";

/** A finding of a failed check run: it names the check and cites that run's evidence. */
const checkRunFinding = (finding: Pick<Review["findings"][number], "claim" | "evidenceIds">) =>
  /^Required check \S+ failed$/.test(finding.claim) && finding.evidenceIds.length > 0;

/**
 * How many corrections lead to a task: 0 for a planned task, 1 for the correction of a planned
 * task, 2 for the correction of that correction, and so on.
 */
function correctionDepth(state: RuntimeState, taskId: string): number {
  let depth = 0;
  let current = state.graph?.tasks.find((t) => t.id === taskId);
  const seen = new Set<string>();
  while (current && current.origin !== "planned" && !seen.has(current.id)) {
    seen.add(current.id);
    depth++;
    const predecessor = current.findingIds
      .map((id) => state.repairPredecessors[id])
      .find((id): id is string => Boolean(id));
    current = predecessor ? state.graph?.tasks.find((t) => t.id === predecessor) : undefined;
  }
  return depth;
}

/**
 * Adds corrective tasks for findings. `scope: "task"` is a correction a task's own failed checks
 * start during the implement stage: it is bounded by `maxTaskRepairs` per chain of corrections
 * and does not spend a repair round, which counts checks-stage passes (cfgtrace 276e4858: two
 * task-level corrections used both rounds and the checks stage could not repair eight failing
 * tests). `scope: "review"` is a correction a review pass starts: it counts review rounds, which
 * have their own `maxRepairRounds` budget, so a checks stage that needed both rounds still leaves
 * the review its corrections (mdrefs 8531a4f0: a reproduced medium finding was refused as round 3
 * with every required check green).
 */
export function appendCorrections(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
  findings: Review["findings"],
  kind: "repair" | "convergence",
  scope: "round" | "task" | "review" = "round",
): void {
  if (!state.graph || !state.rootGraph || !state.spec || !state.approvalRoot)
    throw new WorkflowFault("STALE_DECISION", "Repair requires an approved root graph");
  const run = store.run(runId);
  const taskLevel = kind === "repair" && scope === "task";
  const chain = taskLevel
    ? Math.max(
        0,
        ...findings.map((f) => {
          const predecessor = state.repairPredecessors[f.id];
          return predecessor ? correctionDepth(state, predecessor) : 0;
        }),
      )
    : 0;
  const reviewPass = kind === "repair" && scope === "review";
  // The counter this correction spends and the name its artifact and correction record carry.
  const roundKind = reviewPass ? "review" : kind;
  const round = taskLevel
    ? chain + 1
    : (reviewPass
        ? (run.review_rounds ?? 0)
        : kind === "repair"
          ? run.repair_rounds
          : run.convergence_rounds) + 1;
  // A person's "one more round" at a convergence decision raises both limits for that stage.
  const limit = taskLevel
    ? (policy.maxTaskRepairs ?? DEFAULT_MAX_TASK_REPAIRS)
    : kind === "repair"
      ? policy.maxRepairRounds
      : policy.maxConvergenceRounds + state.extraConvergenceRounds;
  const cap = policy.maxCorrectiveTasks + state.extraCorrectiveTasks;
  const findingSet = findingSetHash(findings);
  // A task-level correction repeating its task's failure is bounded by its chain length; it
  // leaves the stage-level repeat count to the checks stage and reviews.
  const repeats = taskLevel
    ? 0
    : state.previousFindingSet === findingSet
      ? state.noProgressRounds + 1
      : 0;
  // A repair that leaves the failing output as it was may have had no way to see the cause
  // (hookdrop c325575b: a library dropped a character the code could not restore). Repeats before
  // `freshRestartAfter` get the next repair round, told to isolate the failure with run_probe
  // before editing again. At `freshRestartAfter` the correction starts from a clean context:
  // the accumulated attempts are what it would otherwise keep repeating. A repeat after that
  // stops the run. Convergence repeats go to a person first (convergenceStop), so a convergence
  // round never repeats.
  const after =
    kind === "repair" && !taskLevel ? (policy.freshRestartAfter ?? DEFAULT_FRESH_RESTART_AFTER) : 0;
  const fresh = kind === "repair" && !taskLevel && repeats === after;
  // The fresh-context attempt is the restart of a repeated failure, not another repair round, so
  // the round limit does not refuse it; the corrective task cap still applies.
  const overRounds = round > limit && !fresh;
  const refuse = (setting: string, value: number, count: number): never => {
    // Not BUDGET_EXHAUSTED: `workflow extend` raises tokens, calls and time, none of which helps.
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      `no_progress: ${count} finding(s) remain after the policy's ${setting} (${value}). Narrow the spec or raise ${setting} with workflow revise, or fork the run.`,
      { reason: "no_progress", limit: setting },
    );
  };
  if (overRounds)
    refuse(
      taskLevel ? "maxTaskRepairs" : kind === "repair" ? "maxRepairRounds" : "maxConvergenceRounds",
      limit,
      findings.length,
    );
  if (repeats > after)
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      kind === "repair"
        ? `no_progress: a correction started from a clean context left the same ${findings.length} finding(s) as the ${String(after)} repair round(s) before it. Fix the cause by hand or revise the plan, then resume.`
        : "no_progress: consecutive reflection rounds repeat the same findings",
      { reason: "no_progress", ...(kind === "repair" ? { freshRestart: true } : {}) },
    );
  const toCorrect =
    repeats > 0 && !fresh
      ? findings.map((f) => ({
          ...f,
          suggestedFix: `${f.suggestedFix} The previous correction left this failure unchanged: isolate the cause with run_probe (a minimal program or the failing test alone) and confirm what the code or a library actually does before editing again; if the cause lies outside the files you may edit, say so in unresolved.`,
        }))
      : findings;
  const predecessorsBefore = { ...state.repairPredecessors };
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
  // The cap counts corrective tasks: the findings of one failed check run become one task, so one
  // pytest run recorded against six owning files is one task, not six (cfgtrace 276e4858).
  if (run.corrective_tasks + groups.size > cap) {
    state.repairPredecessors = predecessorsBefore;
    refuse("maxCorrectiveTasks", cap, findings.length);
  }
  if (!taskLevel) {
    state.noProgressRounds = repeats;
    state.previousFindingSet = findingSet;
  }
  const root = state.rootGraph;
  // A planned file the correction needs: its owner of the same profile joins the group, so the
  // correction may write it and the acceptance rule still finds it related.
  const writable = (group: { bases: Task[] }): string[] =>
    group.bases.flatMap((b) => correctionWrites(b, root, null)).map((w) => w.path);
  const join = (group: { base: Task; bases: Task[] }, path: string): void => {
    if (writable(group).includes(path)) return;
    const owner = root.tasks.find(
      (t) => t.profileId === group.base.profileId && t.writes.some((w) => w.path === path),
    );
    if (!owner || group.bases.some((b) => b.id === owner.id)) return;
    group.bases.push(owner);
    group.base = {
      ...group.base,
      criterionIds: unique([...group.base.criterionIds, ...owner.criterionIds]),
      requirementIds: unique([...group.base.requirementIds, ...owner.requirementIds]),
    };
  };
  const planned = unique(root.tasks.flatMap((t) => t.writes.map((w) => w.path)));
  for (const group of groups.values()) {
    // The files a failing check names, and the planned files the findings name in their claim or
    // fix (expenses-py 1363445a: "update tests/test_cli.py" from a task that could not write it).
    for (const finding of group.findings) {
      for (const path of state.repairScope?.[finding.id] ?? []) join(group, path);
      for (const path of pathsInOutput(`${finding.claim}\n${finding.suggestedFix}`, root.tasks))
        join(group, path);
    }
    // The planned tests of the files the correction writes: a fix often needs its regression
    // assertion there (junitdigest 3e5be74b T014 could not add one to internal/cli/cli_test.go).
    const written = writable(group);
    for (const path of planned)
      if (written.some((source) => isTestOf(path, source))) join(group, path);
  }
  const additions = [...groups.values()].map(({ base, bases, findings: grouped }) => {
    const ids = grouped.map((f) => f.id);
    return {
      ...base,
      writes: mergeCorrectionWrites(
        bases.flatMap((b) => correctionWrites(b, root, state.expectedFiles)),
        state.expectedFiles,
      ),
      checkIds: unique(bases.flatMap((b) => correctionChecks(b, root))),
      id: `T${String(next++).padStart(3, "0")}`,
      title: `Correct ${ids.join(", ")}`,
      description: grouped
        .map(
          (finding) =>
            `${grouped.length > 1 ? `Finding ${finding.id}: ` : ""}${finding.claim}\nImpact: ${finding.impact}\nProposed fix: ${finding.suggestedFix}${reproStep(finding.repro)}${kind === "convergence" && !checkRunFinding(finding) ? SIBLING_STEP : ""}`,
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
    roundKind,
    round,
  });
  const artifact = store.artifact(
    runId,
    "correction",
    taskLevel
      ? `corrections/task-${additions[0]?.id ?? "T000"}.json`
      : `corrections/${roundKind}-${round}.json`,
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
    const account = freshAccount(store, runId, state, roundKind, round, repeats, findings);
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
  if (taskLevel) store.addCorrectiveTasks(runId, additions.length);
  else store.addRound(runId, roundKind, additions.length);
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
  roundKind: "repair" | "review" | "convergence",
  round: number,
  repeats: number,
  findings: Review["findings"],
): { summary: string; attempts: { taskId: string; title: string; changed: string[] }[] } {
  const attempts: { taskId: string; title: string; changed: string[] }[] = [];
  for (let earlier = round - repeats; earlier < round; earlier++) {
    const record = store.latestArtifact(runId, `corrections/${roundKind}-${String(earlier)}.json`);
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

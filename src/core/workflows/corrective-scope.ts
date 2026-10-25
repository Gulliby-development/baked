import { matchGlob } from "../platform/index.js";
import { canonical, hashJson } from "../specs/hash.js";
import { siblingOwner } from "../verification/initiative-ownership.js";
import { isStaticCheck } from "./check-policy.js";
import { isTestCheck } from "./quality/mutation.js";
import {
  HOST_REMEDIES,
  type HostRemedy,
  type RecoveryAdvice,
  type Remedy,
  recoveryAdvice,
} from "./remedies.js";
import { CorrectionSchema, type Repro, type Review, type RunPolicy } from "./schemas.js";
import { stopMode } from "./stop-reasons.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState } from "./types.js";

/**
 * Whether a task-level corrective can write the files its own diagnostics name (#2094). skillcomb
 * (bench round 67): the sizing split cut tests/test_fields.py into T010 (create) and T017
 * (modify, after T010). T010 left seven ruff ISC004 hits in the file, and its corrective T024 was
 * built without it: a task-level repair may not take over a test file whose later slice has still
 * to run (#1612), so T024 got the three source files of T010's related tasks instead. Six sessions
 * (1.89M tokens) edited code the task was told not to change, the hold of `readyTasks` kept eight
 * independent test tasks waiting on those source files, and the run blocked
 * `out_of_scope_failure` only after the sessions were paid.
 *
 * The rule: a corrective for a failed required check that is not a test check writes the files
 * the check names that the failing task itself writes (`ownScope`), also while a later slice
 * still writes them; a later slice depends on the failing task, so it reads the corrected file.
 * A diagnostics-only corrective (a linter, formatter or type checker, `diagnosticsOnly`) writes
 * only the failing task's own files, never the related tasks' sources. A failing test check keeps
 * #1612: its defect is usually in the source the test reaches, and the later slice adds tests.
 *
 * The precondition is recorded when the corrective is created and again before each of its
 * sessions as `scope/tasks/<task>.json` (kind `corrective-scope`, kept in bench traces), and a
 * corrective that misses one of its diagnosed files records a `corrective_scope` would-stop
 * (shadow): no model can write a file outside its scope. `replayCorrectiveScopes` (`trace.ts`)
 * decides each record again.
 */
export const SCOPE_KIND = "corrective-scope";
/** One record per task-level corrective of a failed non-test check: `scope/tasks/<task>.json`. */
export const SCOPE_TASKS_DIR = "scope/tasks/";

/** The check a task-level finding names: `Task T001 required check lint failed`. */
const TASK_CHECK_FAILED = /^Task \S+ required check (\S+) failed$/;

/** How a task-level finding of a failed required check is corrected, or null for any other finding. */
export function checkRepairKind(
  policy: Pick<RunPolicy, "checks">,
  finding: Pick<Review["findings"][number], "claim">,
): "diagnostics" | "build" | null {
  const id = TASK_CHECK_FAILED.exec(finding.claim)?.[1];
  const check = id ? policy.checks.find((c) => c.id === id) : undefined;
  if (!check || isTestCheck(check)) return null;
  return isStaticCheck(check) ? "diagnostics" : "build";
}

type ScopeState = Pick<RuntimeState, "repairScope" | "repairPredecessors" | "graph">;

/** The files in a finding's repair scope that the failing task (its predecessor) itself writes. */
export function ownScope(state: ScopeState, findingId: string): string[] {
  const base = state.graph?.tasks.find((t) => t.id === state.repairPredecessors?.[findingId]);
  if (!base) return [];
  return (state.repairScope?.[findingId] ?? []).filter((path) =>
    base.writes.some((w) => w.path === path && w.action !== "delete"),
  );
}

/**
 * The files a corrective of `finding` must be able to write: those its failed non-test check
 * names in the failing task's own files. Empty for a test check and every other finding.
 */
export function diagnosedFiles(
  state: ScopeState,
  policy: Pick<RunPolicy, "checks">,
  finding: Pick<Review["findings"][number], "id" | "claim">,
): string[] {
  return checkRepairKind(policy, finding) ? ownScope(state, finding.id) : [];
}

/**
 * Whether a finding is corrected as diagnostics only: a linter, formatter or type checker named
 * only files the failing task writes. Its corrective writes the failing task's own files and no
 * related task's sources (#2094, #1067).
 */
export function diagnosticsOnly(
  state: ScopeState,
  policy: Pick<RunPolicy, "checks">,
  finding: Pick<Review["findings"][number], "id" | "claim">,
): boolean {
  const scope = state.repairScope?.[finding.id] ?? [];
  return (
    checkRepairKind(policy, finding) === "diagnostics" &&
    scope.length > 0 &&
    ownScope(state, finding.id).length === scope.length
  );
}

export type ScopeDecision = "fits" | "refuse";

/**
 * Where a corrective's finding comes from (#2133). A failed check names its files through the
 * check's diagnostics (`diagnosedFiles`); a review, an edge or sibling probe, a battery case and
 * a worker's unresolved report name theirs through the finding's file, the stack frames of its
 * repro output and the unresolved items of the corrective's attempts.
 */
export type FindingOrigin = "check" | "review" | "probe" | "battery" | "unresolved";

export function findingOrigin(finding: Pick<Review["findings"][number], "claim">): FindingOrigin {
  const claim = finding.claim;
  if (TASK_CHECK_FAILED.test(claim) || /^Required check \S+ failed/.test(claim)) return "check";
  if (/^(?:Edge input|Sibling case) \d+ of /.test(claim)) return "probe";
  if (/^Battery case /.test(claim)) return "battery";
  if (/ reported unresolved in its own files: /.test(claim)) return "unresolved";
  return "review";
}

/** A file name in prose or a stack frame: `src/a.ts`, `C:\w\src\a.ts:91:53`, `Reader.cs`. */
const PATH_TOKEN =
  /(?:[A-Za-z]:)?(?:[\\/]?[\w@+-][\w.@+-]*[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?![\w])/g;

/**
 * The workspace paths a text names, in the order it names them (#2133): a path relative to the
 * root, an absolute path under `root` (a stack frame of the probe's run), an absolute path that
 * ends in a known path (a frame recorded on another machine, `C:\...\src\storage.ts:91:53`), or a
 * bare file name that exactly one known path has (`Reader.cs`, a Java frame's `Storage.java`).
 * A relative path no known path matches counts only when `accept` holds it (it exists, or an
 * initiative feature's boundary holds it).
 */
export function evidencePaths(
  text: string,
  root: string,
  known: readonly string[],
  accept: (path: string) => boolean = () => false,
): string[] {
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const found: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    let path = match[0].replaceAll("\\", "/");
    if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`))
      path = path.slice(base.length + 1);
    path = path.replace(/^(?:\.\/)+/, "");
    const absolute = /^(?:[A-Za-z]:)?\//.test(path);
    const resolved = known.includes(path)
      ? path
      : (known.filter((k) => path.endsWith(`/${k}`)).sort((a, b) => b.length - a.length)[0] ??
        (!path.includes("/")
          ? (() => {
              const named = known.filter((k) => (k.split("/").at(-1) ?? k) === path);
              return named.length === 1 ? named[0] : undefined;
            })()
          : undefined) ??
        (!absolute && !path.startsWith("../") && path.includes("/") && accept(path)
          ? path
          : undefined));
    if (resolved && !found.includes(resolved)) found.push(resolved);
  }
  return found;
}

/**
 * The lines of a program's output that are stack frames: a file with a line number, as every
 * supported runtime prints one (`at f (/w/src/a.ts:9:5)`, `File "/w/a.py", line 9`, `/w/a.go:9`,
 * `src/a.rs:9:5`, `(A.java:9)`, `in /w/A.cs:line 9`). Prose that names a file is not a frame.
 */
export function stackFrames(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => /\.[A-Za-z][\w]{0,9}(?::\d+|", line \d+|:line \d+)/.test(line))
    .join("\n");
}

/**
 * What the host does about a file a corrective's evidence names outside its writes (#2133), the
 * one decision for every origin: `route` opens a corrective of the settled task of this run that
 * wrote it (as `routeReportedDefect` does for a reported defect) and the corrective waits for it;
 * `widen` adds the path to the corrective's writes as a recorded host edit, when the run's
 * approved paths hold it and no task writes it; `park` waits for the initiative feature whose
 * boundary holds it (an accepted upstream feature) with a request naming the path and the owner;
 * `wait` leaves it to the wait for an unfinished writer (`deferOnMissingArtifact`); `refuse`
 * blocks the corrective without another session. Shadow by default (`corrective_unowned_file`).
 */
export type UnownedDecision = "wait" | "route" | "widen" | "park" | "refuse";

/** One named path outside a corrective's writes, with the inputs of its decision. */
export interface UnownedPath {
  path: string;
  /** The settled (implemented or verified) task of this run that last writes the path. */
  owner: string | null;
  /** The unfinished tasks of this run that write it. */
  openWriters: string[];
  /** The other initiative feature whose boundary holds it. */
  feature: string | null;
  /** Whether the run's approved paths hold it: auto-approval's `allowedPaths`, the feature's boundary. */
  allowed: boolean;
  /** The file's content hash when recorded, null when it does not exist. */
  hash: string | null;
  decision: UnownedDecision;
}

export type UnownedRule = (input: Omit<UnownedPath, "decision" | "hash">) => UnownedDecision;

export const unownedRule: UnownedRule = (input) =>
  input.openWriters.length
    ? "wait"
    : input.owner
      ? "route"
      : input.feature
        ? "park"
        : input.allowed
          ? "widen"
          : "refuse";

/** The corrective's decision over its named paths: one act per decision, in this order. */
export function hostDecision(
  paths: readonly Pick<UnownedPath, "decision">[],
): UnownedDecision | "fits" {
  if (!paths.length) return "fits";
  for (const decision of ["route", "park", "widen", "wait"] as const)
    if (paths.some((p) => p.decision === decision)) return decision;
  return "refuse";
}

/** What a record reads besides the findings: the attempts' reports and the run's owners (#2133). */
export interface ScopeEvidence {
  /** The unresolved items of the corrective's result now, or of its last attempt before a session. */
  unresolved: readonly string[];
  /** The run's task rows, for which tasks settled. */
  rows: readonly { id: string; status: string }[];
  /** The workspace paths a text names (`evidencePaths` on the run's root). */
  paths: (text: string) => string[];
  /** Auto-approval's `allowedPaths`, empty without limits. */
  allowedPaths: readonly string[];
  hash: (path: string) => string | null;
}

/** What `scope/tasks/<task>.json` records: the precondition's inputs and its decision. */
export interface ScopeRecord {
  taskId: string;
  /**
   * Where the precondition was checked: when the corrective was created, before a session, or on
   * a session's blocked or failed result (#2133).
   */
  at: "create" | "start" | "result";
  /** The tasks whose failed checks the corrective corrects. */
  failing: string[];
  /** The checks that failed. */
  checks: string[];
  /** The files those checks name in the failing tasks' own files. */
  diagnosed: string[];
  /** The corrective's write scope. */
  writes: string[];
  /** The diagnosed files outside its write scope. */
  missing: string[];
  decision: ScopeDecision;
  /** The origins of the corrective's findings (#2133). */
  origins?: FindingOrigin[];
  /** The files the evidence of other origins and the attempts' unresolved items name. */
  named?: string[];
  /** The named files outside the writes, each with its decision. */
  unowned?: UnownedPath[];
  /** The corrective's decision over them (`hostDecision`). */
  host?: UnownedDecision | "fits";
}

/** The diagnosed files a corrective cannot write; `replayCorrectiveScopes` takes another rule. */
export type ScopeRule = (diagnosed: readonly string[], writes: readonly string[]) => string[];

export const missingDiagnosed: ScopeRule = (diagnosed, writes) =>
  diagnosed.filter((path) => !writes.includes(path));

type ScopeFinding = Pick<Review["findings"][number], "id" | "claim"> & {
  file?: string | null;
  repro?: Pick<Repro, "actual"> | undefined;
};

const SETTLED = ["implemented", "verified"];
const ENDED = ["implemented", "verified", "blocked", "failed", "cancelled"];

/**
 * Whether the run's approval holds a path no task writes (#2133): auto-approval's `allowedPaths`
 * or, in an initiative, the feature's own boundary. The one rule for the decision to widen and
 * for acceptance's check of a `host-widen` link.
 */
export function approvedPath(
  path: string,
  allowedPaths: readonly string[],
  bounds: RuntimeState["initiativeBounds"],
): boolean {
  const lower = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  const current = bounds?.features.find((f) => f.id === bounds.featureId);
  return (
    allowedPaths.some((glob) => matchGlob(lower(path), lower(glob))) ||
    (current?.paths.some((glob) => matchGlob(lower(path), lower(glob))) ?? false)
  );
}

/** The inputs of each named path outside `writes` (#2133). */
function unownedPaths(
  state: ScopeState & Partial<Pick<RuntimeState, "initiativeBounds">>,
  taskId: string,
  named: readonly string[],
  writes: readonly string[],
  evidence: ScopeEvidence,
  rule: UnownedRule,
): UnownedPath[] {
  const status = new Map(evidence.rows.map((r) => [r.id, r.status]));
  const tasks = (state.graph?.tasks ?? []).filter((t) => t.id !== taskId);
  const writers = (path: string) =>
    tasks.filter((t) => t.writes.some((w) => w.path === path && w.action !== "delete"));
  const bounds = state.initiativeBounds ?? null;
  return named
    .filter((path) => !writes.includes(path))
    .map((path) => {
      const all = writers(path);
      const input = {
        path,
        owner:
          all.filter((t) => SETTLED.includes(status.get(t.id) ?? "pending")).at(-1)?.id ?? null,
        openWriters: all
          .filter((t) => !ENDED.includes(status.get(t.id) ?? "pending"))
          .map((t) => t.id),
        feature: siblingOwner(path, bounds)?.id ?? null,
        allowed: approvedPath(path, evidence.allowedPaths, bounds),
      };
      return { ...input, hash: evidence.hash(path), decision: rule(input) };
    });
}

/** The precondition of one corrective, decided on its findings and write scope. */
export function scopeRecord(
  state: ScopeState & Partial<Pick<RuntimeState, "initiativeBounds">>,
  policy: Pick<RunPolicy, "checks">,
  task: { id: string; writes: { path: string; action: string }[] },
  findings: ScopeFinding[],
  at: ScopeRecord["at"],
  rule: ScopeRule = missingDiagnosed,
  evidence?: ScopeEvidence,
  unowned: UnownedRule = unownedRule,
): ScopeRecord | null {
  const own = findings.filter((f) => checkRepairKind(policy, f));
  const writes = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
  // A failed check names its files through its diagnostics, which #2094 compares; every other
  // origin names them through the finding's file and its repro's output, and every attempt
  // through its unresolved items (#2133).
  const named = evidence
    ? [
        ...new Set([
          ...findings
            .filter((f) => findingOrigin(f) !== "check")
            .flatMap((f) => [
              ...(f.file ? [f.file] : []),
              ...(f.repro ? evidence.paths(stackFrames(f.repro.actual)) : []),
            ]),
          ...evidence.unresolved.flatMap((item) => evidence.paths(item)),
        ]),
      ]
    : [];
  if (!own.length && !named.length) return null;
  const diagnosed = [...new Set(own.flatMap((f) => ownScope(state, f.id)))];
  const missing = rule(diagnosed, writes);
  const outside = evidence ? unownedPaths(state, task.id, named, writes, evidence, unowned) : [];
  return {
    taskId: task.id,
    at,
    failing: [
      ...new Set(
        own.map((f) => state.repairPredecessors?.[f.id]).filter((id): id is string => !!id),
      ),
    ],
    checks: [...new Set(own.map((f) => TASK_CHECK_FAILED.exec(f.claim)?.[1] ?? ""))],
    diagnosed,
    writes,
    missing,
    decision: missing.length ? "refuse" : "fits",
    ...(evidence
      ? {
          origins: [...new Set(findings.map(findingOrigin))],
          named,
          unowned: outside,
          host: hostDecision(outside),
        }
      : {}),
  };
}

/**
 * The paths the host already acted on for a corrective (`scope/edits/<task>.json`, #2133): a
 * routed, parked or widened path is acted on once per corrective, so a resume after the owner's
 * correction runs the corrective's session instead of routing it again.
 */
export const SCOPE_EDITS_DIR = "scope/edits/";

export interface ScopeEdit {
  path: string;
  decision: Exclude<UnownedDecision, "wait">;
  owner: string | null;
  at: ScopeRecord["at"];
  /** The corrective the host opened for a routed path. */
  correctiveIds?: string[];
  hash: string | null;
  /** A person chose the act through a remedy of the block, in shadow (#2155). */
  approvedBy?: "user";
}

type WidenState = Pick<
  RuntimeState,
  "graph" | "rootGraph" | "approvalRoot" | "correctionHashes" | "manifest" | "initiativeBounds"
>;

/**
 * Widens a corrective's writes by paths no task writes (#2133) as a `host-widen` link of the
 * correction chain, so acceptance can check it: the frozen policy enforces
 * `corrective_unowned_file`, the paths are inside the run's approved paths, no planned task
 * writes them, and the link's graph hash is the graph after the edit. Returns the paths added.
 */
export function hostWiden(
  store: Pick<WorkflowStore, "artifact" | "syncTasks">,
  runId: string,
  state: WidenState,
  policy: Pick<RunPolicy, "stopModes" | "costForecast" | "autoApproval">,
  task: { id: string; findingIds: string[] },
  paths: readonly { path: string; exists: boolean }[],
): string[] {
  const graph = state.graph;
  const target = graph?.tasks.find((t) => t.id === task.id);
  if (!graph || !target || !state.approvalRoot || !task.findingIds.length) return [];
  const widened = paths
    .filter(
      (p) =>
        !target.writes.some((w) => w.path === p.path) && widenAuthorized(p.path, state, policy),
    )
    .map((p) => ({
      taskId: task.id,
      path: p.path,
      action: p.exists ? ("modify" as const) : ("create" as const),
    }));
  if (!widened.length) return [];
  const next = {
    ...graph,
    tasks: graph.tasks.map((t) =>
      t.id === task.id
        ? { ...t, writes: [...t.writes, ...widened.map(({ path, action }) => ({ path, action }))] }
        : t,
    ),
  };
  const correction = CorrectionSchema.parse({
    schemaVersion: 1,
    parentDigest: state.approvalRoot,
    parentGraphHash: hashJson(graph),
    rule: "host-widen",
    newGraphHash: hashJson(next),
    findingIds: task.findingIds,
    taskIds: [task.id],
    roundKind: "repair",
    round: 1,
    widened,
  });
  const artifact = store.artifact(
    runId,
    "correction",
    `corrections/widen-${task.id}-${String(state.correctionHashes.length + 1)}.json`,
    canonical(correction),
  );
  state.correctionHashes.push(artifact.content_hash);
  state.manifest.correctionHashes = [...state.correctionHashes];
  state.graph = next;
  state.manifest.effectiveGraphHash = hashJson(next);
  // The task row keeps its definition, which the task's check gate is keyed on.
  store.syncTasks(runId, next);
  return widened.map((w) => w.path);
}

/** Whether a `host-widen` link may add `path` (acceptance reads the same rule). */
export function widenAuthorized(
  path: string,
  state: Pick<RuntimeState, "rootGraph" | "initiativeBounds"> &
    Partial<Pick<RuntimeState, "personWidened">>,
  policy: Pick<RunPolicy, "stopModes" | "costForecast" | "autoApproval">,
): boolean {
  return (
    (stopMode(policy, "corrective_unowned_file") === "enforce" ||
      (state.personWidened ?? []).includes(path)) &&
    !(state.rootGraph?.tasks ?? []).some((t) => t.writes.some((w) => w.path === path)) &&
    approvedPath(path, policy.autoApproval?.limits?.allowedPaths ?? [], state.initiativeBounds)
  );
}

/**
 * The text of a would-stop or a block for a corrective's decision over its named paths.
 */
export function unownedSummary(
  taskId: string,
  paths: readonly UnownedPath[],
  decision: UnownedDecision,
): string {
  const these = paths.filter((p) => p.decision === decision);
  const files = these
    .map((p) => p.path)
    .slice(0, 5)
    .join(", ");
  switch (decision) {
    case "route":
      return `${taskId} cannot write ${files}, which ${[...new Set(these.map((p) => p.owner))].join(", ")} wrote: a correction of the owner would be opened and ${taskId} would wait for it`;
    case "park":
      return `${taskId} cannot write ${files}, which feature ${[...new Set(these.map((p) => p.feature))].join(", ")} owns: the run would wait for an upstream change of that feature`;
    case "widen":
      return `${taskId} cannot write ${files}, which no task writes and the approved paths hold: ${taskId}'s writes would be widened by ${these[0]?.path ?? files}`;
    case "wait":
      return `${taskId} cannot write ${files}, which ${[...new Set(these.flatMap((p) => p.openWriters))].join(", ")} still write: ${taskId} waits for them`;
    case "refuse":
      return `${taskId} cannot write ${files}, which no task, feature or approved path of the run owns: the corrective would block without another session`;
  }
}

/**
 * What a person can do about a corrective whose evidence names a file nothing in the run may
 * change (#2133): change it and resume with the change accepted, or revise the plan.
 */
export function unownedAdvice(runId: string, message: string, paths: string[]): RecoveryAdvice {
  const files = paths.slice(0, 5).join(", ");
  return recoveryAdvice(
    `${message} Change ${files} yourself and resume with \`baked workflow resume ${runId} --accept-workspace\`, or revise the plan so a task may write them (\`baked workflow revise ${runId}\`); a plain resume does not start the correction again while ${files} is unchanged.`,
    `A correction needs ${files} changed, which no task of the run may write. Change the files and accept the change, or revise the plan.`,
    { action: "accept-workspace", runId },
    { action: "revise", runId },
    { action: "cancel", runId },
  );
}

/**
 * A person's answer to a blocked corrective's unowned files (#2155), one per host decision a
 * block can be answered with: `route` corrects the owner first, `widen` lets the corrective write
 * the paths, `upstream` asks the owning initiative feature for the change (the host's `park`).
 */
export { HOST_REMEDIES, type HostRemedy };
export const REMEDY_DECISION: Record<HostRemedy, "route" | "widen" | "park"> = {
  route: "route",
  widen: "widen",
  upstream: "park",
};

/**
 * The remedies a blocked corrective's last scope record offers: one per decision the host would
 * take over its unowned files when enforced (route, widen, park), in `hostDecision`'s order. A
 * record that fits, waits or refuses offers none.
 */
export function unownedRemedies(runId: string, record: ScopeRecord | undefined): Remedy[] {
  const paths = record?.unowned ?? [];
  return HOST_REMEDIES.flatMap((action): Remedy[] => {
    const these = paths.filter((p) => p.decision === REMEDY_DECISION[action]);
    if (!record || !these.length) return [];
    const owner = action === "route" ? these[0]?.owner : these[0]?.feature;
    return [
      {
        action,
        runId,
        taskId: record.taskId,
        paths: these.map((p) => p.path),
        ...(owner ? { owner } : {}),
      },
    ];
  });
}

/**
 * The advice of a corrective's block when its last scope record names unowned files a person can
 * answer for (#2155): the act the host would take, as one command or click each, then a plain
 * retry, a revision and a cancel. Undefined when the record offers no such remedy.
 */
export function unownedBlockAdvice(
  runId: string,
  message: string,
  record: ScopeRecord | undefined,
): RecoveryAdvice | undefined {
  const remedies = unownedRemedies(runId, record);
  if (!record || !remedies.length) return undefined;
  const commands = remedies.map((r) => {
    const files = (r.paths ?? []).slice(0, 5).join(", ");
    const act =
      r.action === "route"
        ? `correct ${r.owner ?? "the owner"} first, which wrote ${files}`
        : r.action === "widen"
          ? `let ${record.taskId} write ${files}`
          : `ask feature ${r.owner ?? "upstream"} to change ${files}`;
    return `${act} (\`baked workflow resume ${runId} --remedy ${r.action}\`)`;
  });
  const choices = commands.join(", or ");
  return recoveryAdvice(
    `${message} ${record.taskId} cannot write files its evidence names: ${choices}.`,
    `${record.taskId} cannot write ${[...new Set(remedies.flatMap((r) => r.paths ?? []))].slice(0, 5).join(", ")}. Choose how the run goes on.`,
    ...remedies,
    { action: "resume", runId },
    { action: "revise", runId },
    { action: "cancel", runId },
  );
}

/** Every precondition record of a run, in the order they were written. */
export function scopeRecords(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): ScopeRecord[] {
  const records: ScopeRecord[] = [];
  for (const artifact of store.artifacts(runId)) {
    if (artifact.kind !== SCOPE_KIND || !artifact.logical_path.startsWith(SCOPE_TASKS_DIR))
      continue;
    try {
      records.push(JSON.parse(store.readArtifact(runId, artifact.id)) as ScopeRecord);
    } catch {}
  }
  return records;
}

/**
 * What a person can do about a corrective that cannot write the files its failing check names
 * (`out_of_scope_failure`): fix them in the workspace and resume with the change accepted, or
 * revise the plan so a task may write them. A plain resume would start the same sessions again.
 */
export function outOfScopeAdvice(runId: string, message: string, paths: string[]): RecoveryAdvice {
  const files = paths.slice(0, 5).join(", ");
  return recoveryAdvice(
    `${message} Fix ${files} yourself and resume with \`baked workflow resume ${runId} --accept-workspace\`, or revise the plan so a task may write them (\`baked workflow revise ${runId}\`); a plain resume starts the same correction again.`,
    `A correction cannot write ${files}, which its failing check names. Fix the files and accept the change, or revise the plan.`,
    { action: "accept-workspace", runId },
    { action: "revise", runId },
    { action: "cancel", runId },
  );
}

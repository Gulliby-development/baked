import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  ROUTING_ARTIFACT,
  type RouteEffort,
  type RoutingRecord,
  RoutingRecordSchema,
} from "../llm/model-routing.js";
import { modelVendor } from "../llm/model-vendor.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { renderSpec, renderTasks } from "../specs/render.js";
import { validatePackage, workspacePath } from "../specs/validate.js";
import {
  assertAcceptance,
  assertAcceptanceV2,
  v1ReviewDimensions,
} from "../verification/acceptance.js";
import { buildCheckEnv, CheckRunner, executeCheckCommand } from "../verification/check-runner.js";
import {
  appendCorrections,
  failedCheckFindings,
  pathsInOutput,
} from "../verification/convergence.js";
import {
  acceptResidual,
  assumeDecision,
  convergenceBody,
  convergenceStop,
  earlierFindings,
  grantRound,
  noteUnverifiedCriteria,
  passesWithNotes,
  REPEAT_NOTE,
  requiredChecksPass,
} from "../verification/convergence-stop.js";
import {
  currentEvidence,
  evidenceHandle,
  resolveEvidenceIds,
  validateEvidence,
  validEvidenceNote,
} from "../verification/evidence.js";
import { findingBlocks, fingerprint, requiresSecurityReview } from "../verification/findings.js";
import {
  type BaselineCount,
  baselineRegression,
  CHECK_BASELINE_PATH,
  commandKey,
  outputCounts,
  TEST_FILE,
} from "../verification/output-counts.js";
import {
  missingReproAdvice,
  type ReproOutcome,
  reproAllows,
  reproExecutables,
  reproTool,
  runRepro,
} from "../verification/repro.js";
import { completeReview, reviewProblems, validateReview } from "../verification/review.js";
import { addReviewNotes, noteReason } from "../verification/review-notes.js";
import { changedPaths, gitBaseline, sourceManifest } from "../verification/snapshot.js";
import { outputSchemas } from "./agent-executor.js";
import {
  assumable,
  DEFECT_NOTE,
  hostCounts,
  hostDependencyEdges,
  hostSplitParts,
  isCountNit,
  isHostEdgeNit,
  isHostSplitNit,
  knownRisks,
  persistentDefect,
  REQUEST_NOTE,
  restrictsRequest,
} from "./analysis-notes.js";
import { approvalDigest } from "./approval.js";
import { writeViaTemp } from "./atomic-write.js";
import {
  evaluateAutoApproval,
  humanApprovalReason,
  plannerApprovalLimits,
  planScopeAdvice,
  policyDecisions,
} from "./auto-approval.js";
import { budgetUsage, raiseToStartEstimate, reserveTokens } from "./budget.js";
import {
  fixerCommand,
  fixerTiers,
  isCodePath,
  taskCheckList,
  validateChecks,
  withCoveringChecks,
  writtenCodePaths,
} from "./check-policy.js";
import { failFastUnavailable } from "./check-preflight.js";
import {
  ASSUME_NOTE,
  assumeProblems,
  clarificationResumeIndex,
  deferredBlockingProblems,
  demoteDeferred,
  planOnlyFindings,
  researchBudget,
  SCOPING_PLANNERS,
  scopedPlanBudget,
} from "./clarification.js";
import { assertFrozenInputs, buildWorkflowContext } from "./context.js";
import { coverageFinding } from "./coverage.js";
import { git } from "./delivery-git.js";
import { dependencyContracts } from "./dependencies.js";
import { EffectJournal, fileHash, intentRoot, rootField } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { outputTail } from "./gates.js";
import {
  InitiativePlanSchema,
  MAX_FEATURES,
  MIN_FEATURES,
  planStructureProblems,
} from "./initiatives/plan.js";
import { changeReach, repairChangedFiles } from "./invalidation.js";
import {
  commandMayBeRunning,
  mutationLeaseFor,
  type WorkspaceLeases,
  withinWorkflow,
} from "./leases.js";
import { MAX_CONCURRENT_TASK_CHECKS, planBatch, Semaphore, unifiedDiff } from "./parallel.js";
import {
  PLAN_CONSISTENCY_CHECKS,
  planConsistencyProblems,
  withDerivedRequirements,
  withImplementationProfiles,
  withModuleDependencies,
  withReadDependencies,
} from "./plan-consistency.js";
import { ProcessScope } from "./process-scope.js";
import { type LearnedRule, rulesFor } from "./project-memory.js";
import {
  checkDependencies,
  dependencyClaim,
  QUALITY_DEPENDENCIES,
} from "./quality/dependencies.js";
import {
  compareWithBaseline,
  duplicationOf,
  isTestCodePath,
  measureBaseline,
  QUALITY_BASELINE,
  QUALITY_DUPLICATION,
  type QualityBaseline,
  qualityClaim,
  readCodeFiles,
} from "./quality/duplication.js";
import { isManifestPath, manifestDependencies } from "./quality/manifests.js";
import {
  generateMutants,
  isTestCheck,
  type MutationResult,
  mutationClaim,
  mutationOf,
  presetOf,
  QUALITY_MUTATION,
  QUALITY_MUTATION_PENDING,
  runMutants,
} from "./quality/mutation.js";
import type { RegistryFetch } from "./quality/registry.js";
import {
  type ChangedFile,
  checkQualityRules,
  QUALITY_BASELINE_FILES,
  QUALITY_RULES,
  type RuleFinding,
  ruleClaim,
} from "./quality/rules.js";
import { DEFAULT_SAST_CONFIG, QUALITY_SAST, runSast, sastClaim, sastOf } from "./quality/sast.js";
import { carriesOver, changedSince, previousRound } from "./re-review.js";
import { preloadTaskFiles } from "./read-outline.js";
import { recoverRun, requestRecovery, settleSupersededEffects } from "./recovery.js";
import { deliverableProblems, requestCoverage } from "./request-coverage.js";
import {
  abortableDelay,
  accountRefusal,
  endedOnProse,
  isCapacityError,
  isTransient,
  reportsLostTool,
  retryAfterMs,
  retryDelay,
} from "./retry.js";
import { buildReviewBundle, REVIEW_BUNDLE_PATH, taskChangedFiles } from "./review-bundle.js";
import {
  capturePreImage,
  createdByRunLineage,
  readKept,
  runWrittenHash,
  uncommittedEdits,
} from "./rollback.js";
import {
  type AgentProfile,
  AnalysisSchema,
  type Critique,
  CritiqueSchema,
  DEFAULT_MAX_PARALLEL_RUNS,
  executionModeOf,
  generatedPaths,
  ImplementationSchema,
  PlanSchema,
  PolicySchema,
  ProfileSchema,
  ReasonCode,
  RefutationSchema,
  ReportSchema,
  type Repro,
  ResearchSchema,
  type Review,
  ReviewSchema,
  type RunPolicy,
  type Spec,
  SpecSchema,
  specCoverageProblems,
  type TaskGraph,
  WorkflowSchema,
} from "./schemas.js";

type Implementation = ReturnType<typeof ImplementationSchema.parse>;

import {
  codeTaskCheckProblems,
  plannerSizing,
  type SizingReport,
  sizePlan,
  sizingHistory,
  splitNote,
  splitTestTasks,
  withTestDependencies,
} from "./sizing.js";
import { forgetProgress } from "./stall.js";
import type { AttemptUsageRecord } from "./step-budget.js";
import { type LeaseResource, newId, type TaskRow, type WorkflowStore } from "./store.js";
import { hasTaskGate, pendingOwners, readyTasks } from "./task-graph.js";
import { takeHashRefusals } from "./tool-policy.js";
import type { AgentExecutor, Check, HostTool, RuntimeState, Task } from "./types.js";
import { acceptanceGrants, blocksRun } from "./v2/acceptance.js";
import { type BrowserDriverOptions, runAcceptanceGate } from "./v2/acceptance-gate.js";
import {
  effectiveMode,
  type Gate,
  GateSchema,
  type Outcome,
  type Stage,
  selectTransition,
  type WorkflowV2,
} from "./v2/definition.js";
import { gateToCheck } from "./v2/library.js";
import {
  carriedValue,
  contractText,
  parseRunDefinition,
  produces,
  type Reviewer,
  reviewersOf,
  type StageKind,
  stageKind,
  stageProfileId,
} from "./v2/runtime.js";
import {
  contradictsFacts,
  hasNoSource,
  type WorkspaceFacts,
  workspaceFacts,
} from "./workspace-facts.js";
import {
  commitRunBranch,
  createTaskWorktree,
  ensureRunWorktree,
  removeTaskWorktree,
  runContentCommit,
  runRoot,
  userChangesInScope,
  worktreePath,
} from "./worktree.js";

/** Severity of a review finding. */
type Severity = Review["findings"][number]["severity"];
const ALL_SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
const SERIOUS: readonly Severity[] = ["critical", "high"];

/**
 * The severities that start a correction. After the first repair or convergence round, medium and
 * low findings are recorded in the review artifact but no longer start another round: runs
 * de6cf1ab and 2fa658c0 spent their rounds on ever deeper medium findings while every check passed.
 */
const repairSeverities = (run: { repair_rounds: number; convergence_rounds: number }) =>
  run.repair_rounds + run.convergence_rounds > 0 ? SERIOUS : ALL_SEVERITIES;

/** The task graph as the scheduler stores it: hashes are bound to the accepted spec and plan. */
function planGraph(
  spec: Spec,
  plan: { markdown: string; taskGraph: TaskGraph },
  policy: RunPolicy,
  profiles: AgentProfile[],
): TaskGraph {
  return withCoveringChecks(
    withTestDependencies(
      withReadDependencies(
        withModuleDependencies(
          withDerivedRequirements(spec, {
            ...withImplementationProfiles(plan.taskGraph, profiles),
            specHash: hashJson(spec),
            planHash: hashBytes(plan.markdown),
          }),
        ),
      ),
    ),
    policy,
  );
}

/** What the analyzer is told the host verified, including the dependency edges the host owns. */
function hostEdgesNote(graph: TaskGraph): string[] {
  const edges = hostDependencyEdges(graph);
  return edges.length
    ? [
        ...PLAN_CONSISTENCY_CHECKS,
        `these dependsOn edges are added by the host after planning (module index, read hint, test after code) and are not defects, whether or not plan.md mentions them: ${edges.map((e) => `${e.task} after ${e.dependsOn}`).join(", ")}`,
      ]
    : PLAN_CONSISTENCY_CHECKS;
}

/** A request for a person that the current step raised and has not made durable yet. */
interface QueuedRequest {
  kind: "approval" | "clarification" | "manual_evidence" | "convergence";
  digest: string;
  body: unknown;
}

/**
 * The request a spec's deliverables are checked against. A feature of an initiative has its
 * boundary approved with the split, not the request, so it is checked against nothing.
 */
const coverageRequest = (state: RuntimeState): string =>
  state.hostDependencies ? "" : state.requestText;
/** How often rejected approvals may send one run back to revise before a rejection only pauses it. */
const MAX_REJECTION_REVISIONS = 3;
const REJECTION_NOTE =
  "A person rejected the approval of the previous spec and plan with this explanation. Revise the spec, the plan and the tasks so they follow it; where it contradicts an assumption, the explanation wins.";
/** A provider asking to wait longer than this is not waited for once a route has fallback models. */
const LONG_RETRY_AFTER_MS = 30_000;
/** The implementer's own list of what it left unfinished, for the blocked task's message. */
/**
 * The planned files a failed check of a corrective task names, when the task may write none of
 * them; empty when the output names no planned file or one the task writes.
 */
export function outOfScopeFailure(
  task: Pick<Task, "origin" | "writes">,
  checked: { status: string; output?: string },
  tasks: Task[],
): string[] {
  if (task.origin === "planned" || checked.status !== "failed" || !checked.output) return [];
  const named = pathsInOutput(checked.output, tasks);
  return named.some((path) => task.writes.some((w) => w.path === path)) ? [] : named;
}
/** A SQLite failure is a host fault, never a model's invalid output. */
function isStoreError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof WorkflowFault) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === "SQLiteError" || (typeof code === "string" && code.startsWith("SQLITE_"));
}
const incompleteReason = (unresolved: string[]): string =>
  unresolved.length ? `: ${unresolved.slice(0, 3).join("; ").slice(0, 500)}` : "";
/**
 * Files whose edits the host's hash check refused during an attempt that then reported blocked:
 * an infrastructure fault (the worktree differs from the run's record), which the model cannot
 * fix and a second attempt would repeat.
 */
const refusedReason = (paths: string[]): string =>
  paths.length
    ? `; infrastructure fault, not a disagreement with the task: the host refused edits to ${paths.slice(0, 3).join(", ")} because the file differs from the run's record`
    : "";
/** Characters of a task's unified diff kept in its diff evidence. */
const MAX_PATCH_CHARS = 48_000;
/** Lines of a failed check's output handed to a stage that does not write, such as research. */
const HANDOFF_OUTPUT_LINES = 120;

/** What one read evidence looked at: the tool, the paths or symbols it named and its size. */
function readSummary(content: string): { tool: string; targets: string[]; bytes: number } {
  const targets: string[] = [];
  let tool = "read";
  try {
    const parsed = JSON.parse(content) as { tool?: unknown; input?: unknown };
    if (typeof parsed.tool === "string") tool = parsed.tool;
    const input = (parsed.input ?? {}) as Record<string, unknown>;
    for (const key of ["path", "file", "symbol", "query", "target"])
      if (typeof input[key] === "string") targets.push(input[key]);
    if (Array.isArray(input.files))
      for (const file of input.files)
        if (typeof file === "string") targets.push(file);
        else if (
          file &&
          typeof file === "object" &&
          "path" in file &&
          typeof file.path === "string"
        )
          targets.push(file.path);
  } catch {
    // A read artifact that is not JSON is summarized by its size only.
  }
  return { tool, targets, bytes: Buffer.byteLength(content) };
}
/**
 * Marks the input of a review that sees only the diff (the language dimension, #670): its context
 * leaves out the spec, plan and check output, about 15k tokens instead of 45k.
 */
const DIFF_REVIEW = "diffReview";

export class WorkflowScheduler {
  dispose(): void {
    this.executor.dispose?.();
  }
  readonly processes = new ProcessScope();
  readonly journal: EffectJournal;
  readonly checks: CheckRunner;
  /** The mutation lease of the root the driven run writes: the project or its worktree. */
  private mutation: LeaseResource = "mutation";
  /** The driven run's execution lease: the workspace's, or the run's own in worktree mode. */
  private execution: LeaseResource = "execution";
  /** How many runs may execute in the workspace at once (`workflows.maxParallelRuns`). */
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS;
  /** The browser driver of AI acceptance gates; Playwright when unset. Tests inject a fake. */
  browserDriver: BrowserDriverOptions | undefined;
  /** Registry lookups of the dependency check; `fetch` when unset. Tests inject a fake. */
  registryFetch: RegistryFetch | undefined;
  /** The Semgrep executable (null: not installed); detected when unset. Tests inject one. */
  semgrep: string | null | undefined;
  /** The clock of wait stages: wall time and an abortable sleep. Tests inject a fake one. */
  waitClock: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> } = {
    now: () => Date.now(),
    sleep: abortableDelay,
  };
  /** Runs a sleep that does not count as active time; set while a run is driven. */
  private idle: <T>(sleep: () => Promise<T>) => Promise<T> = (sleep) => sleep();
  /**
   * Requests for a person raised by the current step. They become durable only together with the
   * state they were raised on (see `flushWaits`), so a decision never sees a request whose state
   * is not saved yet, and a later save never overwrites what the decision wrote.
   */
  private queued: QueuedRequest[] = [];
  /** Frozen routing records by run; `null` for runs started before routing was recorded. */
  private routing = new Map<string, RoutingRecord | null>();
  constructor(
    private store: WorkflowStore,
    private leases: WorkspaceLeases,
    private executor: AgentExecutor,
  ) {
    this.journal = new EffectJournal(store, leases);
    this.checks = new CheckRunner(store, this.processes);
  }
  async drive(runId: string, outerSignal: AbortSignal): Promise<void> {
    // A reroute between drives writes a new routing revision; read it again.
    this.routing.delete(runId);
    const policy = PolicySchema.parse(JSON.parse(this.store.run(runId).policy_json));
    raiseToStartEstimate(this.store, runId, policy);
    // A worktree run holds the leases of its own worktree and execution; the project working copy
    // stays free and other worktree runs can execute beside it.
    const inWorktree = executionModeOf(policy) === "worktree";
    this.mutation = inWorktree
      ? mutationLeaseFor(this.store.workspace, join(this.store.workspace, worktreePath(runId)))
      : "mutation";
    this.execution = inWorktree ? `execution:${runId}` : "execution";
    this.leases.acquire(this.execution, runId, { maxExecuting: this.maxParallelRuns });
    try {
      this.leases.acquire(this.mutation, runId);
    } catch (error) {
      this.leases.release();
      throw error;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort(outerSignal.reason);
    const leaseSignal = this.leases.signal;
    const leaseLost = (): void => controller.abort(leaseSignal.reason);
    leaseSignal.addEventListener("abort", leaseLost, { once: true });
    outerSignal.addEventListener("abort", abort, { once: true });
    if (outerSignal.aborted) abort();
    const signal = controller.signal;
    const started = performance.now();
    const activeBefore = this.store.run(runId).active_ms;
    let idleMs = 0;
    const arm = () =>
      setTimeout(
        () => controller.abort(new WorkflowFault("BUDGET_EXHAUSTED", "Active deadline exhausted")),
        Math.max(1, policy.maxActiveMs - activeBefore - (performance.now() - started - idleMs)),
      );
    let timeout = arm();
    // A wait stage sleeps between polls; that time is not active time.
    this.idle = async <T>(sleep: () => Promise<T>): Promise<T> => {
      clearTimeout(timeout);
      const from = performance.now();
      try {
        return await sleep();
      } finally {
        idleMs += performance.now() - from;
        timeout = arm();
      }
    };
    // Management commands from another process must stop this owner before the next effect.
    const poll = setInterval(() => {
      if (["paused", "cancelled"].includes(this.store.run(runId).status))
        controller.abort(new Error("Run management command"));
    }, 100);
    let stepId: string | null = null;
    this.queued = [];
    try {
      if (!recoverRun(this.store, this.journal, runId)) return;
      if (executionModeOf(policy) === "worktree") await ensureRunWorktree(this.store, runId);
      this.restoreMutatedFiles(runId);
      this.store.transaction(() => this.store.transition(runId, "running"));
      await withinWorkflow(this.leases.owner, async () => {
        while (this.store.run(runId).status === "running") {
          signal.throwIfAborted();
          this.leases.assert(this.execution);
          this.leases.assert(this.mutation);
          const run = this.store.run(runId);
          const state = this.store.state(runId);
          const parsed = parseRunDefinition(run.definition_json);
          assertFrozenInputs(state);
          if (state.approvalRoot) await this.assertWorkspace(runId, state, policy, signal);
          let stage: { id: string; kind: StageKind; profileId?: string | undefined };
          let v2: { definition: WorkflowV2; stage: Stage; gates: Gate[] } | null = null;
          if (parsed.schemaVersion === 1) {
            const current = parsed.definition.stages[state.stageIndex];
            if (!current) {
              await this.accept(runId, state, policy, signal);
              return;
            }
            stage = current;
          } else {
            const position = state.position;
            if (!position)
              throw new WorkflowFault(
                "INVALID_DEFINITION",
                "Run of a v2 definition has no position",
              );
            const gates = this.frozenGates(runId);
            if (position.stageId === "done") {
              await this.acceptV2(runId, state, policy, parsed.definition, gates, signal);
              return;
            }
            const current = parsed.definition.stages.find((s) => s.id === position.stageId);
            const kind = current ? stageKind(current) : null;
            if (!current || !kind)
              throw new WorkflowFault("INVALID_REFERENCE", `Unknown stage ${position.stageId}`);
            v2 = { definition: parsed.definition, stage: current, gates };
            if (position.outcome) {
              await this.takeTransition(runId, state, policy, v2, signal);
              continue;
            }
            stage = { id: current.id, kind, profileId: stageProfileId(current) };
          }
          stepId = this.store.transaction(() => {
            this.store.bump(runId, run.revision);
            return this.store.beginStep(runId, stage.id);
          });
          const profiles = ProfileSchema.array().parse(JSON.parse(run.profiles_json));
          const profile = profiles.find((p) => p.id === stage.profileId);
          let advance = true;
          // A v2 stage that moved the run's position itself reports no outcome.
          let rerouted = false;
          let repairFindings: {
            findings: Review["findings"];
            kind: "repair" | "convergence";
          } | null = null;
          switch (stage.kind) {
            case "research": {
              const researcher = this.requireProfile(profile);
              const researchRoot = runRoot(this.store.workspace, state);
              const budget = researchBudget(state.prompt, researcher, policy, (path) =>
                existsSync(join(researchRoot, path)),
              );
              const submitted = ResearchSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  researcher,
                  {
                    researchScope: {
                      namedPaths: budget.namedPaths,
                      maxSteps: budget.maxSteps,
                    },
                    workspaceFacts: this.recordFacts(runId, researchRoot),
                  },
                  signal,
                  undefined,
                  0,
                  (output) => {
                    const parsed = ResearchSchema.safeParse(output);
                    if (!parsed.success) return [];
                    const question = (_: unknown, index: number) =>
                      parsed.data.unknowns[index]?.question ?? "";
                    return [
                      ...deferredBlockingProblems(parsed.data.unknowns, question),
                      ...assumeProblems(policy, parsed.data.unknowns, question),
                    ];
                  },
                  { maxSteps: budget.maxSteps, maxTokens: budget.maxTokens },
                ),
              );
              const research = {
                ...submitted,
                unknowns: demoteDeferred(submitted.unknowns, (q) => q.question),
              };
              state.research = canonical(research);
              if (research.unknowns.some((q) => q.blocking)) {
                this.wait("clarification", state, { questions: research.unknowns });
                advance = false;
              }
              break;
            }
            case "specify": {
              state.spec = SpecSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  {
                    featureId: run.feature_id,
                    workspaceFacts: this.recordFacts(runId, runRoot(this.store.workspace, state)),
                  },
                  signal,
                  undefined,
                  0,
                  (output) => {
                    const parsed = SpecSchema.safeParse(output);
                    if (!parsed.success) return [];
                    const questions = parsed.data.openQuestions;
                    return [
                      ...specCoverageProblems(parsed.data),
                      ...deliverableProblems(parsed.data, coverageRequest(state)),
                      ...assumeProblems(
                        policy,
                        questions,
                        (_, index) => questions[index]?.question ?? "",
                      ),
                    ];
                  },
                ),
              );
              // The run owns the feature ID; a spec author that renames it changes nothing.
              if (state.spec.featureId !== run.feature_id)
                state.spec = { ...state.spec, featureId: run.feature_id };
              // An initiative decides which contracts a feature depends on, not the spec author.
              if (state.hostDependencies)
                state.spec = { ...state.spec, dependencies: state.hostDependencies };
              state.manifest.specHash = hashJson(state.spec);
              this.store.transaction(() =>
                this.store.artifact(runId, "spec", "spec.json", canonical(state.spec)),
              );
              if (state.spec.openQuestions.some((q) => q.blocking)) {
                this.wait("clarification", state, { questions: state.spec.openQuestions });
                advance = false;
              }
              break;
            }
            case "plan": {
              const spec = state.spec;
              if (!spec)
                throw new WorkflowFault("ARTIFACT_MISSING", "Spec required before planning");
              const planner = this.requireProfile(profile);
              // A scoping planner finds the files itself, within a budget sized by the request.
              const scope =
                state.research === null && SCOPING_PLANNERS.has(planner.id)
                  ? scopedPlanBudget(state.prompt, planner, policy)
                  : null;
              const approvalLimits = plannerApprovalLimits(policy);
              // Scope advice is given once; a plan that keeps the writes is approved by a person.
              let scopeAdvised = false;
              const plan = PlanSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  planner,
                  {
                    checks: policy.checks,
                    profiles,
                    workspaceFacts: this.recordFacts(runId, runRoot(this.store.workspace, state)),
                    ...(approvalLimits ? { approvalLimits } : {}),
                    ...(policy.sizing
                      ? {
                          sizing: plannerSizing(
                            policy,
                            sizingHistory(this.store.workspace, policy),
                            this.sizingModel(runId, null),
                          ),
                        }
                      : {}),
                    ...(scope
                      ? {
                          researchScope: {
                            namedPaths: scope.namedPaths,
                            maxSteps: scope.maxSteps,
                          },
                        }
                      : {}),
                  },
                  signal,
                  undefined,
                  0,
                  // The planner sees package errors at submission and can correct them in place.
                  (output) => {
                    const parsed = PlanSchema.safeParse(output);
                    if (!parsed.success) return [parsed.error.message];
                    const problems = [
                      ...this.planProblems(runId, spec, parsed.data, policy, profiles),
                      ...codeTaskCheckProblems(parsed.data.taskGraph, policy),
                    ];
                    if (scopeAdvised) return problems;
                    const advice = planScopeAdvice(
                      policy,
                      parsed.data.taskGraph,
                      (path) => existsSync(join(runRoot(this.store.workspace, state), path)),
                      this.baselineScaffold(runId, state),
                    );
                    if (advice.length) scopeAdvised = true;
                    return [...problems, ...advice];
                  },
                  scope ? { maxSteps: scope.maxSteps, maxTokens: scope.maxTokens } : undefined,
                ),
              );
              state.plan = plan.markdown;
              const problems = this.planProblems(runId, spec, plan, policy, profiles);
              if (problems.length)
                throw new WorkflowFault("INVALID_REFERENCE", problems.join("\n"));
              const planned = planGraph(spec, plan, policy, profiles);
              const graph = policy.sizing ? this.splitTests(runId, planned, policy) : planned;
              state.graph = graph;
              state.hostSplitTasks = graph.tasks.length - planned.tasks.length;
              state.rootGraph = structuredClone(state.graph);
              state.manifest.planHash = hashBytes(state.plan);
              state.manifest.rootGraphHash = hashJson(state.graph);
              state.manifest.effectiveGraphHash = hashJson(state.graph);
              this.store.transaction(() => {
                this.store.artifact(runId, "plan", "plan.md", state.plan ?? "");
                this.store.artifact(runId, "tasks", "tasks.json", canonical(state.graph));
                this.store.syncTasks(runId, graph);
              });
              await this.publish(runId, stepId, state, policy, signal);
              break;
            }
            case "analyze": {
              await this.publish(runId, stepId, state, policy, signal);
              state.manifest.dependencyContracts = dependencyContracts(this.store, state).map(
                ({ featureId, contractHash, artifactHash }) => ({
                  featureId,
                  contractHash,
                  artifactHash,
                }),
              );
              const spec = state.spec;
              const graph = state.graph;
              if (!spec || !graph || state.plan === null)
                throw new WorkflowFault(
                  "ARTIFACT_MISSING",
                  "Spec and plan required before analysis",
                );
              // Mechanical defects go back to the user without a model call.
              const problems = this.planProblems(
                runId,
                spec,
                { markdown: state.plan, taskGraph: graph },
                policy,
                profiles,
              );
              if (problems.length) {
                this.wait("clarification", state, {
                  findings: problems.map((description, index) => ({
                    id: `RUNTIME-${index + 1}`,
                    kind: "inconsistency",
                    refs: ["plan.md", "tasks.json"],
                    description,
                    blocking: true,
                  })),
                });
                advance = false;
                break;
              }
              const analysis = AnalysisSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  {
                    verifiedByRuntime: hostEdgesNote(graph),
                    workspaceFacts: this.recordFacts(runId, runRoot(this.store.workspace, state)),
                    hostCounts: hostCounts(graph),
                    ...(Object.keys(hostSplitParts(graph)).length
                      ? { hostSplit: hostSplitParts(graph) }
                      : {}),
                  },
                  signal,
                  undefined,
                  0,
                  (output) => {
                    const parsed = AnalysisSchema.safeParse(output);
                    return parsed.success
                      ? deferredBlockingProblems(
                          parsed.data.findings,
                          (_, index) => parsed.data.findings[index]?.description ?? "",
                        )
                      : [];
                  },
                ),
              );
              // The host binds the analysis to the manifest it analyzed; the model's copy of the hash
              // is not checked (#347: one transposed character blocked d0f55591).
              analysis.inputHash = hashJson(state.manifest);
              // The host adds a finding the model missed: a program was described and none is planned.
              // A feature of an initiative has its boundary approved with the split, not the request.
              const uncovered =
                state.coverageRaised || state.hostDependencies
                  ? null
                  : coverageFinding(
                      state.requestText || state.prompt,
                      this.recordFacts(runId, runRoot(this.store.workspace, state)).kind,
                      graph,
                    );
              if (uncovered) {
                state.coverageRaised = true;
                if (!analysis.findings.some((f) => f.id === uncovered.id))
                  analysis.findings.push(uncovered);
              }
              // The host inventory outranks the model: a finding that a listed file does not exist is a note.
              const facts = this.recordFacts(runId, runRoot(this.store.workspace, state));
              for (const finding of analysis.findings) {
                if (
                  finding.blocking &&
                  finding.kind === "inconsistency" &&
                  contradictsFacts(finding.description, facts)
                ) {
                  finding.blocking = false;
                  finding.description = `Contradicted by the workspace facts (facts/workspace.json); kept as a note: ${finding.description}`;
                }
              }
              // The host computed the task and file counts; a finding that only compares them is a note.
              const counts = hostCounts(graph);
              for (const finding of analysis.findings) {
                if (finding.blocking && isCountNit(finding.description)) {
                  finding.blocking = false;
                  finding.description = `Counts are computed by the host (${String(counts.tasks)} tasks, ${String(counts.files)} distinct files); kept as a note: ${finding.description}`;
                }
              }
              // The host adds some dependsOn edges after planning; plan.md cannot mention them and the
              // planner cannot remove them, so a finding about them is a note.
              const hostEdges = hostDependencyEdges(graph);
              const taskIds = graph.tasks.map((t) => t.id);
              for (const finding of analysis.findings) {
                if (
                  finding.blocking &&
                  finding.kind === "inconsistency" &&
                  isHostEdgeNit(finding, hostEdges, taskIds)
                ) {
                  finding.blocking = false;
                  finding.description = `About dependsOn edges the host adds after planning (${hostEdges.map((e) => `${e.task} after ${e.dependsOn}`).join(", ")}); kept as a note: ${finding.description}`;
                }
              }
              // The host split oversized test tasks after planning; plan.md names only the original.
              const split = hostSplitParts(graph);
              for (const finding of analysis.findings) {
                if (
                  finding.blocking &&
                  finding.kind !== "scope" &&
                  isHostSplitNit(finding, split)
                ) {
                  finding.blocking = false;
                  finding.description = `About tasks the host split by file after planning (${Object.entries(
                    split,
                  )
                    .map(([original, ids]) => `${original}: ${ids.join(", ")}`)
                    .join("; ")}); kept as a note: ${finding.description}`;
                }
              }
              // Findings about check outcomes stay in the record as notes; checks run later.
              let findings = demoteDeferred(analysis.findings, (f) => f.description);
              // Analysis passes when no finding blocks: the rest are notes, whatever the model's verdict.
              const blocking = findings.some((f) => f.blocking);
              state.analysisPassed = !blocking && analysis.verdict !== "inconclusive";
              const planOnly = state.analysisPassed ? [] : planOnlyFindings(findings);
              const stages = this.stageKinds(runId, v2);
              const plan = stages.findIndex((s) => s.kind === "plan");
              if (planOnly.length && state.analysisReplans === 0 && plan >= 0) {
                if (this.moveTo(state, stages, plan, v2)) {
                  // Gaps in the plan text go back to the planner once before a person is asked.
                  state.analysisReplans = 1;
                  state.prompt += `\nAnalysis findings on the plan; fix every one of them in plan.md and tasks.json:\n${canonical(planOnly.map(({ kind, refs, description }) => ({ kind, refs, description })))}`;
                  advance = false;
                  rerouted = v2 !== null;
                  break;
                }
              }
              // An inconsistency that survived the first reroute gets one more, with the finding
              // text and a note that it is a defect to fix, not a decision to assume.
              const defectRound =
                state.analysisReplans === 2 && findings.some((f) => persistentDefect(f));
              // A scope finding that adds a restriction absent from the request gets the same extra
              // return with the instruction that the request is authoritative; a survivor is assumed.
              const restrictsRound =
                !defectRound &&
                state.analysisReplans === 2 &&
                findings.some((f) => restrictsRequest(f));
              if (
                !state.analysisPassed &&
                policy.clarification === "assume" &&
                (state.analysisReplans < 2 || defectRound || restrictsRound) &&
                findings.some((f) => f.blocking)
              ) {
                const blockingFindings = findings.filter((f) => f.blocking);
                const asking = v2
                  ? stages.findIndex((s) => s.id === v2.stage.id)
                  : state.stageIndex;
                const target = clarificationResumeIndex(stages, asking, {
                  findings: blockingFindings,
                });
                if (target !== asking && this.moveTo(state, stages, target, v2)) {
                  // Findings a default settles go back to the stage they refer to before a person.
                  state.analysisReplans = defectRound || restrictsRound ? 3 : 2;
                  const restricted = blockingFindings.some((f) => restrictsRequest(f));
                  state.prompt += `\nAnalysis findings; resolve every one of them in the artifacts they refer to. ${defectRound ? DEFECT_NOTE : `${restricted ? `${REQUEST_NOTE} ` : ""}Where a finding needs a decision: ${ASSUME_NOTE}`}\n${canonical(blockingFindings.map(({ kind, refs, description }) => ({ kind, refs, description })))}`;
                  advance = false;
                  rerouted = v2 !== null;
                  break;
                }
              }
              // Under assume a person is not asked about what a default settles: the findings that
              // survived the reroute are recorded as assumptions and the run goes on to approval,
              // where a person sees them. A scope finding still asks, unless it only adds a restriction the
              // request lacks: the request wins.
              if (
                !state.analysisPassed &&
                policy.clarification === "assume" &&
                state.analysisReplans >= 2 &&
                analysis.verdict !== "inconclusive" &&
                findings.every((f) => !f.blocking || assumable(f) || restrictsRequest(f))
              ) {
                const assumed = findings.filter((f) => f.blocking);
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "assumption",
                    "assumptions/analysis.json",
                    canonical({
                      assumed: assumed.map(({ id, kind, refs, description }) => ({
                        id,
                        kind,
                        refs,
                        description,
                      })),
                    }),
                  ),
                );
                findings = findings.map((f) =>
                  f.blocking
                    ? {
                        ...f,
                        blocking: false,
                        description: `Assumed under clarification assume (assumptions/analysis.json): ${f.description}`,
                      }
                    : f,
                );
                state.analysisPassed = true;
              }
              if (!state.analysisPassed) {
                this.wait("clarification", state, { findings });
                advance = false;
              }
              break;
            }
            case "approve": {
              if (!state.approvalRoot && this.reviseAfterRejection(runId, state, v2)) {
                advance = false;
                rerouted = v2 !== null;
                break;
              }
              const analyzed =
                state.analysisPassed || (v2 !== null && !produces(v2.definition, "analysis"));
              if (!analyzed || !state.spec || !state.graph || !state.plan)
                throw new WorkflowFault(
                  "OUTPUT_INVALID",
                  "Consistency analysis and artifacts required before approval",
                );
              validateChecks(runRoot(this.store.workspace, state), policy, state.graph);
              if (
                policy.checks.every((c) => !c.required) &&
                state.spec.criteria.some((c) => c.method === "automated")
              )
                throw new WorkflowFault(
                  "INVALID_DEFINITION",
                  "Automated criteria require at least one mandatory command check. Revise the policy before approval.",
                );
              if (
                !state.approvalRoot &&
                policy.sizing &&
                this.sizePlan(runId, state, policy, v2 !== null) !== "continue"
              ) {
                advance = false;
                break;
              }
              if (!state.approvalRoot) {
                const snapshot = await this.snapshot(runId, state, policy, signal);
                const repository = await gitBaseline(runRoot(this.store.workspace, state));
                const writes = state.graph.tasks.flatMap((t) => t.writes);
                // Uncommitted user changes never enter the worktree; approving tasks that write
                // such files needs the user's explicit choice to leave them out.
                const userChanges = state.worktree
                  ? await userChangesInScope(
                      this.store.workspace,
                      writes.map((w) => w.path),
                    )
                  : [];
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "baseline",
                    `baselines/${snapshot.id}.json`,
                    canonical({ snapshotId: snapshot.id, repository }),
                  ),
                );
                state.manifest.baselineSnapshotId = snapshot.id;
                await this.measureQualityBaseline(runId, state, policy, signal);
                const digest = approvalDigest(state);
                // A v2 approval stage marked human never approves on its own.
                const humanStage =
                  v2?.stage.type === "approval" && v2.stage.decision === "human" ? v2 : null;
                const human = humanStage !== null;
                const auto = humanStage
                  ? {
                      approval: null,
                      reasons: [humanApprovalReason(humanStage.definition.id, humanStage.stage.id)],
                    }
                  : userChanges.length
                    ? {
                        approval: null,
                        reasons: [
                          `Approved tasks write files with uncommitted user changes: ${userChanges.join(", ")}`,
                        ],
                      }
                    : evaluateAutoApproval(
                        policy,
                        state.manifest,
                        state.spec,
                        state.graph,
                        this.store.requests(runId),
                        policyDecisions(this.store.artifacts(runId), (artifact) =>
                          this.store.readArtifact(runId, artifact.id),
                        ),
                        {
                          request: coverageRequest(state),
                          hostSplitTasks: state.hostSplitTasks,
                          scaffold: this.baselineScaffold(runId, state),
                          exists: (path) =>
                            existsSync(join(runRoot(this.store.workspace, state), path)),
                        },
                      );
                const body = {
                  manifest: state.manifest,
                  writes,
                  executionMode: executionModeOf(policy),
                  ...(state.worktree
                    ? {
                        worktree: {
                          path: state.worktree.path,
                          branch: state.worktree.branch,
                          baseHead: state.worktree.baseHead,
                          userChangesInScope: userChanges,
                        },
                      }
                    : {}),
                  profiles: [...new Set(state.graph.tasks.map((t) => t.profileId))].sort(),
                  checks: policy.checks,
                  policy,
                  deferredCriteria: state.spec.criteria
                    .filter((c) => c.method === "post-release")
                    .map((c) => c.id),
                  // Defaults the agents chose instead of asking; approving accepts them.
                  assumptions: state.spec.assumptions,
                  ...(state.spec.deliverables
                    ? { requestCoverage: requestCoverage(state.spec, coverageRequest(state)) }
                    : {}),
                  boundedCorrection: true,
                  // Granted walk-through capabilities are shown to the person; the frozen gates
                  // that hold them are part of the manifest the digest covers.
                  ...(v2 && acceptanceGrants(v2.gates).length
                    ? { acceptanceCapabilities: acceptanceGrants(v2.gates) }
                    : {}),
                  ...(policy.autoApproval || human
                    ? { autoApproval: auto.approval ?? { declined: auto.reasons } }
                    : {}),
                };
                if (!auto.approval) {
                  this.queued.push({ kind: "approval", digest, body });
                  advance = false;
                  break;
                }
                this.store.transaction(() => {
                  const requestId = this.store.request(runId, "approval", digest, body);
                  // The host signs the same digest a person would. Post-release criteria get here
                  // only under clarification assume; the record names each one it defers.
                  this.store.decideRequest(
                    runId,
                    requestId,
                    "accepted",
                    {
                      digest,
                      autoApproval: auto.approval,
                      deferredCriteria: body.deferredCriteria,
                    },
                    true,
                  );
                  this.store.setApproval(runId, digest);
                  state.approvalRoot = digest;
                  state.deferredCriteria = body.deferredCriteria;
                });
              }
              break;
            }
            case "task-graph": {
              const unavailable = dependencyContracts(this.store, state).filter(
                (dependency) =>
                  !dependency.completed &&
                  state.manualCriteria[`dependency-${dependency.featureId}`]?.snapshotId !==
                    state.snapshotId,
              );
              if (unavailable.length) {
                for (const dependency of unavailable)
                  this.wait("manual_evidence", state, {
                    criterionId: `dependency-${dependency.featureId}`,
                    snapshotId: state.snapshotId,
                    dependency,
                    question:
                      "Provide evidence that this dependency is ready for downstream execution.",
                  });
                advance = false;
                break;
              }
              await this.recordCheckBaseline(runId, state, policy, signal);
              if (policy.maxConcurrentWriters > 1 && state.worktree)
                await this.implementParallel(runId, stepId, state, policy, profiles, signal);
              else await this.implement(runId, stepId, state, policy, profiles, signal);
              break;
            }
            case "wait": {
              const failed = v2
                ? await this.runWaitStage(runId, stepId, state, policy, v2, signal)
                : null;
              if (failed) {
                repairFindings = { findings: failed, kind: "repair" };
                advance = false;
              }
              break;
            }
            case "checks": {
              const failed = v2
                ? await this.runCheckStage(runId, stepId, state, policy, v2, signal)
                : await this.runChecks(runId, stepId, state, policy, signal);
              if (failed.length) {
                repairFindings = { findings: failed, kind: "repair" };
                advance = false;
              }
              break;
            }
            case "review": {
              if (v2 && !state.snapshotId) {
                // A review-only run reviews the frozen diff on the snapshot it starts from.
                await this.snapshot(runId, state, policy, signal);
                const diff = state.diff;
                if (diff)
                  this.store.transaction(() =>
                    this.store.addEvidence(runId, "diff", state.snapshotId ?? "", diff.artifactId),
                  );
              }
              await this.addReviewBundle(runId, state, signal);
              const failures = await this.review(
                runId,
                stepId,
                state,
                policy,
                profiles,
                signal,
                v2 ? this.v2Reviewers(runId, state, v2) : this.v1Reviewers(state, policy),
                !v2 || v2.definition.stages.some((s) => s.type === "reflection"),
              );
              if (failures.length) {
                repairFindings = { findings: failures, kind: "repair" };
                advance = false;
              }
              break;
            }
            case "report": {
              const report = ReportSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  {},
                  signal,
                ),
              );
              state.report = canonical(report);
              this.store.transaction(() =>
                this.store.artifact(runId, "report", "report.json", state.report ?? ""),
              );
              break;
            }
            case "decompose": {
              const plan = InitiativePlanSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  { initiativeBounds: { minFeatures: MIN_FEATURES, maxFeatures: MAX_FEATURES } },
                  signal,
                  undefined,
                  0,
                  // Graph defects go back to the decomposer; the size bound is the initiative's
                  // decision, so an oversized split is kept and refused there with a reason.
                  (output) => {
                    const parsed = InitiativePlanSchema.safeParse(output);
                    return parsed.success
                      ? planStructureProblems(parsed.data)
                      : [parsed.error.message];
                  },
                ),
              );
              const problems = planStructureProblems(plan);
              if (problems.length) throw new WorkflowFault("OUTPUT_INVALID", problems.join("\n"));
              state.initiativePlan = canonical(plan);
              this.store.transaction(() =>
                this.store.artifact(
                  runId,
                  "initiative-plan",
                  "initiative-plan.json",
                  state.initiativePlan ?? "",
                ),
              );
              break;
            }
            case "converge": {
              if (!state.spec || !state.snapshotId || !state.workspaceHash)
                throw new WorkflowFault("ARTIFACT_MISSING", "Missing convergence context");
              const earlier = earlierFindings(this.store, runId);
              const review = ReviewSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  {
                    evidence: this.evidenceContext(runId, state),
                    ...(earlier.length ? { earlierFindings: earlier, repeatOf: REPEAT_NOTE } : {}),
                    ...(Object.keys(state.reviewGaps).length
                      ? {
                          evidenceGaps: {
                            note: "A required reviewer could not establish these criteria from the code and the evidence. For each automated one, name the test or declared check that would establish it so a convergence task adds it; do not pass a criterion without evidence.",
                            byReviewer: state.reviewGaps,
                          },
                        }
                      : {}),
                  },
                  signal,
                  undefined,
                  0,
                  (output) => {
                    const parsed = ReviewSchema.safeParse(output);
                    if (!parsed.success || !state.spec || !state.snapshotId) return [];
                    return reviewProblems(
                      this.store,
                      runId,
                      state.snapshotId,
                      state.workspaceHash ?? "",
                      state.spec,
                      output as Review,
                      false,
                    );
                  },
                ),
              );
              completeReview(
                this.store,
                runId,
                state.snapshotId,
                state.workspaceHash,
                state.spec,
                review,
                false,
              );
              const omitted = state.spec.criteria.filter(
                (criterion) => !review.coverage.some((item) => item.criterionId === criterion.id),
              );
              if (omitted.length) {
                const report = this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "review",
                    `coverage/${newId()}.json`,
                    canonical(review),
                  ),
                );
                const evidenceId = this.store.transaction(() =>
                  this.store.addEvidence(runId, "review", state.snapshotId ?? "", report.id),
                );
                for (const criterion of omitted) {
                  review.coverage.push({
                    criterionId: criterion.id,
                    verdict: "inconclusive",
                    evidenceIds: [],
                    explanation: "Criterion omitted from the convergence report",
                  });
                  if (criterion.method === "automated")
                    review.findings.push({
                      id: newId(),
                      kind: "missing",
                      severity: "high",
                      requirementIds: criterion.requirementIds,
                      criterionIds: [criterion.id],
                      file: null,
                      symbol: null,
                      evidenceIds: [evidenceId],
                      claim: `Criterion ${criterion.id} has no coverage`,
                      impact: "Acceptance cannot be established",
                      suggestedFix: `Implement or demonstrate ${criterion.id} within approved task scope and repeat checks.`,
                    });
                }
                review.verdict = "changes_requested";
              }
              validateReview(
                this.store,
                runId,
                state.snapshotId,
                state.workspaceHash,
                state.spec,
                review,
                true,
              );
              state.convergence = review;
              this.store.transaction(() => {
                for (const item of review.coverage)
                  this.store.criterion(runId, state.snapshotId ?? "", item);
              });
              const severities = repairSeverities(this.store.run(runId));
              const failing = new Set(
                review.coverage
                  .filter(
                    (c) =>
                      c.verdict === "fail" ||
                      (c.verdict === "inconclusive" &&
                        state.spec?.criteria.find((s) => s.id === c.criterionId)?.method ===
                          "automated"),
                  )
                  .map((c) => c.criterionId),
              );
              // A low `partial` finding behind verified behavior passes with notes: it is recorded in
              // the run report and starts no repair, and a criterion that fails only because of
              // such findings counts as met.
              const checksPass = requiredChecksPass(this.store, runId, state, policy);
              const notes = new Set(
                review.findings
                  .filter((f) => passesWithNotes(f, review.coverage, checksPass))
                  .map((f) => f.id),
              );
              const noteOnly = (id: string): boolean => {
                const named = review.findings.filter((f) => f.criterionIds.includes(id));
                return named.length > 0 && named.every((f) => notes.has(f.id));
              };
              const repairing = (f: Review["findings"][number]): boolean =>
                (severities.includes(f.severity) && findingBlocks(f, policy.reviewMinConfidence)) ||
                f.criterionIds.some((id) => failing.has(id));
              const noted = review.findings.filter((f) => notes.has(f.id) && repairing(f));
              for (const id of [...failing]) if (noteOnly(id)) failing.delete(id);
              if (noted.length) {
                const recorded = this.recordFindings(runId, review, noted);
                this.store.transaction(() =>
                  acceptResidual(this.store, runId, state, { findings: recorded }, "notes"),
                );
              }
              // Below the severity floor a finding still repairs when it is why a criterion fails:
              // acceptance needs every automated criterion to pass.
              const repair = review.findings.filter(
                (f) =>
                  !notes.has(f.id) &&
                  ((severities.includes(f.severity) &&
                    findingBlocks(f, policy.reviewMinConfidence)) ||
                    f.criterionIds.some((id) => failing.has(id))),
              );
              const findings = this.recordFindings(runId, review, repair);
              const kept = new Set([...repair, ...noted].map((f) => f.id));
              addReviewNotes(
                state.reviewNotes,
                "convergence",
                state.snapshotId,
                review.findings
                  .filter((f) => !kept.has(f.id))
                  .map((finding) => ({
                    finding,
                    reason: noteReason(finding, severities, policy.reviewMinConfidence),
                  })),
              );
              if (findings.length) {
                repairFindings = { findings, kind: "convergence" };
                advance = false;
              } else {
                if (failing.size) {
                  // An inconclusive criterion no finding names is a limit of the environment, not
                  // an output defect: it becomes a known limitation (propdrift eea2e0e9 AC-008).
                  const failed = [...failing].filter(
                    (id) =>
                      review.coverage.find((c) => c.criterionId === id)?.verdict !== "inconclusive",
                  );
                  if (failed.length)
                    throw new WorkflowFault(
                      "OUTPUT_INVALID",
                      "Coverage is incomplete without an actionable finding",
                    );
                  noteUnverifiedCriteria(
                    state,
                    review.coverage,
                    [...failing],
                    this.store.run(runId).convergence_rounds,
                  );
                }
                const pending = state.spec.criteria.filter(
                  (c) =>
                    c.method === "manual" &&
                    state.manualCriteria[c.id]?.snapshotId !== state.snapshotId,
                );
                if (pending.length) {
                  for (const criterion of pending)
                    this.wait("manual_evidence", state, {
                      criterionId: criterion.id,
                      snapshotId: state.snapshotId,
                      criterion,
                    });
                  advance = false;
                }
              }
              break;
            }
            case "learn": {
              const resolved = this.store
                .findings(runId)
                .filter((f) => f.status === "resolved" && f.repair_task_id);
              if (resolved.length)
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "learning-candidate",
                    "learning/candidate.json",
                    canonical({
                      featureId: run.feature_id,
                      category: "gotcha",
                      source: "agent",
                      scope: "project",
                      findings: resolved.map((f) => ({
                        id: f.id,
                        claim: JSON.parse(f.body_json).claim,
                        repairTaskId: f.repair_task_id,
                      })),
                      evidenceIds: this.store
                        .evidence(runId)
                        .filter(
                          (e) => e.validity === "current" && e.snapshot_id === state.snapshotId,
                        )
                        .map((e) => e.id),
                      automaticAdoption: false,
                    }),
                  ),
                );
              break;
            }
          }
          if (repairFindings && !v2) {
            // A stopped convergence is a decision for a person (or the assume rule), not a block.
            const halt =
              repairFindings.kind === "convergence"
                ? this.haltConvergence(runId, state, policy, repairFindings.findings)
                : "go";
            if (halt === "go")
              this.repair(runId, state, policy, repairFindings.findings, repairFindings.kind);
            else if (halt === "accepted") {
              advance = true;
              repairFindings = null;
            }
          }
          signal.throwIfAborted();
          await this.assertWorkspace(runId, state, policy, signal);
          const waiting = this.queued.length > 0;
          if (
            v2 &&
            state.position &&
            !rerouted &&
            !waiting &&
            this.store.run(runId).status === "running"
          ) {
            // The visit is decided; the next pass takes the transition that answers it.
            state.position.outcome = this.outcomeOf(v2.stage, repairFindings !== null);
            state.position.findings = repairFindings?.findings.map((f) => f.id) ?? [];
            state.position.repairKind = repairFindings?.kind ?? null;
          } else if (advance && !v2) state.stageIndex++;
          // The state, the requests it raised, the waiting status and the finished step are one
          // durable change, written only after the workspace check passed.
          this.store.transaction(() => {
            this.flushWaits(runId, state);
            this.store.finishStep(
              runId,
              stepId ?? "",
              this.store.run(runId).status === "waiting" ? "waiting" : "completed",
            );
          });
          stepId = null;
        }
      });
    } catch (error) {
      // Requests of a step that failed never reach the store: the step runs again and raises
      // them on the state it then has.
      this.queued = [];
      await this.processes.stop();
      const fault =
        signal.aborted && signal.reason instanceof WorkflowFault ? signal.reason : error;
      this.store.transaction(() => {
        if (stepId) this.store.finishStep(runId, stepId, signal.aborted ? "interrupted" : "failed");
        const status = this.store.run(runId).status;
        if (["paused", "cancelled", "waiting"].includes(status)) return;
        if (fault instanceof WorkflowFault && fault.code === "CHECKPOINT_REACHED") {
          // A soft checkpoint is a durable question, not a failure: the run waits for the user.
          const usage = budgetUsage(this.store, this.store.run(runId));
          const body = {
            stageId: this.store.run(runId).stage_id,
            boundary: fault.details.boundary,
            interval: fault.details.interval,
            projectedTokens: fault.details.projected,
            usedTokens: usage.tokens,
            heldTokens: usage.heldTokens,
            calls: usage.calls,
          };
          this.store.request(runId, "checkpoint", hashJson(body), body);
          this.store.transition(runId, "waiting", "checkpoint");
          return;
        }
        // An effect nobody can settle is a question for a person, not a block with no request.
        if (
          fault instanceof WorkflowFault &&
          fault.code === "RECOVERY_REQUIRED" &&
          Array.isArray(fault.details.effectIds)
        ) {
          requestRecovery(this.store, runId, fault.details.effectIds.map(String));
          return;
        }
        const code = fault instanceof WorkflowFault ? fault.code : "OUTPUT_INVALID";
        const explicitReason =
          fault instanceof WorkflowFault ? ReasonCode.safeParse(fault.details.reason) : null;
        const reason = explicitReason?.success
          ? explicitReason.data
          : fault instanceof WorkflowFault && fault.details.reason === "provider_unavailable"
            ? "provider_unavailable"
            : code === "BUDGET_EXHAUSTED"
              ? "budget_exhausted"
              : code === "INPUT_CHANGED"
                ? "input_changed"
                : code === "CAPABILITY_DENIED"
                  ? "tool_denied"
                  : code === "RECOVERY_REQUIRED"
                    ? "no_progress"
                    : isStoreError(fault)
                      ? "storage_failure"
                      : code === "STALE_DECISION" || code === "ARTIFACT_MISSING"
                        ? "host_state"
                        : "invalid_output";
        this.store.artifact(
          runId,
          "diagnostic",
          `errors/${newId()}.txt`,
          // A schema rejection keeps what the schema said, so a resume can tell the agent.
          fault instanceof WorkflowFault && typeof fault.details.validation === "string"
            ? `${fault.message}\n${fault.details.validation}`
            : fault instanceof Error
              ? fault.message
              : String(fault),
        );
        this.store.transition(
          runId,
          outerSignal.aborted ? "paused" : "blocked",
          outerSignal.aborted ? "user_pause" : reason,
        );
      });
    } finally {
      forgetProgress(runId);
      clearInterval(poll);
      clearTimeout(timeout);
      this.idle = (sleep) => sleep();
      outerSignal.removeEventListener("abort", abort);
      leaseSignal.removeEventListener("abort", leaseLost);
      await this.processes.stop();
      try {
        this.store.transaction(() =>
          this.store.addActiveTime(runId, performance.now() - started - idleMs),
        );
      } finally {
        this.leases.release();
      }
    }
  }
  /**
   * Once per task, an attempt that stopped at its step or token cap after editing files gets
   * another with both caps raised by half, instead of blocking the run for a manual resume. Test
   * tasks stopped at the cap with the work nearly done (runs 7df4e666, b0d7484c, 8e117dfa).
   */
  private continueAtCap(runId: string, state: RuntimeState, stepId: string, task: Task): boolean {
    if ((state.taskContinuations[task.id] ?? 0) > 0) return false;
    const record = this.lastAttemptUsage(runId, stepId);
    // An attempt the progress watcher stopped was stuck, not short of room.
    if (!record || record.finalizedBy === null || record.finalizedBy === "watcher") return false;
    state.taskContinuations[task.id] = 1;
    state.taskBudgets[task.id] = Math.ceil(record.maxTokens * 1.5);
    state.taskSteps[task.id] = Math.ceil(record.maxSteps * 1.5);
    return true;
  }
  /** The usage record of the latest attempt of a step, when the executor wrote one. */
  private lastAttemptUsage(runId: string, stepId: string): AttemptUsageRecord | undefined {
    const attempt = this.store
      .attempts(runId)
      .filter((a) => a.step_id === stepId)
      .at(-1);
    const usage = attempt
      ? this.store.latestArtifact(runId, `attempts/${attempt.id}/usage.json`)
      : undefined;
    return usage
      ? (JSON.parse(this.store.readArtifact(runId, usage.id)) as AttemptUsageRecord)
      : undefined;
  }
  /**
   * Why a task that ended without a complete implementation gets one more attempt in a fresh
   * session, or null. Host facts decide it, not the worker's wording: a session that made no tool
   * call and submitted nothing lost its tools (run 982ba3e1, `read`); under `clarification:
   * assume` any other blocked implementer restarts once too, since a plain resume cleared all of
   * the blocked tasks of round 6. A person is asked only when the restart ends the same way.
   */
  private blockedRestartReason(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    stepId: string,
    task: Task,
    result: { outcome: string; summary: string; unresolved: string[] },
    changed: string[],
    proseEnd = false,
  ): string | null {
    if ((state.taskRestarts[task.id] ?? 0) > 0) return null;
    const unfinished =
      ["blocked", "failed"].includes(result.outcome) || result.unresolved.length > 0;
    if (!unfinished) return null;
    // The host's own record that the session ended on text; the worker's wording is not consulted.
    if (proseEnd) return "its session ended on a text reply and never submitted a result";
    if (changed.length === 0 && reportsLostTool(result))
      return "a tool was unavailable to its worker, which submitted no change";
    const usage = this.lastAttemptUsage(runId, stepId);
    if (
      changed.length === 0 &&
      usage?.stopReason === "no_submission" &&
      usage.steps.reduce((sum, step) => sum + step.toolCalls, 0) === 0
    )
      return "its session made no tool call and submitted no result, so it had no working tools";
    if (policy.clarification !== "assume") return null;
    return `the worker ended ${result.outcome === "implemented" ? "unfinished" : result.outcome} under clarification assume`;
  }
  /** The worker's own account of the attempt a restart replaces, for the fresh session's prompt. */
  private previousAttempt(
    runId: string,
    taskId: string,
  ): { previousAttempt?: { summary: string; unresolved: string[]; note: string } } {
    const artifact = this.store.latestArtifact(runId, `tasks/restarts/${taskId}.json`);
    if (!artifact) return {};
    const record = JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
      summary?: string;
      unresolved?: string[];
    };
    if (!record.summary && !record.unresolved?.length) return {};
    return {
      previousAttempt: {
        summary: record.summary ?? "",
        unresolved: record.unresolved ?? [],
        note: "An earlier session of this task ended without a complete implementation, as described here. Start from the current files and finish what it left; do not repeat its failed approach.",
      },
    };
  }
  /**
   * The input of a corrective task that starts from a clean context (convergence.ts
   * `freshRestartAfter`): only the evidence its own findings cite, no earlier attempt's diffs or
   * logs, and the host's account of what the earlier corrections tried.
   */
  private freshStart(
    runId: string,
    state: RuntimeState,
    task: Task,
  ): { only?: ReadonlySet<string>; extra: { freshStart?: { summary: string; note: string } } } {
    const artifactId = state.freshTasks[task.id];
    if (!artifactId) return { extra: {} };
    const record = JSON.parse(this.store.readArtifact(runId, artifactId)) as { summary: string };
    const cited = this.store
      .findings(runId)
      .filter((row) => task.findingIds.includes(row.id))
      .flatMap(
        (row) => (JSON.parse(row.body_json) as { evidenceIds?: string[] }).evidenceIds ?? [],
      );
    return {
      only: new Set(cited),
      extra: {
        freshStart: {
          summary: record.summary,
          note: "Earlier corrections of this failure did not change it. This session starts clean: read the current files and the cited evidence, find the cause yourself, and take a different approach. If the cause lies outside the files you may edit, say so in unresolved.",
        },
      },
    };
  }
  /**
   * Files the finished corrective tasks (repair, convergence) of the run changed; null when one of
   * their diffs is missing.
   */
  private correctedFiles(runId: string, tasks: Task[], rows: TaskRow[]): Set<string> | null {
    const done = tasks.filter(
      (task) =>
        task.origin !== "planned" &&
        rows.some((row) => row.id === task.id && ["implemented", "verified"].includes(row.status)),
    );
    return repairChangedFiles(this.store, runId, done);
  }
  /**
   * Before the agent runs a planned task again (a repair or correction invalidated it), its declared
   * checks (any scope) run in the host: when they pass on the current files and the task's earlier
   * implementation, which passed them under the same definition, is in place, the task is implemented by supersession, with an empty diff and
   * no tokens, and the gate check below it runs as for any implemented task. A rerun that ended
   * with an empty diff in round 6 cost 3.08M tokens of 17.5M. Returns whether any task changed.
   */
  private async hostFirstReruns(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
    ready: Task[],
  ): Promise<boolean> {
    let progressed = false;
    for (const task of ready) {
      const row = this.store.tasks(runId).find((entry) => entry.id === task.id);
      const path = `tasks/${task.id}/host-first-${String(row?.generation ?? 0)}.json`;
      const checks = declaredChecks(policy, task);
      const root = runRoot(this.store.workspace, state);
      if (
        !row ||
        task.origin !== "planned" ||
        row.generation === 0 ||
        row.status === "interrupted" ||
        !checks.length ||
        !task.writes.length ||
        // Its earlier implementation passed its checks under this very definition; a revision
        // that changed it (or reset the gates) always implements it again.
        state.taskGates[task.id]?.definitionHash !== hashJson(task) ||
        !this.store.latestArtifact(runId, `tasks/${task.id}/diff.json`) ||
        this.store.latestArtifact(runId, path) ||
        task.writes.some((w) => w.action !== "delete" && !existsSync(workspacePath(root, w.path)))
      )
        continue;
      signal.throwIfAborted();
      const child = this.store.transaction(() =>
        this.store.beginStep(runId, `task-${task.id}`, stepId),
      );
      let passed = true;
      for (const check of checks) {
        const checked = await this.runTaskCheck(runId, child, check, policy, signal, root);
        if (checked.status !== "passed") {
          passed = false;
          break;
        }
      }
      if (passed) await this.snapshot(runId, state, policy, signal);
      this.store.transaction(() => {
        this.store.artifact(runId, "recovery", path, canonical({ taskId: task.id, passed }));
        if (passed) {
          const diff = this.store.artifact(
            runId,
            "diff",
            `tasks/${task.id}/diff.json`,
            canonical({ changed: [], before: {}, after: {}, patch: "" }),
          );
          this.store.addEvidence(runId, "diff", state.snapshotId ?? "", diff.id);
          this.store.taskStatus(runId, task.id, "implemented", state.snapshotId);
        }
        this.store.finishStep(runId, child, "completed");
        this.store.saveState(runId, state);
      });
      progressed ||= passed;
    }
    return progressed;
  }
  /** The planned graph with its oversized test tasks split by file, recorded when it splits. */
  private splitTests(runId: string, graph: TaskGraph, policy: RunPolicy): TaskGraph {
    const report = sizePlan({
      graph,
      policy,
      samples: sizingHistory(this.store.workspace, policy),
      spent: this.store.run(runId).token_usage,
      model: this.sizingModel(runId, graph),
    });
    const split = splitTestTasks(graph, report);
    if (!split) return graph;
    const revision = this.store.state(runId).sizingReplans;
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "sizing",
        `sizing/split-${String(revision)}.json`,
        canonical({ reasons: report.reasons, tasks: split.tasks.map((t) => t.id) }),
      ),
    );
    return split;
  }
  /**
   * Before the first task of an update run, runs each feature check once on the code the run starts
   * from and stores the counts its output reports (a linter's diagnostics, a test runner's tests)
   * as `facts/check-baseline.json`. The checks stage compares the same commands with it.
   * Nothing is measured for a scaffold, after a task has started, or for output no parser reads.
   */
  private async recordCheckBaseline(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.store.latestArtifact(runId, CHECK_BASELINE_PATH)) return;
    const feature = policy.checks.filter((check) => check.scope === "feature");
    if (!feature.length || this.baselineScaffold(runId, state)) return;
    const fresh = this.store.tasks(runId).every((task) => task.status === "pending");
    const counts: Record<string, BaselineCount[]> = {};
    if (fresh)
      for (const check of feature) {
        const result = await this.checks.measure(
          check,
          signal,
          runRoot(this.store.workspace, state),
        );
        if (result.truncated || result.status === "inconclusive") continue;
        const found = outputCounts(result.output, result.status === "passed");
        if (found.length) counts[commandKey(check)] = found;
      }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "facts",
        CHECK_BASELINE_PATH,
        canonical({ schemaVersion: 1, measured: fresh, counts }),
      ),
    );
  }
  /** What a passing required check fell behind the baseline by, as a failure reason; else null. */
  private checkRegression(
    runId: string,
    state: RuntimeState,
    check: Check,
    output: string,
  ): string | null {
    const artifact = this.store.latestArtifact(runId, CHECK_BASELINE_PATH);
    if (!artifact) return null;
    const baseline = (
      JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
        counts?: Record<string, BaselineCount[]>;
      }
    ).counts?.[commandKey(check)];
    if (!baseline?.length) return null;
    const deletesTests = (state.graph?.tasks ?? []).some((task) =>
      task.writes.some((w) => w.action === "delete" && TEST_FILE.test(w.path)),
    );
    const regressions = baseline.flatMap(
      (count) => baselineRegression(count, output, deletesTests) ?? [],
    );
    return regressions.length ? regressions.join("; ") : null;
  }
  /** Whether the workspace the run started from held no source files (empty or a scaffold). */
  private baselineScaffold(runId: string, state: RuntimeState): boolean {
    const first = this.store
      .artifacts(runId)
      .find((artifact) => artifact.logical_path === "facts/workspace.json");
    try {
      const facts = first
        ? (JSON.parse(this.store.readArtifact(runId, first.id)) as Pick<WorkspaceFacts, "kind">)
        : workspaceFacts(runRoot(this.store.workspace, state));
      return hasNoSource(facts);
    } catch {
      return false;
    }
  }
  /**
   * The host inventory of the workspace the run starts from, taken once before research and stored
   * as `facts/workspace.json`: later stages read the same facts (the run's own published specs
   * must not turn into "existing files"), and every front end shows what the stages were told.
   */
  private recordFacts(runId: string, root: string): WorkspaceFacts {
    const latest = this.store.latestArtifact(runId, "facts/workspace.json");
    if (latest) {
      try {
        const stored = JSON.parse(this.store.readArtifact(runId, latest.id)) as WorkspaceFacts;
        if (stored.schemaVersion === 1 && Array.isArray(stored.files)) return stored;
      } catch {
        // An unreadable record is rebuilt below.
      }
    }
    const facts = workspaceFacts(root);
    this.store.transaction(() =>
      this.store.artifact(runId, "facts", "facts/workspace.json", canonical(facts)),
    );
    return facts;
  }
  /** Every package problem the scheduler would reject, as messages the planner can act on. */
  private planProblems(
    runId: string,
    spec: Spec,
    plan: { markdown: string; taskGraph: TaskGraph },
    policy: RunPolicy,
    profiles: AgentProfile[],
  ): string[] {
    const graph = planGraph(spec, plan, policy, profiles);
    const problems: string[] = [];
    const root = this.rootOf(runId);
    try {
      validatePackage(root, spec, plan.markdown, graph);
    } catch (error) {
      problems.push(...(error instanceof Error ? error.message : String(error)).split("\n"));
    }
    problems.push(
      ...planConsistencyProblems(
        root,
        spec,
        plan.markdown,
        graph,
        (path) => createdByRunLineage(this.store, runId, path, fileHash(workspacePath(root, path))),
        policy.allowOverlappingWrites === true,
      ),
    );
    for (const task of graph.tasks) {
      if (!profiles.some((p) => p.id === task.profileId && p.output === "implementation"))
        problems.push(`Unknown implementation profile ${task.profileId}`);
      if (task.checkIds.some((id) => !policy.checks.some((c) => c.id === id)))
        problems.push(`Unknown checks for ${task.id}`);
    }
    return problems;
  }
  /** The directory the run reads, edits, checks and snapshots: its worktree or the project. */
  private rootOf(runId: string): string {
    return runRoot(this.store.workspace, this.store.state(runId));
  }
  /**
   * The models and effort of an agent call from the run's frozen routing: the route of the
   * definition stage this step belongs to, else the profile's own route. Child steps (tasks,
   * review dimensions, skeptics) follow their parent stage; transition gates have no stage and
   * keep the profile's route. The first model is the primary; the rest are its fallback chain.
   */
  private route(
    runId: string,
    stepId: string,
    profile: AgentProfile,
  ): { models: string[]; effort?: RouteEffort } {
    return this.stageRoute(runId, this.store.rootStage(runId, stepId), profile);
  }
  private stageRoute(
    runId: string,
    stage: string | null | undefined,
    profile: AgentProfile,
  ): { models: string[]; effort?: RouteEffort } {
    const routing = this.routingRecord(runId);
    if (!routing) return { models: [profile.model] };
    // The critic judges the task stage's work, so the stage's route does not apply to it.
    const staged = stage && profile.output !== "critique" ? routing.stages[stage] : undefined;
    const own = routing.profiles[profile.id];
    const entry = staged ?? own;
    // The frozen profile keeps its start model; a reroute changes only the record.
    return {
      models: [staged?.model ?? own?.model ?? profile.model, ...(entry?.fallback ?? [])],
      ...(entry?.effort ? { effort: entry.effort } : {}),
    };
  }
  /** The run's frozen routing record, cached; null for runs started before routing. */
  private routingRecord(runId: string): RoutingRecord | null {
    let routing = this.routing.get(runId);
    if (routing === undefined) {
      const row = this.store.latestArtifact(runId, ROUTING_ARTIFACT);
      routing = row
        ? RoutingRecordSchema.parse(JSON.parse(this.store.readArtifact(runId, row.id)))
        : null;
      this.routing.set(runId, routing);
    }
    return routing;
  }
  /** The profile running on the model at `index` of its route's chain. */
  private routed(runId: string, stepId: string, profile: AgentProfile, index = 0): AgentProfile {
    const model = this.route(runId, stepId, profile).models[index] ?? profile.model;
    return model === profile.model ? profile : { ...profile, model };
  }
  /**
   * The model the plan's tasks will run on, as routing sends the profile most of them name to the
   * task-graph stage; sizing prices them from that model's history. Null when it is not known.
   */
  private sizingModel(runId: string, graph: TaskGraph | null): string | null {
    try {
      const run = this.store.run(runId);
      const profiles = ProfileSchema.array().parse(JSON.parse(run.profiles_json));
      const counts = new Map<string, number>();
      for (const task of graph?.tasks ?? [])
        counts.set(task.profileId, (counts.get(task.profileId) ?? 0) + 1);
      const named = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      const profile =
        profiles.find((p) => p.id === named) ?? profiles.find((p) => p.id === "implementer");
      if (!profile) return null;
      const stage = WorkflowSchema.parse(JSON.parse(run.definition_json)).stages.find(
        (s) => s.kind === "task-graph",
      )?.id;
      return this.stageRoute(runId, stage, profile).models[0] ?? profile.model;
    } catch {
      return null;
    }
  }
  private requireProfile(profile: AgentProfile | undefined): AgentProfile {
    if (!profile) throw new WorkflowFault("INVALID_REFERENCE", "Stage profile is missing");
    return profile;
  }
  private async snapshot(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ) {
    const files = await sourceManifest(
      runRoot(this.store.workspace, state),
      generatedPaths(policy),
      signal,
    );
    const snapshot = this.store.transaction(() => this.store.putSnapshot(runId, files));
    state.snapshotId = snapshot.id;
    state.workspaceHash = snapshot.hash;
    state.expectedFiles = files;
    return snapshot;
  }
  private async assertWorkspace(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    if (!state.expectedFiles) return;
    const files = await sourceManifest(
      runRoot(this.store.workspace, state),
      generatedPaths(policy),
      signal,
    );
    // The run's own journaled edits since the last snapshot are kept (an attempt that was
    // interrupted or failed, an invalidated task): they are the run's baseline, not an outside change.
    const expected = state.expectedFiles;
    const differing = [...new Set([...Object.keys(files), ...Object.keys(expected)])].filter(
      (path) => files[path] !== expected[path],
    );
    if (
      differing.length &&
      differing.every((path) => runWrittenHash(this.store, runId, path) === (files[path] ?? null))
    ) {
      state.expectedFiles = files;
      this.store.transaction(() => this.store.saveState(runId, state));
      return;
    }
    if (differing.length) {
      if (state.snapshotId)
        this.store.transaction(() =>
          this.store.invalidateEvidence(runId, state.snapshotId ?? "", "source_changed"),
        );
      throw new WorkflowFault(
        "INPUT_CHANGED",
        "Sources changed outside the active task; revise or revalidate before continuing",
      );
    }
  }
  private async call(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    stageProfile: AgentProfile,
    extra: unknown,
    signal: AbortSignal,
    task?: Task,
    retry = 0,
    validate?: (output: unknown) => string[],
    limits?: { maxSteps: number; maxTokens: number | undefined },
    hostTools?: (attemptId: string) => Record<string, HostTool>,
    placement: {
      root?: string;
      attemptId?: string;
      /** Position in the route's model chain: 0 is the primary model, then its fallbacks. */
      fallbackIndex?: number;
      /** The primary model's failure, reported if every fallback model fails too. */
      primaryError?: unknown;
      /** Set on the one retry that follows an attempt that ended at its step cap unsubmitted. */
      stepRetry?: boolean;
    } = {},
  ): Promise<unknown> {
    const route = this.route(runId, stepId, stageProfile);
    const fallbackIndex = placement.fallbackIndex ?? 0;
    const profile = this.routed(runId, stepId, stageProfile, fallbackIndex);
    const prompt = this.promptFor(runId, state, policy, profile, extra);
    const inputHash = this.store.run(runId).input_hash;
    // A batch of parallel tasks reserves its attempts before any of them starts.
    const attempt =
      placement.attemptId ??
      this.store.reserve(
        runId,
        stepId,
        profile.model,
        reserveTokens(prompt, profile, policy),
        policy,
      );
    try {
      const result = await this.executor.execute({
        runId,
        attemptId: attempt,
        profile,
        prompt,
        task,
        signal,
        root: placement.root ?? runRoot(this.store.workspace, state),
        maxSteps:
          limits?.maxSteps ??
          (task ? taskSize(state, task, "taskSteps") : undefined) ??
          Math.min(profile.maxSteps, policy.maxAgentSteps),
        ...(limits?.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
        ...(task && taskSize(state, task, "taskBudgets")
          ? { attemptTokens: taskSize(state, task, "taskBudgets") }
          : {}),
        ...(validate ? { validate } : {}),
        ...(this.formatHints(runId, state, profile.output, task)
          ? { formatHints: this.formatHints(runId, state, profile.output, task) }
          : {}),
        ...(hostTools ? { hostTools: hostTools(attempt) } : {}),
        ...(route.effort ? { effort: route.effort } : {}),
      });
      const parsed = outputSchemas[profile.output]?.safeParse(result.output);
      if (!parsed?.success)
        throw new WorkflowFault("OUTPUT_INVALID", `Invalid ${profile.output} result`, {
          validation: parsed?.error.message ?? "Unknown schema",
        });
      const output = parsed.data;
      if (Buffer.byteLength(canonical(output)) > 256 * 1024)
        throw new WorkflowFault("OUTPUT_INVALID", "Structured result exceeds 256 KiB");
      this.store.transaction(() => {
        this.store.finishAttempt(
          runId,
          attempt,
          "completed",
          result.usageComplete === false
            ? null
            : result.inputTokens === null || result.outputTokens === null
              ? this.store.recordedUsage(runId, attempt)
              : result.inputTokens + result.outputTokens,
        );
        this.store.artifact(
          runId,
          profile.output,
          `attempts/${attempt}/result.json`,
          canonical(output),
        );
      });
      if (
        this.store.run(runId).input_hash !== inputHash ||
        this.store.run(runId).status !== "running"
      )
        throw new WorkflowFault("INPUT_CHANGED", "Late result from an invalidated attempt");
      return output;
    } catch (error) {
      // The executor records the spend of every finished model step, so a failed or cancelled
      // attempt is charged what it used. Without such a record the usage is unknown and the
      // reservation stays held.
      if (this.store.attempts(runId).find((a) => a.id === attempt)?.status === "running")
        this.store.transaction(() =>
          this.store.finishAttempt(
            runId,
            attempt,
            signal.aborted ? "cancelled" : "failed",
            this.store.recordedUsage(runId, attempt),
          ),
        );
      const wrote = this.store.effects(runId).some((effect) => effect.attempt_id === attempt);
      const refusal = accountRefusal(error);
      // Another model on the same provider shares the refused account; one elsewhere does not.
      const provider = (model: string) => model.split("/")[0];
      const elsewhere = refusal
        ? route.models.findIndex(
            (model, index) => index > fallbackIndex && provider(model) !== provider(profile.model),
          )
        : -1;
      if (refusal && elsewhere > 0 && !signal.aborted && !wrote)
        return this.call(
          runId,
          stepId,
          state,
          policy,
          stageProfile,
          extra,
          signal,
          task,
          0,
          validate,
          limits,
          hostTools,
          {
            ...(placement.root ? { root: placement.root } : {}),
            fallbackIndex: elsewhere,
            primaryError: placement.primaryError ?? error,
          },
        );
      if (refusal && !signal.aborted)
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `${profile.model} refused the request: ${refusal === "credits" ? "the provider account has no credits or quota left; add credits, then resume the run" : "the provider rejected the API key; fix the key, then resume the run"}, or move the run to another model with baked workflow reroute ${runId} --model ID --expected-revision N. ${error instanceof Error ? error.message : String(error)}`,
          { reason: "provider_account" },
        );
      // An attempt that used its steps without submitting and changed nothing is repeated once
      // with half again as many steps; the same cap would repeat the same experiment (tasks grow
      // the same way through `taskSteps`).
      // A stage agent (not a task: tasks have their own restart) that ended in prose the format
      // correction could not turn into a result, and changed nothing, is repeated once in a
      // fresh session that is shown its prose ending.
      if (
        error instanceof WorkflowFault &&
        error.details.reason === "prose_end" &&
        !task &&
        !placement.stepRetry &&
        !signal.aborted &&
        !wrote
      ) {
        const prose = typeof error.details.prose === "string" ? error.details.prose : "";
        const retryExtra =
          extra && typeof extra === "object" && !Array.isArray(extra)
            ? {
                ...extra,
                previousAttempt: `Your previous attempt ended with this text instead of calling submit_result, and was discarded: ${JSON.stringify(prose.slice(0, 800))}. This time end by calling submit_result with the complete result.`,
              }
            : extra;
        return this.call(
          runId,
          stepId,
          state,
          policy,
          stageProfile,
          retryExtra,
          signal,
          task,
          0,
          validate,
          limits,
          hostTools,
          {
            ...(placement.root ? { root: placement.root } : {}),
            ...(fallbackIndex ? { fallbackIndex } : {}),
            ...(placement.primaryError !== undefined
              ? { primaryError: placement.primaryError }
              : {}),
            stepRetry: true,
          },
        );
      }
      if (
        error instanceof WorkflowFault &&
        error.details.reason === "no_submission" &&
        !placement.stepRetry &&
        !signal.aborted &&
        !wrote
      ) {
        const grown = (n: number) => Math.ceil(n * 1.5);
        const steps =
          limits?.maxSteps ??
          (task ? taskSize(state, task, "taskSteps") : undefined) ??
          Math.min(profile.maxSteps, policy.maxAgentSteps);
        return this.call(
          runId,
          stepId,
          state,
          policy,
          stageProfile,
          extra,
          signal,
          task,
          0,
          validate,
          {
            maxSteps: grown(steps),
            maxTokens: limits?.maxTokens === undefined ? undefined : grown(limits.maxTokens),
          },
          hostTools,
          {
            ...(placement.root ? { root: placement.root } : {}),
            ...(fallbackIndex ? { fallbackIndex } : {}),
            ...(placement.primaryError !== undefined
              ? { primaryError: placement.primaryError }
              : {}),
            stepRetry: true,
          },
        );
      }
      const next = route.models[fallbackIndex + 1];
      // Each fallback model gets one retry. A long retry-after is better spent on the next model,
      // and once the chain has already failed over, the run stops instead of blocking on it.
      // A model at capacity is left for the next model of the route at once; with none, the
      // call waits for it with the capacity backoff.
      const delay =
        ((next !== undefined || fallbackIndex > 0) && retryAfterMs(error) > LONG_RETRY_AFTER_MS) ||
        (next !== undefined && isCapacityError(error))
          ? null
          : retryDelay(error, retry, fallbackIndex === 0 ? 2 : 1);
      const again = (retryNumber: number, index: number, primaryError?: unknown) =>
        this.call(
          runId,
          stepId,
          state,
          policy,
          stageProfile,
          extra,
          signal,
          task,
          retryNumber,
          validate,
          limits,
          hostTools,
          {
            ...(placement.root ? { root: placement.root } : {}),
            ...(index ? { fallbackIndex: index } : {}),
            ...(primaryError !== undefined ? { primaryError } : {}),
          },
        );
      if (delay !== null && !signal.aborted && !wrote) {
        await abortableDelay(delay, signal);
        return again(retry + 1, fallbackIndex, placement.primaryError);
      }
      // A model that keeps failing, or whose window cannot hold the prompt, hands the step to the
      // next model of its route. Nothing is handed over once the attempt has changed files.
      const windowTooSmall =
        error instanceof WorkflowFault &&
        error.code === "BUDGET_EXHAUSTED" &&
        error.details.reason === "context_window";
      if (next !== undefined && !signal.aborted && !wrote && (isTransient(error) || windowTooSmall))
        return again(0, fallbackIndex + 1, placement.primaryError ?? error);
      if (placement.primaryError !== undefined && !signal.aborted) {
        const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `${route.models[0]} failed: ${message(placement.primaryError)}; last fallback ${profile.model} failed: ${message(error)}`,
          { reason: "provider_unavailable" },
        );
      }
      if (!(error instanceof WorkflowFault) && !signal.aborted)
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          error instanceof Error ? error.message : String(error),
          { reason: "provider_unavailable" },
        );
      throw error;
    }
  }
  /** The prompt an agent call gets: the run context, the stage input and the execution contract. */
  private promptFor(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profile: AgentProfile,
    extra: unknown,
  ): string {
    // The agents that start a run see the project's working set; later ones get the research.
    const workingSet =
      state.workingSet &&
      state.research === null &&
      (profile.context === "research" ||
        profile.context === "specification" ||
        profile.context === "planning")
        ? this.store.readArtifact(runId, state.workingSet.artifactId)
        : null;
    // What earlier runs learned helps the agents that ask questions and choose the approach.
    const memory =
      state.projectMemory &&
      (profile.context === "research" ||
        profile.context === "specification" ||
        profile.context === "planning")
        ? this.store.readArtifact(runId, state.projectMemory.artifactId)
        : null;
    // What analysis assumed instead of settling is the first thing a reviewer should test.
    const assumed =
      profile.context === "review" || profile.context === "convergence"
        ? this.store.latestArtifact(runId, "assumptions/analysis.json")
        : null;
    const risks = assumed ? knownRisks(this.store.readArtifact(runId, assumed.id)) : null;
    // Learned rules go to the agents that write and judge code: an implementer gets the rules of
    // its task's paths, reviewers every rule with its scope (#643).
    const task = (extra as { task?: Task } | null)?.task;
    const rules =
      state.learnedRules &&
      (profile.context === "implementation" ||
        profile.context === "review" ||
        profile.context === "convergence")
        ? rulesFor(
            JSON.parse(
              this.store.readArtifact(runId, state.learnedRules.artifactId),
            ) as LearnedRule[],
            profile.context === "implementation" && task ? task.writes.map((w) => w.path) : null,
          )
        : null;
    const { [DIFF_REVIEW]: diffOnly, ...input } = (
      extra && typeof extra === "object" ? extra : { input: extra }
    ) as Record<string, unknown>;
    return buildWorkflowContext(
      state,
      profile,
      {
        ...input,
        ...(rules ? { learnedRules: rules } : {}),
        ...(workingSet ? { projectWorkingSet: workingSet } : {}),
        ...(memory ? { projectMemory: memory } : {}),
        ...(risks && diffOnly !== true ? { knownRisks: risks } : {}),
        executionContract: {
          checks: policy.checks,
          // An implementer works alone; the other agents' tools are only resent on every step.
          profiles: ProfileSchema.array()
            .parse(JSON.parse(this.store.run(runId).profiles_json))
            .filter((p) => profile.context !== "implementation" || p.id === profile.id)
            .map((p) => ({ id: p.id, role: p.role, allowedTools: p.allowedTools })),
          policy: { allowedTools: policy.allowedTools, network: policy.network },
        },
      },
      undefined,
      diffOnly === true,
    );
  }
  /**
   * Prices the analyzed plan before it is approved (see sizing.ts). An oversized plan goes back to
   * the planner once with a split note; a plan still above the run ceiling waits for the user,
   * who can split the request into an initiative or answer to go on. Otherwise every sized task
   * gets its attempt cap and the run budget grows to the price, up to the policy's ceiling.
   */
  private sizePlan(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    v2: boolean,
  ): "continue" | "replan" | "wait" {
    const graph = state.graph;
    if (!graph) return "continue";
    const samples = sizingHistory(this.store.workspace, policy);
    const model = this.sizingModel(runId, graph);
    const report = sizePlan({
      graph,
      policy,
      samples,
      spent: this.store.run(runId).token_usage,
      model,
    });
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "sizing",
        `sizing/plan-${String(state.sizingReplans)}.json`,
        canonical(report),
      ),
    );
    const split = report.decision === "split-tasks" || report.decision === "split-feature";
    if (split && state.sizingReplans === 0 && !v2) {
      const stages = WorkflowSchema.parse(JSON.parse(this.store.run(runId).definition_json)).stages;
      const plan = stages.findIndex((stage) => stage.kind === "plan");
      if (plan >= 0) {
        this.raiseBudget(runId, state, policy, report);
        state.sizingReplans = 1;
        state.prompt += `
${splitNote(report, plannerSizing(policy, samples, model).maxCodeFilesPerTask)}`;
        state.analysisPassed = false;
        state.stageIndex = plan;
        this.store.transaction(() => this.store.saveState(runId, state));
        return "replan";
      }
    }
    if (
      report.decision === "split-feature" &&
      state.sizingReplans < 2 &&
      policy.clarification === "assume"
    ) {
      // Under assume a person is not asked: the run goes on within the ceiling, and the
      // assumption is recorded where the approval shows it (cronsay 15eb3204 asked here).
      const priced = `sizing/plan-${String(state.sizingReplans)}.json`;
      state.sizingReplans = 2;
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "assumption",
          "assumptions/sizing.json",
          canonical({
            assumed: [
              {
                id: "SIZING-1",
                kind: "scope",
                refs: ["tasks.json", priced],
                description: `${report.reasons.join(". ")}. Assumed under clarification assume: the run continues within ${String(report.maxRunTokens)} tokens.`,
              },
            ],
          }),
        ),
      );
    } else if (report.decision === "split-feature" && state.sizingReplans < 2) {
      // Asked once; an answer lets the run go on within the ceiling.
      state.sizingReplans = 2;
      this.wait("clarification", state, {
        findings: [
          {
            id: "SIZING-1",
            kind: "scope",
            refs: ["tasks.json", "sizing/plan-1.json"],
            description: `${report.reasons.join(". ")}. Split the request into an initiative of smaller features (baked workflow initiative), or answer to continue within ${String(report.maxRunTokens)} tokens.`,
            blocking: true,
          },
        ],
      });
      return "wait";
    }
    state.taskSteps = Object.fromEntries(
      report.tasks.flatMap((task) =>
        task.attemptSteps ? [[task.taskId, task.attemptSteps] as const] : [],
      ),
    );
    state.taskBudgets = Object.fromEntries(
      report.tasks.map((task) => [task.taskId, task.attemptTokens]),
    );
    this.raiseBudget(runId, state, policy, report);
    return "continue";
  }
  /**
   * Grows the run budget to the sized price, up to the policy's ceiling. A plan sent back to be
   * split is raised too: the price only grows with the re-plan, and a run on a provider with a
   * high per-step cost otherwise ran out before its plan was accepted (expenses-py-r4).
   */
  private raiseBudget(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    report: SizingReport,
  ): void {
    if (report.budgetAfter > policy.maxTotalTokens) {
      const before = hashJson(policy);
      const after = PolicySchema.parse({ ...policy, maxTotalTokens: report.budgetAfter });
      this.store.transaction(() => {
        this.store.artifact(
          runId,
          "policy-revision",
          `policy-revisions/sizing-${String(state.sizingReplans)}.json`,
          canonical({
            kind: "sizing",
            approvedBy: "sizing",
            previousPolicyHash: before,
            policyHash: hashJson(after),
            previous: { maxTotalTokens: policy.maxTotalTokens },
            next: { maxTotalTokens: after.maxTotalTokens },
          }),
        );
        this.store.setPolicy(runId, after);
      });
      // The drive keeps this policy object; the rest of the run sees the sized budget.
      policy.maxTotalTokens = after.maxTotalTokens;
      state.manifest.policyHash = hashJson(after);
    }
  }
  /**
   * Convergence is about to start another correction round. When its limits are used up, the same
   * findings return or a finding reverses an earlier fix, a person decides instead of the run
   * blocking: accept the findings as known limitations, repair once more, or stop. Under
   * `clarification: assume` the findings are accepted without asking when every required check
   * passes and only a small share of the criteria fail. `go` means no stop applies.
   */
  private haltConvergence(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    findings: Review["findings"],
  ): "go" | "wait" | "accepted" {
    const stop = convergenceStop(this.store, runId, state, policy, findings);
    if (!stop) return "go";
    const body = convergenceBody(this.store, runId, state, policy, stop, findings);
    const rule = assumeDecision(policy, state, stop, body);
    if (rule) body.hostRule = rule;
    if (rule?.decision === "extend") {
      // The request is recorded as decided so the run keeps what the host chose and why.
      this.store.transaction(() => {
        const id = this.store.request(runId, "convergence", hashJson(state.manifest), body);
        this.store.decideRequest(
          runId,
          id,
          "accepted",
          { kind: "continue", automatic: true },
          true,
        );
        grantRound(this.store, runId, state, policy, findings);
        state.autoExtensions += 1;
      });
      return "go";
    }
    if (rule?.decision === "accept") {
      this.store.transaction(() => {
        const id = this.store.request(runId, "convergence", hashJson(state.manifest), body);
        this.store.decideRequest(runId, id, "accepted", { kind: "accept", automatic: true }, true);
        acceptResidual(this.store, runId, state, body, "assume");
      });
      return "accepted";
    }
    this.queued.push({ kind: "convergence", digest: hashJson(state.manifest), body });
    return "wait";
  }
  /** Queues a request for a person; `flushWaits` makes it durable with the step's state. */
  private wait(
    kind: "clarification" | "manual_evidence" | "convergence",
    state: RuntimeState,
    body: unknown,
  ): void {
    this.queued.push({ kind, digest: hashJson(state.manifest), body });
  }
  /**
   * Saves the state and, when the step queued requests, creates them and moves the run to
   * waiting. Callers run it inside a transaction.
   */
  private flushWaits(runId: string, state: RuntimeState): void {
    const queued = this.queued;
    this.queued = [];
    for (const request of queued)
      this.store.request(runId, request.kind, request.digest, request.body);
    const last = queued.at(-1);
    // A stopped convergence waits for a decision because repairs stopped making progress.
    if (last)
      this.store.transition(
        runId,
        "waiting",
        last.kind === "convergence" ? "no_progress" : last.kind,
      );
    this.store.saveState(runId, state);
  }
  private async publish(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!state.spec || !state.graph || !state.plan) return;
    const definition = parseRunDefinition(this.store.run(runId).definition_json);
    // A definition that keeps its documents as run artifacts only still takes the snapshot the
    // later stages compare against.
    if (definition.schemaVersion === 2 && definition.definition.publish === false) {
      await this.snapshot(runId, state, policy, signal);
      return;
    }
    const attempt = this.store.reserve(runId, stepId, null, 0, policy);
    const root = runRoot(this.store.workspace, state);
    const files = {
      "spec.json": canonical(state.spec),
      "spec.md": renderSpec(state.spec),
      "plan.md": state.plan,
      "tasks.json": canonical(state.graph),
      "tasks.md": renderTasks(state.graph),
    };
    for (const [name, content] of Object.entries(files)) {
      const relative = specPublicationPath(state.spec.featureId, name);
      const path = workspacePath(root, relative);
      const current = fileHash(path);
      const expected =
        state.published[relative] ?? this.inheritedPublication(runId, relative, current);
      if (current === hashBytes(content)) {
        state.published[relative] = hashBytes(content);
        continue;
      }
      this.journal.publish(runId, attempt, relative, content, expected, "artifact_write", root);
      state.published[relative] = hashBytes(content);
    }
    this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
    await this.snapshot(runId, state, policy, signal);
  }
  /**
   * The hash a fresh run may overwrite at a path it has not published itself. A spec file that is
   * byte-for-byte what a finished earlier run published was not edited by the user, so a rerun
   * replaces it. A file still owned by an open run, or changed since publication, keeps the
   * INPUT_CHANGED guard.
   */
  private inheritedPublication(
    runId: string,
    relative: string,
    current: string | null,
  ): string | null {
    if (current === null) return null;
    const last = this.store.lastPublication(relative);
    if (!last || last.runId === runId || last.afterHash !== current) return null;
    if (!["completed", "failed", "cancelled"].includes(last.status))
      throw new WorkflowFault(
        "INPUT_CHANGED",
        `${relative} belongs to open run ${last.runId} (${last.status}); continue or cancel that run before publishing a new plan for this feature`,
      );
    return current;
  }
  /**
   * Adds one diff of the run's changes to the review snapshot, once per snapshot. Task diffs sit
   * on the snapshot each task made, so only the last task's patch was current at review and
   * reviewers read the other files whole (or wrote that they could not).
   */
  private async addReviewBundle(
    runId: string,
    state: RuntimeState,
    signal: AbortSignal,
  ): Promise<void> {
    if (!state.snapshotId) return;
    const logicalPath = `${REVIEW_BUNDLE_PATH}${state.snapshotId}.json`;
    if (this.store.latestArtifact(runId, logicalPath)) return;
    const bundle = await buildReviewBundle(this.store, runId, runRoot(this.store.workspace, state));
    signal.throwIfAborted();
    if (bundle.changed.length === 0) return;
    const snapshotId = state.snapshotId;
    const criteria = Object.fromEntries(
      (state.spec?.criteria ?? []).map((c) => [
        c.id,
        (state.graph?.tasks ?? []).filter((t) => t.criterionIds.includes(c.id)).map((t) => t.id),
      ]),
    );
    this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "diff",
        logicalPath,
        canonical({
          note: "One diff of every file the run changed, against its content before the run.",
          changed: bundle.changed,
          files: Object.fromEntries(
            bundle.changed.map((path) => [path, state.expectedFiles?.[path] ?? null]),
          ),
          criteriaToTasks: criteria,
          taskFiles: taskChangedFiles(state.graph?.tasks ?? [], bundle.changed),
          patch: bundle.patch,
        }),
      );
      this.store.addEvidence(runId, "diff", snapshotId, artifact.id);
    });
  }
  /**
   * What a format correction needs and cannot see: the hash and the citable ids of a review, the
   * task id and evidence handles of an implementation, the feature id of a plan.
   */
  private formatHints(
    runId: string,
    state: RuntimeState,
    output: string,
    task?: Task,
  ): string | undefined {
    if (output === "plan") return `featureId is ${this.store.run(runId).feature_id}.`;
    if (output === "implementation" && task && state.snapshotId)
      return `taskId is ${task.id}. ${validEvidenceNote(
        currentEvidence(this.store, runId, state.snapshotId),
      )}`;
    if ((output !== "review" && output !== "convergence") || !state.snapshotId) return undefined;
    return `snapshotHash is ${state.workspaceHash ?? ""}. ${validEvidenceNote(
      currentEvidence(this.store, runId, state.snapshotId),
    )}`;
  }
  /**
   * Current evidence handed to an agent with its content. An implementer does not need the
   * research-phase file reads (up to 16 KB each, resent on every step); it reads what it edits
   * itself and cites its own evidence. Reviewers and auditors get everything.
   */
  private evidenceContext(
    runId: string,
    state: RuntimeState,
    options: { reads: boolean; commands?: boolean; only?: ReadonlySet<string> } = { reads: true },
  ): unknown[] {
    const current = currentEvidence(this.store, runId, state.snapshotId ?? "");
    // Short handles (E1..En) number every current entry, so an agent can cite them instead of
    // copying a 36-character id; the host resolves them.
    const handles = new Map(current.map((e, index) => [e.id, evidenceHandle(index)]));
    return current
      .filter((e) => !options.only || options.only.has(e.id))
      .filter((e) => options.reads || e.kind !== "read")
      .filter((e) => options.commands !== false || e.kind !== "command")
      .map((e) => {
        const content = this.store.readArtifact(runId, e.artifact_id);
        // A read is replaced by what it read: its content is resent on every step of every later
        // agent, and cut at the limit it showed no file whole, so agents read the files again.
        const handle = handles.get(e.id);
        if (e.kind === "read")
          return { id: e.id, handle, kind: e.kind, read: readSummary(content) };
        return {
          id: e.id,
          handle,
          kind: e.kind,
          content: content.slice(0, e.kind === "diff" ? MAX_PATCH_CHARS + 4000 : 16000),
        };
      });
  }
  /**
   * The unified diff of a task's changes, from the content the run kept before each edit to the
   * file now in the root. Reviewers and the auditor read the change from it instead of reading
   * whole files. Files whose earlier content was not kept are listed without a diff.
   */
  private async taskPatch(
    runId: string,
    root: string,
    beforeHashes: Record<string, string | null>,
  ): Promise<string> {
    const parts: string[] = [];
    for (const [path, hash] of Object.entries(beforeHashes)) {
      const earlier = hash === null ? null : readKept(this.store, runId, hash);
      const absolute = workspacePath(root, path);
      const now = existsSync(absolute) ? readFileSync(absolute) : null;
      parts.push(
        hash !== null && earlier === null
          ? `--- ${path}: earlier content not kept, read the file`
          : await unifiedDiff(path, earlier, now),
      );
    }
    const text = parts.filter(Boolean).join("\n");
    return text.length > MAX_PATCH_CHARS
      ? `${text.slice(0, MAX_PATCH_CHARS)}\n... patch cut at ${MAX_PATCH_CHARS} characters; read the files for the rest`
      : text;
  }
  private async implement(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!state.graph || !state.approvalRoot)
      throw new WorkflowFault("STALE_DECISION", "Approved tasks required");
    for (;;) {
      const rows = this.store.tasks(runId);
      const checking = this.checkableTask(state.graph, rows, state);
      if (
        !checking &&
        (await this.hostFirstReruns(
          runId,
          stepId,
          state,
          policy,
          signal,
          readyTasks(state.graph, rows, state.taskGates),
        ))
      )
        continue;
      const task = checking ?? readyTasks(state.graph, rows, state.taskGates)[0];
      if (!task) {
        // Owners that cannot run leave their waiting tasks checked as they are, and repaired if they fail.
        if (this.releaseDeferred(state)) continue;
        break;
      }
      signal.throwIfAborted();
      await this.implementTask(runId, stepId, state, policy, profiles, signal, task, !!checking);
    }
    if (
      this.store
        .tasks(runId)
        .some(
          (t) =>
            state.graph?.tasks.some((task) => task.id === t.id) &&
            !["implemented", "verified"].includes(t.status),
        )
    )
      throw new WorkflowFault("OUTPUT_INVALID", "Task dependencies remain blocked", {
        reason: "dependency_failed",
      });
  }
  /**
   * An implemented task whose check gate is missing and whose check is not deferred: its owners
   * are done, or it never waited. A task still waiting for its owners is left alone.
   */
  private checkableTask(graph: TaskGraph, rows: TaskRow[], state: RuntimeState): Task | undefined {
    const finished = (id: string): boolean =>
      rows.some(
        (r) =>
          r.id === id &&
          (r.status === "verified" ||
            (r.status === "implemented" && hasTaskGate(r, state.taskGates))),
      );
    return graph.tasks.find((candidate) => {
      const waiting = state.deferredChecks[candidate.id];
      if (waiting?.every(finished)) delete state.deferredChecks[candidate.id];
      return (
        !state.deferredChecks[candidate.id] &&
        rows.some(
          (row) =>
            row.id === candidate.id &&
            row.status === "implemented" &&
            !hasTaskGate(row, state.taskGates),
        )
      );
    });
  }
  /** Ends every wait of a deferred check; true when one was waiting. */
  private releaseDeferred(state: RuntimeState): boolean {
    const waiting = Object.keys(state.deferredChecks);
    for (const id of waiting) delete state.deferredChecks[id];
    return waiting.length > 0;
  }
  /**
   * Implements one task in the run's own root, or only checks it when `checking` (implemented
   * before an interruption, without its check gate), then settles it.
   */
  private async implementTask(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    signal: AbortSignal,
    task: Task,
    checking: boolean,
  ): Promise<void> {
    const child = this.store.transaction(() => {
      if (!checking) this.store.taskStatus(runId, task.id, "running");
      return this.store.beginStep(runId, `task-${task.id}`, stepId);
    });
    if (!checking && task.writes.length === 0) {
      // A task that may not write has nothing for a model to do: its task checks decide it,
      // and the checks stage covers the rest.
      await this.snapshot(runId, state, policy, signal);
      this.store.transaction(() => {
        this.store.taskStatus(runId, task.id, "implemented", state.snapshotId);
        this.store.saveState(runId, state);
      });
    } else if (!checking) {
      const root = runRoot(this.store.workspace, state);
      const before = await sourceManifest(root, generatedPaths(policy), signal);
      const knownEffects = new Set(this.store.effects(runId).map((e) => e.id));
      // Edits of earlier attempts of this task that are still in place (a revision, a recovery
      // or a failed attempt keeps them), by path, with the hash the path had before them.
      const earlier = new Map<string, string | null>();
      for (const edit of uncommittedEdits(this.store, runId, task.id)) {
        const path = (JSON.parse(edit.intent_json) as { path: string }).path;
        if (!earlier.has(path)) earlier.set(path, edit.before_hash);
      }
      const stillEdited = (): string[] =>
        [...earlier].flatMap(([path, original]) =>
          fileHash(workspacePath(root, path)) === original ? [] : [path],
        );
      const inherited = stillEdited();
      // The earlier attempt's own edits as a patch: a retry reads only the spans it still has
      // to change instead of every written file again.
      const earlierPatch = inherited.length
        ? await this.taskPatch(
            runId,
            root,
            Object.fromEntries(inherited.map((path) => [path, earlier.get(path) ?? null])),
          )
        : "";
      const focus = correctionFocus(this.store, runId, state, task);
      const preloaded = await preloadTaskFiles(
        root,
        focus.files.length ? focusFirst(task.writes, focus.files) : task.writes,
        `${task.title}\n${task.description}\n${focus.symbols.join(" ")}`,
      );
      // The source manifest cannot see git-ignored files (a docs directory in .gitignore), but the
      // effect journal recorded every file this task changed, so it counts as well.
      const currentChanges = async (): Promise<{
        after: Record<string, string>;
        changed: string[];
      }> => {
        const now = await sourceManifest(root, generatedPaths(policy), signal);
        const journaled = this.store
          .effects(runId)
          .filter(
            (e) =>
              !knownEffects.has(e.id) &&
              e.kind === "file_patch" &&
              ["applied", "reconciled"].includes(e.status) &&
              e.before_hash !== e.after_hash,
          )
          .map((e) => (JSON.parse(e.intent_json) as { path: string }).path);
        return {
          after: now,
          changed: [...new Set([...changedPaths(before, now), ...journaled, ...stillEdited()])],
        };
      };
      let proseEnd = false;
      const fresh = this.freshStart(runId, state, task);
      const result = ImplementationSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          this.requireProfile(profiles.find((p) => p.id === task.profileId)),
          {
            task,
            // A planned task needs the earlier tasks' changes, not their check logs; a repair
            // task gets the logs of the checks it fixes.
            evidence: this.evidenceContext(runId, state, {
              reads: false,
              commands: task.origin !== "planned",
              ...(fresh.only ? { only: fresh.only } : {}),
            }),
            ...fresh.extra,
            ...(preloaded
              ? {
                  taskFiles: {
                    content: preloaded,
                    note: "The files this task modifies, as the read tool shows them: small files whole with line numbers, large ones as outlines followed by the spans of the symbols the task names. Edit them directly; read them again only for other spans of an outlined file or to cite evidence.",
                  },
                }
              : {}),
            unresolvedMeans: UNRESOLVED_MEANING,
            ...this.previousAttempt(runId, task.id),
            ...(focus.files.length
              ? {
                  correctionFocus: {
                    files: focus.files,
                    symbols: focus.symbols,
                    note: "The findings this task corrects point at these files and symbols; they come first in taskFiles. Start the fix there and read the other written files only when the fix needs them.",
                  },
                }
              : {}),
            ...(inherited.length
              ? {
                  earlierEdits: {
                    paths: inherited,
                    patch: earlierPatch,
                    note: "These files already contain the edits in the patch, from an earlier attempt of this task in this run; keep what is correct. Read only the spans you still have to change.",
                  },
                }
              : {}),
          },
          signal,
          task,
        ).catch(async (error: unknown) => {
          if (!endedOnProse(error)) throw error;
          proseEnd = true;
          return this.proseEndResult(
            runId,
            child,
            policy,
            task,
            root,
            signal,
            error,
            async () => (await currentChanges()).changed,
          );
        }),
      );
      if (result.outcome === "implemented")
        await this.fixTaskFiles(runId, child, root, policy, task, signal);
      const { after, changed } = await currentChanges();
      const outside = changed.filter((path) => !task.writes.some((w) => w.path === path));
      if (outside.length)
        throw new WorkflowFault(
          "INPUT_CHANGED",
          `Task changed ${outside.length} file(s) outside its write scope: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}`,
        );
      const correction =
        result.outcome === "implemented" && changed.length === 0 && task.writes.length > 0
          ? await this.correctionSatisfied(runId, state, child, policy, task, result, signal, root)
          : true;
      if (correction instanceof WorkflowFault) {
        this.store.transaction(() => this.store.taskStatus(runId, task.id, "blocked"));
        throw correction;
      }
      if (
        result.taskId !== task.id ||
        ["blocked", "failed"].includes(result.outcome) ||
        result.unresolved.length > 0 ||
        !correction
      ) {
        const restartReason = this.blockedRestartReason(
          runId,
          state,
          policy,
          child,
          task,
          result,
          changed,
          proseEnd,
        );
        const account = { summary: result.summary, unresolved: result.unresolved };
        if (
          restartReason &&
          changed.length === 0 &&
          this.restartOnce(runId, state, child, task.id, restartReason, [], account)
        ) {
          // A fresh session gets the task again; a session without its edit tool stays without it.
          this.store.transaction(() => {
            this.store.taskStatus(runId, task.id, "interrupted");
            this.store.finishStep(runId, child, "failed");
            this.store.saveState(runId, state);
          });
          return;
        }
        if (
          changed.length > 0 &&
          (this.continueAtCap(runId, state, child, task) ||
            (restartReason !== null &&
              this.restartOnce(runId, state, child, task.id, restartReason, changed, account)))
        ) {
          // The task is ready again and the next pass of the task loop continues it.
          this.store.transaction(() => {
            this.store.taskStatus(runId, task.id, "interrupted");
            this.store.finishStep(runId, child, "failed");
            this.store.saveState(runId, state);
          });
          return;
        }
        this.store.transaction(() => this.store.taskStatus(runId, task.id, "blocked"));
        const refused = takeHashRefusals(root);
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `Task ${task.id} did not complete its implementation${incompleteReason(result.unresolved)}${refusedReason(refused)}`,
          refused.length ? { reason: "input_changed", paths: refused } : {},
        );
      }
      if (result.outcome === "already_satisfied")
        this.validateSatisfiedEvidence(runId, state, after, result);
      await this.snapshot(runId, state, policy, signal);
      const beforeHashes = Object.fromEntries(
        changed.map((p) => [p, earlier.has(p) ? (earlier.get(p) ?? null) : (before[p] ?? null)]),
      );
      const patch = await this.taskPatch(runId, root, beforeHashes);
      this.store.transaction(() => {
        const diff = this.store.artifact(
          runId,
          "diff",
          `tasks/${task.id}/diff.json`,
          canonical({
            changed,
            before: beforeHashes,
            after: Object.fromEntries(changed.map((p) => [p, after[p] ?? null])),
            patch,
          }),
        );
        this.store.addEvidence(runId, "diff", state.snapshotId ?? "", diff.id);
        this.store.taskStatus(runId, task.id, "implemented", state.snapshotId);
        this.store.saveState(runId, state);
      });
    }
    const taskFailures: Review["findings"] = [];
    const checkEvidence: string[] = [];
    let inconclusive: string | undefined;
    const taskRoot = runRoot(this.store.workspace, state);
    const taskResults: WorkerCheck[] = [];
    for (const check of taskChecks(policy, task)) {
      const checked = await this.runTaskCheck(runId, child, check, policy, signal, taskRoot);
      taskResults.push({ check, checked });
    }
    for (const { check, checked } of await this.fixFailedTaskChecks(
      runId,
      child,
      state,
      policy,
      task,
      taskResults,
      signal,
      taskRoot,
    ))
      inconclusive ??= this.applyTaskCheck(
        runId,
        state,
        task,
        check,
        checked,
        taskFailures,
        checkEvidence,
      );
    this.inconclusiveTaskCheck(inconclusive, taskFailures);
    await this.critique(
      runId,
      child,
      state,
      policy,
      profiles,
      task,
      taskRoot,
      taskFailures,
      signal,
    );
    this.settleTask(runId, state, policy, task, child, taskFailures, checkEvidence);
  }
  /**
   * Implementation with several writers (a worktree run whose policy allows more than one). Ready
   * tasks run in batches, each task in its own worktree checked out from the run worktree's
   * current content; the results are integrated into the run worktree one at a time in graph
   * order. A task without writes, and a task implemented before an interruption whose checks did
   * not finish, are handled one at a time in the run worktree as with one writer.
   */
  private async implementParallel(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    signal: AbortSignal,
  ): Promise<void> {
    const graph = state.graph;
    const worktree = state.worktree;
    if (!graph || !state.approvalRoot || !worktree)
      throw new WorkflowFault("STALE_DECISION", "Approved tasks in a run worktree required");
    const mainRoot = join(this.store.workspace, worktree.path);
    const checks = new Semaphore(MAX_CONCURRENT_TASK_CHECKS);
    // Tasks whose worker was lost in this drive; the run stops once nothing else can progress.
    const lost = new Map<string, string>();
    for (;;) {
      const rows = this.store.tasks(runId);
      const current = state.graph ?? graph;
      const checking = this.checkableTask(current, rows, state);
      const ready = readyTasks(current, rows, state.taskGates).filter((t) => !lost.has(t.id));
      if (!checking && (await this.hostFirstReruns(runId, stepId, state, policy, signal, ready)))
        continue;
      const single = checking ?? ready.find((t) => t.writes.length === 0);
      signal.throwIfAborted();
      if (single) {
        await this.implementTask(
          runId,
          stepId,
          state,
          policy,
          profiles,
          signal,
          single,
          single === checking,
        );
        continue;
      }
      if (!ready.length) {
        if (this.releaseDeferred(state)) continue;
        break;
      }
      const plan = planBatch(
        ready,
        policy.maxConcurrentWriters,
        policy.allowOverlappingWrites === true,
        (path) => existsSync(workspacePath(mainRoot, path)),
      );
      const batch = this.reserveBatch(runId, stepId, state, policy, profiles, plan.batch);
      const base = await runContentCommit(this.store, runId, worktree);
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "batch",
          `tasks/batches/${newId()}.json`,
          canonical({
            base,
            tasks: batch.map((entry) => entry.task.id),
            deferredByOverlap: plan.overlapping,
            deferredByBudget: plan.batch.slice(batch.length).map((t) => t.id),
          }),
        ),
      );
      let failure: unknown = null;
      try {
        // Worktrees and their leases are set up one at a time: Git locks its worktree list.
        for (const entry of batch) {
          entry.path = await createTaskWorktree(
            this.store,
            runId,
            entry.task.id,
            base,
            entry.task.writes.map((w) => w.path),
          );
          this.leases.acquire(entry.lease(), runId, { isolated: true });
        }
        const outcomes = await Promise.all(
          batch.map((entry) => this.runTaskWorker(runId, state, policy, entry, checks, signal)),
        );
        // A stopped run integrates nothing: its unintegrated tasks are invalidated on recovery.
        // A rejected task does not keep the others of its batch out of the run worktree.
        const fatal = outcomes.find((outcome) => outcome.kind === "fatal");
        if (fatal) failure = fatal.error;
        for (const outcome of outcomes) {
          const { entry } = outcome;
          if (outcome.kind === "fatal") continue;
          if (outcome.kind === "done") {
            if (!fatal) await this.integrateTask(runId, state, policy, profiles, outcome, signal);
            delete state.taskCarry[entry.task.id];
          } else if (outcome.kind === "interrupted") {
            const restart = !fatal && this.restartLostTask(runId, state, outcome);
            if (restart && outcome.edits) this.carryEdits(runId, state, entry, outcome.edits);
            if (!restart) lost.set(entry.task.id, outcome.reason);
            this.store.transaction(() => {
              this.store.taskStatus(runId, entry.task.id, "interrupted");
              this.store.finishStep(runId, entry.child, "interrupted");
            });
          } else if (outcome.kind === "rejected") {
            const again =
              (outcome.edits !== undefined &&
                this.continueAtCap(runId, state, entry.child, entry.task)) ||
              (outcome.restart !== undefined &&
                this.restartOnce(
                  runId,
                  state,
                  entry.child,
                  entry.task.id,
                  outcome.restart.reason,
                  outcome.edits?.changed ?? [],
                  outcome.restart.account,
                ));
            if (again && outcome.edits) this.carryEdits(runId, state, entry, outcome.edits);
            if (!again) failure ??= outcome.error;
            this.store.transaction(() => {
              this.store.taskStatus(runId, entry.task.id, again ? "interrupted" : "blocked");
              this.store.finishStep(runId, entry.child, "failed");
              if (again) this.store.saveState(runId, state);
            });
          }
          await this.releaseTaskWorktree(runId, entry);
        }
      } finally {
        for (const entry of batch) await this.releaseTaskWorktree(runId, entry);
      }
      if (failure) throw failure;
    }
    if (lost.size)
      throw new WorkflowFault(
        "RECOVERY_REQUIRED",
        `Lost the worker of ${[...lost.keys()].join(", ")}: ${[...lost.values()][0]}. Resume the run to implement them again.`,
        { reason: "owner_lost" },
      );
    if (
      this.store
        .tasks(runId)
        .some(
          (t) =>
            state.graph?.tasks.some((task) => task.id === t.id) &&
            !["implemented", "verified"].includes(t.status),
        )
    )
      throw new WorkflowFault("OUTPUT_INVALID", "Task dependencies remain blocked", {
        reason: "dependency_failed",
      });
  }
  /**
   * Decides whether a task whose worker was lost runs again in this drive, from the run worktree's
   * current content and with the edits its worker left, instead of blocking the run. Each task
   * gets one such restart per run. A lost worktree lease belongs to another owner now, and an
   * effect of unknown outcome in the worktree needs recovery, so neither restarts.
   */
  private restartLostTask(
    runId: string,
    state: RuntimeState,
    outcome: Extract<WorkerOutcome, { kind: "interrupted" }>,
  ): boolean {
    const { entry } = outcome;
    if (outcome.leaseLost || (state.taskRestarts[entry.task.id] ?? 0) > 0) return false;
    const unsettled = this.store
      .effects(runId)
      .some(
        (e) =>
          ["prepared", "unknown"].includes(e.status) && intentRoot(e.intent_json) === entry.path,
      );
    if (unsettled || commandMayBeRunning(this.store, runId)) return false;
    return this.restartOnce(
      runId,
      state,
      entry.child,
      entry.task.id,
      outcome.reason,
      outcome.edits?.changed ?? [],
      outcome.account,
    );
  }
  /** Records the one restart a task gets per run; false when it already had it. */
  private restartOnce(
    runId: string,
    state: RuntimeState,
    stepId: string,
    taskId: string,
    reason: string,
    carriedPaths: string[],
    account?: { summary: string; unresolved: string[] },
  ): boolean {
    if ((state.taskRestarts[taskId] ?? 0) > 0) return false;
    this.store.transaction(() => {
      state.taskRestarts[taskId] = 1;
      this.store.artifact(
        runId,
        "recovery",
        `tasks/restarts/${taskId}.json`,
        canonical({ taskId, stepId, reason, carriedPaths, ...account }),
      );
      this.store.saveState(runId, state);
    });
    return true;
  }
  /**
   * Reserves the agent attempts of a whole batch before any task starts. The batch shrinks to the
   * tasks the remaining tokens, calls and checkpoint boundary cover; its first task is always
   * tried, so a run without budget for even one stops on its budget as with one writer.
   */
  private reserveBatch(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    tasks: Task[],
  ): BatchEntry[] {
    const run = this.store.run(runId);
    const held = this.store
      .attempts(runId)
      .filter((a) => !a.usage_complete)
      .reduce((sum, a) => sum + a.reserved_tokens, 0);
    const boundary = this.store.checkpointBoundary(runId, policy);
    const planned: { task: Task; profile: AgentProfile; extra: unknown; tokens: number }[] = [];
    let tokens = 0;
    for (const task of tasks) {
      const profile = this.routed(
        runId,
        stepId,
        this.requireProfile(profiles.find((p) => p.id === task.profileId)),
      );
      const fresh = this.freshStart(runId, state, task);
      const extra = {
        task,
        evidence: this.evidenceContext(runId, state, {
          reads: false,
          ...(fresh.only ? { only: fresh.only } : {}),
        }),
        ...fresh.extra,
        unresolvedMeans: UNRESOLVED_MEANING,
        ...this.previousAttempt(runId, task.id),
      };
      const needed = reserveTokens(
        this.promptFor(runId, state, policy, profile, extra),
        profile,
        policy,
      );
      const projected = run.token_usage + held + tokens + needed;
      if (
        planned.length &&
        (projected > policy.maxTotalTokens ||
          run.agent_calls + planned.length + 1 > policy.maxAgentCalls ||
          (boundary !== null && projected > boundary))
      )
        break;
      tokens += needed;
      planned.push({ task, profile, extra, tokens: needed });
    }
    return planned.map(({ task, profile, extra, tokens: reserved }) => {
      const child = this.store.transaction(() => {
        this.store.taskStatus(runId, task.id, "running");
        return this.store.beginStep(runId, `task-${task.id}`, stepId);
      });
      const attemptId = this.store.reserve(runId, child, profile.model, reserved, policy);
      const entry: BatchEntry = {
        task,
        profile,
        extra,
        child,
        attemptId,
        path: "",
        released: false,
        lease: () => mutationLeaseFor(this.store.workspace, join(this.store.workspace, entry.path)),
      };
      return entry;
    });
  }
  /**
   * One task of a batch in its own worktree: the agent call, the scope check against the task's
   * writes and its task checks, all there. It never throws: the outcome says what happened, and
   * the scheduler integrates or records it afterwards in graph order.
   */
  private async runTaskWorker(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    entry: BatchEntry,
    checks: Semaphore,
    runSignal: AbortSignal,
  ): Promise<WorkerOutcome> {
    const { task } = entry;
    const root = join(this.store.workspace, entry.path);
    const controller = new AbortController();
    const leaseSignal = this.leases.signalOf(entry.lease());
    const stop = (reason: unknown): void => controller.abort(reason);
    const onRun = (): void => stop(runSignal.reason);
    const onLease = (): void => stop(leaseSignal.reason);
    runSignal.addEventListener("abort", onRun, { once: true });
    leaseSignal.addEventListener("abort", onLease, { once: true });
    const signal = controller.signal;
    if (runSignal.aborted) onRun();
    if (leaseSignal.aborted) onLease();
    const known = new Set(this.store.effects(runId).map((e) => e.id));
    let before: Record<string, string> | undefined;
    try {
      before = await sourceManifest(root, generatedPaths(policy), signal);
      const earlierEdits = await this.applyCarry(runId, state, entry, root);
      const currentChanges = async (): Promise<{
        after: Record<string, string>;
        changed: string[];
      }> => {
        const now = await sourceManifest(root, generatedPaths(policy), signal);
        return { after: now, changed: this.workerChanges(runId, entry, known, before ?? {}, now) };
      };
      let proseEnd = false;
      const result = ImplementationSchema.parse(
        await this.call(
          runId,
          entry.child,
          state,
          policy,
          entry.profile,
          entry.extra && typeof entry.extra === "object"
            ? {
                ...entry.extra,
                ...(await this.correctionContext(runId, state, root, task)),
                ...(earlierEdits ? { earlierEdits } : {}),
              }
            : entry.extra,
          signal,
          task,
          0,
          undefined,
          undefined,
          undefined,
          { root, attemptId: entry.attemptId },
        ).catch(async (error: unknown) => {
          if (!endedOnProse(error)) throw error;
          proseEnd = true;
          return this.proseEndResult(
            runId,
            entry.child,
            policy,
            task,
            root,
            signal,
            error,
            async () => (await currentChanges()).changed,
          );
        }),
      );
      if (result.outcome === "implemented")
        await this.fixTaskFiles(runId, entry.child, root, policy, task, signal);
      const { after, changed } = await currentChanges();
      const outside = changed.filter((path) => !task.writes.some((w) => w.path === path));
      if (outside.length)
        return {
          kind: "rejected",
          entry,
          error: new WorkflowFault(
            "INPUT_CHANGED",
            `Task ${task.id} changed ${outside.length} file(s) outside its write scope: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}; its result is not integrated`,
          ),
        };
      const restartReason = this.blockedRestartReason(
        runId,
        state,
        policy,
        entry.child,
        task,
        result,
        changed,
        proseEnd,
      );
      const account = { summary: result.summary, unresolved: result.unresolved };
      if (restartReason && changed.length === 0)
        return { kind: "interrupted", entry, leaseLost: false, reason: restartReason, account };
      const refused = takeHashRefusals(root);
      const correction =
        result.outcome === "implemented" && changed.length === 0
          ? await this.correctionSatisfied(
              runId,
              state,
              entry.child,
              policy,
              task,
              result,
              signal,
              root,
            )
          : true;
      if (correction instanceof WorkflowFault)
        return { kind: "rejected", entry, error: correction };
      if (
        result.taskId !== task.id ||
        ["blocked", "failed"].includes(result.outcome) ||
        result.unresolved.length > 0 ||
        !correction
      )
        return {
          kind: "rejected",
          entry,
          ...(restartReason ? { restart: { reason: restartReason, account } } : {}),
          ...(changed.length ? { edits: { before, changed } } : {}),
          error: new WorkflowFault(
            "OUTPUT_INVALID",
            `Task ${task.id} did not complete its implementation${incompleteReason(result.unresolved)}${refusedReason(refused)}`,
            refused.length ? { reason: "input_changed", paths: refused } : {},
          ),
        };
      if (result.outcome === "already_satisfied")
        this.validateSatisfiedEvidence(runId, state, after, result);
      const results: WorkerCheck[] = [];
      for (const check of taskChecks(policy, task)) {
        const checked = await checks.run(() =>
          this.runTaskCheck(runId, entry.child, check, policy, signal, root),
        );
        results.push({ check, checked });
      }
      return { kind: "done", entry, before, after, changed, checks: results };
    } catch (error) {
      if (runSignal.aborted) return { kind: "fatal", entry, error: runSignal.reason ?? error };
      if (
        error instanceof WorkflowFault &&
        (["BUDGET_EXHAUSTED", "CHECKPOINT_REACHED"].includes(error.code) ||
          error.details.reason === "provider_account" ||
          error.details.reason === "check_unavailable")
      )
        return { kind: "fatal", entry, error };
      // The task's worker or its worktree lease is gone; the other tasks continue.
      const lostWorker =
        leaseSignal.aborted ||
        !(error instanceof WorkflowFault) ||
        error.code === "WORKSPACE_BUSY" ||
        error.details.reason === "provider_unavailable";
      // Another owner may hold the lease before the next heartbeat notices it.
      const leaseLost =
        leaseSignal.aborted || this.store.lease(entry.lease())?.owner_id !== this.leases.owner;
      if (lostWorker)
        return {
          kind: "interrupted",
          entry,
          leaseLost,
          ...(!leaseLost && before
            ? await this.lostWorkerEdits(runId, policy, entry, known, before)
            : {}),
          reason:
            leaseSignal.aborted && !(error instanceof Error && error.message)
              ? "its worktree lease was lost"
              : error instanceof Error
                ? error.message || error.name
                : String(error),
        };
      return { kind: "rejected", entry, error };
    } finally {
      runSignal.removeEventListener("abort", onRun);
      leaseSignal.removeEventListener("abort", onLease);
    }
  }
  /** The files a task's worker changed in its worktree: by its manifest and by the effect journal. */
  private workerChanges(
    runId: string,
    entry: BatchEntry,
    known: Set<string>,
    before: Record<string, string>,
    after: Record<string, string>,
  ): string[] {
    const journaled = this.store
      .effects(runId)
      .filter(
        (e) =>
          !known.has(e.id) &&
          e.kind === "file_patch" &&
          intentRoot(e.intent_json) === entry.path &&
          ["applied", "reconciled"].includes(e.status) &&
          e.before_hash !== e.after_hash,
      )
      .map((e) => (JSON.parse(e.intent_json) as { path: string }).path);
    return [...new Set([...changedPaths(before, after), ...journaled])].sort();
  }
  /** The edits a lost worker left in its worktree, which a restart of its task carries over. */
  private async lostWorkerEdits(
    runId: string,
    policy: RunPolicy,
    entry: BatchEntry,
    known: Set<string>,
    before: Record<string, string>,
  ): Promise<{ edits?: { before: Record<string, string>; changed: string[] } }> {
    try {
      const after = await sourceManifest(
        join(this.store.workspace, entry.path),
        generatedPaths(policy),
      );
      const changed = this.workerChanges(runId, entry, known, before, after);
      return changed.length ? { edits: { before, changed } } : {};
    } catch {
      // An unreadable worktree leaves nothing to carry; the restart starts from the base.
      return {};
    }
  }
  /**
   * Integrates a finished task into the run worktree: each changed file is written there as a
   * journaled effect while the run worktree still holds the content the task started from. A file
   * the run worktree changed meanwhile is a conflict, resolved by an integrator task. The task is
   * then implemented on a new snapshot and settled with its checks.
   */
  private async integrateTask(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    outcome: Extract<WorkerOutcome, { kind: "done" }>,
    signal: AbortSignal,
  ): Promise<void> {
    const { entry } = outcome;
    const task = entry.task;
    const mainRoot = runRoot(this.store.workspace, state);
    const taskRoot = join(this.store.workspace, entry.path);
    const lease = mutationLeaseFor(this.store.workspace, mainRoot);
    const attempt = this.store.beginHostAttempt(runId, entry.child);
    const conflicts: string[] = [];
    const baseline: Record<string, string | null> = {};
    try {
      for (const path of outcome.changed) {
        signal.throwIfAborted();
        const source = workspacePath(taskRoot, path);
        const target = workspacePath(mainRoot, path);
        const theirs = fileHash(source);
        const ours = fileHash(target);
        const base = outcome.before[path] ?? null;
        baseline[path] = ours;
        if (ours === theirs) continue;
        if (ours !== base) {
          conflicts.push(path);
          continue;
        }
        const effectId = this.store.transaction(() =>
          this.store.prepareEffect(
            runId,
            attempt,
            "file_patch",
            {
              path,
              tool: "integrate",
              taskId: task.id,
              ...rootField(this.store.workspace, mainRoot),
            },
            capturePreImage(this.store, runId, target),
            theirs,
          ),
        );
        try {
          this.leases.assert(lease);
          if (fileHash(target) !== ours)
            throw new WorkflowFault("INPUT_CHANGED", `File changed during integration: ${path}`);
          if (theirs === null) unlinkSync(target);
          else {
            mkdirSync(dirname(target), { recursive: true });
            writeViaTemp(target, readFileSync(source), {
              flag: "wx",
              flush: true,
              mode: statSync(source).mode,
            });
          }
          this.store.transaction(() => this.store.effectStatus(runId, effectId, "applied"));
        } catch (error) {
          this.store.transaction(() => this.store.effectStatus(runId, effectId, "unknown"));
          throw error;
        }
      }
    } finally {
      this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
    }
    if (conflicts.length)
      await this.resolveConflicts(runId, state, policy, profiles, outcome, conflicts, signal);
    await this.snapshot(runId, state, policy, signal);
    this.store.transaction(() => {
      const diff = this.store.artifact(
        runId,
        "diff",
        `tasks/${task.id}/diff.json`,
        canonical({
          changed: outcome.changed,
          before: Object.fromEntries(outcome.changed.map((p) => [p, outcome.before[p] ?? null])),
          after: Object.fromEntries(outcome.changed.map((p) => [p, outcome.after[p] ?? null])),
          worktree: entry.path,
          integrated: Object.fromEntries(
            outcome.changed.map((p) => [p, state.expectedFiles?.[p] ?? null]),
          ),
          conflicts,
        }),
      );
      this.store.addEvidence(runId, "diff", state.snapshotId ?? "", diff.id);
      this.store.taskStatus(runId, task.id, "implemented", state.snapshotId);
      this.store.saveState(runId, state);
    });
    // A resolved conflict changed what the task's checks saw: they run again on the result.
    const results = conflicts.length
      ? await this.recheck(runId, entry, policy, signal, mainRoot)
      : outcome.checks;
    const failures: Review["findings"] = [];
    const evidence: string[] = [];
    let inconclusive: string | undefined;
    for (const { check, checked } of await this.fixFailedTaskChecks(
      runId,
      entry.child,
      state,
      policy,
      task,
      results,
      signal,
      mainRoot,
    ))
      inconclusive ??= this.applyTaskCheck(runId, state, task, check, checked, failures, evidence);
    this.inconclusiveTaskCheck(inconclusive, failures);
    await this.critique(
      runId,
      entry.child,
      state,
      policy,
      profiles,
      task,
      mainRoot,
      failures,
      signal,
    );
    this.settleTask(runId, state, policy, task, entry.child, failures, evidence);
  }
  /**
   * A required task check that failed and declares a fixer gets one host repair before it becomes
   * a finding and an LLM repair task: the fixer runs on every file the task writes (documentation
   * and data files too, which the fixer pass before the checks skips) and a check that sees a
   * changed file runs again. Only what the fixer cannot fix is repaired by a model (bench round 07,
   * pkgdrift T004 54k and md-site T009 71k for whitespace and lint findings).
   */
  private async fixFailedTaskChecks(
    runId: string,
    child: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    results: WorkerCheck[],
    signal: AbortSignal,
    root: string,
  ): Promise<WorkerCheck[]> {
    const failed = results.filter(
      ({ check, checked }) => checked.status === "failed" && check.required && check.fix,
    );
    const paths = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
    if (!failed.length || !paths.length) return results;
    const changed = await this.fixFiles(
      runId,
      child,
      root,
      policy,
      failed.map(({ check }) => check),
      new Map(paths.map((path) => [path, task.id])),
      signal,
    );
    if (!changed) return results;
    await this.snapshot(runId, state, policy, signal);
    const rerun: WorkerCheck[] = [];
    for (const result of results)
      rerun.push(
        failed.includes(result)
          ? {
              check: result.check,
              checked: await this.runTaskCheck(runId, child, result.check, policy, signal, root),
            }
          : result,
      );
    return rerun;
  }
  private async recheck(
    runId: string,
    entry: BatchEntry,
    policy: RunPolicy,
    signal: AbortSignal,
    root: string,
  ): Promise<WorkerCheck[]> {
    const results: WorkerCheck[] = [];
    for (const check of taskChecks(policy, entry.task)) {
      const checked = await this.runTaskCheck(runId, entry.child, check, policy, signal, root);
      results.push({ check, checked });
    }
    return results;
  }
  /**
   * The integrator task of phase 3: an implementer call in the run worktree whose write scope is
   * only the conflicting files. It gets both diffs against the content the task started from, the
   * three versions of each file, the spec and the definitions of the tasks that write those files.
   */
  private async resolveConflicts(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    outcome: Extract<WorkerOutcome, { kind: "done" }>,
    conflicts: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const { entry } = outcome;
    const task = entry.task;
    const mainRoot = runRoot(this.store.workspace, state);
    const taskRoot = join(this.store.workspace, entry.path);
    // The tool policy compares edits with the latest snapshot: the files integrated so far are in it.
    await this.snapshot(runId, state, policy, signal);
    const read = (root: string, path: string): Uint8Array | null => {
      const absolute = workspacePath(root, path);
      return existsSync(absolute) ? readFileSync(absolute) : null;
    };
    const files = [];
    for (const path of conflicts) {
      const shown = await git(taskRoot, ["show", `HEAD:${path}`]);
      const base = shown.code === 0 ? shown.bytes : null;
      const ours = read(mainRoot, path);
      const theirs = read(taskRoot, path);
      const text = (bytes: Uint8Array | null): string | null =>
        bytes === null ? null : Buffer.from(bytes).toString("utf8").slice(0, 16000);
      files.push({
        path,
        base: text(base),
        integrated: text(ours),
        task: text(theirs),
        integratedDiff: await unifiedDiff(path, base, ours),
        taskDiff: await unifiedDiff(path, base, theirs),
      });
    }
    const scoped: Task = {
      ...task,
      writes: conflicts.map((path) => ({
        path,
        action: existsSync(workspacePath(mainRoot, path)) ? "modify" : "create",
      })),
    };
    const writers = (state.graph?.tasks ?? []).filter((candidate) =>
      candidate.writes.some((w) => conflicts.includes(w.path)),
    );
    const profile = this.requireProfile(profiles.find((p) => p.id === task.profileId));
    const before = await sourceManifest(mainRoot, generatedPaths(policy), signal);
    const known = new Set(this.store.effects(runId).map((e) => e.id));
    const result = ImplementationSchema.parse(
      await this.call(
        runId,
        entry.child,
        state,
        policy,
        profile,
        {
          task: scoped,
          integration: {
            role: "integrator",
            instruction: `Integrate task ${task.id} into the run worktree. Each listed file was changed both by tasks integrated before it (integrated) and by ${task.id} (task), starting from the same base. Edit only these files so that the result keeps the intent of every listed task; submit the result for ${task.id}.`,
            taskId: task.id,
            files,
            spec: state.spec,
            tasks: writers,
          },
          unresolvedMeans: UNRESOLVED_MEANING,
        },
        signal,
        scoped,
      ),
    );
    const after = await sourceManifest(mainRoot, generatedPaths(policy), signal);
    const journaled = this.store
      .effects(runId)
      .filter(
        (e) =>
          !known.has(e.id) &&
          e.kind === "file_patch" &&
          intentRoot(e.intent_json) === (rootField(this.store.workspace, mainRoot).root ?? "") &&
          ["applied", "reconciled"].includes(e.status),
      )
      .map((e) => (JSON.parse(e.intent_json) as { path: string }).path);
    const changed = [...new Set([...changedPaths(before, after), ...journaled])];
    const outside = changed.filter((path) => !conflicts.includes(path));
    if (outside.length)
      throw new WorkflowFault(
        "INPUT_CHANGED",
        `The integrator of ${task.id} changed files outside the conflict: ${outside.slice(0, 5).join(", ")}`,
      );
    if (
      result.taskId !== task.id ||
      ["blocked", "failed"].includes(result.outcome) ||
      result.unresolved.length > 0
    ) {
      this.store.transaction(() => this.store.taskStatus(runId, task.id, "blocked"));
      throw new WorkflowFault(
        "OUTPUT_INVALID",
        `The integrator of ${task.id} did not resolve the conflict`,
      );
    }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "integration",
        `tasks/${task.id}/integration.json`,
        canonical({
          taskId: task.id,
          conflicts,
          tasks: writers.map((t) => t.id),
          resolved: Object.fromEntries(
            conflicts.map((path) => [path, fileHash(workspacePath(mainRoot, path))]),
          ),
          summary: result.summary,
        }),
      ),
    );
  }
  /**
   * Keeps what a batch task's attempt changed before its worktree is removed: the content after
   * the edit is stored like a pre-image, by hash, so the continuing attempt can get it back.
   */
  private carryEdits(
    runId: string,
    state: RuntimeState,
    entry: BatchEntry,
    edits: { before: Record<string, string>; changed: string[] },
  ): void {
    const root = join(this.store.workspace, entry.path);
    this.store.transaction(() => {
      state.taskCarry[entry.task.id] = Object.fromEntries(
        edits.changed.map((path) => [
          path,
          {
            before: edits.before[path] ?? null,
            after: capturePreImage(this.store, runId, workspacePath(root, path)),
          },
        ]),
      );
      this.store.saveState(runId, state);
    });
  }
  /**
   * Puts a continued batch task's earlier edits into its new worktree, for each path the base has
   * not changed since, and describes them for the prompt like the single-writer path does.
   */
  private async applyCarry(
    runId: string,
    state: RuntimeState,
    entry: BatchEntry,
    root: string,
  ): Promise<{ paths: string[]; patch: string; note: string } | null> {
    const carry = state.taskCarry[entry.task.id];
    if (!carry) return null;
    const applied: Record<string, string | null> = {};
    for (const [path, { before, after }] of Object.entries(carry)) {
      if (fileHash(workspacePath(root, path)) !== before) continue;
      const content = after === null ? null : readKept(this.store, runId, after);
      if (after !== null && content === null) continue;
      // Journaled as the new attempt's own edit: its write tools accept the file as one they made.
      this.journal.publish(runId, entry.attemptId, path, content, before, "file_patch", root);
      applied[path] = before;
    }
    const paths = Object.keys(applied);
    if (!paths.length) return null;
    return {
      paths,
      patch: await this.taskPatch(runId, root, applied),
      note: "These files already contain the edits in the patch, from an earlier attempt of this task in this run; keep what is correct. Read only the spans you still have to change.",
    };
  }
  /** Removes a settled task's worktree and releases its lease; a worktree with unsettled effects stays for recovery. */
  private async releaseTaskWorktree(runId: string, entry: BatchEntry): Promise<void> {
    if (!entry.path || entry.released) return;
    entry.released = true;
    // A lease another owner took over leaves that owner's worktree alone.
    const owned = this.store.lease(entry.lease())?.owner_id === this.leases.owner;
    const unsettled = this.store
      .effects(runId)
      .some(
        (e) =>
          ["prepared", "unknown"].includes(e.status) && intentRoot(e.intent_json) === entry.path,
      );
    if (owned && !unsettled) {
      // A locked directory is a leftover, not a failure: the run goes on and the directory is
      // removed with the run's worktrees or when the task worktree is created again.
      const removal = await removeTaskWorktree(this.store.workspace, entry.path);
      if (!removal.removed)
        this.store.transaction(() =>
          this.store.artifact(
            runId,
            "worktree",
            `worktree/leftover-${entry.task.id}.json`,
            canonical({ path: entry.path, warning: removal.warning }),
          ),
        );
    }
    this.leases.releaseOne(entry.lease());
  }
  /**
   * The result of an implementer that ended on text after the continuation and the format
   * correction failed (R7 keeplint T003: finished work lost with its checks green). The host
   * holds the facts: with a change in the worktree, no unsettled effect and every check of the
   * task passing, it records the implementation itself and review judges it; otherwise the same
   * ending is a blocked result that goes down the restart path.
   */
  private async proseEndResult(
    runId: string,
    child: string,
    policy: RunPolicy,
    task: Task,
    root: string,
    signal: AbortSignal,
    fault: WorkflowFault,
    currentPaths: () => Promise<string[]>,
  ): Promise<Implementation> {
    const prose = typeof fault.details.prose === "string" ? fault.details.prose : "";
    const said = prose.trim() ? ` Its last text: ${prose.trim().slice(0, 1500)}` : "";
    const result = (
      outcome: "implemented" | "blocked",
      summary: string,
      unresolved: string[],
    ): Implementation => ({
      schemaVersion: 1,
      taskId: task.id,
      outcome,
      summary: `${summary}${said}`.slice(0, 15000),
      evidenceIds: [],
      unresolved: unresolved.map((u) => u.slice(0, 15000)),
    });
    const blocked = (reason: string) =>
      result(
        "blocked",
        "The worker ended its session with a text reply and never called submit_result.",
        [reason],
      );
    const paths = await currentPaths();
    if (!paths.length)
      return blocked("The session changed no file in the task's write scope before it ended.");
    const unsettled = this.store
      .effects(runId)
      .some((e) => ["prepared", "unknown"].includes(e.status));
    if (unsettled) return blocked("An effect of the session has no known outcome.");
    await this.fixTaskFiles(runId, child, root, policy, task, signal);
    for (const check of taskChecks(policy, task)) {
      const checked = await this.runTaskCheck(runId, child, check, policy, signal, root);
      if (checked.status !== "passed")
        return blocked(
          `Task check ${check.id} ${checked.status} after the session ended: ${(checked.output ?? "").slice(-1500)}`,
        );
    }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        `tasks/${task.id}/host-result.json`,
        canonical({ taskId: task.id, reason: "prose_end", changed: paths }),
      ),
    );
    return result(
      "implemented",
      `The worker ended its session with a text reply and never called submit_result; the host recorded this result because the task changed ${paths.length} file(s) and its checks pass.`,
      [],
    );
  }
  /** Runs one task check in `root` under its own host attempt. */
  /**
   * Evidence for an `already_satisfied` result. A task's reads are recorded against its worktree,
   * which differs from the run snapshot once an earlier attempt of the task edited files, the
   * case where `already_satisfied` is the right answer on a retry (junitdigest 3e5be74b T014
   * blocked twice). So reads of the worktree as it is now count too; a read taken before a
   * later edit of the attempt names another snapshot and stays stale.
   */
  private validateSatisfiedEvidence(
    runId: string,
    state: RuntimeState,
    worktree: Record<string, string>,
    result: { evidenceIds: string[] },
  ): void {
    const run = state.snapshotId ?? "";
    const current = this.store.transaction(() => this.store.putSnapshot(runId, worktree)).id;
    result.evidenceIds = resolveEvidenceIds(
      [...currentEvidence(this.store, runId, run), ...currentEvidence(this.store, runId, current)],
      result.evidenceIds,
    );
    validateEvidence(this.store, runId, [run, current], result.evidenceIds);
  }
  /**
   * A task whose attempt changed nothing is satisfied, not blocked, when the checks it was created
   * for pass on the current files: a sibling task or an earlier correction already fixed the
   * cause (zoneslot 51f9d664 T007 and md-site 93fbee70 T010 reported passing tests and stopped the
   * run). The checks are the task's own and the ones its findings name. A planned task counts
   * only on a rerun (generation above 0): a repair invalidated it though it was already correct
   * (md-site 2707d602 T004 generation 3 blocked the run), while a first run that changed nothing
   * did not do its work.
   */
  private async correctionSatisfied(
    runId: string,
    state: RuntimeState,
    child: string,
    policy: RunPolicy,
    task: Task,
    result: { taskId: string; outcome: string; unresolved: string[] },
    signal: AbortSignal,
    root: string,
  ): Promise<boolean | WorkflowFault> {
    const rerun = (this.store.tasks(runId).find((t) => t.id === task.id)?.generation ?? 0) > 0;
    if (
      (task.origin === "planned" && !rerun) ||
      result.taskId !== task.id ||
      result.outcome !== "implemented" ||
      result.unresolved.length > 0
    )
      return false;
    const named = new Set(
      this.store
        .findings(runId)
        .filter((f) => task.findingIds.includes(f.id))
        .map((f) => /^Required check (\S+) failed$/.exec(JSON.parse(f.body_json).claim)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
    const checks = policy.checks.filter(
      (c) => c.required && (named.has(c.id) || taskChecks(policy, task).some((t) => t.id === c.id)),
    );
    if (!checks.length) return false;
    for (const check of checks) {
      const checked = await this.runTaskCheck(runId, child, check, policy, signal, root);
      if (checked.status === "passed") continue;
      const outside = outOfScopeFailure(task, checked, state.graph?.tasks ?? []);
      // A correction that changed nothing while its check still fails only on files it may not
      // write would change nothing on a second attempt or a resume either (commitbump cd842f0f:
      // T008, three attempts and 689k with no edit).
      if (outside.length)
        return new WorkflowFault(
          "RECOVERY_REQUIRED",
          `out_of_scope_failure: ${task.id} changed nothing and check ${check.id} still fails on ${outside.slice(0, 5).join(", ")}, which it may not write (evidence ${checked.evidenceId}). Fix those files or revise the plan, then resume.`,
          { reason: "no_progress", paths: outside },
        );
      return false;
    }
    return true;
  }
  /**
   * A corrective task in its own worktree gets the files its findings point at, preloaded in
   * its worktree, as a single-writer run gives them; planned tasks of a batch are unchanged.
   */
  private async correctionContext(
    runId: string,
    state: RuntimeState,
    root: string,
    task: Task,
  ): Promise<Record<string, unknown>> {
    const focus = correctionFocus(this.store, runId, state, task);
    if (!focus.files.length) return {};
    const preloaded = await preloadTaskFiles(
      root,
      focusFirst(task.writes, focus.files).filter((w) => focus.files.includes(w.path)),
      `${task.title}\n${task.description}\n${focus.symbols.join(" ")}`,
    );
    return {
      ...(preloaded
        ? {
            taskFiles: {
              content: preloaded,
              note: "The files the findings this task corrects point at, as the read tool shows them. Edit them directly; read the other written files only when the fix needs them.",
            },
          }
        : {}),
      correctionFocus: {
        files: focus.files,
        symbols: focus.symbols,
        note: "The findings this task corrects point at these files and symbols. Start the fix there and read the other written files only when the fix needs them.",
      },
    };
  }
  private async runTaskCheck(
    runId: string,
    child: string,
    check: Check,
    policy: RunPolicy,
    signal: AbortSignal,
    root: string,
  ): Promise<{
    status: "passed" | "failed" | "inconclusive";
    evidenceId: string;
    output?: string;
  }> {
    const attempt = this.store.reserve(runId, child, null, 0, policy);
    const checked = await this.checks.run(runId, attempt, check, signal, root);
    this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
    failFastUnavailable(check, checked);
    return checked;
  }
  /**
   * Applies one task check result: a pass is gate evidence, a required failure blocks the task
   * and becomes a finding, and a required inconclusive result blocks the task and returns the
   * check's id: it stops the run unless another check failed (see `inconclusiveTaskCheck`).
   */
  private applyTaskCheck(
    runId: string,
    state: RuntimeState,
    task: Task,
    check: Check,
    checked: { status: "passed" | "failed" | "inconclusive"; evidenceId: string; output?: string },
    taskFailures: Review["findings"],
    checkEvidence: string[],
  ): string | undefined {
    if (checked.status === "passed") checkEvidence.push(checked.evidenceId);
    if (!check.required || checked.status === "passed") return undefined;
    const owners =
      checked.status === "failed" && task.origin === "planned" && checked.output
        ? pendingOwners(
            state.rootGraph ?? state.graph,
            this.store.tasks(runId),
            state.taskGates,
            task,
            checked.output,
          )
        : [];
    if (owners.length) {
      // contrastgrid d372ea22: main.tsx imported App.tsx of a task that had not run, and a repair
      // agent started for a failure the owner resolves. The check runs again when the owners are done.
      state.deferredChecks[task.id] = owners;
      this.store.transaction(() =>
        this.store.taskStatus(runId, task.id, "implemented", state.snapshotId),
      );
      return undefined;
    }
    this.store.transaction(() =>
      this.store.taskStatus(runId, task.id, "blocked", state.snapshotId),
    );
    if (checked.status === "inconclusive") return check.id;
    // Files the output names that this task may not write: a repair of the task gets the ones
    // the run's other tasks own (commitbump cd842f0f: fmt of tests/docs.rs failed on src/*.rs).
    const rootTasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    const named = checked.output ? pathsInOutput(checked.output, rootTasks) : [];
    const outside = named.filter((path) => !task.writes.some((w) => w.path === path));
    const owned = outside.filter((path) =>
      rootTasks.some(
        (t) => t.profileId === task.profileId && t.writes.some((w) => w.path === path),
      ),
    );
    // Every file the output names is one this task cannot get write access to: a repair would
    // end "outside this task's approved write scope" after attempts that change nothing.
    if (named.length && outside.length === named.length && !owned.length)
      throw new WorkflowFault(
        "RECOVERY_REQUIRED",
        `out_of_scope_failure: check ${check.id} fails on ${outside.slice(0, 5).join(", ")}, which ${task.id} may not write and no task of its profile owns (evidence ${checked.evidenceId}). Fix those files or revise the plan, then resume.`,
        { reason: "no_progress" },
      );
    const findingId = newId();
    if (owned.length) state.repairScope[findingId] = owned;
    taskFailures.push({
      id: findingId,
      kind: "correctness",
      severity: "high",
      requirementIds: task.requirementIds,
      criterionIds: task.criterionIds,
      file: null,
      symbol: null,
      evidenceIds: [checked.evidenceId],
      claim: `Task ${task.id} required check ${check.id} failed`,
      impact: "Dependent tasks cannot run",
      suggestedFix: owned.length
        ? `Fix ${task.id} and the files the check output names (${owned.slice(0, 5).join(", ")}) and repeat ${check.id}.`
        : `Fix ${task.id} within its approved paths and repeat ${check.id}.`,
    });
    return undefined;
  }
  /**
   * A failed task check is repaired first, and the repaired task reruns all its checks; an
   * inconclusive one with nothing to repair stops the run.
   */
  private inconclusiveTaskCheck(checkId: string | undefined, failures: Review["findings"]): void {
    if (checkId && !failures.length)
      throw new WorkflowFault("OUTPUT_INVALID", `Task check ${checkId} is inconclusive`, {
        reason: "verification_failed",
      });
  }
  /**
   * The critic of a run (#646), or null when it does not run: `critic: "off"` turns it off and
   * `"advise"` on; without the field it runs only on a vendor other than the implementation's
   * (see model-vendor.ts), so a one-provider setup spends nothing on a judge that shares the
   * implementer's blind spots.
   */
  private criticOf(
    runId: string,
    policy: RunPolicy,
    profiles: AgentProfile[],
  ): AgentProfile | null {
    if (policy.critic === "off") return null;
    const critic = profiles.find((p) => p.output === "critique");
    if (!critic) return null;
    if (policy.critic === "advise") return critic;
    const routing = this.routingRecord(runId);
    const modelOf = (profile: AgentProfile) =>
      routing?.profiles[profile.id]?.model ?? profile.model;
    const implementation = profiles
      .filter((p) => p.output === "implementation")
      .map((p) => modelVendor(modelOf(p)));
    return implementation.includes(modelVendor(modelOf(critic))) ? null : critic;
  }
  /**
   * Scores a finished task attempt with the critic and stores the critique as
   * `tasks/TASK/critique.json`. Advice only: it changes no status, and a critic that fails is
   * recorded and skipped. An attempt already scored (same diff) is not scored again on resume.
   * Returns the critique, or null when no critic runs or it failed.
   */
  private async critique(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    task: Task,
    root: string,
    failures: Review["findings"],
    signal: AbortSignal,
  ): Promise<Critique | null> {
    const critic = this.criticOf(runId, policy, profiles);
    const diffRow = this.store.latestArtifact(runId, `tasks/${task.id}/diff.json`);
    if (!critic || !diffRow) return null;
    const path = `tasks/${task.id}/critique.json`;
    const kept = this.store.latestArtifact(runId, path);
    if (kept) {
      const earlier = JSON.parse(this.store.readArtifact(runId, kept.id)) as { diffId?: string };
      if (earlier.diffId === diffRow.id) return null;
    }
    const diff = JSON.parse(this.store.readArtifact(runId, diffRow.id)) as {
      patch?: string;
      before?: Record<string, string | null>;
    };
    const patch = diff.patch ?? (await this.taskPatch(runId, root, diff.before ?? {}));
    const attempt = this.store.artifacts(runId).filter((a) => a.logical_path === path).length + 1;
    const child = this.store.transaction(() => this.store.beginStep(runId, "critic", stepId));
    const record = (body: Record<string, unknown>) =>
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "critique",
          path,
          canonical({ taskId: task.id, attempt, diffId: diffRow.id, model: critic.model, ...body }),
        ),
      );
    try {
      const output = CritiqueSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          critic,
          {
            task,
            patch,
            failedChecks: failures.map((f) => f.claim),
          },
          signal,
        ),
      );
      const critique = { ...output, taskId: task.id };
      record({ critique });
      this.store.transaction(() => this.store.finishStep(runId, child, "completed"));
      return critique;
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof WorkflowFault &&
        ["BUDGET_EXHAUSTED", "CHECKPOINT_REACHED"].includes(error.code)
      )
        throw error;
      record({ error: error instanceof Error ? error.message : String(error) });
      this.store.transaction(() => this.store.finishStep(runId, child, "failed"));
      return null;
    }
  }
  /**
   * Closes a task after its checks: failures become corrective tasks; otherwise the task gets its
   * check gate and the repair chain it closes is restored.
   */
  private settleTask(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    child: string,
    taskFailures: Review["findings"],
    checkEvidence: string[],
  ): void {
    if (state.deferredChecks[task.id] && !taskFailures.length) {
      this.store.transaction(() => {
        this.store.finishStep(runId, child, "completed");
        this.store.saveState(runId, state);
      });
      return;
    }
    if (taskFailures.length) {
      delete state.deferredChecks[task.id];
      const recorded = this.recordFindings(runId, {
        schemaVersion: 1,
        snapshotHash: state.workspaceHash ?? "",
        verdict: "changes_requested",
        coverage: [],
        findings: taskFailures,
      });
      for (const finding of recorded) state.repairPredecessors[finding.id] = task.id;
      this.repair(runId, state, policy, recorded, "repair");
      this.store.transaction(() => this.store.saveState(runId, state));
    } else {
      this.store.transaction(() => {
        const graph = state.graph;
        const row = this.store.tasks(runId).find((entry) => entry.id === task.id);
        if (!graph || !row)
          throw new WorkflowFault("INVALID_REFERENCE", "Checked task graph is missing");
        state.taskGates[task.id] = {
          generation: row.generation,
          snapshotId: row.snapshot_id ?? "",
          definitionHash: hashJson(task),
          evidenceIds: checkEvidence,
        };
        // Restore the whole repair chain atomically with the successful check gate.
        const restored = new Set<string>();
        const completed = [task];
        for (const correction of completed) {
          for (const findingId of correction.findingIds) {
            const predecessor = state.repairPredecessors[findingId];
            if (predecessor && !restored.has(predecessor)) {
              const siblings = graph.tasks.filter((candidate) =>
                candidate.findingIds.some((id) => state.repairPredecessors[id] === predecessor),
              );
              const rows = this.store.tasks(runId);
              if (
                !siblings.every((sibling) =>
                  rows.some(
                    (entry) =>
                      entry.id === sibling.id &&
                      ["implemented", "verified"].includes(entry.status) &&
                      hasTaskGate(entry, state.taskGates),
                  ),
                )
              )
                continue;
              restored.add(predecessor);
              this.store.taskStatus(runId, predecessor, "implemented", state.snapshotId);
              const row = this.store.tasks(runId).find((entry) => entry.id === predecessor);
              if (!row)
                throw new WorkflowFault("INVALID_REFERENCE", "Repair predecessor is missing");
              state.taskGates[predecessor] = {
                generation: row.generation,
                snapshotId: row.snapshot_id ?? "",
                definitionHash: hashJson(JSON.parse(row.definition_json)),
                evidenceIds: checkEvidence,
              };
              const parent = graph.tasks.find((candidate) => candidate.id === predecessor);
              if (parent) completed.push(parent);
            }
          }
        }
        // A task that depends on a restored task is invalidated (its agent runs again) only when
        // the repair changed a file it reads or writes; the other dependents keep their
        // implementation and only run their task checks again (jsondelta 9fbc18e7: one function
        // repaired in src/diff.ts reran three tasks for 494k of 1.94M tokens). Without the diffs of
        // the repair every dependent is invalidated, as before.
        const changedFiles = repairChangedFiles(
          this.store,
          runId,
          completed.filter((entry) => entry.origin !== "planned"),
        );
        const root = runRoot(this.store.workspace, state);
        const rows = this.store.tasks(runId);
        const rewritten = changedFiles ? this.correctedFiles(runId, graph.tasks, rows) : null;
        const invalid = new Set(restored);
        const recheck = new Set<string>();
        for (let changed = true; changed; ) {
          changed = false;
          for (const candidate of graph.tasks) {
            if (invalid.has(candidate.id) || recheck.has(candidate.id)) continue;
            if (!candidate.dependsOn.some((id) => invalid.has(id))) continue;
            const row = rows.find((entry) => entry.id === candidate.id);
            const finished = row && ["implemented", "verified"].includes(row.status);
            // A task only reached through an import keeps its implementation too when it has task
            // checks: the host runs them first, and a failure becomes a repair of that task.
            const reach =
              finished && changedFiles ? changeReach(root, candidate, changedFiles) : null;
            // A task whose every written file a corrective task rewrote is superseded there: its
            // agent would start from its original description and overwrite the correction
            // (md-site a586cde0 T003 ran three times, T006 four). Its checks decide instead.
            // Any declared check counts: a test task whose only check is a feature-scope build or
            // test command (Java `verify`) is protected by it too (propdrift 90c09da7 T006, 114k).
            const superseded =
              reach === "named" &&
              rewritten !== null &&
              declaredChecks(policy, candidate).length > 0 &&
              ownsOnly(candidate, rewritten);
            if (
              reach === "none" ||
              superseded ||
              (reach === "imports" && taskChecks(policy, candidate).length > 0)
            )
              recheck.add(candidate.id);
            else invalid.add(candidate.id);
            changed = true;
          }
        }
        for (const entry of rows) {
          if (restored.has(entry.id) || !["implemented", "verified"].includes(entry.status))
            continue;
          if (invalid.has(entry.id)) this.store.taskStatus(runId, entry.id, "invalidated");
          else if (recheck.has(entry.id)) {
            delete state.taskGates[entry.id];
            this.store.taskStatus(runId, entry.id, "implemented", entry.snapshot_id);
          }
        }
        this.store.finishStep(runId, child, "completed");
        this.store.saveState(runId, state);
      });
    }
  }
  /**
   * A finding "Required check X failed" is superseded by a later passing run of X: its evidence
   * no longer describes the files. Closing it keeps a corrective task that the passing run made
   * moot from being read as an open defect, whatever the other checks report.
   */
  private resolveCoveredFindings(runId: string, passedIds: string[]): void {
    if (!passedIds.length) return;
    const claims = new Set(passedIds.map((id) => `Required check ${id} failed`));
    this.store.transaction(() => {
      for (const finding of this.store.findings(runId))
        if (
          ["open", "confirmed"].includes(finding.status) &&
          claims.has(JSON.parse(finding.body_json).claim)
        )
          this.store.findingStatus(runId, finding.id, "resolved");
    });
  }
  private async runChecks(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
    fixed = false,
  ): Promise<Review["findings"]> {
    await this.snapshot(runId, state, policy, signal);
    const unsafe = await this.dependencyFindings(runId, state, policy);
    if (unsafe.length) return this.recordChecks(runId, state, unsafe);
    const failures: Review["findings"] = [];
    const failedIds: string[] = [];
    const passedIds: string[] = [];
    // A failure is repaired first; the next pass reruns every check, the inconclusive one too.
    let inconclusive: string | undefined;
    for (const check of policy.checks) {
      const attempt = this.store.reserve(runId, stepId, null, 0, policy);
      const result = await this.checks.run(
        runId,
        attempt,
        check,
        signal,
        runRoot(this.store.workspace, state),
      );
      this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
      failFastUnavailable(check, result);
      const regression =
        result.status === "passed" && check.required
          ? this.checkRegression(runId, state, check, result.output)
          : null;
      if (result.status === "passed" && !regression) passedIds.push(check.id);
      if (result.status === "inconclusive" && check.required) inconclusive ??= check.id;
      if ((result.status === "failed" || regression) && check.required) {
        failedIds.push(check.id);
        const task =
          state.graph?.tasks.find((t) => t.checkIds.includes(check.id)) ?? state.graph?.tasks[0];
        if (!task)
          throw new WorkflowFault("OUTPUT_INVALID", "Check failed without an associated task");
        failures.push(
          ...failedCheckFindings(
            check,
            result.evidenceId,
            result.output,
            (state.rootGraph ?? state.graph)?.tasks ?? [],
            task,
            regression
              ? `The check passed but ${regression} (evidence ${result.evidenceId}).`
              : `Inspect command evidence ${result.evidenceId} and correct the implementation within approved scope.`,
            newId,
          ),
        );
      }
    }
    this.resolveCoveredFindings(runId, passedIds);
    if (
      failures.length &&
      !fixed &&
      (await this.applyFixers(runId, stepId, state, policy, failedIds, signal))
    )
      return this.runChecks(runId, stepId, state, policy, signal, true);
    if (!failures.length && inconclusive)
      throw new WorkflowFault("OUTPUT_INVALID", `Required check ${inconclusive} is inconclusive`, {
        reason: "verification_failed",
      });
    if (!failures.length)
      failures.push(...(await this.qualityFindings(runId, state, policy, signal)));
    if (failures.length)
      return this.recordFindings(runId, {
        schemaVersion: 1,
        snapshotHash: state.workspaceHash ?? "",
        verdict: "changes_requested",
        coverage: [],
        findings: failures,
      });
    return failures;
  }
  /**
   * Runs the fixer of each failed check that names one (`ruff check --fix`, `biome check --write`)
   * on the files the run's tasks write, so findings a tool fixes mechanically cost no repair task.
   * Each file is one journaled edit with its pre-image, attributed to the last task that writes
   * it, so undo treats it like that task's own edits. Returns whether a file changed; the caller
   * then takes a new snapshot and reruns its checks once, and only what remains is repaired.
   */
  private async applyFixers(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    failedIds: string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const fixable = policy.checks.filter((c) => c.fix && failedIds.includes(c.id));
    const tasks = state.graph?.tasks ?? [];
    if (!fixable.length || !tasks.length) return false;
    const root = runRoot(this.store.workspace, state);
    const owners = new Map<string, string>();
    for (const task of tasks)
      for (const write of task.writes)
        if (write.action === "delete") owners.delete(write.path);
        else owners.set(write.path, task.id);
    return this.fixFiles(runId, stepId, root, policy, fixable, owners, signal);
  }
  /**
   * Before a task's checks are evaluated, runs the fixers of the static checks that cover its
   * code on the code files it wrote, so what a tool fixes mechanically (import order, formatting,
   * safe lint rules) is never a failure. What it cannot fix stays and fails the check in the task
   * that wrote the file, where the implementer can edit it.
   */
  private async fixTaskFiles(
    runId: string,
    child: string,
    root: string,
    policy: RunPolicy,
    task: Task,
    signal: AbortSignal,
  ): Promise<boolean> {
    const fixable = taskChecks(policy, task).filter((c) => c.fix);
    const paths = writtenCodePaths(task);
    if (!fixable.length || !paths.length) return false;
    return this.fixFiles(
      runId,
      child,
      root,
      policy,
      fixable,
      new Map(paths.map((path) => [path, task.id])),
      signal,
    );
  }
  /**
   * Runs each fixer on the files in `owners` (path to the task that last writes it) inside
   * `root`, one journaled edit per file. A change outside those files faults the call.
   */
  private async fixFiles(
    runId: string,
    stepId: string,
    root: string,
    policy: RunPolicy,
    fixable: Check[],
    owners: Map<string, string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const paths = [...owners.keys()].filter((path) => fileHash(workspacePath(root, path)));
    if (!paths.length) return false;
    const lease = mutationLeaseFor(this.store.workspace, root);
    const generated = generatedPaths(policy);
    const before = await sourceManifest(root, generated, signal);
    const attempt = this.store.beginHostAttempt(runId, stepId);
    const scope = new ProcessScope();
    let changed = false;
    try {
      for (const check of fixable) {
        for (const fix of fixerTiers(check))
          for (const path of paths) {
            signal.throwIfAborted();
            this.leases.assert(lease);
            const target = workspacePath(root, path);
            const preImage = capturePreImage(this.store, runId, target);
            const effectId = this.store.transaction(() =>
              this.store.prepareEffect(
                runId,
                attempt,
                "file_patch",
                {
                  path,
                  tool: "apply_fix",
                  checkId: check.id,
                  taskId: owners.get(path),
                  ...rootField(this.store.workspace, root),
                },
                preImage,
                null,
              ),
            );
            try {
              // A fixer that cannot fix everything exits non-zero; the rerun check decides.
              const command = fixerCommand(fix, path);
              await executeCheckCommand(
                scope,
                command.executable === "bun" ? process.execPath : command.executable,
                command.args,
                {
                  cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
                  env: buildCheckEnv(check),
                  timeoutMs: check.timeoutMs,
                  signal,
                },
              );
              const after = fileHash(target);
              this.store.transaction(() => this.store.finishFileEffect(runId, effectId, after));
              if (after !== preImage) changed = true;
            } catch (error) {
              this.store.transaction(() => this.store.effectStatus(runId, effectId, "unknown"));
              throw error;
            }
          }
      }
      const outside = changedPaths(before, await sourceManifest(root, generated, signal)).filter(
        (path) => !owners.has(path),
      );
      if (outside.length)
        throw new WorkflowFault(
          "CAPABILITY_DENIED",
          `A check fixer changed files outside the run's tasks: ${outside.join(", ")}`,
        );
      this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
      return changed;
    } catch (error) {
      this.store.transaction(() => this.store.finishAttempt(runId, attempt, "failed", 0));
      throw error;
    } finally {
      await scope.stop();
    }
  }
  /**
   * Measures the code at approval, before any task edits it: the baseline of the duplication
   * ratchet (#638), and the planned code files as they are, so the rule pack (#639) checks only
   * the lines the run adds. Kept once per run: a revised plan compares with the same code.
   */
  private async measureQualityBaseline(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    const root = runRoot(this.store.workspace, state);
    if (!this.store.latestArtifact(runId, QUALITY_BASELINE_FILES)) {
      const planned = (state.graph?.tasks ?? []).flatMap((t) => t.writes.map((w) => w.path));
      const existing = planned.filter((path) => state.expectedFiles?.[path] !== undefined);
      const code = await readCodeFiles(
        root,
        [...new Set(existing)],
        (path) => isCodePath(path) || isManifestPath(path),
      );
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "quality",
          QUALITY_BASELINE_FILES,
          canonical(Object.fromEntries(code.files)),
        ),
      );
    }
    if (duplicationOf(policy) === "off" || this.store.latestArtifact(runId, QUALITY_BASELINE))
      return;
    const code = await readCodeFiles(root, Object.keys(state.expectedFiles ?? {}));
    signal.throwIfAborted();
    const baseline = measureBaseline(code.files, code.skipped);
    this.store.transaction(() =>
      this.store.artifact(runId, "quality", QUALITY_BASELINE, canonical(baseline)),
    );
  }
  /**
   * The code quality gates after the command checks pass (#630): the duplication ratchet and
   * the anti-slop rule pack. Both always record their result for the run report; their blocking
   * findings are corrected like failed checks.
   */
  private async qualityFindings(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<Review["findings"]> {
    const blocking = [
      ...(await this.duplicationFindings(runId, state, policy)),
      ...(await this.ruleFindings(runId, state, policy)),
      ...(await this.sastFindings(runId, state, policy)),
    ];
    // Mutants run the tests many times; code that is about to change again is not worth it.
    if (!blocking.length)
      blocking.push(...(await this.mutationFindings(runId, state, policy, signal)));
    return blocking.slice(0, 100);
  }
  /**
   * The mutation gate (#636): plants small faults in the lines the run added, one at a time,
   * and runs the policy's required test checks against each. Surviving mutants are blocking
   * findings under `required`, owned by the task that writes a related test file so the
   * correction adds a test that kills them; under `advisory` they are notes in the run report.
   */
  private async mutationFindings(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<Review["findings"]> {
    const mode = mutationOf(
      policy,
      presetOf(parseRunDefinition(this.store.run(runId).definition_json)),
    );
    if (mode === "off" || !state.snapshotId) return [];
    const root = runRoot(this.store.workspace, state);
    const tests = policy.checks.filter((check) => check.required && isTestCheck(check));
    const changed = await this.changedFiles(runId, state, isCodePath);
    const mutants = tests.length ? generateMutants(changed) : [];
    const originals = new Map<string, Buffer>();
    for (const mutant of mutants)
      if (!originals.has(mutant.file))
        originals.set(mutant.file, readFileSync(workspacePath(root, mutant.file)));
    // Kept until the gate restores the files, so a host that stops mid-mutant restores them on the next drive.
    const pending = (files: Map<string, Buffer>) =>
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "quality",
          QUALITY_MUTATION_PENDING,
          canonical({
            root: relative(this.store.workspace, root).replaceAll("\\", "/"),
            files: Object.fromEntries(
              [...files].map(([path, bytes]) => [path, bytes.toString("base64")]),
            ),
          }),
        ),
      );
    const scope = new ProcessScope();
    let result: MutationResult;
    if (originals.size) pending(originals);
    try {
      result = tests.length
        ? await runMutants(
            mode,
            mutants,
            changed,
            tests.map((check) => check.id),
            {
              plant: async (path, content) => writeFileSync(workspacePath(root, path), content),
              restore: async (path) => {
                const bytes = originals.get(path);
                if (bytes) writeFileSync(workspacePath(root, path), bytes);
              },
              test: async (timeLeftMs) => {
                for (const check of tests) {
                  const outcome = await executeCheckCommand(
                    scope,
                    check.executable === "bun" ? process.execPath : check.executable,
                    check.args,
                    {
                      cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
                      env: buildCheckEnv(check),
                      timeoutMs: Math.max(1000, Math.min(check.timeoutMs, timeLeftMs)),
                      signal,
                    },
                  );
                  if (outcome.timedOut) return { status: "timeout" };
                  if (outcome.exitCode !== 0) return { status: "failed", check: check.id };
                }
                return { status: "passed" };
              },
              now: () => Date.now(),
            },
            {
              ...(policy.mutationBudgetMs ? { budgetMs: policy.mutationBudgetMs } : {}),
              ...(policy.mutationThresholds ? { thresholds: policy.mutationThresholds } : {}),
              signal,
            },
          )
        : {
            schemaVersion: 1,
            mode,
            tests: [],
            mutants: [],
            score: null,
            note: "no required test check in the policy",
          };
    } finally {
      await scope.stop();
      if (originals.size) pending(new Map());
    }
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(runId, "quality", QUALITY_MUTATION, canonical(result));
      return this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
    });
    const blocking = result.mutants.filter((m) => m.blocking);
    if (!blocking.length) {
      this.resolveClaims(runId, mutationClaim);
      return [];
    }
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    return blocking.map((m) => {
      const owner = tasks.find((t) => t.writes.some((w) => w.path === m.file));
      // The test file of a related task, so the correction may write the test that kills it.
      const testFile = tasks
        .filter(
          (t) =>
            t === owner || (owner && t.criterionIds.some((id) => owner.criterionIds.includes(id))),
        )
        .flatMap((t) => t.writes.map((w) => w.path))
        .find((path) => isTestCodePath(path) && isCodePath(path));
      return this.qualityFinding(state, {
        kind: "correctness",
        file: testFile ?? m.file,
        evidenceId,
        claim: `Surviving mutant ${m.id}: ${m.file}:${m.line} changed from \`${m.original.trim().slice(0, 160)}\` to \`${m.mutated.trim().slice(0, 160)}\` and every test check still passed`,
        impact:
          "The tests do not check the behavior of this line: a wrong change to it would go unnoticed.",
        suggestedFix: `Add or strengthen a test${testFile ? ` in ${testFile}` : ""} that passes on the code as it is and fails on the mutant (${m.file}:${m.line}). Do not change ${m.file} to get rid of the mutant.`,
      });
    });
  }
  /**
   * Puts back a file a mutant was planted in when the host stopped before the mutation gate
   * restored it. Only a file that still differs from what the gate saved is written.
   */
  private restoreMutatedFiles(runId: string): void {
    const row = this.store.latestArtifact(runId, QUALITY_MUTATION_PENDING);
    if (!row) return;
    const pending = JSON.parse(this.store.readArtifact(runId, row.id)) as {
      root: string;
      files: Record<string, string>;
    };
    if (!Object.keys(pending.files).length) return;
    const root = join(this.store.workspace, pending.root);
    for (const [path, base64] of Object.entries(pending.files)) {
      const target = workspacePath(root, path);
      const bytes = Buffer.from(base64, "base64");
      if (!existsSync(target) || !readFileSync(target).equals(bytes)) writeFileSync(target, bytes);
    }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "quality",
        QUALITY_MUTATION_PENDING,
        canonical({ root: pending.root, files: {} }),
      ),
    );
  }
  /**
   * The files the run changed that `include` selects and that still exist, with their content
   * now and at baseline: the planned files kept at approval, else the pre-image the run saved
   * before its first edit; undefined when neither is known, null for a file the run created.
   */
  private async changedFiles(
    runId: string,
    state: RuntimeState,
    include: (path: string) => boolean,
  ): Promise<ChangedFile[]> {
    const files = state.expectedFiles ?? {};
    const baselineId = state.manifest.baselineSnapshotId;
    const before = (baselineId && this.store.snapshotFiles(runId, baselineId)) || {};
    const root = runRoot(this.store.workspace, state);
    const kept = this.store.latestArtifact(runId, QUALITY_BASELINE_FILES);
    const planned = kept
      ? (JSON.parse(this.store.readArtifact(runId, kept.id)) as Record<string, string>)
      : {};
    const changed: ChangedFile[] = [];
    for (const path of changedPaths(before, files)) {
      if (!include(path) || files[path] === undefined) continue;
      const content = (await readCodeFiles(root, [path], include)).files.get(path);
      if (content === undefined) continue;
      const hash = before[path];
      changed.push({
        path,
        content,
        before: hash
          ? (planned[path] ?? readKept(this.store, runId, hash)?.toString("utf8") ?? undefined)
          : null,
      });
    }
    return changed;
  }
  /** Closes the open findings whose claim `matches`, once their gate passes. */
  private resolveClaims(runId: string, matches: (claim: unknown) => boolean): void {
    this.store.transaction(() => {
      for (const finding of this.store.findings(runId))
        if (
          ["open", "confirmed"].includes(finding.status) &&
          matches(JSON.parse(finding.body_json).claim)
        )
          this.store.findingStatus(runId, finding.id, "resolved");
    });
  }
  /** A blocking quality finding on a file, owned by the last task that writes the file. */
  private qualityFinding(
    state: RuntimeState,
    item: {
      kind: "correctness" | "security";
      file: string;
      symbol?: string | null;
      evidenceId: string;
      claim: string;
      impact: string;
      suggestedFix: string;
    },
  ): Review["findings"][number] {
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    const task = [...tasks].reverse().find((t) => t.writes.some((w) => w.path === item.file));
    return {
      id: newId(),
      kind: item.kind,
      severity: "high",
      requirementIds:
        task?.requirementIds ?? state.spec?.requirements.map((r) => r.id).slice(0, 1) ?? [],
      criterionIds: task?.criterionIds ?? [],
      file: item.file,
      symbol: item.symbol ?? null,
      evidenceIds: [item.evidenceId],
      claim: item.claim,
      impact: item.impact,
      suggestedFix: item.suggestedFix,
    };
  }
  /**
   * The dependency check (#640) before the run's commands install or run anything: packages
   * the run declares or imports that do not exist, look like typosquats or are days old block;
   * the others are listed in `quality/dependencies.json` for the run report.
   */
  private async dependencyFindings(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
  ): Promise<Review["findings"]> {
    if (!state.snapshotId) return [];
    const changed = await this.changedFiles(
      runId,
      state,
      (path) => isManifestPath(path) || isCodePath(path),
    );
    if (!changed.length) return [];
    const root = runRoot(this.store.workspace, state);
    // Packages that need no registry: declared in any package.json, local workspace packages,
    // and tsconfig path aliases.
    const known = new Set<string>();
    const aliases: string[] = [];
    const config = await readCodeFiles(root, Object.keys(state.expectedFiles ?? {}), (path) =>
      /(^|\/)(package\.json|tsconfig[\w.-]*\.json|jsconfig\.json)$/.test(path),
    );
    for (const [path, text] of config.files) {
      if (path.endsWith("package.json")) {
        for (const d of manifestDependencies(path, text)) known.add(d.name);
        const name = /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
        if (name) known.add(name);
      } else
        for (const m of text.matchAll(/"([^"*]+?)\/?\*"\s*:\s*\[/g))
          if (m[1] && m[1] !== "paths") aliases.push(m[1]);
    }
    const result = await checkDependencies(changed, known, {
      lookups: policy.registryLookups !== false,
      ...(this.registryFetch ? { fetcher: this.registryFetch } : {}),
      aliases,
    });
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "quality",
        QUALITY_DEPENDENCIES,
        canonical(result),
      );
      return this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
    });
    const blocking = result.dependencies.filter((d) => d.blocking);
    if (!blocking.length) {
      this.resolveClaims(runId, dependencyClaim);
      return [];
    }
    return blocking.map((d) =>
      this.qualityFinding(state, {
        kind: "security",
        file: d.file,
        symbol: d.name,
        evidenceId,
        claim: `Dependency ${d.name}: ${d.detail} (${d.file}:${d.line})`,
        impact:
          "Installing a package that does not exist or imitates a popular one can run an attacker's code.",
        suggestedFix:
          d.verdict === "missing"
            ? `Remove ${d.name}, or use the package that really provides it; do not invent package names.`
            : `Replace ${d.name} with the package it imitates, or remove it.`,
      }),
    );
  }
  /** Semgrep on the code the run changed (#640); `ERROR` matches on added lines block. */
  private async sastFindings(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
  ): Promise<Review["findings"]> {
    if (sastOf(policy) === "off" || !state.snapshotId) return [];
    const changed = await this.changedFiles(runId, state, isCodePath);
    const result = runSast(
      runRoot(this.store.workspace, state),
      changed,
      policy.sastConfig ?? DEFAULT_SAST_CONFIG,
      ...(this.semgrep !== undefined ? [this.semgrep] : []),
    );
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(runId, "quality", QUALITY_SAST, canonical(result));
      return this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
    });
    const blocking = result.findings.filter((f) => f.blocking);
    if (!blocking.length) {
      this.resolveClaims(runId, sastClaim);
      return [];
    }
    return blocking.map((f) =>
      this.qualityFinding(state, {
        kind: "security",
        file: f.file,
        evidenceId,
        claim: `SAST ${f.rule}: ${f.message} (${f.file}:${f.line})`,
        impact: "Semgrep reports a security flaw on a line the run added.",
        suggestedFix: "Change the code so the Semgrep rule no longer matches; do not suppress it.",
      }),
    );
  }
  /**
   * The anti-slop rule pack on the lines the run added to code files. A file's baseline is the
   * pre-image the run kept before its first edit; a changed file without one is checked, but its
   * findings stay notes. Earlier rule findings close once no blocking match remains.
   */
  private async ruleFindings(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
  ): Promise<Review["findings"]> {
    if (!state.snapshotId) return [];
    const root = runRoot(this.store.workspace, state);
    const changed = await this.changedFiles(runId, state, isCodePath);
    const result = checkQualityRules(root, changed, policy.qualityRules ?? {});
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(runId, "quality", QUALITY_RULES, canonical(result));
      return this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
    });
    const blocking = result.findings.filter((f) => f.blocking);
    if (!blocking.length) {
      this.store.transaction(() => {
        for (const finding of this.store.findings(runId))
          if (
            ["open", "confirmed"].includes(finding.status) &&
            ruleClaim(JSON.parse(finding.body_json).claim)
          )
            this.store.findingStatus(runId, finding.id, "resolved");
      });
      return [];
    }
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    return blocking.map((match: RuleFinding) => {
      const task = [...tasks].reverse().find((t) => t.writes.some((w) => w.path === match.file));
      return {
        id: newId(),
        kind: "correctness" as const,
        severity: "high" as const,
        requirementIds:
          task?.requirementIds ?? state.spec?.requirements.map((r) => r.id).slice(0, 1) ?? [],
        criterionIds: task?.criterionIds ?? [],
        file: match.file,
        symbol: null,
        evidenceIds: [evidenceId],
        claim: `Rule ${match.rule}: ${match.message} (${match.file}:${match.line}: ${match.text})`,
        impact: "The anti-slop rule pack of this run blocks this pattern.",
        suggestedFix: match.fix,
      };
    });
  }
  /**
   * The duplication ratchet after the command checks pass: the run's code against the baseline
   * measured at approval, recorded for the run report. Under `ratchet` every copy and unused
   * declaration the run added is a blocking finding that names what to reuse; under `warn` they
   * stay notes in the recorded result. Earlier ratchet findings close once nothing blocks.
   */
  private async duplicationFindings(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
  ): Promise<Review["findings"]> {
    const mode = duplicationOf(policy);
    const row = this.store.latestArtifact(runId, QUALITY_BASELINE);
    if (mode === "off" || !row || !state.snapshotId) return [];
    const baseline = JSON.parse(this.store.readArtifact(runId, row.id)) as QualityBaseline;
    const files = state.expectedFiles ?? {};
    const baselineId = state.manifest.baselineSnapshotId;
    const before = (baselineId && this.store.snapshotFiles(runId, baselineId)) || {};
    const code = await readCodeFiles(runRoot(this.store.workspace, state), Object.keys(files));
    const result = compareWithBaseline(
      mode,
      baseline,
      code.files,
      new Set(changedPaths(before, files)),
      code.skipped,
    );
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "quality",
        QUALITY_DUPLICATION,
        canonical(result),
      );
      return this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
    });
    if (!result.blocking) {
      this.store.transaction(() => {
        for (const finding of this.store.findings(runId))
          if (
            ["open", "confirmed"].includes(finding.status) &&
            qualityClaim(JSON.parse(finding.body_json).claim)
          )
            this.store.findingStatus(runId, finding.id, "resolved");
      });
      return [];
    }
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    const owner = (file: string) => {
      const task = [...tasks].reverse().find((t) => t.writes.some((w) => w.path === file));
      return {
        requirementIds:
          task?.requirementIds ?? state.spec?.requirements.map((r) => r.id).slice(0, 1) ?? [],
        criterionIds: task?.criterionIds ?? [],
      };
    };
    const where = (span: { file: string; startLine: number; endLine: number }) =>
      `${span.file}:${span.startLine}-${span.endLine}`;
    return [
      ...result.clones.map((clone) => ({
        id: newId(),
        kind: "correctness" as const,
        severity: "high" as const,
        ...owner(clone.file),
        file: clone.file,
        symbol: null,
        evidenceIds: [evidenceId],
        claim: `Duplicated code: ${where(clone)} copies ${where(clone.original)}`,
        impact:
          "The run adds a copy of existing code, which the duplication ratchet of this run does not allow.",
        suggestedFix: `Reuse the code at ${where(clone.original)} (import it, or extract a shared helper within approved scope) instead of copying it.`,
      })),
      ...result.unused.map((item) => ({
        id: newId(),
        kind: "correctness" as const,
        severity: "high" as const,
        ...owner(item.file),
        file: item.file,
        symbol: item.name,
        evidenceIds: [evidenceId],
        claim: `Unused code: ${item.name} at ${item.file}:${item.line} is used nowhere`,
        impact:
          "The run adds code nothing calls, which the duplication ratchet of this run does not allow.",
        suggestedFix: `Call ${item.name} where the task needs it, or remove it.`,
      })),
    ].slice(0, 100);
  }
  /** Records blocking findings of a checks stage as a review that requests changes. */
  private recordChecks(
    runId: string,
    state: RuntimeState,
    findings: Review["findings"],
  ): Review["findings"] {
    return this.recordFindings(runId, {
      schemaVersion: 1,
      snapshotHash: state.workspaceHash ?? "",
      verdict: "changes_requested",
      coverage: [],
      findings,
    });
  }
  /** Stores a review and registers the findings that block; the others stay in the artifact. */
  private recordFindings(
    runId: string,
    review: Review,
    register: Review["findings"] = review.findings,
  ): Review["findings"] {
    return this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "review",
        `reviews/${newId()}.json`,
        canonical(review),
      );
      return register.map((finding) => ({
        ...finding,
        id: this.store.addFinding(runId, finding, fingerprint(finding), artifact.id),
      }));
    });
  }
  /** The v1 review stage: correctness, security when triggered and language, each blocking. */
  private v1Reviewers(state: RuntimeState, policy: RunPolicy): Reviewer[] {
    const dimensions = v1ReviewDimensions(state, policy);
    return dimensions.map((dimension) => ({
      key: dimension,
      dimension,
      profileId: policy.reviewProfiles[dimension] ?? "",
      skepticProfileId: policy.skepticProfileId,
      blocking: ALL_SEVERITIES,
      required: true,
      appliesWhen: "always",
    }));
  }
  /** The AI review gates of a v2 review stage whose condition holds; the others are skipped. */
  private v2Reviewers(
    runId: string,
    state: RuntimeState,
    v2: { stage: Stage; gates: Gate[] },
  ): Reviewer[] {
    const paths = state.graph
      ? state.graph.tasks.flatMap((t) => t.writes.map((w) => w.path))
      : (state.diff?.files ?? []);
    const policy = PolicySchema.parse(JSON.parse(this.store.run(runId).policy_json));
    return reviewersOf(v2.stage, v2.gates).filter((reviewer) => {
      if (
        reviewer.appliesWhen === "always" ||
        requiresSecurityReview(paths, policy.forceSecurityReview)
      )
        return true;
      this.recordGate(runId, state, reviewer.key, null, {
        status: "skipped",
        mode: reviewer.required ? "required" : "advisory",
        evidenceId: null,
        attempts: 0,
        flaky: false,
      });
      return false;
    });
  }
  private async review(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    signal: AbortSignal,
    reviewers: Reviewer[],
    routeGaps = false,
  ): Promise<Review["findings"]> {
    if (!state.spec || !state.snapshotId || !state.workspaceHash)
      throw new WorkflowFault("ARTIFACT_MISSING", "Review snapshot missing");
    const findings: Review["findings"] = [];
    const owners = new Map<string, Reviewer>();
    const severities = repairSeverities(this.store.run(runId));
    const reviewSpec = state.spec;
    const reviewSnapshotId = state.snapshotId;
    const reviewSnapshotHash = state.workspaceHash;
    const executables = reproExecutables(policy.checks);
    const repro = (r: Repro) =>
      runRepro(this.processes, r, {
        root: runRoot(this.store.workspace, state),
        executables,
        generated: generatedPaths(policy),
        signal,
      });
    // The workspace the run started from had no source code: the reviewers judge the whole program.
    const greenfield = this.baselineScaffold(runId, state);
    const runReviewer = async (reviewer: Reviewer) => {
      // A review of this very snapshot that an earlier, interrupted round finished is kept.
      const kept = state.reviews[reviewer.key];
      if (kept && kept.snapshotHash === reviewSnapshotHash && kept.verdict !== "inconclusive")
        return { reviewer, result: kept };
      // After a correction, a dimension that passed and whose files did not change keeps its
      // review; one that runs again is told what it found and what changed (#713).
      const prior = state.priorReviews[reviewer.key];
      const changed =
        prior && state.expectedFiles ? changedSince(prior.files, state.expectedFiles) : null;
      if (prior && changed && carriesOver(reviewer.dimension, prior.review, changed)) {
        this.store.transaction(() =>
          this.store.artifact(
            runId,
            "diagnostic",
            `reviews/carried-${reviewer.key}-${reviewSnapshotId}.json`,
            canonical({
              key: reviewer.key,
              dimension: reviewer.dimension,
              reviewedSnapshotHash: prior.review.snapshotHash,
              changedSince: changed,
            }),
          ),
        );
        return { reviewer, result: prior.review };
      }
      const rerun =
        prior && changed
          ? {
              previousRound: await previousRound(this.store, runId, prior, changed, (path) => {
                const absolute = workspacePath(runRoot(this.store.workspace, state), path);
                return existsSync(absolute) ? readFileSync(absolute) : null;
              }),
            }
          : {};
      const child = this.store.transaction(() =>
        this.store.beginStep(runId, `dimension-${reviewer.key}`, stepId),
      );
      const profile = this.requireProfile(profiles.find((p) => p.id === reviewer.profileId));
      const canRepro = executables.length > 0 && profile.allowedTools.includes("run_repro");
      // The language dimension reviews idioms in the diff; criterion coverage is not its job.
      const diffOnly = reviewer.dimension === "language";
      let reproAdvised = false;
      const ask = async (extra: Record<string, unknown>): Promise<Review> => {
        const answer = ReviewSchema.parse(
          await this.call(
            runId,
            child,
            state,
            policy,
            profile,
            {
              dimension: reviewer.dimension,
              evidence: diffOnly
                ? this.evidenceContext(runId, state).filter(
                    (e) => (e as { kind: string }).kind === "diff",
                  )
                : this.evidenceContext(runId, state),
              ...(diffOnly ? { [DIFF_REVIEW]: true } : {}),
              ...rerun,
              ...(greenfield ? { baseline: { greenfield } } : {}),
              ...extra,
            },
            signal,
            undefined,
            0,
            (output) => {
              if (!ReviewSchema.safeParse(output).success) return [];
              const problems = reviewProblems(
                this.store,
                runId,
                reviewSnapshotId,
                reviewSnapshotHash,
                reviewSpec,
                output as Review,
                !diffOnly,
              );
              // Asked once: a reviewer that still has no repro after the advice is not blocked.
              if (problems.length || reproAdvised || !canRepro) return problems;
              const advice = missingReproAdvice(output as Review);
              if (advice.length) reproAdvised = true;
              return advice;
            },
            undefined,
            canRepro ? () => ({ run_repro: reproTool(executables, repro) }) : undefined,
          ),
        );
        // The host owns the snapshot hash and the evidence ids; omitted criteria are listed as
        // inconclusive, and the converge stage settles coverage.
        completeReview(
          this.store,
          runId,
          reviewSnapshotId,
          reviewSnapshotHash,
          reviewSpec,
          answer,
          !diffOnly,
        );
        // Without coverage to settle, a diff review is decided by its findings alone.
        if (diffOnly) answer.verdict = answer.findings.length ? "changes_requested" : "pass";
        return answer;
      };
      let result = await ask({});
      if (result.verdict === "inconclusive" && reviewer.required) {
        // One more question with the criteria it left open: a reviewer that sees the list often
        // settles them, or says what evidence would (endfix 2295dbbd, AC-001 and AC-005).
        const open = result.coverage.filter((c) => c.verdict === "inconclusive");
        if (open.length) {
          result = await ask({
            inconclusiveCriteria: {
              note: "Your review was inconclusive on these criteria. Settle each from the code and the evidence, using run_repro where it helps, or say in the explanation which test or check would establish it. Do not leave a criterion inconclusive without a reason.",
              criteria: open.map((c) => ({
                criterionId: c.criterionId,
                explanation: c.explanation,
              })),
            },
          });
        }
      }
      validateReview(
        this.store,
        runId,
        reviewSnapshotId,
        reviewSnapshotHash,
        reviewSpec,
        result,
        false,
      );
      if (result.verdict === "inconclusive" && reviewer.required) {
        // Criteria no review can establish go to the converge stage as evidence gaps, which adds
        // a test or declared check as a convergence task; without such a stage, or when the
        // verdict has no criterion behind it, the run blocks as before.
        const gaps = result.coverage.filter((c) => c.verdict === "inconclusive");
        if (!routeGaps || !gaps.length)
          throw new WorkflowFault("OUTPUT_INVALID", `${reviewer.dimension} review inconclusive`);
        state.reviewGaps[reviewer.key] = gaps.map((c) => ({
          criterionId: c.criterionId,
          explanation: c.explanation,
        }));
        result.verdict = result.findings.length ? "changes_requested" : "pass";
      } else delete state.reviewGaps[reviewer.key];
      this.store.transaction(() => this.store.finishStep(runId, child, "completed"));
      return { reviewer, result };
    };
    for (let offset = 0; offset < reviewers.length; offset += policy.maxConcurrentReadAgents) {
      const batch = await Promise.allSettled(
        reviewers.slice(offset, offset + policy.maxConcurrentReadAgents).map(runReviewer),
      );
      // Reviews that finished are kept before a sibling's failure is raised, so a resume does not
      // pay for them again.
      const failed = batch.find((outcome) => outcome.status === "rejected");
      if (failed) {
        for (const outcome of batch)
          if (outcome.status === "fulfilled")
            state.reviews[outcome.value.reviewer.key] = outcome.value.result;
        this.store.transaction(() => this.store.saveState(runId, state));
        throw failed.reason;
      }
      for (const outcome of batch) {
        if (outcome.status === "rejected") throw outcome.reason;
        const { reviewer, result } = outcome.value;
        state.reviews[reviewer.key] = result;
        // Advisory reviewers, findings below the blocking severities and inferred notes are
        // recorded, not repaired.
        const candidates = reviewer.required
          ? result.findings.filter(
              (f) =>
                reviewer.blocking.includes(f.severity) &&
                severities.includes(f.severity) &&
                findingBlocks(f, policy.reviewMinConfidence),
            )
          : [];
        // A claim starts a correction only when its repro shows it (#155).
        const outcomes = new Map<string, ReproOutcome>();
        for (const finding of candidates)
          if (finding.repro && executables.length)
            outcomes.set(finding.id, await repro(finding.repro));
        if (outcomes.size)
          this.store.transaction(() =>
            this.store.artifact(
              runId,
              "repro",
              `reviews/repro-${newId()}.json`,
              canonical({ dimension: reviewer.dimension, outcomes: Object.fromEntries(outcomes) }),
            ),
          );
        const blocking = candidates.filter((f) =>
          reproAllows(f, outcomes.get(f.id)?.status, executables.length > 0),
        );
        const repaired = new Set(blocking.map((f) => f.id));
        addReviewNotes(
          state.reviewNotes,
          reviewer.dimension,
          reviewSnapshotId,
          result.findings
            .filter((f) => !repaired.has(f.id))
            .map((finding) => ({
              finding,
              reason: reviewer.required
                ? noteReason(
                    finding,
                    severities.filter((s) => reviewer.blocking.includes(s)),
                    policy.reviewMinConfidence,
                  )
                : "advisory",
            })),
        );
        for (const finding of this.recordFindings(runId, result, blocking)) {
          findings.push(finding);
          owners.set(finding.id, reviewer);
        }
      }
    }
    for (const finding of findings.filter((f) => ["critical", "high"].includes(f.severity))) {
      const skeptic = owners.get(finding.id)?.skepticProfileId;
      if (!skeptic) continue;
      const child = this.store.transaction(() =>
        this.store.beginStep(runId, `skeptic-${fingerprint(finding).slice(0, 24)}`, stepId),
      );
      const result = RefutationSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          this.requireProfile(profiles.find((p) => p.id === skeptic)),
          { finding, evidence: this.evidenceContext(runId, state) },
          signal,
        ),
      );
      result.evidenceIds = resolveEvidenceIds(
        currentEvidence(this.store, runId, state.snapshotId),
        result.evidenceIds,
      );
      if (result.findingId !== finding.id)
        throw new WorkflowFault("OUTPUT_INVALID", "Skeptic returned another finding ID");
      validateEvidence(
        this.store,
        runId,
        state.snapshotId,
        result.evidenceIds,
        result.decision !== "inconclusive",
      );
      this.store.transaction(() => {
        this.store.findingStatus(runId, finding.id, result.decision);
        this.store.finishStep(runId, child, "completed");
      });
      if (result.decision === "inconclusive")
        throw new WorkflowFault("OUTPUT_INVALID", "Skeptic could not resolve a blocker");
    }
    const live = new Set(findings.map((f) => f.id));
    this.store.transaction(() => {
      for (const old of this.store.findings(runId))
        if (old.repair_task_id && !live.has(old.id))
          this.store.findingStatus(runId, old.id, "resolved");
    });
    const open = findings.filter(
      (f) => this.store.findings(runId).find((entry) => entry.id === f.id)?.status !== "refuted",
    );
    if (state.position)
      for (const reviewer of reviewers) {
        const result = state.reviews[reviewer.key];
        this.recordGate(runId, state, reviewer.key, null, {
          status:
            result?.verdict === "inconclusive"
              ? "inconclusive"
              : open.some((f) => owners.get(f.id) === reviewer)
                ? "failed"
                : "passed",
          mode: reviewer.required ? "required" : "advisory",
          evidenceId: null,
          attempts: 1,
          flaky: false,
        });
      }
    return open;
  }
  /** The gates frozen when the run started. */
  private frozenGates(runId: string): Gate[] {
    const artifact = this.store
      .artifacts(runId)
      .filter((a) => a.logical_path === GATES_ARTIFACT)
      .at(-1);
    return artifact
      ? GateSchema.array().parse(JSON.parse(this.store.readArtifact(runId, artifact.id)))
      : [];
  }
  private outcomeOf(stage: Stage, repair: boolean): Outcome {
    if (!repair) return "passed";
    return stage.type === "check" || stage.type === "wait" ? "failed" : "changes_requested";
  }
  /** Keeps the latest result of a gate in the state and writes `gate.finished`. */
  private recordGate(
    runId: string,
    state: RuntimeState,
    gateId: string,
    transitionId: string | null,
    result: Omit<RuntimeState["gateResults"][string], "snapshotId">,
  ): void {
    state.gateResults[gateId] = { ...result, snapshotId: state.snapshotId };
    this.store.transaction(() =>
      this.store.emit(runId, {
        type: "gate.finished",
        payload: {
          gateId,
          transitionId,
          mode: result.mode,
          status: result.status,
          attempts: result.attempts,
          flaky: result.flaky,
          evidenceId: result.evidenceId,
        },
      }),
    );
  }
  /**
   * Runs one command gate with its retries. Every attempt is recorded as a check result; a pass
   * after a failed or inconclusive attempt is flagged flaky. Only `failed` may be retried as
   * failed; a timeout is an inconclusive attempt.
   */
  private async runCommandGate(
    runId: string,
    stepId: string,
    check: Check,
    gate: Gate,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<{
    status: "passed" | "failed" | "inconclusive";
    evidenceId: string;
    attempts: number;
    flaky: boolean;
    /** Set when the host failed the gate without running it. */
    reason?: string;
    output?: string;
  }> {
    let attempts = 0;
    let unstable = false;
    // A test promoted from an AI walk-through runs only as the person approved it.
    const pinned = gate.type === "command" ? gate.provenance : undefined;
    if (pinned) {
      const current = fileHash(workspacePath(this.store.workspace, pinned.testPath));
      if (current !== pinned.testHash) {
        const attempt = this.store.reserve(runId, stepId, null, 0, policy);
        const result = await this.checks.refuse(
          runId,
          attempt,
          check,
          "test_modified",
          `test modified since approval: ${pinned.testPath} has ${current ?? "no file"}, approved ${pinned.testHash}`,
        );
        this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
        return {
          status: "failed",
          evidenceId: result.evidenceId,
          attempts: 1,
          flaky: false,
          reason: "test modified since approval",
        };
      }
    }
    for (;;) {
      attempts++;
      const attempt = this.store.reserve(runId, stepId, null, 0, policy);
      const result = await this.checks.run(runId, attempt, check, signal, this.rootOf(runId));
      this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
      failFastUnavailable(check, result);
      if (result.status === "passed")
        return { status: "passed", evidenceId: result.evidenceId, attempts, flaky: unstable };
      unstable = true;
      const retryable = gate.retries.retryOn.some((on) =>
        result.status === "failed" ? on === "failed" : on === "inconclusive" || on === "timeout",
      );
      if (!retryable || attempts > gate.retries.max)
        return {
          status: result.status,
          evidenceId: result.evidenceId,
          attempts,
          flaky: false,
          output: result.output,
        };
    }
  }
  /**
   * A v2 check stage: its command gates in the listed order, required ones first. A required
   * failure becomes a finding for the failed outcome, an inconclusive required gate blocks unless
   * another one failed (the repair comes first and the next pass reruns it), and an advisory gate
   * is recorded and never blocks.
   */
  private async runCheckStage(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    v2: { stage: Stage; gates: Gate[] },
    signal: AbortSignal,
    fixed = false,
  ): Promise<Review["findings"]> {
    if (v2.stage.type !== "check") return [];
    await this.snapshot(runId, state, policy, signal);
    const unsafe = await this.dependencyFindings(runId, state, policy);
    if (unsafe.length) return this.recordChecks(runId, state, unsafe);
    const bound = v2.stage.gates.map((binding) => {
      const gate = v2.gates.find((g) => g.id === binding.gateId);
      if (gate?.type !== "command")
        throw new WorkflowFault("INVALID_REFERENCE", `Check gate ${binding.gateId} is missing`);
      return { gate, check: gateToCheck(gate, binding) };
    });
    const ordered = [
      ...bound.filter((b) => b.check.required),
      ...bound.filter((b) => !b.check.required),
    ];
    const failures: Review["findings"] = [];
    const failedIds: string[] = [];
    const passedIds: string[] = [];
    let inconclusive: string | undefined;
    for (const { gate, check } of ordered) {
      const result = await this.runCommandGate(runId, stepId, check, gate, policy, signal);
      this.recordGate(runId, state, gate.id, null, {
        status: result.status,
        mode: check.required ? "required" : "advisory",
        evidenceId: result.evidenceId,
        attempts: result.attempts,
        flaky: result.flaky,
      });
      const regression =
        result.status === "passed" && check.required
          ? this.checkRegression(runId, state, check, result.output ?? "")
          : null;
      if (result.status === "passed" && !regression) passedIds.push(check.id);
      if (!check.required || (result.status === "passed" && !regression)) continue;
      if (result.status === "inconclusive") {
        inconclusive ??= check.id;
        continue;
      }
      if (!result.reason) failedIds.push(check.id);
      const task =
        state.graph?.tasks.find((t) => t.checkIds.includes(check.id)) ?? state.graph?.tasks[0];
      const fallback = {
        requirementIds: task?.requirementIds ?? state.spec?.requirements.map((r) => r.id) ?? [],
        criterionIds: task?.criterionIds ?? [],
      };
      failures.push(
        ...failedCheckFindings(
          check,
          result.evidenceId,
          // A refused gate names the test it pinned, not a defect; keep it on the fallback.
          result.reason ? "" : (result.output ?? ""),
          (state.rootGraph ?? state.graph)?.tasks ?? [],
          fallback,
          result.reason
            ? `${result.reason}: restore the approved test or promote a new one (evidence ${result.evidenceId}).`
            : regression
              ? `The check passed but ${regression} (evidence ${result.evidenceId}).`
              : `Inspect command evidence ${result.evidenceId} and correct the implementation within approved scope.`,
          newId,
        ),
      );
    }
    this.resolveCoveredFindings(runId, passedIds);
    if (
      failures.length &&
      !fixed &&
      (await this.applyFixers(runId, stepId, state, policy, failedIds, signal))
    )
      return this.runCheckStage(runId, stepId, state, policy, v2, signal, true);
    if (!failures.length && inconclusive)
      throw new WorkflowFault("OUTPUT_INVALID", `Required check ${inconclusive} is inconclusive`, {
        reason: "verification_failed",
      });
    if (!failures.length)
      failures.push(...(await this.qualityFindings(runId, state, policy, signal)));
    if (!failures.length) {
      // Without a review stage nothing else closes the findings of an earlier failed run of
      // these gates; the passing gates close them.
      const closed = new Set(ordered.map(({ check }) => `Required check ${check.id} failed`));
      this.store.transaction(() => {
        for (const finding of this.store.findings(runId))
          if (
            ["open", "confirmed"].includes(finding.status) &&
            closed.has(JSON.parse(finding.body_json).claim)
          )
            this.store.findingStatus(runId, finding.id, "resolved");
      });
      return [];
    }
    return this.recordFindings(runId, {
      schemaVersion: 1,
      snapshotHash: state.workspaceHash ?? "",
      verdict: "changes_requested",
      coverage: [],
      findings: failures,
    });
  }
  /**
   * A wait stage: polls its command gates by host code, without a model call, every interval until
   * every required gate passes or the deadline passes. Polls record nothing; the run that decides
   * the stage records each gate once. The deadline is saved with the position, so a resumed visit
   * keeps it. Returns null when the gates pass, and an empty list (outcome failed, no corrective
   * work) when the wait timed out.
   */
  private async runWaitStage(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    v2: { stage: Stage; gates: Gate[] },
    signal: AbortSignal,
  ): Promise<Review["findings"] | null> {
    const stage = v2.stage;
    const position = state.position;
    if (stage.type !== "wait" || !position) return null;
    const bound = stage.gates.map((binding) => {
      const gate = v2.gates.find((g) => g.id === binding.gateId);
      if (gate?.type !== "command")
        throw new WorkflowFault("INVALID_REFERENCE", `Wait gate ${binding.gateId} is missing`);
      return { gate, check: gateToCheck(gate, binding) };
    });
    const required = bound.filter((b) => b.check.required);
    const clock = this.waitClock;
    const visit = position.visits[stage.id] ?? 1;
    let wait = position.wait;
    if (wait?.stageId !== stage.id || wait.visit !== visit) {
      const now = clock.now();
      wait = {
        stageId: stage.id,
        visit,
        startedAt: now,
        deadlineAt: now + stage.timeoutMinutes * 60_000,
      };
      position.wait = wait;
      this.store.transaction(() => this.store.saveState(runId, state));
    }
    const { deadlineAt } = wait;
    const progress = (pending: readonly string[], polls: number) =>
      this.store.transaction(() =>
        this.store.emit(runId, {
          type: "wait.progress",
          payload: {
            stageId: stage.id,
            deadline: new Date(deadlineAt).toISOString(),
            intervalSeconds: stage.intervalSeconds,
            pending: [...pending],
            polls,
          },
        }),
      );
    progress(
      required.map((b) => b.gate.id),
      0,
    );
    let reported = required.map((b) => b.gate.id).join(",");
    const root = this.rootOf(runId);
    for (let polls = 1; ; polls++) {
      signal.throwIfAborted();
      const pending: string[] = [];
      for (const { gate, check } of required) {
        const left = Math.max(1000, deadlineAt - clock.now());
        if ((await this.checks.probe(check, signal, root, left)) !== "passed")
          pending.push(gate.id);
      }
      const key = pending.join(",");
      if (key !== reported) {
        reported = key;
        progress(pending, polls);
      }
      const timedOut = clock.now() >= deadlineAt;
      if (!pending.length || timedOut) {
        const ordered = [...required, ...bound.filter((b) => !b.check.required)];
        let failing = false;
        for (const { gate, check } of ordered) {
          const result = await this.runCommandGate(runId, stepId, check, gate, policy, signal);
          this.recordGate(runId, state, gate.id, null, {
            status: result.status,
            mode: check.required ? "required" : "advisory",
            evidenceId: result.evidenceId,
            attempts: result.attempts,
            flaky: result.flaky,
          });
          if (check.required && result.status !== "passed") failing = true;
        }
        if (!failing) return null;
        if (timedOut) return [];
        // The gate changed between the poll and the recorded run: keep waiting.
      }
      const left = deadlineAt - clock.now();
      await this.idle(() =>
        clock.sleep(Math.max(0, Math.min(stage.intervalSeconds * 1000, left)), signal),
      );
    }
  }
  /**
   * Takes the transition that answers the decided outcome of the current stage: its gates in
   * order, then corrective tasks when the target writes, the loop and visit bounds, and the new
   * position. A gate that waits for a person keeps the outcome, so the run resumes here.
   */
  private async takeTransition(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    v2: { definition: WorkflowV2; stage: Stage; gates: Gate[] },
    signal: AbortSignal,
  ): Promise<void> {
    const position = state.position;
    if (!position?.outcome) return;
    const carried = carriedValue(state, v2.stage);
    const transition = selectTransition(v2.definition, v2.stage.id, position.outcome, carried);
    if (!transition)
      throw new WorkflowFault(
        "OUTPUT_INVALID",
        `Stage ${v2.stage.id} reported ${position.outcome} and no transition answers it`,
        { reason: "verification_failed" },
      );
    // A convergence that cannot start another correction round asks for a decision instead of
    // taking the loop back to the writing stage.
    if (position.repairKind === "convergence" && position.outcome === "changes_requested") {
      const ids = new Set(position.findings);
      const stopped = this.store
        .findings(runId)
        .filter((f) => ids.has(f.id) && !["refuted", "resolved"].includes(f.status))
        .map((f) => ({ ...JSON.parse(f.body_json), id: f.id }) as Review["findings"][number]);
      const destination = v2.definition.stages.find((s) => s.id === transition.to);
      if (stopped.length && destination?.type === "tasks") {
        const halt = this.haltConvergence(runId, state, policy, stopped);
        if (halt === "wait") {
          this.store.transaction(() => this.flushWaits(runId, state));
          return;
        }
        if (halt === "accepted") {
          position.outcome = "passed";
          position.findings = [];
          position.repairKind = null;
          this.store.transaction(() => this.store.saveState(runId, state));
          return this.takeTransition(runId, state, policy, v2, signal);
        }
      }
    }
    // Task scope gates ran after each task inside the tasks stage.
    const bindings = transition.gates
      .map((binding) => ({ binding, gate: v2.gates.find((g) => g.id === binding.gateId) }))
      .filter((b) => b.gate && b.gate.scope !== "task");
    const required = (b: (typeof bindings)[number]): boolean =>
      b.gate !== undefined && gateToRequired(b.binding, b.gate);
    const ordered = [...bindings.filter(required), ...bindings.filter((b) => !required(b))];
    let stepId: string | null = null;
    for (const { binding, gate } of ordered) {
      if (!gate) continue;
      signal.throwIfAborted();
      const mode = gateToRequired(binding, gate) ? "required" : "advisory";
      if (gate.type === "command") {
        stepId ??= this.store.transaction(() =>
          this.store.beginStep(runId, `transition-${transition.id}`),
        );
        await this.snapshot(runId, state, policy, signal);
        const result = await this.runCommandGate(
          runId,
          stepId,
          gateToCheck(gate, binding),
          gate,
          policy,
          signal,
        );
        const { reason, ...recorded } = result;
        this.recordGate(runId, state, gate.id, transition.id, { ...recorded, mode });
        if (mode === "required" && result.status !== "passed") {
          this.store.transaction(() => {
            this.store.finishStep(runId, stepId ?? "", "failed");
            this.store.saveState(runId, state);
          });
          throw new WorkflowFault(
            "OUTPUT_INVALID",
            `Gate ${gate.id} on ${transition.id} ${result.status}${reason ? `: ${reason}` : ""}`,
            { reason: "verification_failed" },
          );
        }
      } else if (gate.type === "human") {
        if (!state.snapshotId) await this.snapshot(runId, state, policy, signal);
        const criterionId = `gate-${gate.id}`;
        const answered = state.manualCriteria[criterionId];
        if (answered?.snapshotId === state.snapshotId) {
          this.recordGate(runId, state, gate.id, transition.id, {
            status: "passed",
            mode,
            evidenceId: answered.evidenceId,
            attempts: 1,
            flaky: false,
          });
          continue;
        }
        if (mode === "advisory") {
          this.recordGate(runId, state, gate.id, transition.id, {
            status: "skipped",
            mode,
            evidenceId: null,
            attempts: 0,
            flaky: false,
          });
          continue;
        }
        if (stepId)
          this.store.transaction(() => this.store.finishStep(runId, stepId ?? "", "completed"));
        this.wait("manual_evidence", state, {
          criterionId,
          snapshotId: state.snapshotId,
          gateId: gate.id,
          transitionId: transition.id,
          question: gate.human.prompt,
          answer: gate.human.answer,
        });
        this.store.transaction(() => this.flushWaits(runId, state));
        return;
      } else if (gate.type === "ai-acceptance") {
        // Advisory by construction: the walk-through's verdict is recorded and shown, and only a
        // promoted command gate can ever block a transition.
        stepId ??= this.store.transaction(() =>
          this.store.beginStep(runId, `transition-${transition.id}`),
        );
        if (!state.snapshotId) await this.snapshot(runId, state, policy, signal);
        const step = stepId;
        const profiles = ProfileSchema.array().parse(
          JSON.parse(this.store.run(runId).profiles_json),
        );
        const result = await runAcceptanceGate(
          {
            store: this.store,
            runId,
            state,
            policy,
            transitionId: transition.id,
            signal,
            ...(this.browserDriver ? { browser: this.browserDriver } : {}),
            profile: (id) => profiles.find((p) => p.id === id),
            callAgent: (profile, extra, validate, tools, attemptSignal) =>
              this.call(
                runId,
                step,
                state,
                policy,
                profile,
                extra,
                attemptSignal,
                undefined,
                0,
                validate,
                undefined,
                tools,
              ),
          },
          gate,
        );
        this.recordGate(runId, state, gate.id, transition.id, {
          status: result.status,
          mode: "advisory",
          evidenceId: result.evidenceId,
          attempts: result.status === "skipped" ? 0 : 1,
          flaky: false,
        });
        this.store.transaction(() => this.store.saveState(runId, state));
      }
    }
    const target = v2.definition.stages.find((s) => s.id === transition.to);
    this.store.transaction(() => {
      if (stepId) this.store.finishStep(runId, stepId, "completed");
      const ids = new Set(position.findings);
      const findings = this.store
        .findings(runId)
        .filter((f) => ids.has(f.id) && !["refuted", "resolved"].includes(f.status))
        .map((f) => ({ ...JSON.parse(f.body_json), id: f.id }) as Review["findings"][number]);
      if (findings.length && target?.type === "tasks")
        appendCorrections(
          this.store,
          runId,
          state,
          policy,
          findings,
          position.repairKind ?? "repair",
        );
      else if (findings.length) {
        // A loop to a stage that does not write hands the findings to that stage as input; a
        // later review raises them again if they still hold.
        // A failed check hands over the end of its output: the stage has no tool to read evidence.
        state.prompt += `\nFindings of the ${v2.stage.id} stage to address:\n${canonical(
          findings.map((f) => {
            const output = this.commandOutput(runId, f.evidenceIds);
            return {
              claim: f.claim,
              impact: f.impact,
              fix: f.suggestedFix,
              ...(output ? { output } : {}),
            };
          }),
        )}`;
        for (const finding of findings) this.store.findingStatus(runId, finding.id, "resolved");
      }
      if (transition.loop) {
        const count = (position.loops[transition.id] ?? 0) + 1;
        // "One more round" at a convergence decision allows the loop one more pass as well.
        const bound =
          transition.loop.maxIterations +
          (position.repairKind === "convergence" ? state.extraConvergenceRounds : 0);
        if (count > bound)
          throw new WorkflowFault(
            "RECOVERY_REQUIRED",
            `no_progress: loop ${transition.id} reached its bound of ${transition.loop.maxIterations}`,
            { reason: "no_progress" },
          );
        position.loops[transition.id] = count;
        // Returning before the approval needs a new one: the plan it covered will change.
        if (target && (target.type === "agent" || target.type === "approval")) {
          state.approvalRoot = null;
          state.analysisPassed = false;
          this.store.setApproval(runId, null);
        }
      }
      if (target) {
        if (position.total + 1 > v2.definition.limits.maxStageVisits)
          throw new WorkflowFault(
            "RECOVERY_REQUIRED",
            `no_progress: the run reached ${v2.definition.limits.maxStageVisits} stage visits`,
            { reason: "no_progress" },
          );
        position.total++;
        position.visits[target.id] = (position.visits[target.id] ?? 0) + 1;
      }
      const contract = contractText(carried);
      this.store.emit(runId, {
        type: "transition.taken",
        payload: {
          transitionId: transition.id,
          from: v2.stage.id,
          to: transition.to,
          outcome: position.outcome ?? "passed",
          contractHash: contract === null ? null : hashBytes(contract),
        },
      });
      position.stageId = transition.to;
      position.outcome = null;
      position.findings = [];
      position.repairKind = null;
      this.store.saveState(runId, state);
    });
  }
  /** The last lines of the command output behind a finding's evidence, or null when it has none. */
  private commandOutput(runId: string, evidenceIds: readonly string[]): string | null {
    const ids = new Set(evidenceIds);
    const tails: string[] = [];
    for (const row of this.store.evidence(runId)) {
      if (row.kind !== "command" || !ids.has(row.id)) continue;
      try {
        const body = JSON.parse(this.store.readArtifact(runId, row.artifact_id)) as {
          output?: unknown;
        };
        if (typeof body.output === "string" && body.output.trim())
          tails.push(outputTail(body.output, HANDOFF_OUTPUT_LINES));
      } catch {
        // Redacted or missing evidence hands over the finding without output.
      }
    }
    return tails.length ? tails.join("\n") : null;
  }
  /** The stages of a run's definition with the mechanism each one runs. */
  private stageKinds(
    runId: string,
    v2: { definition: WorkflowV2 } | null,
  ): { id: string; kind: string }[] {
    return v2
      ? v2.definition.stages.map((s) => ({ id: s.id, kind: stageKind(s) ?? s.type }))
      : WorkflowSchema.parse(JSON.parse(this.store.run(runId).definition_json)).stages;
  }
  /**
   * A person rejected the last approval with an explanation (envguard 45495079: "implementing the
   * CLI and its tests is in scope"). Resuming must not request the same package again: the run goes
   * back to specify, or to plan when the definition has no specify stage, with the explanation as
   * correction input, and the later stages run again. Each rejection is used once, at most
   * MAX_REJECTION_REVISIONS times per run; a v2 run also stays within its stage visit limit.
   */
  private reviseAfterRejection(
    runId: string,
    state: RuntimeState,
    v2: { definition: WorkflowV2 } | null,
  ): boolean {
    const last = this.store
      .requests(runId)
      .filter((r) => r.kind === "approval")
      .at(-1);
    if (last?.status !== "rejected" || state.revisedRejections.includes(last.id)) return false;
    if (state.revisedRejections.length >= MAX_REJECTION_REVISIONS) return false;
    const answer = last.answer_json
      ? (JSON.parse(last.answer_json) as { explanation?: unknown })
      : {};
    const explanation = typeof answer.explanation === "string" ? answer.explanation.trim() : "";
    if (!explanation) return false;
    const stages = this.stageKinds(runId, v2);
    let target = stages.findIndex((s) => s.kind === "specify");
    if (target < 0) target = stages.findIndex((s) => s.kind === "plan");
    if (target < 0 || !this.moveTo(state, stages, target, v2)) return false;
    state.revisedRejections.push(last.id);
    state.analysisPassed = false;
    state.prompt += `\n${REJECTION_NOTE}\n${canonical({ explanation })}`;
    return true;
  }
  /**
   * Sends the run back to an earlier stage outside the definition's transitions. A v2 run counts
   * the visit; when that would pass the definition's visit limit the run stays and a person is
   * asked instead.
   */
  private moveTo(
    state: RuntimeState,
    stages: readonly { id: string }[],
    index: number,
    v2: { definition: WorkflowV2 } | null,
  ): boolean {
    const target = stages[index];
    if (!target) return false;
    const position = state.position;
    if (!v2 || !position) {
      state.stageIndex = index;
      return true;
    }
    if (position.total + 1 > v2.definition.limits.maxStageVisits) return false;
    position.stageId = target.id;
    position.outcome = null;
    position.findings = [];
    position.repairKind = null;
    position.total++;
    position.visits[target.id] = (position.visits[target.id] ?? 0) + 1;
    return true;
  }
  /** Completion of a run of a v2 definition. */
  private async acceptV2(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    definition: WorkflowV2,
    gates: Gate[],
    signal: AbortSignal,
  ): Promise<void> {
    assertFrozenInputs(state);
    dependencyContracts(this.store, state);
    await this.assertWorkspace(runId, state, policy, signal);
    // A run that ends before any tasks stage, such as Fix CI when the checks already pass, changed
    // nothing and has no approved plan to accept.
    const writes = definition.stages.some(
      (s) => s.type === "tasks" && (state.position?.visits[s.id] ?? 0) > 0,
    );
    const acceptable = (): void => {
      if (writes) assertAcceptanceV2(this.store, runId, state, policy, definition, gates);
      else if (this.store.requests(runId).some(blocksRun))
        throw new WorkflowFault("STALE_DECISION", "Pending decisions remain");
      const unreconciled = this.store
        .effects(runId)
        .filter((e) => ["prepared", "unknown"].includes(e.status));
      if (unreconciled.length)
        throw new WorkflowFault("RECOVERY_REQUIRED", "Unreconciled effects remain", {
          effectIds: unreconciled.map((e) => e.id),
        });
    };
    settleSupersededEffects(this.store, runId);
    await this.commitAccepted(runId, state, acceptable);
    this.store.transaction(() => {
      acceptable();
      for (const task of this.store
        .tasks(runId)
        .filter((t) => state.graph?.tasks.some((task) => task.id === t.id)))
        this.store.taskStatus(runId, task.id, "verified", state.snapshotId);
      state.verificationState = writes ? "current" : state.verificationState;
      this.store.artifact(
        runId,
        "completion",
        "completion.json",
        canonical({
          runId,
          workflowId: definition.id,
          featureId: state.spec?.featureId ?? this.store.run(runId).feature_id,
          approvalRoot: state.approvalRoot,
          correctionHashes: state.correctionHashes,
          snapshotId: state.snapshotId,
          workspaceHash: state.workspaceHash,
          coverage: state.convergence?.coverage ?? null,
          limitations: state.limitations,
          gates: state.gateResults,
          reviews: Object.fromEntries(
            Object.entries(state.reviews).map(([key, review]) => [
              key,
              { verdict: review.verdict, findings: review.findings.length },
            ]),
          ),
          report: state.report ? JSON.parse(state.report) : null,
          checks: this.store.checks(runId).filter((c) => c.snapshot_id === state.snapshotId),
          verifiedTaskIds: state.graph?.tasks.map((t) => t.id) ?? [],
          ...(state.worktree ? { worktree: state.worktree } : {}),
        }),
      );
      this.store.saveState(runId, state);
      this.store.bump(runId, this.store.run(runId).revision);
      this.store.transition(runId, "completed");
    });
  }
  /**
   * Commits the accepted result of a worktree run on its branch, once acceptance holds: the files
   * the run journaled in its worktree and the declared task writes that differ from the approval
   * baseline. The commit is recorded in the state the completion saves; a crash before that save
   * rebuilds the same commit on the next drive.
   */
  private async commitAccepted(
    runId: string,
    state: RuntimeState,
    acceptable: () => void,
  ): Promise<void> {
    const worktree = state.worktree;
    if (!worktree || !state.snapshotId) return;
    this.store.transaction(acceptable);
    const final = this.store.snapshotFiles(runId, state.snapshotId) ?? state.expectedFiles ?? {};
    const baselineId = state.manifest.baselineSnapshotId;
    const baseline = (baselineId && this.store.snapshotFiles(runId, baselineId)) || {};
    const declared = new Set(state.graph?.tasks.flatMap((t) => t.writes.map((w) => w.path)) ?? []);
    const journaled = this.store
      .effects(runId)
      .filter(
        (e) =>
          (e.kind === "file_patch" || e.kind === "artifact_write") &&
          ["applied", "reconciled"].includes(e.status) &&
          intentRoot(e.intent_json) === worktree.path,
      )
      .map((e) => (JSON.parse(e.intent_json) as { path: string }).path);
    const title = state.spec?.title ?? this.store.run(runId).feature_id;
    const commit = await commitRunBranch(
      this.store,
      runId,
      worktree,
      [...journaled, ...changedPaths(baseline, final).filter((path) => declared.has(path))],
      `${title.slice(0, 72)}\n\nAccepted result of BAKED workflow run ${runId}.\n\nBaked-Run: ${runId}\nBaked-Snapshot: ${state.snapshotId}\n`,
    );
    state.worktree = { ...worktree, commit };
  }
  private repair(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    findings: Review["findings"],
    kind: "repair" | "convergence",
  ): void {
    this.store.transaction(() => {
      appendCorrections(this.store, runId, state, policy, findings, kind);
      state.stageIndex = WorkflowSchema.parse(
        JSON.parse(this.store.run(runId).definition_json),
      ).stages.findIndex((s) => s.kind === "task-graph");
    });
  }
  private async accept(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    assertFrozenInputs(state);
    dependencyContracts(this.store, state);
    await this.assertWorkspace(runId, state, policy, signal);
    const acceptable = (): void => {
      assertAcceptance(this.store, runId, state, policy);
      const unreconciled = this.store
        .effects(runId)
        .filter((e) => ["prepared", "unknown"].includes(e.status));
      if (unreconciled.length)
        throw new WorkflowFault("RECOVERY_REQUIRED", "Unreconciled effects remain", {
          effectIds: unreconciled.map((e) => e.id),
        });
    };
    settleSupersededEffects(this.store, runId);
    await this.commitAccepted(runId, state, acceptable);
    this.store.transaction(() => {
      acceptable();
      for (const task of this.store
        .tasks(runId)
        .filter((t) => state.graph?.tasks.some((task) => task.id === t.id)))
        this.store.taskStatus(runId, task.id, "verified", state.snapshotId);
      state.verificationState = "current";
      this.store.artifact(
        runId,
        "completion",
        "completion.json",
        canonical({
          runId,
          featureId: state.spec?.featureId,
          approvalRoot: state.approvalRoot,
          correctionHashes: state.correctionHashes,
          snapshotId: state.snapshotId,
          workspaceHash: state.workspaceHash,
          coverage: state.convergence?.coverage,
          limitations: state.limitations,
          checks: this.store.checks(runId).filter((c) => c.snapshot_id === state.snapshotId),
          verifiedTaskIds: state.graph?.tasks.map((t) => t.id),
          ...(state.worktree ? { worktree: state.worktree } : {}),
        }),
      );
      this.store.saveState(runId, state);
      this.store.bump(runId, this.store.run(runId).revision);
      this.store.transition(runId, "completed");
    });
  }
}

/**
 * Where a corrective task's findings point (#714): the files they name (the finding's file, the
 * files a failing check's output names, paths in the claim or fix) and their symbols. A
 * correction may write every file of the tasks it corrects, and read them all again from
 * scratch when nothing says which one the finding is about.
 */
export function correctionFocus(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  task: Task,
): { files: string[]; symbols: string[] } {
  if (task.origin === "planned" || !task.findingIds.length) return { files: [], symbols: [] };
  const files: string[] = [];
  const symbols: string[] = [];
  const add = (list: string[], value: string | null | undefined): void => {
    if (value && !list.includes(value)) list.push(value);
  };
  for (const finding of store.findings(runId)) {
    if (!task.findingIds.includes(finding.id)) continue;
    const body = JSON.parse(finding.body_json) as {
      file?: string | null;
      symbol?: string | null;
      claim?: string;
      suggestedFix?: string;
    };
    add(files, body.file);
    add(symbols, body.symbol);
    for (const path of state.repairScope?.[finding.id] ?? []) add(files, path);
    for (const path of pathsInOutput(`${body.claim ?? ""}\n${body.suggestedFix ?? ""}`, [task]))
      add(files, path);
  }
  return { files: files.filter((path) => task.writes.some((w) => w.path === path)), symbols };
}
/** The writes with the given paths first, in their order, then the rest in plan order. */
export function focusFirst<T extends { path: string }>(writes: readonly T[], first: string[]): T[] {
  const rank = (path: string): number => {
    const index = first.indexOf(path);
    return index === -1 ? first.length : index;
  };
  return [...writes].sort((a, b) => rank(a.path) - rank(b.path));
}

/** The sized attempt cap of a task; a correction uses the cap of the task it corrects. */
function taskSize(
  state: RuntimeState,
  task: Task,
  field: "taskBudgets" | "taskSteps",
): number | undefined {
  const own = state[field][task.id];
  if (own) return own;
  for (const findingId of task.findingIds) {
    const base = state.repairPredecessors[findingId];
    const inherited = base ? state[field][base] : undefined;
    if (inherited) return inherited;
  }
  return undefined;
}

/** The checks run after a task, in policy order: its task-scope checks and the static ones covering its code. */
const taskChecks = (policy: RunPolicy, task: Task): Check[] => taskCheckList(policy, task);
/** Every check a task declares, whatever its scope. */
const declaredChecks = (policy: RunPolicy, task: Task): Check[] =>
  policy.checks.filter((check) => task.checkIds.includes(check.id));

/** The documents a run publishes under `specs/<featureId>/` once its plan is ready. */
export const SPEC_PUBLICATION_FILES = ["spec.json", "spec.md", "plan.md", "tasks.json", "tasks.md"];
export const specPublicationPath = (featureId: string, name: string): string =>
  `specs/${featureId}/${name}`;
/** Logical path of the gates a v2 run froze when it started. */
export const GATES_ARTIFACT = "definition/gates.json";

const gateToRequired = (binding: { gateId: string; mode?: "required" | "advisory" }, gate: Gate) =>
  effectiveMode(binding, gate) === "required";

/**
 * Told to the implementer with every task: unresolved blocks the task, so it must not carry other
 * tasks' work. Run 563e4f6c: a test task that caught a bug in src/site.ts listed the fix as
 * unresolved and blocked; resume repeated it. A failing task check is repaired instead.
 */
const UNRESOLVED_MEANING =
  "unresolved lists only parts of THIS task that you could not finish. Work that belongs to other tasks of the plan, to checks run later, or to documentation tasks is not unresolved: leave it out. A defect you found in a file outside your write scope is not unresolved either: finish your own files (a test that exposes the defect stays as written), name the file and the defect in summary, and report implemented; the failing check becomes a corrective task that may edit that file. Any entry blocks this task.";

/** One task of a batch: its reserved attempt and, once created, its worktree. */
interface BatchEntry {
  task: Task;
  profile: AgentProfile;
  extra: unknown;
  child: string;
  attemptId: string;
  /** The task worktree relative to the project root; empty until it is created. */
  path: string;
  released: boolean;
  lease: () => LeaseResource;
}
interface WorkerCheck {
  check: Check;
  checked: { status: "passed" | "failed" | "inconclusive"; evidenceId: string; output?: string };
}
/** How a task worker ended; only `done` is integrated. */
/** Whether every file a task writes (a deletion aside) is among the given files; false for none. */
function ownsOnly(task: Task, files: ReadonlySet<string>): boolean {
  const written = task.writes.filter((w) => w.action !== "delete");
  return written.length > 0 && written.every((w) => files.has(w.path));
}

type WorkerOutcome =
  | {
      kind: "done";
      entry: BatchEntry;
      before: Record<string, string>;
      after: Record<string, string>;
      changed: string[];
      checks: WorkerCheck[];
    }
  /** The task's result is refused: a change outside its writes, or no complete implementation. */
  | {
      kind: "rejected";
      entry: BatchEntry;
      error: unknown;
      /** Set when the task gets one restart in a fresh session instead of blocking the run. */
      restart?: { reason: string; account: { summary: string; unresolved: string[] } };
      /** The files the attempt changed in its worktree, with the manifest before it. */
      edits?: { before: Record<string, string>; changed: string[] };
    }
  /** The task's worker or worktree lease was lost; only this task stops. */
  | {
      kind: "interrupted";
      entry: BatchEntry;
      reason: string;
      /** Another owner took the task worktree's lease, so the worktree is not this run's to reuse. */
      leaseLost: boolean;
      /** What the worker said when it ended without a complete implementation, for the restart. */
      account?: { summary: string; unresolved: string[] };
      /** The files the lost worker had changed in its worktree, with the manifest before it. */
      edits?: { before: Record<string, string>; changed: string[] };
    }
  /** The whole run stops: it was aborted or its budget is used up. */
  | { kind: "fatal"; entry: BatchEntry; error: unknown };

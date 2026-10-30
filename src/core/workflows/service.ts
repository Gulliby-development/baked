import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AppConfig } from "../../types/index.js";
import { SharedRootContext } from "../context/shared-root.js";
import { ROUTING_ARTIFACT, type RoutingRecord, RoutingRecordSchema } from "../llm/model-routing.js";
import { resolveModel } from "../llm/provider.js";
import { probeProvider, providerBackoffMs } from "../llm/provider-health.js";
import { displayPath } from "../projects/paths.js";
import { activeProject } from "../projects/resolve.js";
import {
  renderWorkingSet,
  resolveWorkingSet,
  WORKING_SET_ARTIFACT,
} from "../projects/working-set.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { validatePackage, workspacePath } from "../specs/validate.js";
import { appendCorrections } from "../verification/convergence.js";
import {
  acceptResidual,
  type ConvergenceRequestBody,
  grantRound,
  noteRejectedManual,
  noteStoppedInconclusive,
} from "../verification/convergence-stop.js";
import { noteSiblingFindings } from "../verification/initiative-ownership.js";
import { hostDiff, sourceManifest } from "../verification/snapshot.js";
import { NativeAgentExecutor } from "./agent-executor.js";
import { supersedeResearch } from "./analysis-notes.js";
import { approvalDigest } from "./approval.js";
import { AttentionNotifier } from "./attention-notify.js";
import {
  assertCostCapPriced,
  type BudgetLimits,
  budgetUsage,
  LIMIT_NAMES,
  limitsOf,
  MAX_EXTENDED_MS,
  MAX_EXTENDED_TOKENS,
  proposeCostCap,
  proposeExtension,
} from "./budget.js";
import { validateChecks } from "./check-policy.js";
import {
  CHECK_PREFLIGHT_ARTIFACT,
  type CheckSmoke,
  smokeChecks,
  smokeLine,
} from "./check-preflight.js";
import { answerInvalidatesAnalysis, clarificationResumeIndex } from "./clarification.js";
import { CONFLICT_DECISION_PREFIX, recordConflictDecision } from "./conflict-decisions.js";
import {
  adoptCurrentInstructions,
  assertFrozenInputs,
  changedFrozenInputs,
  FROZEN_DEFINITION_PATH,
  frozenInputAdvice,
  frozenInstructions,
} from "./context.js";
import { type HostRemedy, REMEDY_DECISION } from "./corrective-scope.js";
import { refreshCriticOutcomes } from "./critic-outcomes.js";
import { decideDelivery, isDeliveryRequest } from "./delivery.js";
import {
  applyReleasedCreates,
  dependencyContracts,
  isHostRelease,
  releasedCreates,
} from "./dependencies.js";
import {
  checkLine,
  checkRoutingModels,
  checkStartModels,
  type DoctorDeps,
  defaultDoctorDeps,
} from "./doctor.js";
import { fileHash } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { estimateHistory, type SavedEstimate } from "./estimate.js";
import { replayEvents } from "./events.js";
import { canExtendRun } from "./extendable.js";
import {
  captureForkSeed,
  FORK_SEED_ARTIFACT,
  type ForkSeed,
  forkStagePosition,
  forkStages,
} from "./fork-stage.js";
import { isStoreError, recordHostError } from "./host-error.js";
import { InitiativeService } from "./initiatives/service.js";
import { InitiativeStore } from "./initiatives/store.js";
import {
  INVALID_OUTPUT_KEY,
  invalidOutputRepeat,
  repeatedInvalidOutputAdvice,
} from "./invalid-output-repeat.js";
import {
  commandProcessMayRun,
  executionLeaseFor,
  leaseOwnerAlive,
  mutationLeaseFor,
  releaseDeadOwnerLeases,
  WorkspaceLeases,
} from "./leases.js";
import { estimatePrepared } from "./pre-run.js";
import {
  collectProjectMemory,
  LEARNED_RULES_ARTIFACT,
  PROJECT_MEMORY_ARTIFACT,
  renderProjectMemory,
} from "./project-memory.js";
import { checkRecoveryNote, noteInterruptedChecks, withRecoveryNote } from "./recovery.js";
import { recoveryAdvice } from "./remedies.js";
import type { ResumeRemedy } from "./remedies-model.js";
import { canRepairRun } from "./repairable.js";
import {
  abortableDelay,
  accountRefusal,
  closeProviderCircuit,
  isTransient,
  providerCircuitOpen,
} from "./retry.js";
import {
  REFUSED_EDIT_PREFIX,
  runWrittenHash,
  UNFINISHED_BLOCK_PREFIX,
  undoRunEdits,
} from "./rollback.js";
import {
  independenceWarnings,
  independentReviewMode,
  type RerouteRequest,
  type RouteChange,
  rerouteRecord,
  routeChanges,
  strictRoutingConfig,
} from "./routing.js";
import {
  GATES_ARTIFACT,
  SPEC_PUBLICATION_FILES,
  specPublicationPath,
  WorkflowScheduler,
} from "./scheduler.js";
import {
  type CommandIdentity,
  CorrectionSchema,
  type Decision,
  executionModeOf,
  generatedPaths,
  Hash,
  PolicySchema,
  ProfileSchema,
  parallelRunCap,
  ResearchSchema,
  type Review,
  type RunPolicy,
  type RunSnapshot,
  type RunState,
  SafeId,
  type StartRequest,
  type WorkflowService,
  workflowsEnabled,
  writerPolicyProblem,
} from "./schemas.js";
import { IMPORT_SEED_ARTIFACT, seedState } from "./sdd-export/seed.js";
import { providerResumeWaitMs, stallSettings } from "./stall.js";
import { recordStallPark } from "./stall-ladder.js";
import { bindDefinition, type PreparedStart, prepareStart } from "./start.js";
import { assertMutable } from "./state-machine.js";
import { stopRecovery } from "./stop-detail.js";
import { newId, WorkflowStore } from "./store.js";
import type { StalledDriver } from "./supervisor.js";
import { reusableImplementations } from "./task-graph.js";
import { isTestTask } from "./tests-first.js";
import { type AgentExecutor, type RuntimeState, RuntimeStateSchema } from "./types.js";
import { blocksRun, isAcceptanceRequest } from "./v2/acceptance.js";
import { decideAcceptance } from "./v2/acceptance-gate.js";
import {
  type ContractId,
  type Gate,
  GateSchema,
  type WorkflowV2,
  WorkflowV2Schema,
} from "./v2/definition.js";
import { loadGateLibrary } from "./v2/library.js";
import { definitionRevisionProblems } from "./v2/revision.js";
import {
  autoApprovalHash,
  hostSpec,
  initialPosition,
  parseRunDefinition,
  produces,
  stageKind,
} from "./v2/runtime.js";
import {
  moveRunWorktree,
  placeBaseFiles,
  removeRunWorktree,
  runRoot,
  trackedPaths,
} from "./worktree.js";
import {
  cleanWorktrees,
  type WorktreeCleanup,
  type WorktreeReport,
  worktreeUsage,
} from "./worktree-usage.js";

/** A checked reroute that is not written yet (`planReroute`). */
export interface PlannedReroute {
  before: RoutingRecord;
  after: RoutingRecord;
  changes: RouteChange[];
}

/** The stored command body of a reroute; a replay with the same command ID must match it. */
function rerouteBody(runId: string, command: CommandIdentity, request: RerouteRequest) {
  const model = request.model?.trim() || undefined;
  return {
    runId,
    ...command,
    action: "reroute",
    model: model ?? null,
    routes: request.routes ?? {},
  };
}

/** A file a person changed outside the run; `frozen` marks an instruction or configuration file the run froze. */
export interface OutsideChange {
  path: string;
  before: string | null;
  after: string | null;
  frozen?: true;
}
/**
 * A request the provider answered with a refusal of the request itself (HTTP 400 or 422, an
 * `invalid_request_error`), not an account problem, an outage or a rate limit (#1889).
 */
function rejectedRequest(error: unknown): boolean {
  if (accountRefusal(error) || isTransient(error)) return false;
  const info = error as { statusCode?: number; message?: string } | null;
  return (
    info?.statusCode === 400 ||
    info?.statusCode === 422 ||
    /invalid_request_error|invalid_json_schema|\binvalid schema for\b/i.test(info?.message ?? "")
  );
}

export class NativeWorkflowService implements WorkflowService {
  readonly store: WorkflowStore;
  readonly leases: WorkspaceLeases;
  /** The primary drive lane; a run driven while it is busy gets a lane of its own (see `lane`). */
  readonly scheduler: WorkflowScheduler;
  private primaryBusy = false;
  /** The executor the caller injected, shared by every lane; null for the native executor. */
  private readonly injectedExecutor: AgentExecutor | null;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<RunSnapshot> }
  >();
  /**
   * Answers whether a provider can be called; checked for every model before a run starts. Only
   * the native executor calls providers, so a service given its own executor checks nothing.
   */
  providerReady: DoctorDeps["providerReady"] | null;
  /**
   * The process's root context, created on first use. The native executor builds each step's
   * context on it, and `baked serve` gives it to the chat host too. The service disposes it on close.
   */
  readonly rootContext: SharedRootContext;
  /** Announces runs that start waiting for a person; null on a read-only service. */
  readonly attention: AttentionNotifier | null;
  constructor(
    readonly workspace: string,
    readonly config: AppConfig,
    executor?: AgentExecutor,
    readonly = false,
    rootContext?: SharedRootContext,
  ) {
    this.rootContext = rootContext ?? SharedRootContext.forWorkspace(workspace, config);
    this.providerReady = executor ? null : defaultDoctorDeps.providerReady;
    this.store = new WorkflowStore(workspace, readonly);
    this.leases = new WorkspaceLeases(this.store);
    this.leases.progressWindowMs = Math.ceil(stallSettings(this.config).stepStallMs * 1.5);
    this.injectedExecutor = executor ?? null;
    this.attention = readonly ? null : new AttentionNotifier(this.store, workspace, config);
    this.scheduler = new WorkflowScheduler(
      this.store,
      this.leases,
      executor ?? new NativeAgentExecutor(this.store, this.leases, config, this.rootContext),
    );
    this.scheduler.growLimits = (runId) => this.growLimits?.(runId);
    this.store.reserveStages = (runId, requestedUsd) => this.reserveStages?.(runId, requestedUsd);
    this.store.tokenHold = (runId) => this.tokenHold?.(runId) ?? null;
    this.store.planShareGate = (runId) => this.planShareGate?.(runId) ?? false;
  }
  /**
   * Raises a run's host-derived limits before its deadline stops it: an initiative's feature run
   * asks its initiative for room (#1958). The service holds the hook itself, so every entry point
   * that drives a run has it: R68 ewvet scanner stopped "Active deadline exhausted" 33 s after a
   * headless `workflow reroute --resume`, which drove the run before any `InitiativeService`
   * existed in that process, with 37 percent of the initiative's time used (#2134).
   */
  growLimits: ((runId: string) => void) | undefined = (runId) => {
    if (this.store.readonly) return;
    this.initiatives ??= new InitiativeService(this);
    this.initiatives.growRun(runId);
  };
  /**
   * Asked before a model call stops on a run's cost ceiling: an initiative's feature run that
   * finished its tasks reserves its remaining review and convergence (#2241). Held by the service
   * for the same reason as `growLimits`: every entry point that drives a run has it.
   */
  reserveStages: ((runId: string, requestedUsd: number) => void) | undefined = (
    runId,
    requestedUsd,
  ) => {
    if (this.store.readonly) return;
    this.initiatives ??= new InitiativeService(this);
    this.initiatives.reserveStages(runId, requestedUsd);
  };
  /**
   * The most tokens a run's limit may reach by the host's own growth: an initiative's feature run
   * stays inside what the pool leaves after the other runs (#2468). Held by the service for the
   * same reason as `growLimits`. A read-only store grows nothing, so it has no hold to read.
   */
  tokenHold: ((runId: string) => number | null) | undefined = (runId) => {
    if (this.store.readonly) return null;
    this.initiatives ??= new InitiativeService(this);
    return this.initiatives.tokenHold(runId);
  };
  /**
   * The plan-time share gate (#2488): a started initiative feature run whose plan needs more than
   * its ceiling asks its initiative before its first task. Held by the service for the same
   * reason as `growLimits`. A read-only store grows nothing.
   */
  planShareGate: ((runId: string) => boolean) | undefined = (runId) => {
    if (this.store.readonly) return false;
    this.initiatives ??= new InitiativeService(this);
    return this.initiatives.planShareGate(runId);
  };
  private initiatives: InitiativeService | null = null;
  private enabled(): void {
    if (!workflowsEnabled(this.config))
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        "Workflows are turned off by workflows.enabled: false in the configuration.",
      );
  }
  private outcomesRefreshedAt = 0;
  /**
   * Updates the late labels of the critic outcome log (delivery, line survival) at most once a
   * day per process, before a run starts. Collection only: a failure is ignored.
   */
  private async refreshOutcomes(): Promise<void> {
    const now = Date.now();
    if (now - this.outcomesRefreshedAt < 24 * 60 * 60 * 1000) return;
    this.outcomesRefreshedAt = now;
    await refreshCriticOutcomes(this.store, now).catch(() => undefined);
  }
  async start(request: StartRequest): Promise<RunSnapshot> {
    this.enabled();
    SafeId.parse(request.featureId);
    SafeId.parse(request.workflowId);
    SafeId.parse(request.commandId);
    if (!request.prompt.trim())
      throw new WorkflowFault("INVALID_DEFINITION", "Workflow prompt is required");
    const previous = this.store.previousCommand(request.commandId, request);
    if (previous) return previous;
    await this.refreshOutcomes();
    const prepared = await prepareStart(this.workspace, this.config, request);
    const smoke = await this.preflight(prepared);
    const {
      policy,
      registry,
      loaded,
      routing,
      profiles,
      workflow,
      gates,
      instructions,
      skillHashes,
      instructionHashes,
    } = prepared;
    const v2 = loaded.schemaVersion === 2 ? loaded.definition : null;
    if (!v2 || (v2.publish !== false && produces(v2, "plan")))
      this.refuseTakenFeatureId(request.featureId);
    // A definition without a spec stage works on the request stated as one requirement.
    const hostDependencies = request.dependencies
      ? request.dependencies.map(({ featureId, contractHash }) => ({
          featureId: SafeId.parse(featureId),
          contractHash: Hash.parse(contractHash),
        }))
      : null;
    const generated =
      v2 && !produces(v2, "spec")
        ? hostSpec(
            request.featureId,
            request.prompt,
            policy.checks.some((c) => c.required),
            request.contract,
          )
        : null;
    const spec =
      generated && hostDependencies ? { ...generated, dependencies: hostDependencies } : generated;
    const diff = v2?.inputs.includes("diff") ? await hostDiff(this.workspace) : null;
    for (const entry of registry.list())
      if (entry.source !== "builtin")
        instructions.files[entry.source] = hashBytes(readFileSync(entry.source));
    // The working set is captured once; its hash joins the inputs before the run is created.
    const project = activeProject(this.workspace);
    const workingSet = project
      ? renderWorkingSet(project.id, resolveWorkingSet(project), { cwd: this.workspace })
      : null;
    if (workingSet) instructionHashes.push({ source: WORKING_SET_ARTIFACT, hash: workingSet.hash });
    const remembered = collectProjectMemory(this.store, undefined, {
      rules: policy.learnedRules !== false,
    });
    const memory = policy.projectMemory === false ? null : renderProjectMemory(remembered, policy);
    if (memory)
      instructionHashes.push({ source: PROJECT_MEMORY_ARTIFACT, hash: hashBytes(memory) });
    // Learned rules reach implementers and reviewers even when project memory is off.
    const rules = remembered.rules?.length ? canonical(remembered.rules) : null;
    if (rules) instructionHashes.push({ source: LEARNED_RULES_ARTIFACT, hash: hashBytes(rules) });
    const state: RuntimeState = {
      prompt: request.prompt,
      requestText: request.prompt,
      coverageRaised: false,
      uncoveredReturned: [],
      ownerLabel: request.ownerLabel,
      stageIndex: 0,
      manifest: {
        schemaVersion: 1,
        featureId: request.featureId,
        workflowHash: hashJson(workflow),
        policyHash: hashJson(policy),
        profileHashes: Object.fromEntries(profiles.map((p) => [p.id, hashJson(p)])),
        skillHashes,
        instructionHashes,
        constitutionHash: instructions.files[join(this.workspace, "baked/constitution.md")] ?? null,
        specHash: spec ? hashJson(spec) : null,
        planHash: null,
        rootGraphHash: null,
        effectiveGraphHash: null,
        correctionHashes: [],
        baselineSnapshotId: null,
        dependencyContracts: [],
      },
      spec,
      plan: null,
      graph: null,
      rootGraph: null,
      research: null,
      analysisPassed: false,
      snapshotId: null,
      workspaceHash: null,
      expectedFiles: null,
      reviews: {},
      priorReviews: {},
      reviewGaps: {},
      convergence: null,
      approvalRoot: null,
      correctionHashes: [],
      published: {},
      manualCriteria: {},
      deferredCriteria: [],
      previousFindingSet: null,
      noProgressRounds: 0,
      extraConvergenceRounds: 0,
      extraRepairRounds: 0,
      pendingTaskRepair: [],
      extraTaskRepairs: {},
      extraReviewRounds: 0,
      extraLoopIterations: {},
      extraStageVisits: 0,
      extraRepeatRepairs: 0,
      correctedSinceRepair: false,
      extraCorrectiveTasks: 0,
      decidedFindings: [],
      autoExtensions: 0,
      limitations: [],
      reviewNotes: [],
      verificationState: "not_verified",
      instructionText: instructions.text,
      frozenFiles: instructions.files,
      frozenInputEffectCount: 0,
      repairPredecessors: {},
      repairScope: {},
      slicedTests: {},
      freshTasks: {},
      widenedCorrections: [],
      unownedRemedies: {},
      acceptedCheckTimeouts: [],
      personWidened: [],
      narrowedCorrections: {},
      taskBudgets: {},
      taskSteps: {},
      sizingReplans: 0,
      hostSplitTasks: 0,
      sizingPlannedTasks: null,
      deferredChecks: {},
      waitingFor: {},
      affectedTests: {},
      analysisReplans: 0,
      lateDefectRounds: 0,
      derivationReturns: 0,
      derivationAmend: null,
      auditCarried: [],
      analysisRaised: [],
      answeredFindings: [],
      revisedRejections: [],
      pendingPatch: null,
      taskContinuations: {},
      taskEditRetries: {},
      taskProgressAttempts: {},
      quickFixes: {},
      taskRestarts: {},
      ownerLostResumes: 0,
      stallResumes: 0,
      unfinishedResumes: 0,
      providerResumes: 0,
      taskCarry: {},
      taskGates: {},
      position: v2 ? initialPosition(v2) : null,
      report: null,
      initiativePlan: null,
      initiativeBounds: request.initiativeBounds ?? null,
      hostDependencies,
      hostFiles: request.hostFiles?.length ? request.hostFiles : null,
      diff: null,
      workingSet: null,
      projectMemory: null,
      learnedRules: null,
      worktree: null,
      gateResults: {},
      acceptance: {},
      issue: request.issue ?? null,
      worktreeBase: request.baseCommit ?? null,
      baseFiles: request.baseCommit ? (request.baseFiles ?? []) : [],
      testsFirst: null,
      presetChoice: request.presetChoice ?? null,
      autoApprovalDeclined: request.autoApprovalDeclined ?? null,
      planAhead:
        request.planAhead && request.baseCommit ? { released: false, baselined: false } : null,
    };
    if (request.seed) {
      // Only a workflow that specifies and plans can take the documents those stages made.
      if (generated || (v2 && !produces(v2, "plan")))
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Workflow ${request.workflowId} has no spec and plan stages to start an imported feature from`,
          { reason: "seed_unsupported" },
        );
      seedState(state, request.seed, request.featureId, hostDependencies, this.workspace);
      state.stageIndex = 3;
      state.position = restartPosition(canonical(workflow), true);
    }
    return this.store.transaction(() => {
      const duplicate = this.store.previousCommand(request.commandId, request);
      if (duplicate) return duplicate;
      const id = newId();
      this.store.create(
        id,
        request.featureId,
        workflow,
        profiles,
        policy,
        state,
        null,
        project?.id ?? null,
      );
      this.store.artifact(id, "routing", ROUTING_ARTIFACT, canonical(routing));
      // A light feature run that others depend on records its host-made spec as their contract.
      if (spec && request.contract !== undefined)
        this.store.artifact(id, "spec", "spec.json", canonical(spec));
      if (smoke?.length)
        this.store.artifact(
          id,
          "preflight",
          CHECK_PREFLIGHT_ARTIFACT,
          canonical({ checks: smoke }),
        );
      if (gates.length) this.store.artifact(id, "gates", GATES_ARTIFACT, canonical(gates));
      if (workingSet) {
        const artifact = this.store.artifact(id, "context", WORKING_SET_ARTIFACT, workingSet.text);
        state.workingSet = {
          artifactId: artifact.id,
          hash: artifact.content_hash,
          files: workingSet.included.map((path) => displayPath(this.workspace, path)),
        };
        this.store.saveState(id, state);
      }
      if (memory) {
        const artifact = this.store.artifact(id, "context", PROJECT_MEMORY_ARTIFACT, memory);
        state.projectMemory = { artifactId: artifact.id, hash: artifact.content_hash };
        this.store.saveState(id, state);
      }
      if (rules) {
        const artifact = this.store.artifact(id, "context", LEARNED_RULES_ARTIFACT, rules);
        state.learnedRules = { artifactId: artifact.id, hash: artifact.content_hash };
        this.store.saveState(id, state);
      }
      if (diff) {
        const artifact = this.store.artifact(id, "diff", "diff/input.patch", diff.text);
        state.diff = { artifactId: artifact.id, hash: artifact.content_hash, files: diff.files };
        this.store.saveState(id, state);
      }
      if (request.seed && state.spec && state.plan !== null && state.graph) {
        this.store.artifact(id, "spec", "spec.json", canonical(state.spec));
        this.store.artifact(id, "plan", "plan.md", state.plan);
        this.store.artifact(id, "tasks", "tasks.json", canonical(state.graph));
        this.store.syncTasks(id, state.graph);
        this.store.artifact(
          id,
          "import",
          IMPORT_SEED_ARTIFACT,
          canonical({ source: request.seed.source, featureId: request.seed.spec.featureId }),
        );
      }
      this.saveEstimate(id, prepared, request.workflowId);
      const snapshot = this.store.snapshot(id);
      this.store.saveCommand(request.commandId, request, snapshot);
      return snapshot;
    });
  }
  /** Keeps the expectation made at creation, so a finished run can be compared with it. */
  /**
   * Refuses a start on the model checks `workflow doctor` fails: a bound model whose provider has
   * no credentials, naming what uses it; the run would otherwise fail at that stage much later.
   * Its warnings (fallback models, unbound profiles, unknown providers, an unanswered probe) are
   * recorded with the routing.
   */
  private async preflight(prepared: PreparedStart): Promise<CheckSmoke[] | null> {
    if (!this.providerReady) return null;
    const checks = await checkStartModels(this.workspace, prepared, this.providerReady);
    const refusals = checks.filter((check) => check.status === "fail").map(checkLine);
    if (refusals.length)
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        `These models cannot be called:\n${refusals.join("\n")}`,
        { reason: "model_unavailable", problems: refusals },
      );
    const warnings = checks.filter((check) => check.status === "warn").map(checkLine);
    if (warnings.length)
      prepared.routing.warnings = [...(prepared.routing.warnings ?? []), ...warnings];
    return this.smokeChecks(prepared);
  }
  /**
   * Starts every declared check once before the run spends a token: a required check that is not
   * on its PATH or cannot be spawned refuses the start, an advisory one becomes a routing warning.
   */
  private async smokeChecks(prepared: PreparedStart): Promise<CheckSmoke[]> {
    const smoke = await smokeChecks(prepared.policy.checks, this.workspace);
    const failed = smoke.filter((s) => s.status === "not_found" || s.status === "cannot_start");
    const missing = failed.filter((s) => s.required);
    if (missing.length)
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        `These required checks cannot start:\n${missing.map(smokeLine).join("\n")}`,
        { reason: "check_unavailable", problems: missing },
      );
    if (failed.length)
      prepared.routing.warnings = [...(prepared.routing.warnings ?? []), ...failed.map(smokeLine)];
    return smoke;
  }
  /**
   * Publication refuses to overwrite `specs/<featureId>/` files that no finished run published
   * as they are, but only after research, specify and plan have run. The same check at start
   * costs no model call.
   */
  private refuseTakenFeatureId(featureId: string): void {
    const taken: { path: string; openRun: string | null }[] = [];
    for (const name of SPEC_PUBLICATION_FILES) {
      const path = specPublicationPath(featureId, name);
      const current = fileHash(join(this.workspace, path));
      if (current === null) continue;
      const last = this.store.lastPublication(path);
      const published = last !== null && last.afterHash === current;
      if (published && ["completed", "failed", "cancelled"].includes(last.status)) continue;
      taken.push({ path, openRun: published ? last.runId : null });
    }
    if (!taken.length) return;
    const open = taken.find((t) => t.openRun)?.openRun;
    throw new WorkflowFault(
      "INPUT_CHANGED",
      open
        ? `specs/${featureId}/ belongs to open run ${open}; continue or cancel that run, or start with another feature id`
        : `specs/${featureId}/ already holds ${taken.map((t) => t.path).join(", ")}, which no finished run published; start with another feature id, or move that folder first`,
      { reason: "feature_id_taken", files: taken.map((t) => t.path) },
    );
  }
  private saveEstimate(runId: string, prepared: PreparedStart, workflowId: string): void {
    try {
      const estimate = estimatePrepared(
        prepared,
        workflowId,
        estimateHistory(this.store, this.workspace, prepared.policy),
      );
      const saved: SavedEstimate = {
        schemaVersion: 1,
        at: Date.now(),
        tokens: estimate.tokens,
        basis: estimate.basis,
        samples: estimate.samples,
        maxTokens: prepared.policy.maxTotalTokens,
        workflowId,
        costUsd: estimate.costUsd,
      };
      this.store.artifact(runId, "estimate", "estimates/start.json", canonical(saved));
    } catch {
      // An estimate is advice; a failure to compute it never blocks a run.
    }
  }
  async get(runId: string): Promise<RunSnapshot> {
    return this.store.snapshot(runId);
  }
  async list(opts: { featureId?: string; status?: RunState; limit: number; cursor?: string }) {
    return this.store.list(opts.limit, opts.featureId, opts.status, opts.cursor);
  }
  /** Waits before the automatic resumes of a run blocked with `owner_lost`; one entry per resume. */
  ownerLostBackoffMs: number[] = [30_000, 60_000, 120_000];
  providerProbe = async (modelId: string, signal: AbortSignal): Promise<unknown> =>
    (await probeProvider(resolveModel(modelId, this.config), modelId, signal)).usage;
  providerDelay = abortableDelay;
  private providerWaits = new Map<
    string,
    { controller: AbortController; promise: Promise<boolean> }
  >();
  async drive(runId: string, signal: AbortSignal): Promise<RunSnapshot> {
    // Room the initiative freed since the run stopped is the run's before it drives (#2134).
    this.growLimits?.(runId);
    for (;;) {
      const current = this.store.run(runId);
      if (current.status === "blocked" && providerCircuitOpen(this.store, runId)) {
        // In shadow: what the `provider_stall` park's automatic resume would do (#2271).
        recordStallPark(this.store, runId);
        return this.store.snapshot(runId);
      }
      if (current.status === "waiting" && current.reason === "provider") {
        if (await this.resumeReachableProvider(runId, signal)) continue;
        return this.store.snapshot(runId);
      }
      const snapshot = await this.driveOnce(runId, signal);
      if (snapshot.status === "waiting" && snapshot.reason === "provider") continue;
      if (process.env.BAKED_TRACE_RUN_BLOCKS === "1") this.traceBlock(runId);
      if (await this.resumeOwnerLost(runId, signal)) continue;
      if (await this.resumeStalled(runId, signal)) continue;
      if (await this.resumeUnfinished(runId, signal)) continue;
      if (await this.resumeProviderOutage(runId, signal)) continue;
      if (snapshot.status === "blocked") recordStallPark(this.store, runId);
      return snapshot;
    }
  }
  /** Durable provider waits survive a driver restart and never spend stall/provider resumes. */
  private async resumeReachableProvider(runId: string, outer: AbortSignal): Promise<boolean> {
    if (this.providerWaits.has(runId))
      throw new WorkflowFault("WORKSPACE_BUSY", "Provider health wait already executing");
    const controller = new AbortController();
    const signal = AbortSignal.any([outer, controller.signal]);
    const waiting = () => {
      const run = this.store.run(runId);
      return run.status === "waiting" && run.reason === "provider";
    };
    const poll = setInterval(() => {
      try {
        if (!waiting()) controller.abort();
      } catch (error) {
        controller.abort(error);
      }
    }, 100);
    const recover = async () => {
      while (!signal.aborted && waiting()) {
        const saved = this.store.snapshot(runId).providerWait;
        if (!saved) return false;
        try {
          await this.providerDelay(Math.max(0, Date.parse(saved.retryAt) - Date.now()), signal);
          signal.throwIfAborted();
          if (!waiting()) return false;
          let usage: unknown;
          let rejected: string | undefined;
          try {
            usage = await this.providerProbe(saved.modelId, signal);
          } catch (error) {
            // The provider answered and refused the probe's own request: a defect of the probe,
            // not of the provider, so the run resumes and its stage call decides (#1889).
            if (signal.aborted || !rejectedRequest(error)) throw error;
            rejected = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          }
          signal.throwIfAborted();
          if (!waiting()) return false;
          this.store.artifact(
            runId,
            "recovery",
            "provider/healthy.json",
            canonical({
              modelId: saved.modelId,
              at: new Date().toISOString(),
              ...(rejected === undefined ? { usage } : { probeRejected: rejected }),
            }),
          );
          try {
            await this.resume(runId, {
              commandId: newId(),
              expectedRevision: this.store.run(runId).revision,
            });
          } catch (error) {
            const reason =
              error instanceof WorkflowFault
                ? error.code === "INPUT_CHANGED"
                  ? "input_changed"
                  : "host_state"
                : isStoreError(error)
                  ? "storage_failure"
                  : "host_error";
            this.store.transition(runId, "blocked", reason);
            const diagnostic = this.store.artifact(
              runId,
              "diagnostic",
              `errors/${newId()}.txt`,
              error instanceof Error ? error.message : String(error),
            );
            if (reason === "host_error") recordHostError(this.store, runId, diagnostic.id, error);
            return false;
          }
          return true;
        } catch (error) {
          if (signal.aborted || !waiting()) return false;
          if (!isTransient(error)) {
            this.store.transition(
              runId,
              "blocked",
              accountRefusal(error) ? "provider_account" : "provider_unavailable",
            );
            this.store.artifact(
              runId,
              "diagnostic",
              `errors/${newId()}.txt`,
              error instanceof Error ? error.message : String(error),
            );
            return false;
          }
          const probe = saved.probe + 1;
          const delay = providerBackoffMs(probe - 1);
          this.store.artifact(
            runId,
            "recovery",
            "provider/wait.json",
            canonical({
              modelId: saved.modelId,
              probe,
              retryAt: new Date(Date.now() + delay).toISOString(),
            }),
          );
        }
      }
      return false;
    };
    const promise = recover();
    this.providerWaits.set(runId, { controller, promise });
    try {
      return await promise;
    } finally {
      clearInterval(poll);
      this.providerWaits.delete(runId);
      if (signal.aborted && waiting()) this.store.transition(runId, "paused", "user_pause");
    }
  }
  /**
   * Prints why a drive stopped on a block, with the run's latest events, to stderr. The test setup
   * turns it on in CI (`BAKED_TRACE_RUN_BLOCKS=1`), so a run that blocks only on one platform and
   * then waits out a test names its fault in the log (#1177).
   */
  private traceBlock(runId: string, label = "run-block"): void {
    const run = this.store.run(runId);
    if (label === "run-block" && run.status !== "blocked") return;
    const recent = this.store
      .events(runId, 0, 100_000)
      .slice(-15)
      .map((e) => `  ${e.seq} ${e.at} ${e.type} ${JSON.stringify(e.payload).slice(0, 1500)}`);
    process.stderr.write(
      `[${label}] ${runId} ${run.status}: ${run.reason}\n${recent.join("\n")}\n`,
    );
  }
  /**
   * A run that blocked with `owner_lost` under `clarification: assume` resumes itself after a
   * growing wait, at most `ownerLostBackoffMs.length` times; the worker is usually lost to a
   * transient provider or process failure that a person would only have resumed. Each resume is
   * journaled as a recovery artifact.
   */
  private async resumeOwnerLost(runId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const run = this.store.run(runId);
    if (run.status !== "blocked" || run.reason !== "owner_lost") return false;
    if (PolicySchema.parse(JSON.parse(run.policy_json)).clarification !== "assume") return false;
    const state = this.store.state(runId);
    const wait = this.ownerLostBackoffMs[state.ownerLostResumes];
    if (wait === undefined || this.store.requests(runId).some(blocksRun)) return false;
    try {
      await abortableDelay(wait, signal);
    } catch {
      return false;
    }
    const attempt = state.ownerLostResumes + 1;
    this.store.transaction(() => {
      state.ownerLostResumes = attempt;
      this.store.artifact(
        runId,
        "recovery",
        `owner-lost/resume-${attempt}.json`,
        canonical({ attempt, of: this.ownerLostBackoffMs.length, waitedMs: wait }),
      );
      this.store.saveState(runId, state);
    });
    try {
      await this.resume(runId, {
        commandId: newId(),
        expectedRevision: this.store.run(runId).revision,
      });
    } catch {
      // The run needs a person after all (a pending request, changed inputs): it stays blocked.
      return false;
    }
    return true;
  }
  /**
   * A run that blocked with `step_stalled` (an attempt made no progress, or its tools kept hitting
   * their deadlines) resumes by itself, at most `workflows.stall.autoResumes` times. The edits the
   * stalled attempt left open were already settled from the file hashes, so nothing needs a person.
   * Each resume is journaled as a recovery artifact.
   */
  private async resumeStalled(runId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const run = this.store.run(runId);
    if (run.status !== "blocked" || run.reason !== "step_stalled") return false;
    const state = this.store.state(runId);
    const limit = stallSettings(this.config).autoResumes;
    if (state.stallResumes >= limit || this.store.requests(runId).some(blocksRun)) return false;
    const attempt = state.stallResumes + 1;
    this.store.transaction(() => {
      state.stallResumes = attempt;
      this.store.artifact(
        runId,
        "recovery",
        `stalled/resume-${attempt}.json`,
        canonical({ attempt, of: limit }),
      );
      this.store.saveState(runId, state);
    });
    try {
      await this.resume(runId, {
        commandId: newId(),
        expectedRevision: this.store.run(runId).revision,
      });
    } catch {
      return false;
    }
    return true;
  }
  /**
   * Takes over a run whose driver (a process, or a worker thread of the terminal UI) the
   * supervisor stopped because its thread no longer ran (#1533: a synchronous call that never
   * returned left the run "running" for 31 min). Called after that driver is gone. Within `workflows.stall.autoResumes`, counted with the
   * watchdog's own resumes in `stallResumes`, the run is resumed (its open edits are settled from
   * the file hashes on the next drive) and true is returned; past it the run blocks `step_stalled`
   * for a person. Each takeover is journaled as `stalled/takeover-N.json`.
   */
  async takeOverStalledDriver(runId: string, driver: StalledDriver): Promise<boolean> {
    const run = this.store.run(runId);
    if (run.status !== "running") return false;
    const state = this.store.state(runId);
    const limit = stallSettings(this.config).autoResumes;
    const attempt = state.stallResumes + 1;
    const resumes = attempt <= limit;
    return this.store.transaction(() => {
      this.store.artifact(
        runId,
        "recovery",
        `stalled/takeover-${attempt}.json`,
        canonical({
          attempt,
          of: limit,
          pid: driver.pid,
          ...(driver.owner ? { owner: driver.owner } : {}),
          resumed: resumes,
        }),
      );
      if (resumes) {
        state.stallResumes = attempt;
        this.store.saveState(runId, state);
      }
      this.store.artifact(
        runId,
        "diagnostic",
        `errors/${newId()}.txt`,
        `The driver ${driver.owner ? `worker ${driver.owner} of process ${driver.pid}` : `process ${driver.pid}`} stopped running its timers (no lease renewal, tool deadline or step watchdog) and was stopped by its supervisor`,
      );
      this.store.transition(runId, "blocked", "step_stalled");
      if (!resumes) return false;
      try {
        // Publish the takeover and resume together: readers must not mistake the intermediate
        // step_stalled state for an exhausted resume budget while the next worker continues.
        this.resumeCommand(runId, {
          commandId: newId(),
          expectedRevision: this.store.run(runId).revision,
        });
      } catch {
        return false;
      }
      // A command of unknown outcome makes the resume ask a person instead (`interrupted_effect`).
      return this.store.run(runId).status === "paused";
    });
  }
  /**
   * A run that blocked because a task ended unfinished after its one restart (#1516: a watcher stop
   * left a check red, and the restarted session stopped too) resumes by itself once. The output is
   * a well-formed account of work left, not a schema fault, and the next session starts from it:
   * the stopped attempt's `unresolved` and the red checks' output. Only under `clarification:
   * assume`; a pending request still holds the run for a person. The resume is journaled as a recovery artifact.
   */
  private async resumeUnfinished(runId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const run = this.store.run(runId);
    if (run.status !== "blocked" || run.reason !== "invalid_output") return false;
    // Without `assume` an unfinished task is a person's call, as its restart is (#1516).
    if (PolicySchema.parse(JSON.parse(run.policy_json)).clarification !== "assume") return false;
    const state = this.store.state(runId);
    if (state.unfinishedResumes >= 1 || this.store.requests(runId).some(blocksRun)) return false;
    const diagnostic = this.store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("errors/"))
      .at(-1);
    const marker = diagnostic
      ? this.store.latestArtifact(runId, `${UNFINISHED_BLOCK_PREFIX}${diagnostic.id}.json`)
      : null;
    if (!marker) return false;
    const { taskId } = JSON.parse(this.store.readArtifact(runId, marker.id)) as { taskId: string };
    const attempt = state.unfinishedResumes + 1;
    this.store.transaction(() => {
      state.unfinishedResumes = attempt;
      this.store.artifact(
        runId,
        "recovery",
        `unfinished/resume-${attempt}.json`,
        canonical({ attempt, of: 1, taskId }),
      );
      this.store.saveState(runId, state);
    });
    try {
      await this.resume(runId, {
        commandId: newId(),
        expectedRevision: this.store.run(runId).revision,
      });
    } catch {
      return false;
    }
    return true;
  }
  /**
   * A run that blocked with `provider_unavailable` (the provider stayed down, was at capacity, or
   * the connection kept dropping through the in-call retries and the route's fallbacks) resumes by
   * itself after a growing wait, at most `workflows.stall.providerResumes` times. The failed call
   * changed no files, so a person would only have resumed it. The wait is journaled first, with the
   * time of the retry, so `workflow status` and the desktop run view can show when it comes back.
   * The limit counts one outage: once a model attempt has completed since the last resume, the
   * provider came back, so the next outage starts again from the first, shortest wait (#1068).
   */
  private async resumeProviderOutage(runId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const run = this.store.run(runId);
    if (run.status !== "blocked" || run.reason !== "provider_unavailable") return false;
    const state = this.store.state(runId);
    const settings = stallSettings(this.config);
    const completed = this.store
      .attempts(runId)
      .filter((a) => a.model_id !== null && a.status === "completed").length;
    const used = this.providerResumesOfOutage(runId, state.providerResumes, completed);
    if (used >= settings.providerResumes) return false;
    if (this.store.requests(runId).some(blocksRun)) return false;
    const attempt = used + 1;
    const wait = providerResumeWaitMs(settings, attempt);
    this.store.transaction(() => {
      state.providerResumes = attempt;
      this.store.artifact(
        runId,
        "recovery",
        `provider/resume-${attempt}.json`,
        canonical({
          attempt,
          of: settings.providerResumes,
          waitMs: wait,
          retryAt: new Date(Date.now() + wait).toISOString(),
          completedAttempts: completed,
        }),
      );
      this.store.saveState(runId, state);
    });
    try {
      await abortableDelay(wait, signal);
    } catch {
      return false;
    }
    // A person may have resumed, paused or cancelled the run during the wait.
    const current = this.store.run(runId);
    if (current.status !== "blocked" || current.reason !== "provider_unavailable") return false;
    try {
      await this.resume(runId, { commandId: newId(), expectedRevision: current.revision });
    } catch {
      return false;
    }
    return true;
  }
  /** The automatic resumes already spent on the current outage: 0 once an attempt completed since the last one. */
  private providerResumesOfOutage(runId: string, resumes: number, completed: number): number {
    if (resumes < 1) return 0;
    const last = this.store.latestArtifact(runId, `provider/resume-${resumes}.json`);
    if (!last) return resumes;
    const body = JSON.parse(this.store.readArtifact(runId, last.id)) as {
      completedAttempts?: number;
    };
    return body.completedAttempts !== undefined && completed > body.completedAttempts ? 0 : resumes;
  }
  private async driveOnce(runId: string, signal: AbortSignal): Promise<RunSnapshot> {
    this.enabled();
    assertMutable(this.store.run(runId).status);
    if (this.store.requests(runId).some(blocksRun)) return this.store.snapshot(runId);
    if (this.active.has(runId))
      throw new WorkflowFault("WORKSPACE_BUSY", "Run already executing in this process");
    // Runs saved before initiative boundaries were persisted recover them from their approved
    // plan revision, so resuming the original ownership stop does not require a new run.
    const state = this.store.state(runId);
    if (!state.initiativeBounds) {
      const initiatives = new InitiativeStore(this.store);
      const initiativeId = initiatives.initiativeOfRun(runId);
      const link = initiativeId
        ? initiatives.links(initiativeId).find((entry) => entry.run_id === runId)
        : null;
      if (initiativeId && link) {
        const plan = initiatives.plan(initiatives.revision(initiativeId, link.plan_revision));
        state.initiativeBounds = {
          featureId: link.feature_id,
          features: plan.features.map((feature) => ({
            id: feature.id,
            ...feature.boundary,
            ...(feature.testedBy ? { testedBy: feature.testedBy } : {}),
            dependsOn: feature.dependsOn,
          })),
        };
      }
    }
    if (state.initiativeBounds) {
      this.store.transaction(() => {
        // Re-route old blockers even when a prior binary already saved boundary metadata.
        const findings = this.store
          .findings(runId)
          .filter((finding) => !["resolved", "refuted"].includes(finding.status))
          .map((finding) => JSON.parse(finding.body_json) as Review["findings"][number]);
        for (const id of noteSiblingFindings(state, "review", findings))
          this.store.findingStatus(runId, id, "resolved");
        this.store.saveState(runId, state);
      });
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const primary = !this.primaryBusy;
    if (primary) this.primaryBusy = true;
    const scheduler = primary ? this.scheduler : this.lane();
    scheduler.maxParallelRuns = parallelRunCap(this.config);
    const promise = scheduler
      .drive(runId, controller.signal)
      .then(() => this.store.snapshot(runId));
    this.active.set(runId, { controller, promise });
    try {
      return await promise;
    } finally {
      if (primary) this.primaryBusy = false;
      this.active.delete(runId);
      signal.removeEventListener("abort", abort);
    }
  }
  /**
   * A drive lane for a run that starts while the primary lane drives another: its own leases and
   * scheduler, since both hold the state of one drive. Worktree runs then execute side by side;
   * a second inline run is refused by the workspace execution lease as before. A lane's executor
   * shares the root context, so it owns nothing that needs disposing.
   */
  private lane(): WorkflowScheduler {
    const leases = new WorkspaceLeases(this.store);
    leases.progressWindowMs = Math.ceil(stallSettings(this.config).stepStallMs * 1.5);
    const lane = new WorkflowScheduler(
      this.store,
      leases,
      this.injectedExecutor ??
        new NativeAgentExecutor(this.store, leases, this.config, this.rootContext),
    );
    lane.browserDriver = this.scheduler.browserDriver;
    lane.layoutProbe = this.scheduler.layoutProbe;
    lane.registryFetch = this.scheduler.registryFetch;
    lane.semgrep = this.scheduler.semgrep;
    lane.waitClock = this.scheduler.waitClock;
    lane.growLimits = (runId) => this.growLimits?.(runId);
    return lane;
  }
  async pause(runId: string, command: CommandIdentity): Promise<RunSnapshot> {
    return this.stop(runId, command, "paused");
  }
  async cancel(runId: string, command: CommandIdentity): Promise<RunSnapshot> {
    return this.stop(runId, command, "cancelled");
  }
  private async stop(
    runId: string,
    command: CommandIdentity,
    status: "paused" | "cancelled",
  ): Promise<RunSnapshot> {
    const result = this.store.command(runId, command, { runId, ...command, action: status }, () => {
      assertMutable(this.store.run(runId).status);
      this.store.transition(runId, status, "user_pause");
      // A crashed owner must not keep the workspace locked for ordinary edits after the user stops the run.
      if (!this.active.has(runId)) releaseDeadOwnerLeases(this.store, runId);
    });
    const active = this.active.get(runId);
    const providerWait = this.providerWaits.get(runId);
    providerWait?.controller.abort();
    active?.controller.abort();
    if (active) await active.promise;
    if (providerWait) await providerWait.promise;
    return result;
  }
  async resume(
    runId: string,
    command: CommandIdentity,
    options: { acceptWorkspace?: boolean; remedy?: ResumeRemedy } = {},
  ): Promise<RunSnapshot> {
    this.enabled();
    const outside = options.acceptWorkspace ? await this.outsideChanges(runId) : null;
    return this.resumeCommand(runId, command, outside, options.remedy);
  }
  /**
   * A person's answer to a corrective blocked on files it may not write (#2155): the remedy must
   * be one the block offers. The corrective's next session applies that one host decision, as an
   * enforced `corrective_unowned_file` would, and `decisions/unowned-TASK-COMMAND.json` records it.
   */
  private applyHostRemedy(runId: string, command: CommandIdentity, remedy: HostRemedy): void {
    const offered = stopRecovery(this.store, runId)?.remedies.find((r) => r.action === remedy);
    if (this.store.run(runId).status !== "blocked" || !offered?.taskId)
      throw new WorkflowFault(
        "STALE_DECISION",
        `This run's block does not offer the remedy ${remedy}; see \`baked workflow status ${runId}\``,
      );
    const state = this.store.state(runId);
    state.unownedRemedies[offered.taskId] = REMEDY_DECISION[remedy];
    this.store.artifact(
      runId,
      "decision",
      `decisions/unowned-${offered.taskId}-${command.commandId}.json`,
      canonical({
        approvedBy: "user",
        commandId: command.commandId,
        remedy,
        taskId: offered.taskId,
        paths: offered.paths ?? [],
        ...(offered.owner ? { owner: offered.owner } : {}),
      }),
    );
    this.store.saveState(runId, state);
  }
  /**
   * A person's acceptance of a required check that timed out twice on one workspace (#2358): the
   * block must offer it. The check's timeouts stop the run no more, the run report lists the check
   * as a known limitation, and `decisions/limitation-CHECK-COMMAND.json` records the decision.
   * The host never takes it on its own.
   */
  private acceptCheckLimitation(runId: string, command: CommandIdentity): void {
    const offered = stopRecovery(this.store, runId)?.remedies.find(
      (r) => r.action === "accept-limitation",
    );
    const checkId = offered?.checkId;
    if (this.store.run(runId).status !== "blocked" || !checkId)
      throw new WorkflowFault(
        "STALE_DECISION",
        `This run's block does not offer the remedy accept-limitation; see \`baked workflow status ${runId}\``,
      );
    const state = this.store.state(runId);
    const runs = this.store.checks(runId).filter((c) => c.check_id === checkId);
    const evidence = runs.slice(-2).map((c) => c.evidence_id);
    if (!state.acceptedCheckTimeouts.includes(checkId)) state.acceptedCheckTimeouts.push(checkId);
    const findingId = `limitation-${checkId}`;
    if (!state.limitations.some((l) => l.findingId === findingId))
      state.limitations.push({
        findingId,
        severity: "medium",
        kind: "check_not_run",
        criterionIds: [],
        file: null,
        symbol: null,
        claim: `Required check ${checkId} could not run: it timed out twice on the same workspace (evidence ${evidence.join(" and ")}).`,
        impact: `The delivered change is not verified by ${checkId}.`,
        decidedBy: "user",
        round: this.store.run(runId).convergence_rounds,
      });
    this.store.artifact(
      runId,
      "decision",
      `decisions/limitation-${checkId}-${command.commandId}.json`,
      canonical({ approvedBy: "user", commandId: command.commandId, checkId, evidence }),
    );
    this.store.saveState(runId, state);
  }
  /** A person's grant applies only to the operation refused by the current diagnostic. */
  async repair(runId: string, command: CommandIdentity, rounds = 1): Promise<RunSnapshot> {
    this.enabled();
    return this.store.command(
      runId,
      command,
      { runId, ...command, action: "repair", rounds },
      () => {
        if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100)
          throw new WorkflowFault(
            "INVALID_DEFINITION",
            "Repair rounds must be an integer between 1 and 100",
          );
        const run = this.store.snapshot(runId);
        const block = run.repairBlock;
        if (!canRepairRun(run) || !block)
          throw new WorkflowFault("STALE_DECISION", "This run is not blocked on a repair limit");
        const state = this.store.state(runId);
        assertFrozenInputs(state, this.store, runId);
        // One grant covers the refused operation even when it needs several corrective tasks.
        const extra = block.required + rounds - 1;
        switch (block.limit) {
          case "maxTaskRepairs":
            for (const id of block.taskIds)
              state.extraTaskRepairs[id] = (state.extraTaskRepairs[id] ?? 0) + extra;
            break;
          case "maxRepairRounds":
            if (block.scope === "review") state.extraReviewRounds += extra;
            else state.extraRepairRounds += extra;
            break;
          case "maxCorrectiveTasks":
            state.extraCorrectiveTasks += extra;
            break;
          case "maxIterations":
            if (!block.transitionId)
              throw new WorkflowFault("STALE_DECISION", "Missing refused transition");
            state.extraLoopIterations[block.transitionId] =
              (state.extraLoopIterations[block.transitionId] ?? 0) + extra;
            break;
          case "maxStageVisits":
            state.extraStageVisits += extra;
            break;
          case "freshRestart":
            state.extraRepeatRepairs += extra;
            break;
        }
        this.store.artifact(
          runId,
          "recovery",
          `repair-grants/${command.commandId}.json`,
          canonical({
            approvedBy: "user",
            commandId: command.commandId,
            block,
            rounds,
            extra,
            tokenUsage: run.tokenUsage,
          }),
        );
        this.store.saveState(runId, state);
        // Use the normal resume checks and task recovery in the same command transaction.
        this.resumeCommand(runId, {
          commandId: `${command.commandId}-resume`,
          expectedRevision: run.revision,
        });
      },
    );
  }
  /** The synchronous resume checks and writes, also used inside a takeover transaction. */
  private resumeCommand(
    runId: string,
    command: CommandIdentity,
    outside: Awaited<ReturnType<NativeWorkflowService["outsideChanges"]>> | null = null,
    remedy?: ResumeRemedy,
  ): RunSnapshot {
    this.enabled();
    const body = {
      runId,
      ...command,
      action: "resume",
      ...(outside ? { acceptWorkspace: true } : {}),
      ...(remedy ? { remedy } : {}),
    };
    return this.store.command(runId, command, body, () => {
      assertMutable(this.store.run(runId).status);
      if (remedy === "accept-limitation") this.acceptCheckLimitation(runId, command);
      else if (remedy) this.applyHostRemedy(runId, command, remedy);
      if (outside) this.acceptOutsideChanges(runId, outside);
      else this.assertNoRefusedEdit(runId);
      if (this.store.requests(runId).some(blocksRun))
        throw new WorkflowFault("STALE_DECISION", "Resolve pending requests before resuming");
      assertFrozenInputs(this.store.state(runId), this.store, runId);
      const lease = this.store.lease(executionLeaseFor(this.store, runId));
      if (lease?.run_id === runId && leaseOwnerAlive(lease) === false) {
        const uncertain = this.store
          .effects(runId)
          .filter(
            (effect) =>
              effect.kind === "command" && ["prepared", "unknown"].includes(effect.status),
          );
        if (uncertain.length) {
          for (const effect of uncertain)
            this.store.request(runId, "recovery", this.store.run(runId).input_hash, {
              effectId: effect.id,
              intent: JSON.parse(effect.intent_json),
              ...checkRecoveryNote(this.store, runId, effect.id),
            });
          noteInterruptedChecks(
            this.store,
            runId,
            uncertain.map((effect) => effect.id),
            "resume",
          );
          this.store.transition(runId, "waiting", "interrupted_effect");
          return;
        }
      }
      const blocked = this.store.run(runId);
      // A remedy changes what the next attempt does, so it is no repeat of the same attempt.
      if (
        !remedy &&
        blocked.status === "blocked" &&
        blocked.reason === "invalid_output" &&
        !this.noteInvalidOutput(runId)
      )
        throw new WorkflowFault("STALE_DECISION", repeatedInvalidOutputAdvice(runId), {
          reason: "repeated_invalid_output",
        });
      // Resuming is the operator's decision to try again: a task whose implementation did not
      // complete (no snapshot) goes back to pending and continues on the edits already in place.
      closeProviderCircuit(this.store, runId, command.commandId);
      for (const task of this.store.tasks(runId))
        if (task.status === "blocked" && task.snapshot_id === null)
          this.store.taskStatus(runId, task.id, "pending");
      this.store.transition(runId, "paused", "none");
    });
  }
  /**
   * A plain resume after a stop by repeated hash refusals (#954) would start an attempt whose edits
   * of that file are refused again, while the run root still holds the refused content: that is a
   * decision for a person, keep the file or restore it (#1269). A file in a task worktree is
   * rebuilt on resume, so only a refusal in the run root is held.
   */
  private assertNoRefusedEdit(runId: string): void {
    const run = this.store.run(runId);
    if (run.status !== "blocked" || run.reason !== "input_changed") return;
    const diagnostic = this.store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("errors/"))
      .at(-1);
    const last = diagnostic
      ? this.store.latestArtifact(runId, `${REFUSED_EDIT_PREFIX}${diagnostic.id}.json`)
      : null;
    if (!last) return;
    const refused = JSON.parse(this.store.readArtifact(runId, last.id)) as {
      path: string;
      root: string;
      hash: string | null;
    };
    const state = this.store.state(runId);
    if (refused.root !== (state.worktree?.path ?? "")) return;
    if (fileHash(workspacePath(runRoot(this.workspace, state), refused.path)) !== refused.hash)
      return;
    throw new WorkflowFault(
      "STALE_DECISION",
      recoveryAdvice(
        `${refused.path} still differs from what the run recorded, so its edits would be refused again. Keep it with \`baked workflow resume ${runId} --accept-workspace\`, or put back the content the run wrote and resume`,
        `${refused.path} still differs from what the run recorded. Keep these changes, or restore the content the run wrote before retrying.`,
        { action: "accept-workspace", runId },
      ),
      { path: refused.path },
    );
  }
  /**
   * The source files that differ from what the run expects and that none of the run's own
   * journaled edits explain: a person's changes in the run's workspace.
   */
  async outsideChanges(runId: string): Promise<OutsideChange[]> {
    const state = this.store.state(runId);
    const expected = state.expectedFiles;
    const changes: OutsideChange[] = [];
    if (expected) {
      const policy = PolicySchema.parse(JSON.parse(this.store.run(runId).policy_json));
      const files = await sourceManifest(runRoot(this.workspace, state), generatedPaths(policy));
      changes.push(
        ...[...new Set([...Object.keys(files), ...Object.keys(expected)])]
          .filter((path) => files[path] !== expected[path])
          .filter((path) => runWrittenHash(this.store, runId, path) !== (files[path] ?? null))
          .sort()
          .map((path) => ({ path, before: expected[path] ?? null, after: files[path] ?? null })),
      );
    }
    // A changed instruction or configuration file the run froze is accepted too (#1654), named
    // relative to the workspace when it lies there.
    for (const path of changedFrozenInputs(state, this.store, runId)) {
      if (FROZEN_DEFINITION_PATH.test(path.replaceAll("\\", "/"))) continue;
      const shown = relative(this.workspace, path);
      const name =
        shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown.replaceAll("\\", "/") : path;
      if (changes.some((change) => change.path === name)) continue;
      changes.push({
        path: name,
        before: state.frozenFiles[path] ?? null,
        after: fileHash(path),
        frozen: true,
      });
    }
    return changes;
  }
  /**
   * Keeps a person's changes to the run's workspace as the run's baseline (#971, rotaplan
   * c4ae5074: a diagnostic asked the operator to delete a file, and the run then blocked on that
   * change with no way back). The accepted paths with their hashes are an operator record; the
   * run's own edits stay journaled, so `workflow undo` still restores what the run wrote.
   */
  private acceptOutsideChanges(runId: string, outside: OutsideChange[]): void {
    const changes = outside.filter((change) => !change.frozen);
    const state = this.store.state(runId);
    const frozen = this.acceptFrozenChanges(runId, state);
    if (!frozen.length && (!changes.length || !state.expectedFiles))
      throw new WorkflowFault(
        "STALE_DECISION",
        `The workspace has no outside changes to accept. --accept-workspace only accepts file changes; it cannot expand the approved task scope. Revise the run (\`baked workflow revise ${runId}\`) or replan the initiative feature (\`baked workflow initiative replan ID --feature F\`) to change its plan or boundary.`,
      );
    if (changes.length && state.expectedFiles) {
      const expected = { ...state.expectedFiles };
      for (const change of changes) {
        if ((expected[change.path] ?? null) !== change.before)
          throw new WorkflowFault("STALE_DECISION", `${change.path} changed again; check it again`);
        if (change.after === null) delete expected[change.path];
        else expected[change.path] = change.after;
      }
      state.expectedFiles = expected;
    }
    this.store.artifact(
      runId,
      "recovery",
      `operator/accepted-workspace-${newId()}.json`,
      canonical({ acceptedBy: "operator", changes, ...(frozen.length ? { frozen } : {}) }),
    );
    this.store.saveState(runId, state);
  }
  /**
   * A person's edit to an instruction or configuration file the run froze is kept the same way
   * (#1654): the run adopts the current files, as a revision does, instead of blocking on the
   * changed input again. A frozen skill, agent, workflow or gate file still needs a definition
   * revision.
   */
  private acceptFrozenChanges(runId: string, state: RuntimeState) {
    const changed = changedFrozenInputs(state, this.store, runId);
    if (!changed.length) return [];
    const definition = changed.find((path) =>
      FROZEN_DEFINITION_PATH.test(path.replaceAll("\\", "/")),
    );
    if (definition)
      throw new WorkflowFault("INPUT_CHANGED", frozenInputAdvice(runId, definition), {
        path: definition,
      });
    return adoptCurrentInstructions(
      state,
      this.store,
      runId,
      frozenInstructions(this.store.workspace, this.config.instructionFiles),
    );
  }
  /**
   * Resuming a run that blocked on invalid output repeats the stage that produced it. The agent
   * gets the diagnostic as a correction note, so the retry is not the same attempt again; a
   * diagnostic already noted is not added twice.
   */
  /**
   * Gives the next attempt the diagnostic of the stop. False when an earlier resume already gave
   * it this very diagnostic with the same inputs: the attempt after that resume stopped the same
   * way, and narrowfit 3c2e3629 stopped identically after two more resumes and an extension
   * (#1348). The prompt is not the only input: the same diagnostic after a reroute is a new
   * situation, since another model makes another attempt (commitbump-update 0894df2d, #2191). The
   * repeat key is the diagnostic plus `invalidOutputInputs`, recorded under `INVALID_OUTPUT_KEY`;
   * the note itself goes into the prompt once. The decision is `invalidOutputRepeat`, which the
   * run views read too (#2201).
   */
  private noteInvalidOutput(runId: string): boolean {
    const repeat = invalidOutputRepeat(this.store, runId);
    if (!repeat) return true;
    if (repeat.repeats) return false;
    const state = this.store.state(runId);
    if (!state.prompt.includes(repeat.note)) {
      state.prompt += repeat.note;
      this.store.saveState(runId, state);
    }
    this.store.artifact(runId, "recovery", INVALID_OUTPUT_KEY, repeat.key);
    return true;
  }
  /**
   * "Accept" on a stopped convergence: the remaining findings become known limitations, and the
   * run leaves the convergence stage as if it had passed.
   */
  private acceptStoppedConvergence(
    runId: string,
    state: RuntimeState,
    body: ConvergenceRequestBody,
  ): void {
    acceptResidual(this.store, runId, state, body, "user");
    noteStoppedInconclusive(state, this.store.run(runId).convergence_rounds);
    const parsed = parseRunDefinition(this.store.run(runId).definition_json);
    const position = state.position;
    if (parsed.schemaVersion === 1) {
      if (parsed.definition.stages[state.stageIndex]?.kind === "converge") state.stageIndex++;
    } else if (position) {
      position.outcome = "passed";
      position.findings = [];
      position.repairKind = null;
    }
  }
  /**
   * "One more round" on a stopped convergence: the limit that stopped it is raised just far
   * enough for these findings. A schema 1 run starts the corrections now; a schema 2 run takes
   * its decided transition again when it resumes.
   */
  private repairStoppedConvergence(
    runId: string,
    state: RuntimeState,
    body: ConvergenceRequestBody,
  ): void {
    const run = this.store.run(runId);
    const policy = PolicySchema.parse(JSON.parse(run.policy_json));
    grantRound(this.store, runId, state, policy, body.findings);
    const ids = new Set(body.findings.map((f) => f.id));
    const parsed = parseRunDefinition(run.definition_json);
    if (parsed.schemaVersion !== 1) return;
    const findings = this.store
      .findings(runId)
      .filter((f) => ids.has(f.id))
      .map((f) => ({ ...JSON.parse(f.body_json), id: f.id }));
    appendCorrections(this.store, runId, state, policy, findings, "convergence");
    state.stageIndex = parsed.definition.stages.findIndex((s) => s.kind === "task-graph");
  }
  /**
   * Whether a run can continue right after a decision: it is not finished and no request that
   * blocks it is still pending (another question or approval waits for a person first).
   */
  canResumeAfterDecision(runId: string): boolean {
    return (
      !["completed", "cancelled", "failed"].includes(this.store.run(runId).status) &&
      !this.store.requests(runId).some(blocksRun)
    );
  }
  async decide(runId: string, command: CommandIdentity, given: Decision): Promise<RunSnapshot> {
    // A recovery decision needs no evidence: it records a generated note instead (#2415).
    const decision = withRecoveryNote(given);
    return this.store.command(runId, command, { runId, ...command, decision }, () => {
      const named = this.store.requests(runId).find((r) => r.id === decision.requestId);
      // The decision on an acceptance test is advisory work beside the run, at any status.
      if (named && isAcceptanceRequest(named)) {
        decideAcceptance(this.store, runId, named, decision);
        return;
      }
      // Delivery happens after a run completed; its decisions never change the run's state.
      if (named && isDeliveryRequest(named)) {
        if (named.status !== "pending")
          throw new WorkflowFault("STALE_DECISION", `Request is ${named.status}, not pending`);
        decideDelivery(this.store, runId, named, decision);
        return;
      }
      const request = named?.status === "pending" ? named : undefined;
      assertMutable(this.store.run(runId).status);
      if (!request) throw new WorkflowFault("STALE_DECISION", "Pending request not found");
      const state = this.store.state(runId);
      const body = JSON.parse(request.body_json) as Record<string, unknown>;
      let accepted = true;
      // A manual criterion the person could not confirm is settled as a known limitation.
      let settled = false;
      const testsFirst = request.kind === "approval" && "testsFirst" in body;
      if (testsFirst && (decision.kind === "approve" || decision.kind === "reject")) {
        if (state.testsFirst?.digest !== request.digest)
          throw new WorkflowFault("STALE_DECISION", "The tests changed since this request");
        if (decision.kind === "approve") {
          if (decision.digest !== request.digest)
            throw new WorkflowFault("STALE_DECISION", "Approval digest does not match the tests");
          state.testsFirst = { ...state.testsFirst, approved: true };
        } else {
          // The tests are written again with the person's note; the code still waits for them.
          accepted = false;
          state.prompt += `\nUser rejected the tests written first: ${decision.explanation}`;
          state.testsFirst = null;
          const tests = new Set(
            (state.graph?.tasks ?? []).filter(isTestTask).map((task) => task.id),
          );
          for (const row of this.store.tasks(runId))
            if (tests.has(row.id) && ["implemented", "verified"].includes(row.status)) {
              delete state.taskGates[row.id];
              this.store.taskStatus(runId, row.id, "invalidated");
            }
        }
      } else if (decision.kind === "approve") {
        assertFrozenInputs(state, this.store, runId);
        if (
          request.kind !== "approval" ||
          request.digest !== decision.digest ||
          decision.digest !== approvalDigest(state)
        )
          throw new WorkflowFault(
            "STALE_DECISION",
            "Approval digest does not match current inputs",
          );
        const root = runRoot(this.workspace, state);
        for (const [path, hash] of Object.entries(state.published))
          if (!existsSync(join(root, path)) || hashBytes(readFileSync(join(root, path))) !== hash)
            throw new WorkflowFault("INPUT_CHANGED", `Published artifact changed: ${path}`);
        const scope = (body.worktree as { userChangesInScope?: string[] } | undefined)
          ?.userChangesInScope;
        if (scope?.length) {
          if (decision.userChanges !== "exclude")
            throw new WorkflowFault(
              "STALE_DECISION",
              `Approved tasks write files with uncommitted changes in your working copy: ${scope.join(", ")}. The worktree starts from HEAD without them. Approve with the choice to exclude them (CLI: --exclude-user-changes), or reject, commit them and start a new run.`,
              { userChangesInScope: scope },
            );
          if (state.worktree)
            state.worktree = { ...state.worktree, excludedUserChanges: [...scope] };
        }
        state.approvalRoot = decision.digest;
        state.deferredCriteria =
          state.spec?.criteria.filter((c) => c.method === "post-release").map((c) => c.id) ?? [];
        this.store.setApproval(runId, decision.digest);
        if (state.position) state.position.outcome = "passed";
        else state.stageIndex++;
      } else if (decision.kind === "answer") {
        if (request.kind !== "clarification" || Object.keys(decision.answers).length === 0)
          throw new WorkflowFault("STALE_DECISION", "Clarification answers required");
        const parsed = parseRunDefinition(this.store.run(runId).definition_json);
        const position = state.position;
        const stages =
          parsed.schemaVersion === 1
            ? parsed.definition.stages
            : parsed.definition.stages.map((s) => ({ id: s.id, kind: stageKind(s) ?? s.type }));
        const askingIndex = position
          ? stages.findIndex((s) => s.id === position.stageId)
          : state.stageIndex;
        const asking = stages[askingIndex];
        state.prompt += `\nUser clarification${asking ? ` (answers the questions of the ${asking.id} stage; they are resolved)` : ""}:\n${canonical(decision.answers)}`;
        // An answer to a task's spec conflict is a decision of the run: the findings the task
        // corrects are decided, so their repros stop gating it and it is not asked again (#1350).
        const conflict = body.specConflict as
          | { taskId?: unknown; criterionIds?: unknown }
          | undefined;
        if (typeof conflict?.taskId === "string") {
          const taskId = conflict.taskId;
          const findingIds = state.graph?.tasks.find((t) => t.id === taskId)?.findingIds ?? [];
          const criterionIds = Array.isArray(conflict.criterionIds)
            ? conflict.criterionIds.filter((id): id is string => typeof id === "string")
            : [];
          recordConflictDecision(this.store, runId, {
            requestId: request.id,
            taskId,
            findingIds,
            answer: canonical(decision.answers),
            ...(criterionIds.length ? { criterionIds } : {}),
          });
          if (findingIds.length)
            state.prompt += `\nThis answer decides the findings ${findingIds.join(", ")} that task ${taskId} corrects (${CONFLICT_DECISION_PREFIX}${request.id}.json): their repros no longer gate the task.`;
        }
        // Answered research questions no longer block; the report itself stays valid.
        if (asking?.kind === "research" && state.research) {
          const research = ResearchSchema.parse(JSON.parse(state.research));
          state.research = canonical({
            ...research,
            unknowns: research.unknowns.map((q) => ({ ...q, blocking: false })),
          });
        }
        // An answer to an analysis finding supersedes the research the analyzer reads, so the same
        // fact is not raised again.
        if (asking?.kind === "analyze" && state.research) {
          const findings = Array.isArray(body.findings)
            ? (body.findings as { id?: unknown; description?: unknown }[])
            : [];
          state.research = canonical(
            supersedeResearch(
              ResearchSchema.parse(JSON.parse(state.research)),
              findings,
              decision.answers,
            ),
          );
        }
        // The answered blocking findings, so a repeat of one is not asked again (#1297).
        if (asking?.kind === "analyze" && Array.isArray(body.findings)) {
          const answer = canonical(decision.answers);
          for (const finding of body.findings as {
            kind?: unknown;
            refs?: unknown;
            description?: unknown;
            blocking?: unknown;
          }[])
            if (
              finding.blocking === true &&
              typeof finding.kind === "string" &&
              typeof finding.description === "string" &&
              Array.isArray(finding.refs)
            )
              state.answeredFindings.push({
                kind: finding.kind,
                refs: finding.refs.filter((ref): ref is string => typeof ref === "string"),
                description: finding.description,
                answer,
                rerouted: false,
              });
        }
        if (answerInvalidatesAnalysis(asking?.kind)) state.analysisPassed = false;
        const resume = clarificationResumeIndex(stages, askingIndex, body);
        if (!position) state.stageIndex = resume;
        else if (asking?.kind === "research") position.outcome = "passed";
        else if (resume !== askingIndex && stages[resume]) {
          // The user's answer sends the run back to the stage the questions were about.
          position.stageId = stages[resume].id;
          position.total++;
          position.visits[position.stageId] = (position.visits[position.stageId] ?? 0) + 1;
        }
      } else if (decision.kind === "manual-evidence") {
        if (
          request.kind !== "manual_evidence" ||
          body.criterionId !== decision.criterionId ||
          body.snapshotId !== state.snapshotId ||
          !decision.evidence.trim()
        )
          throw new WorkflowFault(
            "STALE_DECISION",
            "Manual decision does not match the current criterion and snapshot",
          );
        accepted = decision.accepted;
        if (accepted && state.snapshotId) {
          const artifact = this.store.artifact(
            runId,
            "manual",
            `manual/${decision.criterionId}.txt`,
            decision.evidence,
          );
          const evidenceId = this.store.addEvidence(runId, "manual", state.snapshotId, artifact.id);
          state.manualCriteria[decision.criterionId] = { evidenceId, snapshotId: state.snapshotId };
        } else if (!accepted) {
          settled = noteRejectedManual(
            state,
            decision.criterionId,
            decision.evidence,
            this.store.run(runId).convergence_rounds,
          );
        }
      } else if (decision.kind === "recovery") {
        const effect = this.store.effects(runId).find((entry) => entry.id === decision.effectId);
        const child = effect ? (JSON.parse(effect.intent_json) as { pid?: number }).pid : undefined;
        if (effect && child !== undefined && commandProcessMayRun(effect.intent_json))
          throw new WorkflowFault(
            "WORKSPACE_BUSY",
            "Recovery must wait until the command process is confirmed stopped",
          );
        if (request.kind !== "recovery" || body.effectId !== decision.effectId)
          throw new WorkflowFault("STALE_DECISION", "The recovery request is for another effect");
        const lease = this.store.lease(executionLeaseFor(this.store, runId));
        if (lease && leaseOwnerAlive(lease) !== false)
          throw new WorkflowFault(
            "WORKSPACE_BUSY",
            "Recovery cannot override a live process owner",
          );
        if (decision.resolution === "cancel") {
          const unresolved = this.store
            .effects(runId)
            .filter((entry) => ["prepared", "unknown"].includes(entry.status));
          for (const entry of unresolved) {
            const pid = (JSON.parse(entry.intent_json) as { pid?: number }).pid;
            if (
              entry.kind === "command" &&
              pid !== undefined &&
              commandProcessMayRun(entry.intent_json)
            )
              throw new WorkflowFault(
                "WORKSPACE_BUSY",
                "All owned commands must be stopped before abandoning recovery",
              );
          }
          this.store.artifact(
            runId,
            "recovery",
            `abandoned-effects/${newId()}.json`,
            canonical({
              effects: unresolved,
              decision,
              outcome: "unknown; abandoned by trusted recovery decision; never replay",
            }),
          );
          for (const pending of this.store
            .requests(runId)
            .filter(
              (entry) =>
                entry.kind === "recovery" && entry.status === "pending" && entry.id !== request.id,
            ))
            this.store.decideRequest(runId, pending.id, "accepted", decision);
          // The execution lease and the mutation lease of the run's root, project or worktree.
          for (const held of this.store.leases()) {
            if (held.run_id !== runId) continue;
            if (leaseOwnerAlive(held) !== false)
              throw new WorkflowFault(
                "WORKSPACE_BUSY",
                "Recovery cannot release a live mutation owner",
              );
            this.store.releaseLease(held.resource, held.owner_id, held.owner_epoch);
          }
          this.store.transition(runId, "cancelled", "user_pause");
        } else
          this.store.effectStatus(
            runId,
            decision.effectId,
            decision.resolution === "record-applied" ? "reconciled" : "failed",
          );
      } else if (decision.kind === "continue") {
        if (request.kind === "convergence")
          this.repairStoppedConvergence(runId, state, body as unknown as ConvergenceRequestBody);
        else if (request.kind !== "checkpoint")
          throw new WorkflowFault(
            "STALE_DECISION",
            "Only a token checkpoint or a stopped convergence can be continued",
          );
      } else if (decision.kind === "accept") {
        if (request.kind !== "convergence")
          throw new WorkflowFault("STALE_DECISION", "Only a stopped convergence can be accepted");
        this.acceptStoppedConvergence(runId, state, body as unknown as ConvergenceRequestBody);
      } else if (decision.kind === "reject") accepted = false;
      this.store.decideRequest(runId, request.id, accepted ? "accepted" : "rejected", decision);
      const pending = this.store.requests(runId).some(blocksRun);
      if (decision.kind === "manual-evidence" && accepted && !pending) {
        const parsed = parseRunDefinition(this.store.run(runId).definition_json);
        const position = state.position;
        if (parsed.schemaVersion === 1) {
          if (parsed.definition.stages[state.stageIndex]?.kind === "converge") state.stageIndex++;
        } else if (position && !position.outcome) {
          const stage = parsed.definition.stages.find((s) => s.id === position.stageId);
          if (stage?.type === "reflection") position.outcome = "passed";
        }
      }
      this.store.saveState(runId, state);
      if (this.store.run(runId).status !== "cancelled")
        this.store.transition(
          runId,
          pending ? "waiting" : "paused",
          accepted || settled ? "none" : "user_pause",
        );
    });
  }
  /**
   * Checks a revised v2 definition for a started run (V2-11) and binds it like a start would: the
   * gate library, the profiles frozen in the run, first-use gate confirmation and auto-approval
   * limits. `state` is the candidate state with its package applied; its manifest and frozen files
   * are updated here. Rejected with every reason when the run's history does not fit the new graph.
   */
  definitionCandidate(
    runId: string,
    state: RuntimeState,
    basePolicy: RunPolicy,
    request: { definition: unknown; definitionPath?: string; autoApprovalConfirmation?: string },
  ): { definition: WorkflowV2; gates: Gate[]; policy: RunPolicy } {
    const row = this.store.run(runId);
    const parsed = parseRunDefinition(row.definition_json);
    if (parsed.schemaVersion !== 2)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "A run started from a schema 1 workflow keeps its definition; fork it or start a new run",
      );
    const current = parsed.definition;
    const next = WorkflowV2Schema.safeParse(request.definition);
    if (!next.success)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `The revised definition is not a schema 2 workflow: ${next.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    const definition = next.data;
    const mode = executionModeOf(PolicySchema.parse(JSON.parse(row.policy_json)));
    if (definition.execution !== undefined && definition.execution !== mode)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "A revision cannot change the execution mode; fork or start a new run",
      );
    const profiles = ProfileSchema.array().parse(JSON.parse(row.profiles_json));
    const outputOf = (id: string): string => {
      const profile = profiles.find((p) => p.id === id);
      if (!profile)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Profile ${id} is not frozen in this run; start a new run to use it`,
        );
      return profile.output;
    };
    // Unchanged auto-approval limits were confirmed when the run started.
    const sameLimits =
      current.autoApproval !== null &&
      definition.autoApproval !== null &&
      autoApprovalHash(current.autoApproval) === autoApprovalHash(definition.autoApproval);
    const bound = bindDefinition(
      this.workspace,
      definition,
      basePolicy,
      outputOf,
      request.autoApprovalConfirmation ??
        (sameLimits && current.autoApproval ? autoApprovalHash(current.autoApproval) : undefined),
    );
    const position = state.position;
    if (!position)
      throw new WorkflowFault("INVALID_DEFINITION", "The run has no position in its definition");
    const keepsPackage = Boolean(state.spec && state.plan && state.graph);
    const resumeAt = keepsPackage
      ? (restartPosition(canonical(definition), true)?.stageId ?? definition.entry)
      : position.stageId;
    const held: ContractId[] = [];
    if (state.spec) held.push("spec");
    if (state.plan) held.push("plan");
    if (state.research) held.push("research");
    if (state.report) held.push("report");
    if (state.initiativePlan) held.push("initiativePlan");
    const problems = definitionRevisionProblems(current, definition, position, held, resumeAt);
    if (problems.length)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `The revised definition does not fit this run:\n${problems.join("\n")}`,
        { problems },
      );
    // The run now follows the candidate content; the files it came from are frozen again.
    const definitionFile = new RegExp(`/(?:\\.baked|baked)/workflows/${current.id}\\.json$`, "i");
    for (const path of Object.keys(state.frozenFiles)) {
      const normal = path.replaceAll("\\", "/");
      if (definitionFile.test(normal) || /\/(?:\.baked|baked)\/gates\//i.test(normal))
        delete state.frozenFiles[path];
    }
    Object.assign(state.frozenFiles, bound.gateFiles);
    if (
      request.definitionPath &&
      /\/(?:\.baked|baked)\/workflows\/[^/]+\.json$/i.test(
        request.definitionPath.replaceAll("\\", "/"),
      )
    )
      state.frozenFiles[request.definitionPath] = hashBytes(readFileSync(request.definitionPath));
    state.manifest.workflowHash = hashJson(definition);
    state.manifest.instructionHashes = [
      ...state.manifest.instructionHashes.filter((h) => h.source !== GATES_ARTIFACT),
      ...(bound.gates.length ? [{ source: GATES_ARTIFACT, hash: hashJson(bound.gates) }] : []),
    ];
    return { definition, gates: bound.gates, policy: bound.policy };
  }
  async revise(
    runId: string,
    command: CommandIdentity,
    candidateHash: string,
  ): Promise<RunSnapshot> {
    this.enabled();
    return this.store.command(runId, command, { runId, ...command, candidateHash }, () => {
      assertMutable(this.store.run(runId).status);
      if (this.store.run(runId).status === "running")
        throw new WorkflowFault("WORKSPACE_BUSY", "Pause the run before applying a revision");
      const artifact = this.store
        .artifacts(runId)
        .find((a) => a.kind === "revision-candidate" && a.content_hash === candidateHash);
      if (!artifact)
        throw new WorkflowFault(
          "ARTIFACT_MISSING",
          "Stage the revision candidate before applying it",
        );
      const candidate = JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
        expectedInputHash: string;
        state: RuntimeState;
        policy: unknown;
        definition?: unknown;
        gates?: unknown;
      };
      if (candidate.expectedInputHash !== this.store.run(runId).input_hash)
        throw new WorkflowFault("INPUT_CHANGED", "Revision candidate was built from stale inputs");
      const state = RuntimeStateSchema.parse(candidate.state);
      const definition =
        candidate.definition !== undefined ? WorkflowV2Schema.parse(candidate.definition) : null;
      const keepsPackage = Boolean(state.spec && state.plan && state.graph);
      if (!keepsPackage && !definition)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          "Revision requires a complete spec, plan and task package",
        );
      const previous = this.store.state(runId);
      // The run keeps its worktree; the candidate cannot move it.
      state.worktree = previous.worktree;
      const root = runRoot(this.workspace, state);
      // The initiative owns the upstream contracts of its features; a revision cannot repoint them.
      const pinned = this.store.state(runId).hostDependencies;
      if (state.spec && state.plan && state.graph) {
        validatePackage(root, state.spec, state.plan, state.graph);
        if (pinned && hashJson(state.spec.dependencies) !== hashJson(pinned))
          throw new WorkflowFault(
            "INVALID_DEFINITION",
            "The dependencies of an initiative feature are pinned by the initiative; keep them in the revision",
          );
      }
      state.hostDependencies = pinned;
      state.initiativeBounds = previous.initiativeBounds;
      const policy = PolicySchema.parse(candidate.policy);
      if (
        executionModeOf(policy) !==
        executionModeOf(PolicySchema.parse(JSON.parse(this.store.run(runId).policy_json)))
      )
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          "A revision cannot change the execution mode; fork or start a new run",
        );
      const writers = writerPolicyProblem(policy);
      if (writers) throw new WorkflowFault("INVALID_DEFINITION", writers);
      validateChecks(root, policy, state.graph ?? undefined);
      for (const request of this.store.requests(runId).filter((r) => r.status === "pending"))
        this.store.decideRequest(runId, request.id, "superseded", { candidateHash });
      if (definition) {
        // The operator's revise command is the decision on the new definition (V2-11); the run's
        // gates are frozen again and the previous definition stays in the record.
        const previous = JSON.parse(this.store.run(runId).definition_json) as unknown;
        const gates = GateSchema.array().parse(candidate.gates ?? []);
        this.store.setDefinition(runId, definition);
        this.store.artifact(runId, "gates", GATES_ARTIFACT, canonical(gates));
        this.store.artifact(
          runId,
          "definition-revision",
          `definition-revisions/${command.commandId}.json`,
          canonical({
            approvedBy: "user",
            commandId: command.commandId,
            candidateHash,
            previousDefinitionHash: hashJson(previous),
            definitionHash: hashJson(definition),
            previous,
          }),
        );
      }
      state.approvalRoot = null;
      this.store.setApproval(runId, null);
      if (state.graph && keepsPackage) {
        if (state.snapshotId)
          this.store.invalidateEvidence(runId, state.snapshotId, "input_changed");
        state.stageIndex = 3;
        state.position = restartPosition(this.store.run(runId).definition_json, true);
        state.analysisPassed = false;
        state.reviews = {};
        state.priorReviews = {};
        state.convergence = null;
        state.manualCriteria = {};
        state.correctionHashes = [];
        state.repairPredecessors = {};
        state.pendingTaskRepair = [];
        state.widenedCorrections = [];
        state.unownedRemedies = {};
        state.acceptedCheckTimeouts = [];
        state.personWidened = [];
        state.narrowedCorrections = {};
        state.quickFixes = {};
        state.taskGates = {};
        state.affectedTests = {};
        state.previousFindingSet = null;
        state.noProgressRounds = 0;
        state.extraConvergenceRounds = 0;
        state.extraRepairRounds = 0;
        state.extraTaskRepairs = {};
        state.extraReviewRounds = 0;
        state.extraLoopIterations = {};
        state.extraStageVisits = 0;
        state.extraRepeatRepairs = 0;
        state.correctedSinceRepair = false;
        state.extraCorrectiveTasks = 0;
        state.decidedFindings = [];
        state.autoExtensions = 0;
        state.limitations = [];
        state.reviewNotes = [];
        state.manifest.correctionHashes = [];
        state.rootGraph = structuredClone(state.graph);
        if (state.hostEdits)
          this.store.artifact(runId, "host-edits", "host-edits.json", canonical(state.hostEdits));
        state.manifest.rootGraphHash = hashJson(state.graph);
        state.manifest.effectiveGraphHash = hashJson(state.graph);
        state.expectedFiles = null;
        state.verificationState = "stale";
      } else if (definition && state.position) {
        // Before a package exists the run continues at its current stage under the new graph;
        // loop counters of transitions the revision removed are dropped.
        const kept = new Set(definition.transitions.map((t) => t.id));
        state.position.loops = Object.fromEntries(
          Object.entries(state.position.loops).filter(([id]) => kept.has(id)),
        );
      }
      const before = PolicySchema.parse(JSON.parse(this.store.run(runId).policy_json));
      // The operator's revise command is the decision on its policy. Auto-approval renewal may
      // rely on this record, but never on a policy the model produced.
      if (hashJson(before) !== hashJson(policy))
        this.store.artifact(
          runId,
          "policy-revision",
          `policy-revisions/${command.commandId}.json`,
          canonical({
            kind: "revision",
            approvedBy: "user",
            commandId: command.commandId,
            candidateHash,
            previousPolicyHash: hashJson(before),
            policyHash: hashJson(policy),
          }),
        );
      this.store.setPolicy(runId, policy);
      if (state.graph && keepsPackage) {
        // Tasks the revision leaves as they were keep their implementation; their checks run
        // again on the new snapshot, as every other evidence does. A definition revision may
        // change how tasks are implemented, and so may new project instructions: either
        // implements every task again. The gates are compared with the definition.
        const instructions = (s: RuntimeState) =>
          hashJson([
            s.manifest.instructionHashes.filter((h) => h.source !== GATES_ARTIFACT),
            s.manifest.constitutionHash,
          ]);
        const kept =
          definition || instructions(previous) !== instructions(state)
            ? new Set<string>()
            : reusableImplementations(previous, state, this.store.tasks(runId));
        this.store.syncTasks(runId, state.graph, true, kept);
      }
      this.store.saveState(runId, state);
      this.store.transition(runId, "paused");
    });
  }
  /**
   * Raises the token, call and time limits of a run that stopped on its budget, from where it
   * stopped. Scope, tools and checks cannot change here, so the approved plan stays valid and the
   * stage, evidence and approval digest are untouched. The user's command is the approval; it is
   * recorded with both policies as an immutable policy-revision artifact.
   */
  async extendBudget(
    runId: string,
    command: CommandIdentity,
    requested: Partial<BudgetLimits> & { maxCostUsd?: number } = {},
  ): Promise<RunSnapshot> {
    this.enabled();
    return this.store.command(
      runId,
      command,
      { runId, ...command, action: "extend-budget", requested },
      () => {
        const row = this.store.run(runId);
        if (row.status === "blocked" && (row.reason === "attempt_cap" || row.reason === "step_cap"))
          throw new WorkflowFault(
            "STALE_DECISION",
            `The run stopped at an attempt's ${row.reason === "step_cap" ? "step" : "token"} cap, not on its budget: resume it to continue the task with the edits already made`,
          );
        const before = PolicySchema.parse(JSON.parse(row.policy_json));
        const spent = this.store.costUsage(runId);
        if (
          !canExtendRun({
            status: row.status,
            reason: row.reason,
            estimatedCostUsd: spent.spentUsd,
            reservedCostUsd: spent.reservedUsd,
            maxCostUsd: before.maxCostUsd,
          })
        )
          throw new WorkflowFault(
            "STALE_DECISION",
            "Only a run that stopped on its budget, or is blocked with its cost cap nearly spent, can be extended",
          );
        const proposal = proposeExtension(limitsOf(before), budgetUsage(this.store, row));
        const limits: BudgetLimits = {
          maxTotalTokens:
            requested.maxTotalTokens ?? proposal?.maxTotalTokens ?? before.maxTotalTokens,
          maxAgentCalls: requested.maxAgentCalls ?? proposal?.maxAgentCalls ?? before.maxAgentCalls,
          maxActiveMs: requested.maxActiveMs ?? proposal?.maxActiveMs ?? before.maxActiveMs,
        };
        const current = limitsOf(before);
        const cost = this.store.costUsage(runId);
        const costCap =
          requested.maxCostUsd ??
          proposeCostCap(
            before.maxCostUsd,
            cost.spentUsd + cost.reservedUsd,
            current,
            budgetUsage(this.store, row),
          );
        if (costCap !== null && before.maxCostUsd === null)
          throw new WorkflowFault(
            "INVALID_DEFINITION",
            "This run has no cost cap to raise; a cost cap is set in the policy at start",
          );
        if (costCap !== null && before.maxCostUsd !== null && costCap < before.maxCostUsd)
          throw new WorkflowFault(
            "INVALID_DEFINITION",
            `Limits can only be raised: cost $${before.maxCostUsd} now, you asked $${costCap}`,
          );
        for (const key of Object.keys(current) as (keyof BudgetLimits)[])
          if (limits[key] < current[key])
            throw new WorkflowFault(
              "INVALID_DEFINITION",
              `Limits can only be raised: ${LIMIT_NAMES[key]} ${current[key].toLocaleString("en-US")} now, you asked ${limits[key].toLocaleString("en-US")}`,
            );
        if (
          costCap === before.maxCostUsd &&
          Object.keys(current).every(
            (key) => limits[key as keyof BudgetLimits] === current[key as keyof BudgetLimits],
          )
        )
          throw new WorkflowFault(
            "INVALID_DEFINITION",
            "No limit can be raised further. Fork the run or narrow the request.",
          );
        // The user's extension approves the new token budget, so an auto-approval token bound that
        // covered the old budget follows it; otherwise the next scope approval would need a person
        // only because the budget the same user just raised is larger than the old bound.
        const auto = before.autoApproval;
        const autoApproval =
          auto?.limits && auto.limits.maxTotalTokens >= before.maxTotalTokens
            ? {
                ...auto,
                limits: {
                  ...auto.limits,
                  maxTotalTokens: Math.max(auto.limits.maxTotalTokens, limits.maxTotalTokens),
                },
              }
            : auto;
        const after = PolicySchema.parse({
          ...before,
          ...limits,
          maxCostUsd: costCap,
          ...(autoApproval === undefined ? {} : { autoApproval }),
        });
        if (limits.maxActiveMs > MAX_EXTENDED_MS || limits.maxTotalTokens > MAX_EXTENDED_TOKENS)
          throw new WorkflowFault(
            "INVALID_DEFINITION",
            "Requested limits are above the allowed ceiling",
          );
        this.store.artifact(
          runId,
          "policy-revision",
          `policy-revisions/${command.commandId}.json`,
          canonical({
            kind: "budget-extension",
            approvedBy: "user",
            commandId: command.commandId,
            stageId: row.stage_id,
            previous: {
              ...current,
              ...(before.maxCostUsd === null ? {} : { maxCostUsd: before.maxCostUsd }),
            },
            next: {
              ...limitsOf(after),
              ...(after.maxCostUsd === null ? {} : { maxCostUsd: after.maxCostUsd }),
            },
            ...(after.maxCostUsd === null ? {} : { cost }),
            previousPolicyHash: hashJson(before),
            policyHash: hashJson(after),
            usage: budgetUsage(this.store, row),
          }),
        );
        this.store.setPolicy(runId, after);
        this.store.transition(runId, "paused", "none");
      },
    );
  }
  /**
   * Moves a run that is not executing to other models: a new revision of its routing record, so
   * completed stages and tasks stay and the next agent calls use the new models. The new models
   * pass the start's model checks and the `independentReview` rule first; the run keeps its
   * status, and resume continues it from where it stopped.
   */
  async reroute(
    runId: string,
    command: CommandIdentity,
    request: RerouteRequest,
  ): Promise<RunSnapshot> {
    this.enabled();
    const previous = this.store.previousCommand(
      command.commandId,
      rerouteBody(runId, command, request),
    );
    if (previous) return previous;
    const planned = await this.planReroute(runId, request);
    if (!planned)
      throw new WorkflowFault("INVALID_DEFINITION", "The run already uses these models");
    return this.commitReroute(runId, command, request, planned);
  }
  /**
   * The routing record a reroute would write, after the same checks as `reroute`; nothing is
   * written. Null when the run already uses these models. An initiative plans every run first, so
   * one refused model leaves all of them unchanged.
   */
  async planReroute(runId: string, request: RerouteRequest): Promise<PlannedReroute | null> {
    this.enabled();
    const model = request.model?.trim() || undefined;
    const routes = request.routes ?? {};
    this.assertReroutable(runId);
    if (!model && !Object.keys(routes).length)
      throw new WorkflowFault("INVALID_DEFINITION", "Name a model (--model ID) or stage routes");
    if (model === "none")
      throw new WorkflowFault("INVALID_DEFINITION", "Select a model to switch the run to");
    const row = this.store.run(runId);
    const saved = this.store.latestArtifact(runId, ROUTING_ARTIFACT);
    if (!saved)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "This run started before routing was recorded; fork it to choose other models",
      );
    const before: RoutingRecord = RoutingRecordSchema.parse(
      JSON.parse(this.store.readArtifact(runId, saved.id)),
    );
    const { definition } = parseRunDefinition(row.definition_json);
    const policy = PolicySchema.parse(JSON.parse(row.policy_json));
    const profiles = ProfileSchema.array().parse(JSON.parse(row.profiles_json));
    const after = rerouteRecord(
      this.workspace,
      this.config,
      before,
      definition.id,
      definition.stages.map((stage) => stage.id),
      profiles.map((profile) => profile.id),
      { model, routes },
    );
    const changes = routeChanges(before, after);
    if (!changes.length && after.runModel === before.runModel) return null;
    assertCostCapPriced(PolicySchema.parse(JSON.parse(row.policy_json)), after);
    const warnings: string[] = [];
    // A strict run checks independence on the configuration its start used (#2230).
    const independence = independentReviewMode(
      before.strict ? strictRoutingConfig(this.config) : this.config,
    );
    if (independence !== "off") {
      const found = independenceWarnings(
        after,
        definition,
        policy,
        loadGateLibrary(this.workspace, policy).gates,
        profiles,
        // A reroute names its models, so `provider` only warns about a shared vendor.
        independence === "provider" ? "provider" : "model",
      );
      if (found.length && independence === "require")
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `${found.join("\n")}\nmodelRouting.independentReview is "require"; route the reviewers to another model`,
        );
      warnings.push(...found);
    }
    if (this.providerReady) {
      const checks = await checkRoutingModels(
        this.workspace,
        { routing: after, definition, policy, profiles },
        this.providerReady,
      );
      const refusals = checks.filter((check) => check.status === "fail").map(checkLine);
      if (refusals.length)
        throw new WorkflowFault(
          "CAPABILITY_DENIED",
          `These models cannot be called:\n${refusals.join("\n")}`,
          { reason: "model_unavailable", problems: refusals },
        );
      warnings.push(...checks.filter((check) => check.status === "warn").map(checkLine));
    }
    if (warnings.length) after.warnings = warnings;
    return { before, after, changes };
  }
  /** Writes a planned reroute: the new routing revision and its `run.rerouted` event. */
  commitReroute(
    runId: string,
    command: CommandIdentity,
    request: RerouteRequest,
    planned: PlannedReroute,
  ): RunSnapshot {
    this.enabled();
    const { before, after, changes } = planned;
    return this.store.command(runId, command, rerouteBody(runId, command, request), () => {
      this.assertReroutable(runId);
      const artifact = this.store.artifact(runId, "routing", ROUTING_ARTIFACT, canonical(after));
      this.store.emit(runId, {
        type: "run.rerouted",
        payload: {
          artifactId: artifact.id,
          runModel: { from: before.runModel, to: after.runModel },
          changes,
        },
      });
    });
  }
  private assertReroutable(runId: string): void {
    const status = this.store.run(runId).status;
    assertMutable(status);
    if (status === "running" || this.active.has(runId))
      throw new WorkflowFault(
        "WORKSPACE_BUSY",
        "The run is executing; pause it before switching its models",
      );
  }
  /**
   * A new run with the parent's spec, plan and task graph. Without `fromStage` it starts again at
   * the analysis; with it, it starts at that stage (after the implementation) from the parent's
   * changes as they are now, keeping the parent's approval, so a re-run of one stage on another
   * model does not repeat the implementation (#855).
   */
  async fork(
    runId: string,
    command: CommandIdentity,
    options: { fromStage?: string } = {},
  ): Promise<RunSnapshot> {
    this.enabled();
    const fromStage = options.fromStage;
    return this.forkRun(
      runId,
      command,
      { runId, ...command, action: "fork", ...(fromStage ? { fromStage } : {}) },
      undefined,
      fromStage,
    );
  }
  /** The stages a fork of the run can start at with `fromStage`. */
  forkStages(runId: string): string[] {
    return forkStages(this.store.run(runId).definition_json);
  }
  /**
   * A fork of an initiative feature whose upstream contracts changed: the new run keeps its spec,
   * pins the given contract hashes as its dependencies and starts again at the plan stage, so the
   * plan is made, analyzed and approved against the new contracts. `policy` replaces the run policy
   * (an initiative drops auto approval here, so a person reviews the changed contract).
   */
  async rebase(
    runId: string,
    command: CommandIdentity,
    rebase: {
      dependencies: { featureId: string; contractHash: string }[];
      policy?: RunPolicy;
      /** The new worktree base: the feature's upstream results merged onto HEAD. */
      baseCommit?: string;
      /** Files placed untracked in the new worktree (the upstream specs, #2046). */
      baseFiles?: { path: string; content: string }[];
      /** Why the rebased run's policy has no auto approval (#1467). */
      autoApprovalDeclined?: string;
      /** `baseCommit` is provisional: the rebased run plans ahead again (#1834). */
      planAhead?: boolean;
    },
  ): Promise<RunSnapshot> {
    this.enabled();
    const dependencies = rebase.dependencies.map(({ featureId, contractHash }) => ({
      featureId: SafeId.parse(featureId),
      contractHash: Hash.parse(contractHash),
    }));
    const policy = rebase.policy ? PolicySchema.parse(rebase.policy) : undefined;
    const baseCommit = rebase.baseCommit;
    const baseFiles = baseCommit ? (rebase.baseFiles ?? []) : [];
    const declined = rebase.autoApprovalDeclined;
    const planAhead = Boolean(rebase.planAhead && baseCommit);
    return this.forkRun(
      runId,
      command,
      {
        runId,
        ...command,
        action: "rebase",
        dependencies,
        policy: policy ?? null,
        ...(baseCommit ? { baseCommit } : {}),
        ...(planAhead ? { planAhead } : {}),
      },
      {
        dependencies,
        policy,
        ...(baseCommit ? { baseCommit, baseFiles } : {}),
        ...(declined ? { autoApprovalDeclined: declined } : {}),
        ...(planAhead ? { planAhead } : {}),
      },
    );
  }
  /**
   * Moves a planned-ahead initiative feature run (#1834) from its provisional base to `baseCommit`,
   * the results of the features it depends on, once every one of them is finished. The run waits
   * at its tasks for exactly that: its host-release requests are decided by the host, and its
   * next drive takes the baseline again before the first task. Refused while a dependency is not
   * finished or its contract changed (the initiative rebases the run then), or the run waits for
   * anything else.
   */
  async releaseBase(
    runId: string,
    command: CommandIdentity,
    release: { baseCommit: string; baseFiles?: { path: string; content: string }[] },
  ): Promise<RunSnapshot> {
    this.enabled();
    const baseCommit = release.baseCommit;
    const baseFiles = release.baseFiles ?? [];
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit))
      throw new WorkflowFault("INVALID_REFERENCE", `Not a commit: ${baseCommit}`);
    const body = { runId, ...command, action: "release-base", baseCommit };
    const previous = this.store.previousCommand(command.commandId, body);
    if (previous) return previous;
    const run = this.store.run(runId);
    const state = this.store.state(runId);
    const pending = this.store.requests(runId).filter((r) => r.status === "pending");
    const held = pending.filter(isHostRelease);
    if (
      run.status !== "waiting" ||
      this.active.has(runId) ||
      !state.planAhead ||
      state.planAhead.released ||
      !state.worktree ||
      !held.length ||
      held.length !== pending.filter(blocksRun).length
    )
      throw new WorkflowFault(
        "STALE_DECISION",
        `Run ${runId} is not a planned-ahead run waiting for its dependencies`,
      );
    const unfinished = dependencyContracts(this.store, state).filter((d) => !d.completed);
    if (unfinished.length)
      throw new WorkflowFault(
        "STALE_DECISION",
        `The run still waits for ${unfinished.map((d) => d.featureId).join(", ")}`,
      );
    const from = state.worktree.baseHead;
    // A retry after a crash between the move and the state save finds the worktree moved.
    if (from !== baseCommit) await moveRunWorktree(this.workspace, state.worktree, baseCommit);
    // Upstream specs of the features accepted since the provisional base (#2046); idempotent.
    await placeBaseFiles(this.workspace, state.worktree, baseCommit, baseFiles);
    // A planned create of a file an accepted upstream feature wrote since the plan (#2514).
    const before = await trackedPaths(this.workspace, from);
    const after = await trackedPaths(this.workspace, baseCommit);
    const released = state.graph
      ? releasedCreates(state.graph, (path) => after.has(path) && !before.has(path))
      : [];
    return this.store.command(runId, command, body, () => {
      const current = this.store.state(runId);
      if (!current.worktree || !current.planAhead)
        throw new WorkflowFault("STALE_DECISION", "The run changed during its release");
      if (released.length && current.graph && current.approvalRoot) {
        const next = applyReleasedCreates(current.graph, released);
        const link = CorrectionSchema.parse({
          schemaVersion: 1,
          parentDigest: current.approvalRoot,
          parentGraphHash: hashJson(current.graph),
          rule: "host-release",
          newGraphHash: hashJson(next),
          findingIds: [],
          taskIds: [...new Set(released.map((r) => r.taskId))],
          roundKind: "release",
          round: 1,
          released,
        });
        const artifact = this.store.artifact(
          runId,
          "correction",
          "corrections/release.json",
          canonical(link),
        );
        current.correctionHashes.push(artifact.content_hash);
        current.manifest.correctionHashes = [...current.correctionHashes];
        current.graph = next;
        current.manifest.effectiveGraphHash = hashJson(next);
        this.store.syncTasks(runId, next);
      }
      current.worktree = { ...current.worktree, baseHead: baseCommit };
      current.worktreeBase = baseCommit;
      current.baseFiles = baseFiles;
      current.planAhead = { released: true, baselined: false };
      // The baseline is taken again on the new base before the first task.
      current.expectedFiles = null;
      this.store.artifact(
        runId,
        "plan-ahead",
        "plan-ahead/release.json",
        canonical({
          from,
          to: baseCommit,
          requests: held.map((r) => r.id),
          ...(released.length ? { modified: released } : {}),
        }),
      );
      for (const request of held)
        this.store.decideRequest(
          runId,
          request.id,
          "accepted",
          { kind: "host-release", baseCommit },
          "host-release",
        );
      this.store.saveState(runId, current);
      this.store.transition(runId, "paused", "none");
    });
  }
  private forkRun(
    runId: string,
    command: CommandIdentity,
    body: Record<string, unknown>,
    rebase?: {
      dependencies: { featureId: string; contractHash: string }[];
      policy?: RunPolicy;
      baseCommit?: string;
      baseFiles?: { path: string; content: string }[];
      autoApprovalDeclined?: string;
      planAhead?: boolean;
    },
    fromStage?: string,
  ): RunSnapshot {
    return this.store.transaction(() => {
      const old = this.store.previousCommand(command.commandId, body);
      if (old) return old;
      const run = this.store.run(runId);
      if (run.revision !== command.expectedRevision)
        throw new WorkflowFault("REVISION_CONFLICT", "Run changed before fork");
      const state = this.store.state(runId);
      const id = newId();
      let seed: ForkSeed | null = null;
      const stagePosition = fromStage ? forkStagePosition(run.definition_json, fromStage) : null;
      const parentApproval = state.approvalRoot;
      if (fromStage) {
        if (run.status === "running" || this.active.has(runId))
          throw new WorkflowFault("WORKSPACE_BUSY", "Pause the run before forking it from a stage");
        if (!state.spec || !state.graph || !state.plan || !parentApproval)
          throw new WorkflowFault(
            "STALE_DECISION",
            `Run ${runId} has no approved task graph, so it cannot be forked from ${fromStage}; fork it without a stage`,
          );
        seed = captureForkSeed(this.store, runId, state, runRoot(this.workspace, state), fromStage);
      }
      const worktreeBase = state.worktree?.baseHead ?? state.worktreeBase;
      // The parent's documents were published into its own worktree, untracked; a fork that
      // plans again publishes them into its new worktree, where they do not exist yet. Kept, they
      // stopped every rebase of a worktree feature at "File changed before publication" (#1834).
      if (state.worktree && !fromStage) state.published = {};
      state.stageIndex = state.spec && state.graph && state.plan ? 3 : 0;
      state.position = restartPosition(
        run.definition_json,
        Boolean(state.spec && state.graph && state.plan),
      );
      state.gateResults = {};
      state.report = null;
      // A fork of a worktree run gets its own worktree and branch when it first executes.
      state.worktree = null;
      state.approvalRoot = null;
      state.snapshotId = null;
      state.workspaceHash = null;
      state.expectedFiles = null;
      state.reviews = {};
      state.priorReviews = {};
      state.convergence = null;
      state.manualCriteria = {};
      state.correctionHashes = [];
      state.analysisPassed = false;
      state.verificationState = "not_verified";
      state.manifest.baselineSnapshotId = null;
      state.manifest.correctionHashes = [];
      state.rootGraph = state.graph ? structuredClone(state.graph) : null;
      state.manifest.rootGraphHash = state.graph ? hashJson(state.graph) : null;
      state.repairPredecessors = {};
      state.pendingTaskRepair = [];
      state.widenedCorrections = [];
      state.unownedRemedies = {};
      state.acceptedCheckTimeouts = [];
      state.personWidened = [];
      state.narrowedCorrections = {};
      state.quickFixes = {};
      state.taskGates = {};
      state.affectedTests = {};
      state.previousFindingSet = null;
      state.noProgressRounds = 0;
      state.extraConvergenceRounds = 0;
      state.extraRepairRounds = 0;
      state.extraTaskRepairs = {};
      state.extraReviewRounds = 0;
      state.extraLoopIterations = {};
      state.extraStageVisits = 0;
      state.extraRepeatRepairs = 0;
      state.correctedSinceRepair = false;
      state.extraCorrectiveTasks = 0;
      state.decidedFindings = [];
      state.autoExtensions = 0;
      state.limitations = [];
      state.reviewNotes = [];
      if (seed && stagePosition) {
        // The parent's approval covers the same graph; the fork starts from the parent's base
        // commit and its first drive writes the parent's changes back as journaled edits.
        state.approvalRoot = parentApproval;
        state.position = stagePosition.position;
        state.stageIndex = stagePosition.stageIndex;
        state.worktreeBase = worktreeBase;
      }
      const policy = rebase?.policy ?? PolicySchema.parse(JSON.parse(run.policy_json));
      if (rebase) {
        state.hostDependencies = rebase.dependencies;
        if (rebase.baseCommit) {
          state.worktreeBase = rebase.baseCommit;
          state.baseFiles = rebase.baseFiles ?? [];
        }
        state.planAhead = rebase.planAhead ? { released: false, baselined: false } : null;
        state.autoApprovalDeclined = rebase.autoApprovalDeclined ?? null;
        state.manifest.policyHash = hashJson(policy);
        state.manifest.dependencyContracts = [];
        if (state.spec) {
          // The feature's own spec stays; the plan is made again against the new upstream
          // contracts and the workspace as it is now, then analyzed and approved again.
          state.spec = { ...state.spec, dependencies: rebase.dependencies };
          state.manifest.specHash = hashJson(state.spec);
          state.plan = null;
          state.graph = null;
          state.hostEdits = undefined;
          state.rootGraph = null;
          state.manifest.planHash = null;
          state.manifest.rootGraphHash = null;
          state.manifest.effectiveGraphHash = null;
          const restart = planPosition(run.definition_json);
          state.stageIndex = restart.stageIndex;
          state.position = restart.position;
        }
      }
      const parsed = parseRunDefinition(run.definition_json);
      this.store.create(
        id,
        run.feature_id,
        parsed.definition,
        JSON.parse(run.profiles_json),
        policy,
        state,
        runId,
        run.project_id ?? null,
      );
      // Dependents find a feature's accepted contract through this artifact.
      if (state.spec) this.store.artifact(id, "spec", "spec.json", canonical(state.spec));
      if (state.graph) this.store.syncTasks(id, state.graph);
      if (state.graph && state.hostEdits)
        this.store.artifact(id, "host-edits", "host-edits.json", canonical(state.hostEdits));
      if (seed) {
        this.store.artifact(id, "fork", FORK_SEED_ARTIFACT, canonical(seed));
        this.store.setApproval(id, parentApproval);
      }
      const gates = this.store.artifacts(runId).find((a) => a.logical_path === GATES_ARTIFACT);
      if (gates)
        this.store.artifact(id, "gates", GATES_ARTIFACT, this.store.readArtifact(runId, gates.id));
      // A fork keeps the models its parent froze at start, stage routes included.
      const routing = this.store.latestArtifact(runId, ROUTING_ARTIFACT);
      if (routing)
        this.store.artifact(
          id,
          "routing",
          ROUTING_ARTIFACT,
          this.store.readArtifact(runId, routing.id),
        );
      if (state.diff) {
        const diff = this.store.artifact(
          id,
          "diff",
          "diff/input.patch",
          this.store.readArtifact(runId, state.diff.artifactId),
        );
        state.diff = { ...state.diff, artifactId: diff.id };
        this.store.saveState(id, state);
      }
      if (state.workingSet) {
        const copy = this.store.artifact(
          id,
          "context",
          WORKING_SET_ARTIFACT,
          this.store.readArtifact(runId, state.workingSet.artifactId),
        );
        state.workingSet = { ...state.workingSet, artifactId: copy.id };
        this.store.saveState(id, state);
      }
      if (state.projectMemory) {
        const copy = this.store.artifact(
          id,
          "context",
          PROJECT_MEMORY_ARTIFACT,
          this.store.readArtifact(runId, state.projectMemory.artifactId),
        );
        state.projectMemory = { ...state.projectMemory, artifactId: copy.id };
        this.store.saveState(id, state);
      }
      if (state.learnedRules) {
        const copy = this.store.artifact(
          id,
          "context",
          LEARNED_RULES_ARTIFACT,
          this.store.readArtifact(runId, state.learnedRules.artifactId),
        );
        state.learnedRules = { ...state.learnedRules, artifactId: copy.id };
        this.store.saveState(id, state);
      }
      const result = this.store.snapshot(id);
      this.store.saveCommand(command.commandId, body, result);
      return result;
    });
  }
  /**
   * Undoes the run's own task edits that are not part of its baseline: those of a failed or
   * interrupted attempt, of tasks a revision invalidated or dropped, or of a cancelled run. Only
   * files that still hold exactly what the run wrote are restored; anything changed since is
   * left in place and reported. The run's versions are kept as artifacts, every restore is a
   * journaled file effect, and the outcome is the latest `workspace-rollback` artifact.
   */
  async undo(runId: string, command: CommandIdentity, paths: string[] = []): Promise<RunSnapshot> {
    this.enabled();
    const body = { runId, ...command, action: "undo", paths: [...paths].sort() };
    const previous = this.store.transaction(() => {
      const old = this.store.previousCommand(command.commandId, body);
      if (old) return old;
      const run = this.store.run(runId);
      if (run.status === "running" || this.active.has(runId))
        throw new WorkflowFault("WORKSPACE_BUSY", "Pause the run before undoing its edits");
      if (run.revision !== command.expectedRevision)
        throw new WorkflowFault("REVISION_CONFLICT", "Run changed before undo");
      return undefined;
    });
    if (previous) return previous;
    this.leases.acquire(executionLeaseFor(this.store, runId), runId);
    try {
      this.leases.acquire(
        mutationLeaseFor(this.workspace, runRoot(this.workspace, this.store.state(runId))),
        runId,
      );
      undoRunEdits(this.store, this.leases, runId, paths);
    } finally {
      this.leases.release();
    }
    return this.store.command(runId, command, body, () => {});
  }
  /**
   * Removes the worktree and deletes the branch of a terminal run executed in a worktree: the
   * user's explicit decision to discard what the branch carries. A delivered result is already a
   * commit of its own; delivery removes the worktree itself and keeps the branch.
   */
  async discardWorktree(runId: string, command: CommandIdentity): Promise<RunSnapshot> {
    const body = { runId, ...command, action: "discard-worktree" };
    const previous = this.store.transaction(() => {
      const old = this.store.previousCommand(command.commandId, body);
      if (old) return old;
      const run = this.store.run(runId);
      if (!["completed", "failed", "cancelled"].includes(run.status) || this.active.has(runId))
        throw new WorkflowFault(
          "STALE_DECISION",
          `Only a completed, failed or cancelled run's worktree can be discarded; run ${runId} is ${run.status}. Cancel it first.`,
        );
      if (run.revision !== command.expectedRevision)
        throw new WorkflowFault("REVISION_CONFLICT", "Run changed before discard");
      const worktree = this.store.state(runId).worktree;
      if (!worktree || !existsSync(join(this.workspace, worktree.path)))
        throw new WorkflowFault("NOT_FOUND", `Run ${runId} has no worktree to discard`);
      if (
        this.store
          .effects(runId)
          .some((e) => e.kind === "delivery" && ["prepared", "unknown"].includes(e.status))
      )
        throw new WorkflowFault(
          "RECOVERY_REQUIRED",
          "A delivery of this run has an unsettled step; finish or recover it first",
        );
      return undefined;
    });
    if (previous) return previous;
    const worktree = this.store.state(runId).worktree;
    if (!worktree) throw new WorkflowFault("NOT_FOUND", `Run ${runId} has no worktree`);
    await removeRunWorktree(this.store, runId, worktree, { deleteBranch: true });
    // The state keeps the worktree record: it names the run's root and branch for history.
    return this.store.command(runId, command, body, () => {
      this.store.artifact(
        runId,
        "worktree",
        "worktree/discarded.json",
        canonical({ ...worktree, discardedAt: new Date().toISOString() }),
      );
    });
  }
  /** Run and task worktrees on disk with their size and run status (`baked workflow worktrees`). */
  worktrees(): Promise<WorktreeReport> {
    return worktreeUsage(this.store, (runId) => this.active.has(runId));
  }
  /** Removes the worktrees of ended and unknown runs; their branches stay. */
  cleanWorktrees(dryRun: boolean): Promise<WorktreeCleanup> {
    return cleanWorktrees(this.store, { dryRun, isActive: (runId) => this.active.has(runId) });
  }
  events(runId: string, afterSeq: number, signal: AbortSignal) {
    return replayEvents(this.store, runId, afterSeq, signal);
  }
  async shutdown(): Promise<void> {
    for (const wait of this.providerWaits.values())
      wait.controller.abort(new Error("Application shutdown"));
    for (const active of this.active.values())
      active.controller.abort(new Error("Application shutdown"));
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await Promise.allSettled([...this.providerWaits.values()].map((wait) => wait.promise));
  }
  close(): void {
    if (this.active.size && process.env.BAKED_TRACE_RUN_BLOCKS === "1")
      for (const runId of this.active.keys()) this.traceBlock(runId, "run-active-at-close");
    if (this.active.size || this.providerWaits.size)
      throw new WorkflowFault(
        "WORKSPACE_BUSY",
        "Stop active runs before closing the workflow service",
      );
    this.leases.release();
    this.scheduler.dispose();
    void this.rootContext.dispose().catch(() => {});
    this.attention?.dispose();
    this.store.close();
  }
}

/**
 * Where a revised or forked run of a v2 definition starts: the analysis stage when the package is
 * kept (the v1 runtime restarts at analyze), otherwise the first approval, or the entry.
 */
function restartPosition(definitionJson: string, keepsPackage: boolean): RuntimeState["position"] {
  const parsed = parseRunDefinition(definitionJson);
  if (parsed.schemaVersion === 1) return null;
  const definition = parsed.definition;
  const position = initialPosition(definition);
  if (!keepsPackage) return position;
  const stage =
    definition.stages.find((s) => s.produces === "analysis") ??
    definition.stages.find((s) => s.type === "approval");
  if (stage) {
    position.stageId = stage.id;
    position.visits = { [stage.id]: 1 };
  }
  return position;
}

/** Where a rebased run starts: the stage that produces the plan. */
function planPosition(definitionJson: string): {
  stageIndex: number;
  position: RuntimeState["position"];
} {
  const parsed = parseRunDefinition(definitionJson);
  if (parsed.schemaVersion === 1) {
    const index = parsed.definition.stages.findIndex((s) => s.kind === "plan");
    if (index < 0) throw new WorkflowFault("INVALID_DEFINITION", "The workflow has no plan stage");
    return { stageIndex: index, position: null };
  }
  const position = initialPosition(parsed.definition);
  const stage = parsed.definition.stages.find((s) => s.produces === "plan");
  if (!stage) throw new WorkflowFault("INVALID_DEFINITION", "The workflow has no plan stage");
  position.stageId = stage.id;
  position.visits = { [stage.id]: 1 };
  return { stageIndex: 0, position };
}

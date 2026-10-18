import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { codeWithoutComments } from "../intelligence/comments.js";
import { largerContextModel } from "../llm/context-sizes.js";
import {
  lowerEffort,
  ROUTING_ARTIFACT,
  type RouteContext,
  type RouteEffort,
  type RoutingRecord,
  RoutingRecordSchema,
} from "../llm/model-routing.js";
import { modelVendor } from "../llm/model-vendor.js";
import { knownModelContextWindow } from "../llm/models.js";
import { runSandbox } from "../security/sandbox.js";
import { buildSafeEnv } from "../spawn.js";
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
  failingFilesInOutput,
  failureSignature as failingLines,
  failuresCovered,
  isTestOf,
  noTestsCollected,
  pathsInOutput,
} from "../verification/convergence.js";
import {
  acceptResidual,
  assumeDecision,
  convergenceBody,
  convergenceStop,
  earlierFindings,
  grantRound,
  limitedCriteria,
  noteInconclusiveReview,
  noteStoppedInconclusive,
  noteUnverifiedCriteria,
  passesWithNotes,
  REPEAT_NOTE,
  reaskableCriteria,
  requiredChecksPass,
  reversalCandidates,
  reviewLimitAccepts,
  STYLE_UNSHOWN,
} from "../verification/convergence-stop.js";
import { caseCheck as criteriaCaseCheck } from "../verification/criteria-cases.js";
import { type DocExampleResult, isDocFile, runDocExamples } from "../verification/doc-examples.js";
import {
  currentEvidence,
  evidenceHandle,
  resolveEvidenceIds,
  validateEvidence,
  validEvidenceNote,
} from "../verification/evidence.js";
import {
  confidenceOnlyNote,
  findingBlocks,
  fingerprint,
  requiresSecurityReview,
} from "../verification/findings.js";
import {
  type BaselineCount,
  baselineRegression,
  CHECK_BASELINE_PATH,
  commandKey,
  diagnosticCount,
  failureSignature,
  outputCounts,
  TEST_FILE,
} from "../verification/output-counts.js";
import {
  carryNoRepro,
  convergenceReproGated,
  missingReproAdvice,
  outputShows,
  type ReproOutcome,
  reproAllows,
  reproCannotSeeCorrection,
  reproExecutables,
  reproTool,
  runProbe,
  runRepro,
  unconfidentReproAdvice,
} from "../verification/repro.js";
import {
  completeReview,
  reviewProblems,
  unnamedFailureAdvice,
  unnamedFailures,
  validateReview,
} from "../verification/review.js";
import { addReviewNotes, noteReason } from "../verification/review-notes.js";
import { changedPaths, gitBaseline, sourceManifest } from "../verification/snapshot.js";
import { baselineDebt, baselineKeys, taskErrors } from "../verification/task-end-check.js";
import {
  affectedTestCheck,
  affectedTestsFor,
  holdsWrittenTests,
  isCompiledTestFile,
  isWrittenTestFile,
  plannedWrittenTests,
  taskCaseText,
  writtenTestsCheck,
} from "./affected-tests.js";
import { outputSchemas } from "./agent-executor.js";
import {
  asksUnsupportedMethod,
  assumable,
  DEFECT_NOTE,
  hostCounts,
  hostDependencyEdges,
  hostSplitParts,
  isCountNit,
  isHostEdgeNit,
  isHostSplitNit,
  knownRisks,
  namesExampleRule,
  namesPlatformLimit,
  namesRequestSide,
  persistentDefect,
  REQUEST_NOTE,
  repeatedFacet,
  restrictsRequest,
  VERIFICATION_METHODS,
} from "./analysis-notes.js";
import { approvalDigest } from "./approval.js";
import { writeViaTemp } from "./atomic-write.js";
import { type CheckState, checkState, checksProgressed } from "./attempt-progress.js";
import {
  APPROVAL_REVIEWER,
  evaluateAutoApproval,
  hostBudgetGrowth,
  humanApprovalReason,
  plannerApprovalLimits,
  planScopeAdvice,
  policyDecisions,
  withoutApprovalRemarks,
} from "./auto-approval.js";
import { budgetUsage, grownCostCap, raiseToStartEstimate, reserveTokens } from "./budget.js";
import {
  type CandidateResult,
  type CandidateSelection,
  candidateCount,
  candidateModel,
  candidatesToJudge,
  changedLineCount,
  normalizedFingerprint,
  selectCandidate,
} from "./candidates.js";
import {
  fixerCommand,
  fixerTiers,
  isCodePath,
  isStaticCheck,
  isWholeUnitCheck,
  isWholeUnitFixer,
  isWholeUnitFormatter,
  styleClaimShown,
  taskCheckList,
  validateChecks,
  wholeUnitFixerCommand,
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
import {
  CONFLICT_DECISION_PREFIX,
  conflictDecisions,
  decidedFindingIds,
  declaredPlatformLimits,
  type PlatformLimit,
  recordConflictDecision,
  recordDeclaredLimits,
  settledConflicts,
} from "./conflict-decisions.js";
import { assertFrozenInputs, buildWorkflowContext } from "./context.js";
import { costToleranceOf, currentCostCap, inCostWrapUp } from "./cost-tolerance.js";
import { coverageFinding } from "./coverage.js";
import { type CriticCalibration, calibrateCritic, criticExamples } from "./critic-calibration.js";
import { crossPlatformNote } from "./cross-platform.js";
import { git } from "./delivery-git.js";
import { dependencyContracts } from "./dependencies.js";
import {
  DERIVATION_RETURN_NOTE,
  derivationAuditExtra,
  derivationAuditOn,
  derivationFindings,
  derivationProblems,
  isDerivationFinding,
} from "./derivation-audit.js";
import { EffectJournal, fileHash, intentRoot, rootField } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { describeChange, keepOutside, restoreOutside, unjournaledOutside } from "./fixer-scope.js";
import {
  FORK_SEED_ARTIFACT,
  FORK_SEEDED_ARTIFACT,
  type ForkSeed,
  seedBytes,
} from "./fork-stage.js";
import { outputTail } from "./gates.js";
import { criticalPathProblems } from "./initiatives/critical-path.js";
import {
  InitiativePlanSchema,
  MAX_FEATURES,
  MIN_FEATURES,
  planStructureProblems,
} from "./initiatives/plan.js";
import { featureWorkflowChoices } from "./initiatives/workflows.js";
import { changeReach, importedFiles, repairChangedFiles } from "./invalidation.js";
import {
  commandMayBeRunning,
  mutationLeaseFor,
  type WorkspaceLeases,
  withinWorkflow,
} from "./leases.js";
import {
  configuredMcpCall,
  fetchLibraryDocs,
  type LockedLibrary,
  lockedLibraries,
  type McpCall,
  taskLibraries,
} from "./library-docs.js";
import { MAX_CONCURRENT_TASK_CHECKS, planBatch, Semaphore, unifiedDiff } from "./parallel.js";
import {
  fileReferences,
  PLAN_CONSISTENCY_CHECKS,
  planConsistencyProblems,
  withCommandDependencies,
  withDerivedRequirements,
  withImplementationProfiles,
  withModuleDependencies,
  withReadDependencies,
  writesOnlyDocs,
} from "./plan-consistency.js";
import { ProcessScope } from "./process-scope.js";
import { type LearnedRule, rulesFor } from "./project-memory.js";
import {
  checkDependencies,
  dependencyClaim,
  PROPERTY_LIBRARY_PACKAGES,
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
import {
  HARDEN_PRESET,
  hardenNote,
  hardenPlanProblems,
  hardenTargets,
  QUALITY_MUTATION_BASELINE,
} from "./quality/harden.js";
import { isManifestPath, manifestDependencies } from "./quality/manifests.js";
import {
  DEFAULT_MUTATION_BUDGET_MS,
  generateMutants,
  greenSuiteMs,
  isTestCheck,
  MAX_EQUIVALENCE_CHECKS,
  MAX_MUTANTS,
  type Mutant,
  type MutationMode,
  type MutationResult,
  mutationClaim,
  mutationOf,
  presetOf,
  proposalFiles,
  proposedMutants,
  QUALITY_MUTATION,
  QUALITY_MUTATION_EQUIVALENCE,
  QUALITY_MUTATION_PENDING,
  QUALITY_MUTATION_PROPOSALS,
  runMutants,
  scoreMutants,
} from "./quality/mutation.js";
import {
  detectMutationTool,
  runMutationTool,
  type ToolShell,
  toolShellFiles,
} from "./quality/mutation-tools.js";
import {
  checkPropertyTests,
  libraryFiles,
  propertyClaim,
  propertyLibraries,
  propertyTestsNote,
  propertyTestsOf,
  QUALITY_PROPERTIES,
  QUALITY_PROPERTY_LIBRARIES,
} from "./quality/properties.js";
import type { RegistryFetch } from "./quality/registry.js";
import {
  type ChangedFile,
  checkQualityRules,
  QUALITY_BASELINE_FILES,
  QUALITY_RULES,
  type RuleFinding,
  ruleClaim,
  ruleClaimKey,
  ruleClaimText,
  ruleFindingKey,
} from "./quality/rules.js";
import { DEFAULT_SAST_CONFIG, QUALITY_SAST, runSast, sastClaim, sastOf } from "./quality/sast.js";
import { carriesOver, changedSince, previousRound } from "./re-review.js";
import { preloadTaskFiles } from "./read-outline.js";
import { recoverRun, requestRecovery, settleSupersededEffects } from "./recovery.js";
import { deliverableProblems, repairDeliverables, requestCoverage } from "./request-coverage.js";
import {
  type AccountRefusal,
  abortableDelay,
  accountRefusal,
  atStepCap,
  capEnded,
  endedOnProse,
  failedOwnEdits,
  isCapacityError,
  isInputTooLarge,
  isOutputLimit,
  isTransient,
  reportsLostTool,
  retryAfterMs,
  retryDelay,
  usageLimitReset,
} from "./retry.js";
import {
  buildReviewBundle,
  journaledBaseHashes,
  REVIEW_BUNDLE_PATH,
  taskChangedFiles,
} from "./review-bundle.js";
import {
  capturePreImage,
  createdByRunLineage,
  REFUSED_EDIT_PREFIX,
  readKept,
  runWrittenHash,
  UNFINISHED_BLOCK_PREFIX,
  uncommittedEdits,
} from "./rollback.js";
import {
  type AgentProfile,
  AnalysisSchema,
  type ApprovalReview,
  ApprovalReviewSchema,
  advisorySizeTarget,
  type Critique,
  CritiqueSchema,
  clarificationOf,
  DEFAULT_MAX_PARALLEL_RUNS,
  DEFAULT_REVIEW_MIN_CONFIDENCE,
  type Distinction,
  DistinctionSchema,
  executionModeOf,
  generatedPaths,
  ImplementationSchema,
  type InterruptCause,
  layoutCriteria,
  type MutantProposal,
  MutantProposalSchema,
  PlanSchema,
  PolicySchema,
  ProfileSchema,
  ReasonCode,
  RefutationSchema,
  ReportSchema,
  type Repro,
  ReproSchema,
  ResearchSchema,
  type Review,
  ReviewSchema,
  type RunPolicy,
  repairHostBoundCriteria,
  repairLayoutCriteria,
  type Spec,
  SpecSchema,
  specCoverageProblems,
  type TaskGraph,
  WorkflowSchema,
} from "./schemas.js";
import { specSizeNote, specSizeProblems } from "./spec-size.js";
import {
  repairUncoveredCriteria,
  UNCOVERED_SUBMISSIONS,
  uncoveredCriterion,
  uncoveredFindings,
  uncoveredSpecNote,
} from "./uncovered.js";

type Implementation = ReturnType<typeof ImplementationSchema.parse>;

import { browserLayoutProbe, type LayoutProbe, layoutVerdict } from "./layout-check.js";
import { planCostOf, planCostWarning } from "./plan-cost.js";
import { EDIT_TOOLS } from "./progress-watch.js";
import {
  applyRevision,
  MAX_PATCH_FINDINGS,
  RevisionSchema,
  type RevisionTarget,
  revisionNote,
} from "./revision-patch.js";
import {
  codeTaskCheckProblems,
  loopHistory,
  overCeilingOf,
  plannerSizing,
  rateHistory,
  type SizingReport,
  sizePlan,
  sizingHistory,
  splitNote,
  splitTestTasks,
  withTestDependencies,
} from "./sizing.js";
import {
  amendmentNote,
  analysisAmendmentOf,
  criterionAgainstRequirement,
  documentAmendmentOf,
  namesRunDocument,
  type SpecAmendment,
  specAmendmentOf,
} from "./spec-amendment.js";
import { digestsSpec, mayDigestSpec, READ_CRITERION, readCriterionTool } from "./spec-digest.js";
import { forgetProgress } from "./stall.js";
import type { AttemptUsageRecord } from "./step-budget.js";
import {
  type LeaseResource,
  newId,
  type RequestRow,
  type TaskRow,
  type WorkflowStore,
} from "./store.js";
import {
  documentsOnly,
  hasTaskGate,
  hostContentProblems,
  hostFileProblems,
  hostWritten,
  missingArtifactOwners,
  namesPath,
  pendingCodePaths,
  pendingOwners,
  pendingWriters,
  readyTasks,
  siblingCorrections,
  testUpdateOwners,
} from "./task-graph.js";
import {
  integrityFix,
  isTestPath,
  rewriteTargets,
  scanTestIntegrity,
  strengthenTargets,
  testChanges,
  testIntegrityOf,
  testWriteProblems,
} from "./test-integrity.js";
import {
  isTestTask,
  redProblem,
  testsDigest,
  testsFirstCriteria,
  testsFirstNote,
  testsFirstOf,
  testsFirstProblems,
  withTestsFirstOrder,
} from "./tests-first.js";
import { takeHashRefusals } from "./tool-policy.js";
import { transientSqliteError } from "./transient-sqlite.js";
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
  workspaceInventory,
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

/** Set by the test setup in CI: agent-call errors that block a run are printed with their stack (#1177). */
const TRACE_RUN_BLOCKS = process.env.BAKED_TRACE_RUN_BLOCKS === "1";

/** Severity of a review finding. */
type Severity = Review["findings"][number]["severity"];
/** The task worktree an advisory mutation gate runs in beside the review (#1147). */
const MUTATION_COPY = "quality-mutation";
const ALL_SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
const SERIOUS: readonly Severity[] = ["critical", "high"];

const NOT_LOW: readonly Severity[] = ["critical", "high", "medium"];

/**
 * The severities that start a correction. After the first repair or convergence round, medium and
 * low findings are recorded in the review artifact but no longer start another round: runs
 * de6cf1ab and 2fa658c0 spent their rounds on ever deeper medium findings while every check passed.
 * With the policy's `lowFindings: "note"` low findings are notes from the first round on: a low
 * README wording finding cost structpad 6d048155 663k tokens and an attempt cap stop (#1001).
 * A run winding up inside its cost tolerance band (`inCostWrapUp`) repairs only serious findings,
 * so the band pays for finishing the work rather than for polishing it (#1263).
 */
const repairSeverities = (
  run: {
    repair_rounds: number;
    review_rounds?: number;
    convergence_rounds: number;
  },
  policy: Pick<RunPolicy, "lowFindings">,
  wrapUp = false,
) =>
  wrapUp || run.repair_rounds + (run.review_rounds ?? 0) + run.convergence_rounds > 0
    ? SERIOUS
    : policy.lowFindings === "note"
      ? NOT_LOW
      : ALL_SEVERITIES;

/**
 * A finding the severity floor does not demote once the host reproduces it: it is based on the
 * spec and carries a repro. dirdrift-update 6b57dc61 completed with AC-005 failing because its
 * confirmed medium finding arrived after the first repair round (#801).
 */
const confirmableSpecFinding = (f: Review["findings"][number]): boolean =>
  (f.basis ?? "spec") === "spec" && f.repro !== undefined;

/** The task graph as the scheduler stores it: hashes are bound to the accepted spec and plan. */
function planGraph(
  spec: Spec,
  plan: { markdown: string; taskGraph: TaskGraph },
  policy: RunPolicy,
  profiles: AgentProfile[],
  stageProfile?: string,
): TaskGraph {
  const graph = withCommandDependencies(
    withReadDependencies(
      withModuleDependencies(
        withDerivedRequirements(spec, {
          ...withImplementationProfiles(
            withoutApprovalRemarks(plan.taskGraph),
            profiles,
            stageProfile,
          ),
          specHash: hashJson(spec),
          planHash: hashBytes(plan.markdown),
        }),
      ),
    ),
    spec,
  );
  // Tests first runs the test tasks before the code; otherwise a test task waits for its code.
  return withCoveringChecks(
    testsFirstOf(policy) === "off" ? withTestDependencies(graph) : withTestsFirstOrder(graph),
    policy,
  );
}

/** What the analyzer is told the host verified, including the dependency edges the host owns. */
function hostEdgesNote(graph: TaskGraph, spec?: Spec): string[] {
  const edges = hostDependencyEdges(graph, spec);
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
 * What the test-integrity guard reads as requirements: the request (its fenced examples
 * included), the spec and the plan. A literal any of them names is prescribed, not a test input:
 * the compact spec drops exact messages and directives a brief prescribes (#1284).
 */
function integrityRequirementText(state: RuntimeState): string {
  return [
    state.requestText || state.prompt,
    state.spec ? canonical(state.spec) : "",
    state.plan ?? "",
  ].join("\n");
}

/**
 * The request with the clarification answers a person gave. A bound or an exclusion a person
 * decided ("files up to 100 MiB") is stated, not invented by the spec author (#1413).
 */
function statedRequest(state: RuntimeState, requests: readonly RequestRow[]): string {
  const answers = requests
    .filter((r) => r.kind === "clarification" && r.status === "accepted" && r.actor === "user")
    // Only the answers: the decision's request id would add stray numbers.
    .map((r) =>
      canonical((JSON.parse(r.answer_json ?? "{}") as { answers?: unknown }).answers ?? ""),
    );
  return [state.requestText || state.prompt, ...answers].join("\n");
}

/**
 * The request a spec's deliverables are checked against. A feature of an initiative has its
 * boundary approved with the split, not the request, so it is checked against nothing.
 */
/** What a person does about a provider refusal before resuming the run. */
function refusalAdvice(refusal: AccountRefusal, error: unknown): string {
  if (refusal === "limit") {
    const reset = usageLimitReset(error);
    return `the provider account reached its usage limit${reset ? ` until ${reset}` : ""}; add credits or wait for the limit to reset, then resume the run`;
  }
  if (refusal === "credits")
    return "the provider account has no credits or quota left; add credits, then resume the run";
  if (refusal === "key")
    return "the provider rejected the API key; fix the key, then resume the run";
  return "the provider's CLI is not installed or not where PATH says (an app update may have moved it); install it, fix PATH or set BAKED_CODEX_PATH or BAKED_CLAUDE_CODE_PATH, then resume the run";
}
const coverageRequest = (state: RuntimeState): string =>
  state.hostDependencies ? "" : state.requestText;
/** Records that the planner was given the scope advice in this run. */
const SCOPE_ADVICE = "plan-repairs/scope-advice.json";
/** The planner's accepted plan that a revision by patch edits (#1058). */
const PLAN_BASE = "revisions/base/plan.json";
/** A corrective task's finding files before its first attempt, under `tasks/<id>/` (#1517). */
const FINDING_FILES = "finding-files.json";
/** Largest finding file kept for the comment-only comparison. */
const FINDING_FILE_MAX = 1_000_000;
/** A file's text, or null when it is missing, unreadable or larger than `FINDING_FILE_MAX`. */
function readText(path: string): string | null {
  try {
    return statSync(path).size <= FINDING_FILE_MAX ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}
/** How often rejected approvals may send one run back to revise before a rejection only pauses it. */
const MAX_REJECTION_REVISIONS = 3;
const REJECTION_NOTE =
  "A person rejected the approval of the previous spec and plan with this explanation. Revise the spec, the plan and the tasks so they follow it; where it contradicts an assumption, the explanation wins.";
/** A provider asking to wait longer than this is not waited for once a route has fallback models. */
const LONG_RETRY_AFTER_MS = 30_000;
/** Immediate retries, each at one effort step lower, after a response ran past the output cap (#1479). */
const OUTPUT_LIMIT_RETRIES = 2;
/** How often a driving process writes the run's active time to the run row (#1038). */
export const ACTIVE_FLUSH_MS = 1_000;

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
  const named = failingFilesInOutput(checked.output, tasks);
  return named.some((path) => task.writes.some((w) => w.path === path)) ? [] : named;
}
/** A SQLite failure is a host fault, never a model's invalid output. */
function isStoreError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof WorkflowFault) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === "SQLiteError" || (typeof code === "string" && code.startsWith("SQLITE_"));
}
/** The start of the restart reason for an edit of the task's own file that did not apply. */
const EDIT_RETRY = "an edit of its own file did not apply";
/** Lines of a failed check's output a restarted or resumed session gets (#1516). */
const FAILED_CHECK_LINES = 30;
/** The start of the restart reason for a wrong claim of no edit tool (#1516). */
const LOST_TOOL_CLAIM = "its worker reported that it had no edit tool";
const CHECK_FAILURE = /fail|error|violation|assert|does not pass|not passing/i;
const CHECK_KIND =
  /test|lint|ruff|eslint|biome|clippy|flake8|mypy|pyright|tsc|typecheck|type check/i;
/** A linter rule code such as Ruff's ISC004 or ESLint-style E501: naming one reports a violation. */
const RULE_CODE = /\b[A-Z]{1,4}\d{3,4}\b/;
/**
 * A task that changed its files and reports, as unresolved, only failing tests or lint findings in
 * those files has done its work: the failures go to a corrective task like a failed task check,
 * instead of a rejection that restarts the task and blocks the run when the second attempt reports
 * the same (#1110, keeplint T004: two attempts, 592k tokens, two failing tests of its own).
 */
export function ownCheckFailures(
  task: Task,
  result: { taskId: string; outcome: string; unresolved: string[] },
  changed: string[],
): boolean {
  if (result.taskId !== task.id || result.outcome !== "implemented" || !changed.length)
    return false;
  if (!result.unresolved.length || result.unresolved.length > 5) return false;
  return result.unresolved.every(
    (item) => (CHECK_FAILURE.test(item) && CHECK_KIND.test(item)) || RULE_CODE.test(item),
  );
}
const incompleteReason = (unresolved: string[]): string =>
  unresolved.length ? `: ${unresolved.slice(0, 3).join("; ").slice(0, 500)}` : "";
/** Why a result that changed nothing was not accepted (#972: the message had no detail). */
const correctionReason = (correction: true | string | WorkflowFault): string =>
  typeof correction === "string" && correction ? `: ${correction}` : "";
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
/** Characters of each test file the tests-first approval shows. */
const MAX_TEST_CHARS = 20_000;
/** Files above this size are not scanned by the test-integrity guard. */
const MAX_INTEGRITY_BYTES = 1024 * 1024;
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
/**
 * Model steps of one review attempt; one that ends unsubmitted gets one retry with 1.5 times as
 * many, the reviewers' former cap. The host runs the README examples, so a review reads the
 * patch, tries a few repros and submits (#750: an 11-step attempt cost 236k tokens).
 */
const REVIEW_ATTEMPT_STEPS = 16;
/** Errors of the task-end check one submission gets back; the checks stage reports the rest. */
const TASK_END_ERRORS = 20;

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
  /** The layout measurement of `layoutCheck` (#1262); Playwright when unset. Tests inject a fake. */
  layoutProbe: LayoutProbe | undefined;
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
  /** Re-arms the active-time deadline after the policy's cap changed; set while a run is driven. */
  private rearmDeadline: () => void = () => {};
  /**
   * Requests for a person raised by the current step. They become durable only together with the
   * state they were raised on (see `flushWaits`), so a decision never sees a request whose state
   * is not saved yet, and a later save never overwrites what the decision wrote.
   */
  private queued: QueuedRequest[] = [];
  /** Frozen routing records by run; `null` for runs started before routing was recorded. */
  private routing = new Map<string, RoutingRecord | null>();
  /** How a `libraryDocs` MCP source is called; tests replace it. */
  mcpCall: McpCall = (server, tool, args) =>
    configuredMcpCall(this.store.workspace, server, tool, args);
  /** Best-of-N candidate steps that run on a model of `candidateModels` instead of their route. */
  private stepModels = new Map<string, string>();
  /** Advisory mutation gates running beside the review in a copy of the run (#1147), by run. */
  private backgroundMutations = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
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
    let idleFrom: number | null = null;
    const arm = () =>
      setTimeout(
        () => controller.abort(new WorkflowFault("BUDGET_EXHAUSTED", "Active deadline exhausted")),
        Math.max(1, policy.maxActiveMs - activeBefore - (performance.now() - started - idleMs)),
      );
    let timeout = arm();
    this.rearmDeadline = () => {
      clearTimeout(timeout);
      timeout = arm();
    };
    // A wait stage sleeps between polls; that time is not active time.
    this.idle = async <T>(sleep: () => Promise<T>): Promise<T> => {
      clearTimeout(timeout);
      const from = performance.now();
      idleFrom = from;
      try {
        return await sleep();
      } finally {
        idleFrom = null;
        idleMs += performance.now() - from;
        timeout = arm();
      }
    };
    // The run row keeps the active time as it accrues, so a process that dies loses at most the
    // last interval of it, not everything since the drive started (#1038).
    let recorded = 0;
    // After a laptop sleep the first write can fail with a transient SQLite I/O or busy error; it
    // ran in a timer, so it killed the command with an uncaught exception (bench round 32, #1313).
    // The write is tried once more, and an interval still unrecorded goes with the next flush.
    const recordActive = (): void => {
      const now = performance.now();
      const idle = idleMs + (idleFrom === null ? 0 : now - idleFrom);
      const add = Math.ceil(now - started - idle - recorded);
      if (add <= 0) return;
      for (let tries = 2; tries > 0; tries--) {
        try {
          this.store.transaction(() => this.store.addActiveTime(runId, add));
          recorded += add;
          return;
        } catch (error) {
          if (!transientSqliteError(error)) throw error;
        }
      }
    };
    const flush = setInterval(recordActive, ACTIVE_FLUSH_MS);
    // Management commands from another process must stop this owner before the next effect.
    const poll = setInterval(() => {
      try {
        if (["paused", "cancelled"].includes(this.store.run(runId).status))
          controller.abort(new Error("Run management command"));
      } catch (error) {
        // A throw from a timer ends the process; after a sleep the next tick reads it (#1410).
        if (!transientSqliteError(error)) controller.abort(error);
      }
    }, 100);
    let stepId: string | null = null;
    this.queued = [];
    try {
      if (!recoverRun(this.store, this.journal, runId)) return;
      if (executionModeOf(policy) === "worktree") await ensureRunWorktree(this.store, runId);
      this.restoreMutatedFiles(runId);
      this.store.transaction(() => this.store.transition(runId, "running"));
      await this.seedFork(runId, policy, signal);
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
              await this.settleMutation(runId, false);
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
              await this.settleMutation(runId, false);
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
              // An oversized spec goes back once; the author's second submission stands (#1013).
              let sizeAdvised = false;
              // Without a browser gate the host settles a layout criterion itself (#1247).
              const layoutRepair = {
                browser: !!v2 && acceptanceGrants(v2.gates).some((g) => g.driver === "browser"),
                measured: !!policy.layoutCheck,
              };
              const hostRepairs = (spec: Spec): Spec =>
                repairLayoutCriteria(repairHostBoundCriteria(spec).spec, layoutRepair).spec;
              const validateSpec = (output: unknown): string[] => {
                const parsed = SpecSchema.safeParse(output);
                if (!parsed.success) return [];
                const questions = parsed.data.openQuestions;
                const size = sizeAdvised
                  ? []
                  : specSizeProblems(parsed.data, state.requestText || state.prompt);
                if (size.length) sizeAdvised = true;
                // The host makes a host-bound criterion checkable itself (#1015).
                return [
                  ...size,
                  ...specCoverageProblems(hostRepairs(parsed.data), policy.checks, {
                    request: statedRequest(state, this.store.requests(runId)),
                  }),
                  // The host maps a deliverable the spec names elsewhere itself (#1037).
                  ...deliverableProblems(
                    repairDeliverables(parsed.data, coverageRequest(state)).spec,
                    coverageRequest(state),
                  ),
                  ...assumeProblems(
                    policy,
                    questions,
                    (_, index) => questions[index]?.question ?? "",
                  ),
                ];
              };
              const author = this.requireProfile(profile);
              const patched = await this.patchRevision(
                runId,
                stepId,
                state,
                policy,
                author,
                "spec",
                state.spec,
                (artifact) => {
                  const parsed = SpecSchema.safeParse(artifact);
                  return parsed.success ? validateSpec(parsed.data) : [parsed.error.message];
                },
                signal,
              );
              state.spec = SpecSchema.parse(
                patched ??
                  (await this.call(
                    runId,
                    stepId,
                    state,
                    policy,
                    author,
                    {
                      featureId: run.feature_id,
                      workspaceFacts: this.recordFacts(runId, runRoot(this.store.workspace, state)),
                    },
                    signal,
                    undefined,
                    0,
                    validateSpec,
                  )),
              );
              const repair = repairHostBoundCriteria(state.spec);
              if (repair.repaired.length) {
                const added = repair.spec.criteria
                  .slice(state.spec.criteria.length)
                  .map((c) => c.id);
                state.spec = repair.spec;
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "diagnostic",
                    "spec-repairs/host-bound.json",
                    canonical({ postRelease: repair.repaired, added }),
                  ),
                );
              }
              const layout = repairLayoutCriteria(state.spec, layoutRepair);
              if (layout.repaired.length) {
                const added = layout.spec.criteria
                  .slice(state.spec.criteria.length)
                  .map((c) => c.id);
                state.spec = layout.spec;
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "diagnostic",
                    "spec-repairs/layout.json",
                    canonical(
                      layout.method === "manual"
                        ? { measured: layout.repaired }
                        : { postRelease: layout.repaired, added },
                    ),
                  ),
                );
              }
              const mapped = repairDeliverables(state.spec, coverageRequest(state));
              if (mapped.repaired.length) {
                state.spec = mapped.spec;
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "diagnostic",
                    "spec-repairs/deliverables.json",
                    canonical({ mapped: mapped.repaired }),
                  ),
                );
              }
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
              // Scope advice is given once per run, not once per plan generation: a plan that
              // keeps the writes is approved by a person, and a later generation that is told
              // again only submits the same plan twice (#1111).
              let scopeAdvised = this.store.latestArtifact(runId, SCOPE_ADVICE) !== null;
              // A criterion left uncovered again by a plan that names it is one the planner cannot
              // cover; it stops being a submission error and goes back to the spec (#780).
              const uncoveredSubmissions = new Map<string, number>();
              const cannotCover = new Set<string>();
              // The planner sees package errors at submission and can correct them in place.
              const validatePlan = (output: unknown): string[] => {
                const parsed = PlanSchema.safeParse(output);
                if (!parsed.success) return [parsed.error.message];
                // The host lists a criterion on the task that implements its requirement (#1037).
                const submitted = repairUncoveredCriteria(spec, parsed.data).plan;
                const problems = [
                  ...this.planProblems(runId, spec, submitted, policy, profiles),
                  ...codeTaskCheckProblems(submitted.taskGraph, policy),
                  ...hostContentProblems(submitted.taskGraph),
                  ...hostFileProblems(submitted.taskGraph, state.hostFiles),
                  ...testWriteProblems(submitted.taskGraph, policy),
                  ...testsFirstProblems(spec, submitted.taskGraph, policy),
                ];
                const open = problems.filter((problem) => {
                  const id = uncoveredCriterion(problem);
                  if (!id) return true;
                  const count = (uncoveredSubmissions.get(id) ?? 0) + 1;
                  uncoveredSubmissions.set(id, count);
                  if (count >= UNCOVERED_SUBMISSIONS && parsed.data.markdown.includes(id))
                    cannotCover.add(id);
                  return !cannotCover.has(id);
                });
                if (scopeAdvised) return open;
                const advice = planScopeAdvice(
                  policy,
                  parsed.data.taskGraph,
                  (path) => existsSync(join(runRoot(this.store.workspace, state), path)),
                  this.baselineScaffold(runId, state),
                  state.requestText || state.prompt,
                );
                if (advice.length) {
                  scopeAdvised = true;
                  this.store.transaction(() =>
                    this.store.artifact(runId, "diagnostic", SCOPE_ADVICE, canonical({ advice })),
                  );
                }
                return [...open, ...advice];
              };
              const patchedPlan = await this.patchRevision(
                runId,
                stepId,
                state,
                policy,
                planner,
                "plan",
                this.planBase(runId),
                validatePlan,
                signal,
              );
              const submittedPlan = PlanSchema.parse(
                patchedPlan ??
                  (await this.call(
                    runId,
                    stepId,
                    state,
                    policy,
                    planner,
                    {
                      checks: policy.checks,
                      // The approval reviewer decides approvals; no task can be assigned to it.
                      profiles: profiles.filter((p) => p.output !== "approval-review"),
                      workspaceFacts: this.recordFacts(runId, runRoot(this.store.workspace, state)),
                      ...(approvalLimits ? { approvalLimits } : {}),
                      ...(state.hostFiles?.length
                        ? {
                            hostFiles: {
                              files: state.hostFiles,
                              note: "The split fixed the whole content of these files. Write all of them in one task of their own whose writes carry exactly this content (the host writes them with no agent), and let later tasks modify them.",
                            },
                          }
                        : {}),
                      ...(testsFirstOf(policy) !== "off"
                        ? {
                            testsFirst: testsFirstNote(
                              testsFirstOf(policy),
                              testsFirstCriteria(spec, testsFirstOf(policy)),
                            ),
                          }
                        : {}),
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
                    validatePlan,
                    scope ? { maxSteps: scope.maxSteps, maxTokens: scope.maxTokens } : undefined,
                  )),
              );
              // The plan a later revision by patch starts from (#1058): the planner's own, before
              // the host adds edges and splits tasks.
              if (policy.revision === "patch")
                this.store.transaction(() =>
                  this.store.artifact(runId, "plan", PLAN_BASE, canonical(submittedPlan)),
                );
              const listed = repairUncoveredCriteria(spec, submittedPlan);
              const plan = listed.plan;
              if (listed.repaired.length)
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "diagnostic",
                    "plan-repairs/uncovered.json",
                    canonical({ listed: listed.repaired }),
                  ),
                );
              state.plan = plan.markdown;
              const problems = this.planProblems(runId, spec, plan, policy, profiles);
              const uncovered = problems.map(uncoveredCriterion);
              if (
                problems.length &&
                uncovered.every((id): id is string => id !== null && cannotCover.has(id))
              ) {
                const ids = [...new Set(uncovered)] as string[];
                const stages = this.stageKinds(runId, v2);
                const specify = stages.findIndex((s) => s.kind === "specify");
                // The spec author gets the planner's reason once; a criterion it keeps goes to a person.
                if (
                  specify >= 0 &&
                  ids.some((id) => !state.uncoveredReturned.includes(id)) &&
                  this.moveTo(state, stages, specify, v2)
                ) {
                  state.uncoveredReturned.push(
                    ...ids.filter((id) => !state.uncoveredReturned.includes(id)),
                  );
                  state.prompt += `\n${uncoveredSpecNote(spec, ids, plan.markdown)}`;
                  advance = false;
                  rerouted = v2 !== null;
                  break;
                }
                this.wait("clarification", state, {
                  findings: uncoveredFindings(spec, ids, plan.markdown),
                });
                advance = false;
                break;
              }
              if (problems.length)
                throw new WorkflowFault("INVALID_REFERENCE", problems.join("\n"));
              const planned = planGraph(spec, plan, policy, profiles, this.tasksProfile(runId));
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
              // A patch answers the findings of one analysis; the next analysis judges the result.
              state.pendingPatch = null;
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
              const audit = derivationAuditOn(policy) ? derivationAuditExtra(spec) : null;
              const analysis = AnalysisSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  {
                    verifiedByRuntime: hostEdgesNote(graph, spec),
                    workspaceFacts: this.recordFacts(runId, runRoot(this.store.workspace, state)),
                    hostCounts: hostCounts(graph),
                    ...(state.analysisRaised.length
                      ? { earlierFindings: state.analysisRaised }
                      : {}),
                    ...(Object.keys(hostSplitParts(graph)).length
                      ? { hostSplit: hostSplitParts(graph) }
                      : {}),
                    ...(audit ? { derivationAudit: audit } : {}),
                  },
                  signal,
                  undefined,
                  0,
                  (output) => {
                    const parsed = AnalysisSchema.safeParse(output);
                    return parsed.success
                      ? [
                          ...deferredBlockingProblems(
                            parsed.data.findings,
                            (_, index) => parsed.data.findings[index]?.description ?? "",
                          ),
                          ...(audit ? derivationProblems(spec, parsed.data) : []),
                        ]
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
              // The spec schema has three verification methods; a finding that asks for another one
              // cannot be satisfied by the spec author, so it is a note (#1065).
              for (const finding of analysis.findings) {
                if (finding.blocking && asksUnsupportedMethod(finding.description)) {
                  finding.blocking = false;
                  finding.description = `Asks for a verification method the spec schema does not have (only ${VERIFICATION_METHODS.join(", ")}; automated covers the reviewer reading a file); kept as a note: ${finding.description}`;
                }
              }
              // The host adds some dependsOn edges after planning; plan.md cannot mention them and the
              // planner cannot remove them, so a finding about them is a note.
              const hostEdges = hostDependencyEdges(graph, spec);
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
              // The host raises the rows the audit could not reproduce; the model does not (#1465).
              if (audit)
                findings = [
                  ...findings.filter((f) => !isDerivationFinding(f)),
                  ...derivationFindings(spec, analysis),
                ];
              // Analysis passes when no finding blocks: the rest are notes, whatever the model's verdict.
              const blocking = findings.some((f) => f.blocking);
              state.analysisPassed = !blocking && analysis.verdict !== "inconclusive";
              // What earlier passes raised, before this pass adds to it (#1209).
              const earlierRaised = [...state.analysisRaised];
              // The next pass sees what this one raised, whichever way the run goes on.
              for (const { kind, refs, description } of findings.filter((f) => f.blocking))
                if (!state.analysisRaised.some((f) => f.description === description))
                  state.analysisRaised.push({ kind, refs, description });
              const planOnly = state.analysisPassed ? [] : planOnlyFindings(findings);
              const stages = this.stageKinds(runId, v2);
              const plan = stages.findIndex((s) => s.kind === "plan");
              // Every blocking finding repeats one a person already answered: the planner kept
              // what the answer ruled out, because a built-in profile rule seemed to outrank it
              // (pgnvet 3f03497b asked the same finding four times, about 1.2M tokens). Each such
              // finding goes back once with the answer as binding before the person is asked again.
              const answered = state.analysisPassed
                ? []
                : findings
                    .filter((f) => f.blocking)
                    .map((f) => ({ finding: f, earlier: answeredFinding(state, f) }));
              if (
                answered.length &&
                answered.every(({ earlier }) => earlier && !earlier.rerouted)
              ) {
                const asking = v2
                  ? stages.findIndex((s) => s.id === v2.stage.id)
                  : state.stageIndex;
                const target = clarificationResumeIndex(stages, asking, {
                  findings: answered.map(({ finding }) => finding),
                });
                if (target !== asking && this.moveTo(state, stages, target, v2)) {
                  for (const { earlier } of answered) if (earlier) earlier.rerouted = true;
                  const back = stages[target]?.kind;
                  if (back === "specify" || back === "plan")
                    this.pendPatch(
                      state,
                      policy,
                      answered.map(({ finding }) => finding),
                      back === "specify" ? ["spec", "plan"] : ["plan"],
                    );
                  state.prompt += `\n${ANSWERED_NOTE}\n${canonical(
                    answered.map(({ finding, earlier }) => ({
                      kind: finding.kind,
                      refs: finding.refs,
                      description: finding.description,
                      answer: earlier?.answer,
                    })),
                  )}`;
                  advance = false;
                  rerouted = v2 !== null;
                  break;
                }
              }
              // A criterion row the requirements do not give goes back to the spec author once,
              // whatever the clarification policy: the requirements settle it (#1465).
              const derived = state.analysisPassed
                ? []
                : findings.filter((f) => f.blocking && isDerivationFinding(f));
              const specify = stages.findIndex((s) => s.kind === "specify");
              if (
                derived.length &&
                state.derivationReturns === 0 &&
                specify >= 0 &&
                this.moveTo(state, stages, specify, v2)
              ) {
                state.derivationReturns = 1;
                this.pendPatch(state, policy, derived, ["spec", "plan"]);
                state.prompt += `\n${DERIVATION_RETURN_NOTE}\n${canonical(derived.map(({ kind, refs, description }) => ({ kind, refs, description })))}`;
                advance = false;
                rerouted = v2 !== null;
                break;
              }
              if (planOnly.length && state.analysisReplans === 0 && plan >= 0) {
                if (this.moveTo(state, stages, plan, v2)) {
                  // Gaps in the plan text go back to the planner once before a person is asked.
                  state.analysisReplans = 1;
                  this.pendPatch(state, policy, planOnly, ["plan"]);
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
              // A scope finding that adds a restriction or a requirement absent from the request gets
              // the same extra return with the instruction that the request is authoritative; a
              // survivor is assumed.
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
                  const back = stages[target]?.kind;
                  if (back === "specify" || back === "plan")
                    this.pendPatch(
                      state,
                      policy,
                      blockingFindings,
                      back === "specify" ? ["spec", "plan"] : ["plan"],
                    );
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
                findings.every(
                  (f) =>
                    !f.blocking ||
                    assumable(f) ||
                    restrictsRequest(f) ||
                    repeatedFacet(f, earlierRaised),
                )
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
                // A spec finding the request settles is an amendment, so review does not raise
                // it against spec.json again after implement (#1120).
                this.store.transaction(() =>
                  this.amendFromAnalysis(
                    runId,
                    state,
                    assumed.filter((f) => restrictsRequest(f)),
                  ),
                );
                findings = findings.map((f) =>
                  f.blocking
                    ? {
                        ...f,
                        blocking: false,
                        description: `${repeatedFacet(f, earlierRaised) ? "Assumed under clarification assume with the first alternative the finding offers, as another facet of a defect an earlier pass raised" : "Assumed under clarification assume"} (assumptions/analysis.json): ${f.description}`,
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
                // Before approval, so the person sees a required check that already fails (#934).
                await this.recordCheckBaseline(runId, state, policy, signal);
                const baselineFailures = this.baselineFailingChecks(runId, policy);
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
                          manifestRequest: state.requestText || state.prompt,
                          hostSplitTasks: state.hostSplitTasks,
                          scaffold: this.baselineScaffold(runId, state),
                          hostGrowthTokens: hostBudgetGrowth(
                            this.store.artifacts(runId),
                            (artifact) => this.store.readArtifact(runId, artifact.id),
                          ),
                          policyRevisions: {
                            artifacts: this.store.artifacts(runId),
                            read: (artifact) => this.store.readArtifact(runId, artifact.id),
                          },
                          exists: (path) =>
                            existsSync(join(runRoot(this.store.workspace, state), path)),
                        },
                      );
                // A package that leaves the limits only by its size or paths may go to the
                // approval reviewer (`autoApproval.modelReview`). It fails closed: any error or
                // an answer other than a low-risk approve leaves the request with a person.
                let review: { review: ApprovalReview } | { reviewError: string } | null = null;
                if (!auto.approval && auto.reviewable && auto.limitsHash) {
                  review = await this.reviewApproval(
                    runId,
                    stepId,
                    state,
                    policy,
                    profiles,
                    auto.reasons,
                    signal,
                  );
                  if (
                    "review" in review &&
                    review.review.verdict === "approve" &&
                    review.review.risk === "low"
                  )
                    auto.approval = {
                      mode: "model-review",
                      limitsHash: auto.limitsHash,
                      review: review.review,
                    };
                }
                const body = {
                  manifest: state.manifest,
                  writes,
                  executionMode: executionModeOf(policy),
                  ...(policy.sandbox ? { sandbox: policy.sandbox } : {}),
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
                  ...(state.activeTime ? { activeTime: state.activeTime } : {}),
                  // A plan priced above the ceiling, in tokens (#974) or dollars (#1503), is
                  // approved knowing where it should stop; planning so far next to what the tasks
                  // should cost (#1019).
                  ...this.approvalCost(runId, policy),
                  ...(state.spec.deliverables
                    ? { requestCoverage: requestCoverage(state.spec, coverageRequest(state)) }
                    : {}),
                  boundedCorrection: true,
                  ...(baselineFailures.length ? { baselineFailures } : {}),
                  // Granted walk-through capabilities are shown to the person; the frozen gates
                  // that hold them are part of the manifest the digest covers.
                  ...(v2 && acceptanceGrants(v2.gates).length
                    ? { acceptanceCapabilities: acceptanceGrants(v2.gates) }
                    : {}),
                  // A run the host gave no auto approval says why first, also at a human stage (#1467).
                  ...(policy.autoApproval || human || state.autoApprovalDeclined
                    ? {
                        autoApproval: auto.approval ?? {
                          declined: [
                            ...(state.autoApprovalDeclined ? [state.autoApprovalDeclined] : []),
                            ...(policy.autoApproval || human ? auto.reasons : []),
                          ],
                          ...(review ?? {}),
                        },
                      }
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
              if ((policy.maxConcurrentWriters > 1 || candidateCount(policy) > 1) && state.worktree)
                await this.implementParallel(runId, stepId, state, policy, profiles, signal);
              else await this.implement(runId, stepId, state, policy, profiles, signal);
              // A task that reported a spec conflict waits for a person's answer.
              if (this.queued.length) advance = false;
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
              const failed = [
                ...(v2
                  ? await this.runCheckStage(runId, stepId, state, policy, v2, signal)
                  : await this.runChecks(runId, stepId, state, policy, signal)),
                ...this.runIntegrityFailures(runId, state, policy),
              ];
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
              // With the review rounds used up and every required check green, findings below
              // high are known limitations rather than a no_progress stop: stmtsplit-update
              // cae4291d and cfgtrace a657dc4d ended blocked on one low or medium finding (#1157).
              if (
                failures.length &&
                reviewLimitAccepts(
                  this.store.run(runId).review_rounds ?? 0,
                  policy,
                  failures,
                  requiredChecksPass(this.store, runId, state, policy),
                )
              )
                this.store.transaction(() =>
                  acceptResidual(this.store, runId, state, { findings: failures }, "review"),
                );
              else if (
                failures.length &&
                (await this.reversedFixes(runId, state, policy, failures, signal))
              )
                this.store.transaction(() =>
                  acceptResidual(this.store, runId, state, { findings: failures }, "assume"),
                );
              else if (failures.length) {
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
                  {
                    initiativeBounds: { minFeatures: MIN_FEATURES, maxFeatures: MAX_FEATURES },
                    featureWorkflows: featureWorkflowChoices(this.store.workspace, policy, {
                      tiered: false,
                    }).map((w) => ({ id: w.id, description: w.description, spec: w.contract })),
                  },
                  signal,
                  undefined,
                  0,
                  // Graph defects go back to the decomposer; the size bound is the initiative's
                  // decision, so an oversized split is kept and refused there with a reason.
                  (output) => {
                    const parsed = InitiativePlanSchema.safeParse(output);
                    return parsed.success
                      ? [
                          ...planStructureProblems(parsed.data),
                          ...(policy.criticalPath === "split"
                            ? criticalPathProblems(parsed.data, state.requestText || state.prompt)
                            : []),
                        ]
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
              // The walker tries a correctness claim with the run's own runner, as the review
              // dimensions do: a static claim it cannot show starts no correction (#930).
              const auditor = this.requireProfile(profile);
              const executables = reproExecutables(policy.checks);
              const canRepro = executables.length > 0 && auditor.allowedTools.includes("run_repro");
              const converged = state.snapshotId;
              const touched = this.runChangedPaths(runId, state);
              const repro = (r: Repro, file?: string | null) =>
                runRepro(this.processes, r, {
                  root: runRoot(this.store.workspace, state),
                  executables,
                  generated: generatedPaths(policy),
                  signal,
                  sandbox: runSandbox(policy, runRoot(this.store.workspace, state), {
                    gitWrite: Boolean(state.worktree),
                  }),
                  shadows: file ? [file, ...touched] : touched,
                });
              const previous = state.convergence ?? undefined;
              const minConfidence = policy.reviewMinConfidence ?? DEFAULT_REVIEW_MIN_CONFIDENCE;
              let reproAdvised = false;
              let failAdvised = false;
              const review = ReviewSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  auditor,
                  {
                    evidence: this.evidenceContext(runId, state),
                    ...(canRepro
                      ? { reproTool: { name: "run_repro", programs: executables } }
                      : {}),
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
                    if (!parsed.success || !state.spec || !converged) return [];
                    const problems = reviewProblems(
                      this.store,
                      runId,
                      converged,
                      state.workspaceHash ?? "",
                      state.spec,
                      output as Review,
                      false,
                    );
                    if (problems.length) return problems;
                    // Each advice is given once: a walker that keeps its answer is not blocked.
                    const advice: string[] = [];
                    const unnamed = failAdvised ? [] : unnamedFailures(output as Review);
                    if (unnamed.length) {
                      failAdvised = true;
                      advice.push(unnamedFailureAdvice(unnamed));
                    }
                    if (!reproAdvised && canRepro) {
                      const missing = [
                        ...missingReproAdvice(output as Review, executables, previous),
                        ...unconfidentReproAdvice(output as Review, minConfidence),
                      ];
                      if (missing.length) reproAdvised = true;
                      advice.push(...missing);
                    }
                    return advice;
                  },
                  undefined,
                  canRepro ? () => ({ run_repro: reproTool(executables, repro) }) : undefined,
                ),
              );
              carryNoRepro(review, previous);
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
              // A criterion the walker still fails without a finding after the advice gets one from
              // the walker's own explanation, so it is repaired; it ended mdtoc-update 20f81464
              // invalid_output with every check green (#1143).
              const unnamed = unnamedFailures(review);
              let reportEvidence: string | null = null;
              const coverageEvidence = (): string => {
                if (reportEvidence) return reportEvidence;
                const report = this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "review",
                    `coverage/${newId()}.json`,
                    canonical(review),
                  ),
                );
                reportEvidence = this.store.transaction(() =>
                  this.store.addEvidence(runId, "review", state.snapshotId ?? "", report.id),
                );
                return reportEvidence;
              };
              for (const id of unnamed) {
                const item = review.coverage.find((c) => c.criterionId === id);
                const criterion = state.spec.criteria.find((c) => c.id === id);
                review.findings.push({
                  id: newId(),
                  kind: "contradicts",
                  severity: "high",
                  requirementIds: criterion?.requirementIds ?? [],
                  criterionIds: [id],
                  file: null,
                  symbol: null,
                  evidenceIds: item?.evidenceIds.length ? item.evidenceIds : [coverageEvidence()],
                  claim: item?.explanation || `Criterion ${id} fails`,
                  impact: `Criterion ${id} fails, so acceptance cannot be established`,
                  suggestedFix: `Make ${id} pass within approved task scope and repeat checks.`,
                });
              }
              if (unnamed.length) review.verdict = "changes_requested";
              if (omitted.length) {
                const evidenceId = coverageEvidence();
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
              // A formatting or lint claim passes only on a check that shows it (#1480).
              const results = this.store.checks(runId);
              const passedChecks = policy.checks.filter((check) => {
                const last = results
                  .filter((c) => c.check_id === check.id && c.snapshot_id === state.snapshotId)
                  .at(-1);
                return last?.status === "passed" && last.validity === "current";
              });
              for (const item of review.coverage) {
                const text = state.spec.criteria.find((c) => c.id === item.criterionId)?.then;
                if (
                  item.verdict !== "pass" ||
                  !text ||
                  styleClaimShown(text, passedChecks) !== false
                )
                  continue;
                item.verdict = "inconclusive";
                item.explanation = `${STYLE_UNSHOWN} (passing checks: ${passedChecks.map((c) => c.id).join(", ") || "none"}). ${item.explanation}`;
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
              const severities = repairSeverities(
                this.store.run(runId),
                policy,
                inCostWrapUp(this.store, runId, policy),
              );
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
              // Below high severity, a correctness claim the host does not reproduce, and any claim
              // its repro refutes, is a note: cfgtrace2 e88a14dd spent about 1.1M on two corrective
              // tasks for static medium claims the walker could not run (#930).
              // A claim kept a note only for its confidence repairs when its repro shows it (#1210).
              const outcomes = new Map<string, ReproOutcome>();
              for (const finding of review.findings)
                if (
                  (convergenceReproGated(finding) || confidenceOnlyNote(finding, minConfidence)) &&
                  finding.repro &&
                  executables.length
                )
                  outcomes.set(finding.id, await repro(finding.repro, finding.file));
              const blocks = (f: Review["findings"][number]): boolean =>
                findingBlocks(
                  f,
                  minConfidence,
                  confidenceOnlyNote(f, minConfidence) &&
                    outcomes.get(f.id)?.status === "reproduced",
                );
              if (outcomes.size)
                this.store.transaction(() =>
                  this.store.artifact(
                    runId,
                    "repro",
                    `convergence/repro-${newId()}.json`,
                    canonical({ outcomes: Object.fromEntries(outcomes) }),
                  ),
                );
              const unreproduced = new Set(
                canRepro
                  ? review.findings
                      .filter(
                        (f) =>
                          convergenceReproGated(f) &&
                          !notes.has(f.id) &&
                          !reproAllows(f, outcomes.get(f.id)?.status, true),
                      )
                      .map((f) => f.id)
                  : [],
              );
              const noteOnly = (id: string): boolean => {
                const named = review.findings.filter((f) => f.criterionIds.includes(id));
                return (
                  named.length > 0 && named.every((f) => notes.has(f.id) || unreproduced.has(f.id))
                );
              };
              const repairing = (f: Review["findings"][number]): boolean =>
                (severities.includes(f.severity) && blocks(f)) ||
                f.criterionIds.some((id) => failing.has(id));
              // Both are taken while `failing` still holds the criteria they explain: the loop below
              // drops a criterion only these findings name, and an unreproduced claim that was the
              // only one naming an inconclusive criterion then left it unlimited, so acceptance
              // threw after all the work was done (lockorder 6487b225, #1225).
              const noted = review.findings.filter((f) => notes.has(f.id) && repairing(f));
              // An unreproduced claim that would have repaired is a known limitation, so the criterion
              // it fails is accepted with it and the run report names the claim.
              const unshown = review.findings.filter((f) => unreproduced.has(f.id) && repairing(f));
              for (const id of [...failing]) if (noteOnly(id)) failing.delete(id);
              if (noted.length) {
                const recorded = this.recordFindings(runId, review, noted);
                this.store.transaction(() =>
                  acceptResidual(this.store, runId, state, { findings: recorded }, "notes"),
                );
              }
              if (unshown.length) {
                const recorded = this.recordFindings(runId, review, unshown);
                this.store.transaction(() =>
                  acceptResidual(this.store, runId, state, { findings: recorded }, "repro"),
                );
              }
              // Below the severity floor a finding still repairs when it is why a criterion fails:
              // acceptance needs every automated criterion to pass.
              const repair = review.findings.filter(
                (f) =>
                  !notes.has(f.id) &&
                  !unreproduced.has(f.id) &&
                  ((severities.includes(f.severity) && blocks(f)) ||
                    f.criterionIds.some((id) => failing.has(id))),
              );
              const findings = this.recordFindings(runId, review, repair);
              const kept = new Set([...repair, ...noted, ...unshown].map((f) => f.id));
              addReviewNotes(
                state.reviewNotes,
                "convergence",
                state.snapshotId,
                review.findings
                  .filter((f) => !kept.has(f.id))
                  .map((finding) => ({
                    finding,
                    reason: unreproduced.has(finding.id)
                      ? "repro"
                      : noteReason(finding, severities, policy.reviewMinConfidence),
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
                // A criterion the person could not confirm is a known limitation, not a new
                // request with the same question (#1273).
                const limited = limitedCriteria(state);
                const unanswered = () =>
                  state.spec?.criteria.filter(
                    (c) =>
                      c.method === "manual" &&
                      !limited.has(c.id) &&
                      state.manualCriteria[c.id]?.snapshotId !== state.snapshotId,
                  ) ?? [];
                const measured = await this.measureLayout(
                  runId,
                  state,
                  policy,
                  unanswered(),
                  signal,
                );
                const pending = unanswered();
                if (pending.length) {
                  for (const criterion of pending)
                    this.wait("manual_evidence", state, {
                      criterionId: criterion.id,
                      snapshotId: state.snapshotId,
                      criterion,
                      ...(measured?.criteria.includes(criterion.id)
                        ? { layoutCheck: measured.record }
                        : {}),
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
              this.repair(
                runId,
                state,
                policy,
                repairFindings.findings,
                repairFindings.kind,
                stage.kind === "review" ? "review" : "round",
              );
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
        const diagnostic = this.store.artifact(
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
        // A task that ended unfinished after its restart (#1516): the service resumes it once.
        if (fault instanceof WorkflowFault && typeof fault.details.unfinishedTask === "string")
          this.store.artifact(
            runId,
            "recovery",
            `${UNFINISHED_BLOCK_PREFIX}${diagnostic.id}.json`,
            canonical({ taskId: fault.details.unfinishedTask }),
          );
        // An attempt stopped by repeated hash refusals: the file stays as it is until someone
        // decides, so a plain resume would only be refused again (#1269). Named after the
        // diagnostic of this stop.
        if (
          fault instanceof WorkflowFault &&
          fault.code === "INPUT_CHANGED" &&
          typeof fault.details.refusals === "number" &&
          typeof fault.details.path === "string"
        )
          this.store.artifact(
            runId,
            "recovery",
            `${REFUSED_EDIT_PREFIX}${diagnostic.id}.json`,
            canonical({
              path: fault.details.path,
              root: fault.details.root ?? "",
              hash: fault.details.hash ?? null,
            }),
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
      clearInterval(flush);
      clearTimeout(timeout);
      this.idle = (sleep) => sleep();
      this.rearmDeadline = () => {};
      outerSignal.removeEventListener("abort", abort);
      leaseSignal.removeEventListener("abort", leaseLost);
      // A run that waits keeps its gate's result; one that stopped or failed will change the code.
      await this.settleMutation(
        runId,
        !["waiting", "completed"].includes(this.store.run(runId).status),
      );
      await this.processes.stop();
      try {
        recordActive();
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
    const record = this.capContinuable(runId, state, stepId, task);
    if (!record) return false;
    state.taskContinuations[task.id] = 1;
    state.taskBudgets[task.id] = Math.ceil(record.maxTokens * 1.5);
    state.taskSteps[task.id] = Math.ceil(record.maxSteps * 1.5);
    return true;
  }
  /**
   * Whether a task whose attempt was cut off continues with the output of a required check it
   * fails (#1329). md-site 11b11f19 (bench round 33): corrective T013 hit its token cap after 14
   * steps, edited a test after its last request_check and submitted a complete result; the test
   * expected `.md` where the spec says `.html`, the check failed after the attempt, a sibling
   * inherited the failing test and the run stopped `no_progress`. When the attempt was finalized
   * by its token or step cap or the progress watcher after an edit it did not check, the host runs
   * the task's required checks before the result is accepted; a failure sends the task back once
   * as a continuation at the cap, with the failing output, instead of opening a finding.
   */
  private async cutOffCheckFailures(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    stepId: string,
    task: Task,
    changed: string[],
    signal: AbortSignal,
    root: string,
    run: (check: Check) => Promise<WorkerCheck["checked"]>,
  ): Promise<boolean> {
    if (!changed.length || (state.taskContinuations[task.id] ?? 0) > 0) return false;
    if (this.testsPending(state, policy) && isTestTask(task)) return false;
    const record = this.lastAttemptUsage(runId, stepId);
    if (!record || !record.finalizedBy || !editedAfterLastCheck(record)) return false;
    const failed: { id: string; output: string }[] = [];
    for (const check of this.gatedChecks(runId, state, policy, task, root, changed)) {
      if (!check.required) continue;
      signal.throwIfAborted();
      const checked = await run(check);
      if (checked.status !== "failed") continue;
      let output = (checked.output ?? "").slice(-4000);
      // A failing test that runs another check of the project shows only its exit code: the
      // continuation gets that check's own output too.
      const tests = checked.output ? failingTestNames(checked.output) : [];
      const spawned = policy.checks.find(
        (c) => c.id !== check.id && tests.some((name) => namesCheckCommand(name, c)),
      );
      if (spawned) {
        const ran = await run(spawned);
        if (ran.status === "failed" && ran.output?.trim())
          output = `${output}\n\nThe failing test runs the project's ${spawned.id} check (${[spawned.executable, ...spawned.args].join(" ")}); run on its own it fails with:\n${ran.output.trim().slice(-SPAWNED_OUTPUT_CHARS)}`;
      }
      failed.push({ id: check.id, output });
    }
    if (!failed.length) return false;
    this.store.transaction(() => {
      state.taskContinuations[task.id] = 1;
      state.taskBudgets[task.id] = Math.ceil(record.maxTokens * 1.5);
      state.taskSteps[task.id] = Math.ceil(record.maxSteps * 1.5);
      this.store.artifact(
        runId,
        "recovery",
        `tasks/${task.id}/cut-off-checks.json`,
        canonical({
          taskId: task.id,
          stepId,
          finalizedBy: record.finalizedBy,
          reason: "cut_off",
          failed,
        }),
      );
      this.store.saveState(runId, state);
    });
    return true;
  }
  /** Whether a planned task is in its continuation after its tests-written check failed (#1518). */
  private writtenTestsContinuation(runId: string, state: RuntimeState, task: Task): boolean {
    if ((state.taskContinuations[task.id] ?? 0) === 0) return false;
    const artifact = this.store.latestArtifact(runId, `tasks/${task.id}/cut-off-checks.json`);
    return (
      artifact !== null &&
      (JSON.parse(this.store.readArtifact(runId, artifact.id)) as { reason?: string }).reason ===
        "written_tests"
    );
  }
  /** The required checks a task failed after an attempt was cut off (#1329), for its continuation. */
  private cutOffChecks(
    runId: string,
    taskId: string,
  ): { cutOffChecks?: { failed: { id: string; output: string }[]; note: string } } {
    const artifact = this.store.latestArtifact(runId, `tasks/${taskId}/cut-off-checks.json`);
    if (!artifact) return {};
    const record = JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
      failed: { id: string; output: string }[];
      reason?: "cut_off" | "correction" | "written_tests";
    };
    return {
      cutOffChecks: {
        failed: record.failed,
        note:
          record.reason === "written_tests"
            ? "This task's earlier attempt submitted, and these required checks then failed on the files it wrote, with this output. Find the cause: a test whose expectation contradicts the spec, a test too slow for the check's limit, or a defect in code this task writes. Fix it within this task's files, run the check with request_check, then submit. When the test is right and the defect is in code another task owns, keep the test as the spec requires and submit without unresolved items: the host then opens a correction of that code."
            : record.reason === "correction"
              ? "This correction's earlier attempt submitted, and these required checks then failed on its files, with this output. The failure is part of this correction: find its cause in what the earlier attempt changed (a test that contradicts the spec is a cause too), fix it, run the check with request_check, then submit."
              : "An earlier attempt of this task reached its limit after edits it did not check, and these required checks failed on its files, with this output. Fix what fails, run the check with request_check, then submit.",
      },
    };
  }
  /** The usage record of a step's latest attempt when its task may still continue at the cap. */
  private capContinuable(
    runId: string,
    state: RuntimeState,
    stepId: string,
    task: Task,
  ): AttemptUsageRecord | undefined {
    if ((state.taskContinuations[task.id] ?? 0) > 0) return undefined;
    const record = this.lastAttemptUsage(runId, stepId);
    // An attempt the progress watcher stopped was stuck, not short of room. One whose last step
    // went past the cap before the final submit could be forced ended at the cap all the same
    // (cfgtrace T016: an edit applied, 426,324 tokens of a 426,324 cap, the run stopped; #1070).
    if (
      !record ||
      record.finalizedBy === "watcher" ||
      (record.finalizedBy === null && record.stopReason !== "tokens")
    )
      return undefined;
    return record;
  }
  /**
   * The result of an implementer attempt that used its token or step cap without submitting
   * (#1056, #1478: fpbits T010 used 20 of 20 steps at 37% of its token cap, its last edit broke the
   * syntax gate and no step was left to repair it). The
   * forced final submit needs room an attempt ending exactly at the cap may not have, so the same
   * attempt either restarted its task or stopped the run (bench round 20: 3 of 9 runs). When the
   * task may still continue at the cap and the attempt changed files, it is a blocked result, so
   * the task continues on its edits like a capped attempt that submitted, and the other tasks of
   * its batch are integrated. Otherwise the fault stops the run as before.
   */
  private async capEndResult(
    runId: string,
    state: RuntimeState,
    stepId: string,
    task: Task,
    fault: WorkflowFault,
    currentPaths: () => Promise<string[]>,
  ): Promise<Implementation> {
    if (
      (!this.capContinuable(runId, state, stepId, task) &&
        !this.progressShown(runId, state, stepId, task)) ||
      !(await currentPaths()).length
    )
      throw fault;
    return {
      schemaVersion: 1,
      taskId: task.id,
      outcome: "blocked",
      summary: fault.message.slice(0, 15000),
      evidenceIds: [],
      unresolved: [
        atStepCap(fault)
          ? "The attempt used its steps before a result was accepted; the next attempt continues from its edits."
          : "The attempt used its token cap before it submitted a result; the next attempt continues from its edits.",
      ],
    };
  }
  /**
   * The last result of each check run in each step of a task, oldest step first, with the
   * failure count and first failure of a failed one.
   */
  private taskCheckStates(runId: string, taskId: string): Map<string, Map<string, CheckState>> {
    const byStep = new Map<string, Map<string, CheckState>>();
    for (const row of this.store.taskCheckRuns(runId, taskId)) {
      if (row.status !== "passed" && row.status !== "failed") continue;
      let output = "";
      try {
        output = String(
          (JSON.parse(this.store.readArtifact(runId, row.artifact_id)) as { output?: unknown })
            .output ?? "",
        );
      } catch {}
      const checks = byStep.get(row.step_id) ?? new Map<string, CheckState>();
      checks.set(row.check_id, checkState(row.status, output));
      byStep.set(row.step_id, checks);
    }
    return byStep;
  }
  /**
   * The check states of a task's current attempt and of the latest earlier attempt that ran
   * checks, when the task used its continuation and its restart, has no progress attempt yet, and
   * its failing checks moved between the two (#1351). md-site 4b08acf6 (bench round 35): T006 used
   * its continuation and its restart, then its third attempt ended at the cap after 6
   * edit-then-check rounds and the run stopped `attempt_cap` with nothing for a person to decide.
   */
  private progressShown(
    runId: string,
    state: RuntimeState,
    stepId: string,
    task: Task,
  ): { previous: Record<string, CheckState>; current: Record<string, CheckState> } | null {
    if (
      (state.taskContinuations[task.id] ?? 0) === 0 ||
      (state.taskRestarts[task.id] ?? 0) === 0 ||
      (state.taskProgressAttempts[task.id] ?? 0) > 0
    )
      return null;
    // An attempt the progress watcher stopped was stuck, not short of room.
    if (this.lastAttemptUsage(runId, stepId)?.finalizedBy === "watcher") return null;
    const steps = this.taskCheckStates(runId, task.id);
    const current = steps.get(stepId);
    const earlier = [...steps].filter(([id]) => id !== stepId).at(-1)?.[1];
    if (!current || !earlier || !checksProgressed(earlier, current)) return null;
    return { previous: Object.fromEntries(earlier), current: Object.fromEntries(current) };
  }
  /** Grants the progress attempt `progressShown` allows, recording what moved. */
  private progressAttempt(runId: string, state: RuntimeState, stepId: string, task: Task): boolean {
    const shown = this.progressShown(runId, state, stepId, task);
    if (!shown) return false;
    this.store.transaction(() => {
      state.taskProgressAttempts[task.id] = 1;
      this.store.artifact(
        runId,
        "recovery",
        `tasks/progress-attempts/${task.id}.json`,
        canonical({ taskId: task.id, stepId, ...shown }),
      );
      this.store.saveState(runId, state);
    });
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
    reproduced: string | null = null,
  ): string | null {
    const failedEdits = failedOwnEdits(result, task.writes);
    const editRetry = failedEdits.length
      ? `${EDIT_RETRY}: ${failedEdits.join(", ")}; the next attempt starts from the edits that applied`
      : null;
    if ((state.taskRestarts[task.id] ?? 0) > 0)
      return (state.taskEditRetries[task.id] ?? 0) === 0 ? editRetry : null;
    // A fresh session gets the repro output once; the attempt's own refusals did not move it.
    if (reproduced) return `the host refused its result because ${reproduced}`;
    const unfinished =
      ["blocked", "failed"].includes(result.outcome) || result.unresolved.length > 0;
    if (!unfinished) return null;
    // The host's own record that the session ended on text; the worker's wording is not consulted.
    if (proseEnd) return "its session ended on a text reply and never submitted a result";
    if (changed.length === 0 && reportsLostTool(result))
      return "a tool was unavailable to its worker, which submitted no change";
    // A claim of no edit tool from a session that edited (#1516, md-site T002: "exposes no BAKED
    // edit_file or multi_edit tool" after two edit_file calls) is wrong, and the next session is told.
    if (reportsLostTool(result))
      return `${LOST_TOOL_CLAIM}, although it edited ${changed.join(", ")} with them: this session has edit_file and multi_edit too; call them to finish the change`;
    const usage = this.lastAttemptUsage(runId, stepId);
    if (
      changed.length === 0 &&
      usage?.stopReason === "no_submission" &&
      usage.steps.reduce((sum, step) => sum + step.toolCalls, 0) === 0
    )
      return "its session made no tool call and submitted no result, so it had no working tools";
    if (policy.clarification !== "assume") return editRetry;
    return `the worker ended ${result.outcome === "implemented" ? "unfinished" : result.outcome} under clarification assume`;
  }
  /**
   * Unresolved items of an implemented result that only report a missed size target ("543 lines,
   * exceeding the approximate 400-line target") do not leave it unfinished: they move to its summary
   * for the reviewers and to `tasks/size-targets/<task>.json`, and the task's checks still decide
   * it. Without this the items made it unfinished and the restart trimmed lines it could not
   * count (#1282). A blocked or failed result stays as it is. Every task result passes here, so
   * the platform limits a finished one declares are recorded as settled here too (#1536).
   */
  private settleSizeTargets<
    T extends {
      outcome: string;
      summary: string;
      unresolved: string[];
      platformLimits?: PlatformLimit[] | undefined;
    },
  >(runId: string, taskId: string, result: T): T {
    recordDeclaredLimits(this.store, runId, taskId, declaredPlatformLimits(result));
    if (result.outcome !== "implemented" || !result.unresolved.length) return result;
    const advisory = result.unresolved.filter(advisorySizeTarget);
    if (!advisory.length) return result;
    this.store.artifact(
      runId,
      "recovery",
      `tasks/size-targets/${taskId}.json`,
      canonical({ taskId, advisory }),
    );
    return {
      ...result,
      summary: `${result.summary}\nAdvisory size targets not met (not blocking): ${advisory.join("; ")}`,
      unresolved: result.unresolved.filter((item) => !advisory.includes(item)),
    };
  }
  /**
   * The earlier findings of the run on the symbol this correction's findings name, when a
   * correction already fixed them: the symbol is being patched one finding at a time, so this
   * correction rewrites it for its whole input class against every finding's repro (#1330).
   */
  private recurringContext(runId: string, task: Task): Record<string, unknown> {
    const earlier = recurringFindings(this.store, runId, task);
    // The same-file findings gate submit beside the recurring ones (`reproCheck`), so the worker
    // gets both lists (#1423).
    const siblings = this.siblingContext(runId, task);
    if (!earlier.length) return siblings;
    return {
      ...siblings,
      recurringFindings: {
        symbols: [...new Set(earlier.map((f) => f.symbol))],
        earlier: earlier.map((f) => ({
          id: f.id,
          claim: f.claim,
          ...(f.repro ? { repro: f.repro } : {}),
        })),
        note: "Earlier corrections of this run already patched these symbols for the findings listed here, and the findings this task corrects are the next case of the same input. Do not add another special case: rewrite the symbol for its whole input class. First state the input grammar or contract it must handle (for a parser: tokenize code spans, links and delimiters first, then interpret them; no placeholder substitution), then rewrite it, and add table-driven tests with one row per finding here and per finding this task corrects. The host runs the repro of every listed finding before it accepts submit_result, and run_repro runs them too.",
      },
    };
  }
  /**
   * The earlier corrected findings in the file this correction's findings name, on other symbols:
   * the review is finding the neighbouring cases of one construct one round at a time, so this
   * correction covers the construct's sibling contexts in one go (#1397).
   */
  private siblingContext(runId: string, task: Task): Record<string, unknown> {
    const earlier = sameFileFindings(this.store, runId, task);
    if (!earlier.length) return {};
    return {
      siblingFindings: {
        files: [...new Set(earlier.map((f) => f.file))],
        earlier: earlier.map((f) => ({
          id: f.id,
          claim: f.claim,
          ...(f.repro ? { repro: f.repro } : {}),
        })),
        note: "Earlier corrections of this run already fixed these findings in the same file, and a review found the case this task corrects only afterwards. Do not fix only the reported case: name the construct it is about (for example multiline inline code, or emphasis next to a code span), list every context the construct can appear in (inside a blockquote, a list item, a heading or a table cell, nested in another construct, next to a line that looks like a block marker), make it work in each, and add one table-driven test with a row per context. The host runs the repro of every finding listed here before it accepts submit_result.",
      },
    };
  }
  /** The worker's own account of the attempt a restart replaces, for the fresh session's prompt. */
  private previousAttempt(
    runId: string,
    taskId: string,
  ): {
    previousAttempt?: {
      summary: string;
      unresolved: string[];
      failedChecks?: { id: string; output: string }[];
      restartReason?: string;
      note: string;
    };
  } {
    const artifact = this.store.latestArtifact(runId, `tasks/restarts/${taskId}.json`);
    if (!artifact) return {};
    const record = JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
      summary?: string;
      unresolved?: string[];
      failedChecks?: { id: string; output: string }[];
      reason?: string;
    };
    if (!record.summary && !record.unresolved?.length && !record.failedChecks?.length) return {};
    return {
      previousAttempt: {
        summary: record.summary ?? "",
        unresolved: record.unresolved ?? [],
        ...(record.failedChecks?.length ? { failedChecks: record.failedChecks } : {}),
        // Why the host restarted it, when that corrects the earlier session (#1516: a claim of no
        // edit tool from a session that edited).
        ...(record.reason?.startsWith(LOST_TOOL_CLAIM) ? { restartReason: record.reason } : {}),
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
        hostWritten(task) ||
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
   * Before the approval of an update run, runs each feature check once on the code the run starts
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
    const scaffold = this.baselineScaffold(runId, state);
    // On a scaffold only the required checks run, to learn which already fail (#934).
    const feature = policy.checks.filter(
      (check) => check.scope === "feature" && (!scaffold || check.required),
    );
    if (!feature.length) return;
    const fresh = this.store.tasks(runId).every((task) => task.status === "pending");
    const counts: Record<string, BaselineCount[]> = {};
    // The errors a whole-unit check already reports, so the task-end check does not feed them back.
    const diagnostics: Record<string, string[]> = {};
    // The output of each required check that fails before any change, by command key.
    const failures: Record<string, string> = {};
    // The diagnostics of each failing static check, for `staticBaseline: "relative"` (#1222).
    const debt: Record<string, string[]> = {};
    if (fresh)
      for (const check of feature) {
        const root = runRoot(this.store.workspace, state);
        const result = await this.checks.measure(
          check,
          signal,
          root,
          runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
        );
        if (result.status === "failed" && check.required && !result.truncated)
          failures[commandKey(check)] = failureSignature(result.output, root);
        if (
          policy.staticBaseline === "relative" &&
          result.status === "failed" &&
          check.required &&
          isStaticCheck(check) &&
          !isTestCheck(check)
        ) {
          const keys = baselineKeys(result.output, root);
          if (keys.length) debt[commandKey(check)] = keys;
        }
        if (scaffold) continue;
        if (result.status === "failed" && isWholeUnitCheck(check))
          diagnostics[commandKey(check)] = baselineKeys(result.output, root);
        if (result.truncated || result.status === "inconclusive") continue;
        const found = outputCounts(result.output, result.status === "passed");
        if (found.length) counts[commandKey(check)] = found;
      }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "facts",
        CHECK_BASELINE_PATH,
        canonical({
          schemaVersion: 1,
          measured: fresh,
          counts,
          diagnostics,
          failures,
          ...(Object.keys(debt).length ? { debt } : {}),
        }),
      ),
    );
  }
  /**
   * Stops the run when a required check fails exactly as it did before any change (#934): the
   * plan changes nothing the failure depends on (md-site 00ae0ac0: `vite build` of a Bun CLI
   * with no index.html), so a corrective task could only spend attempts on it.
   */
  private assertNotBaselineFailure(
    runId: string,
    state: RuntimeState,
    check: Check,
    output: string,
    evidenceId: string,
  ): void {
    if (!this.failsAsBaseline(runId, state, check, output)) return;
    throw new WorkflowFault(
      "RECOVERY_REQUIRED",
      `baseline_failure: required check ${check.id} failed before any change and fails the same way now (evidence ${evidenceId}); nothing the run changed affects it. Fix the check or the project setup, or revise the plan, then resume.`,
      { reason: "no_progress", checkId: check.id },
    );
  }
  /**
   * The baseline debt a failing required static check reports under `staticBaseline: "relative"`
   * (#1222): its diagnostics were all there before the run and none is in a file a task of the
   * plan writes. Recorded as an artifact when found; null when the check fails as usual.
   */
  private staticDebt(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy | undefined,
    check: Check,
    output: string,
    evidenceId: string,
  ): string[] | null {
    if (policy?.staticBaseline !== "relative" || !isStaticCheck(check) || isTestCheck(check))
      return null;
    const artifact = this.store.latestArtifact(runId, CHECK_BASELINE_PATH);
    if (!artifact) return null;
    const baseline = (
      JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
        debt?: Record<string, string[]>;
      }
    ).debt?.[commandKey(check)];
    if (!baseline?.length) return null;
    const changed = ((state.rootGraph ?? state.graph)?.tasks ?? []).flatMap((t) =>
      t.writes.map((w) => w.path),
    );
    const debt = baselineDebt(output, runRoot(this.store.workspace, state), {
      baseline,
      changed,
      summary: diagnosticCount(output)?.count ?? null,
    });
    if (!debt) return null;
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        `checks/baseline-debt/${check.id}-${newId()}.json`,
        canonical({ checkId: check.id, evidenceId, debt }),
      ),
    );
    return debt;
  }
  /**
   * Whether the review findings left after the last review round only reverse earlier fixes
   * (#1234), so another correction would undo one of them. expenses-py 617fef26: the repair of
   * F004 (an unterminated quote swallowed the valid rows after it) made F005 (a valid multiline
   * field with a record-shaped line is split); both repros cannot pass, and the run blocked
   * `no_progress` after a round that could not succeed. Under `clarification: assume`, with every
   * required check passing and no critical finding, each finding must sit where a correction of
   * an earlier finding changed the code, and that earlier finding's repro must no longer
   * reproduce: its fix holds and the new finding is the other side of the trade-off. The pair is
   * recorded in `review/reversals-<round>.json`, and the findings become known limitations.
   */
  private async reversedFixes(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    findings: Review["findings"],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      clarificationOf(policy) !== "assume" ||
      (this.store.run(runId).review_rounds ?? 0) < policy.maxRepairRounds ||
      findings.some((f) => f.severity === "critical") ||
      !requiredChecksPass(this.store, runId, state, policy)
    )
      return false;
    const candidates = reversalCandidates(this.store, runId, findings);
    if (candidates.some((c) => !c.earlier.length)) return false;
    const root = runRoot(this.store.workspace, state);
    const executables = reproExecutables(policy.checks);
    const pairs: { findingId: string; earlierId: string; earlierClaim: string }[] = [];
    for (const candidate of candidates) {
      let held: { id: string; claim: string } | undefined;
      for (const earlier of candidate.earlier) {
        const repro = ReproSchema.safeParse(earlier.body.repro);
        if (!repro.success) continue;
        const outcome = await runRepro(this.processes, repro.data, {
          root,
          executables,
          generated: generatedPaths(policy),
          signal,
          sandbox: runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
        });
        if (outcome.status === "refuted") {
          held = { id: earlier.id, claim: earlier.body.claim ?? "" };
          break;
        }
      }
      if (!held) return false;
      pairs.push({ findingId: candidate.findingId, earlierId: held.id, earlierClaim: held.claim });
    }
    const round = this.store.run(runId).review_rounds ?? 0;
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        `review/reversals-${String(round)}.json`,
        canonical({ round, pairs }),
      ),
    );
    return true;
  }
  /** Whether a required check fails exactly as it did before any change (#934). */
  /**
   * Settles the pending manual layout criteria with the policy's `layoutCheck` (#1262): the host
   * serves the app, measures each page in a headless browser and records the result as the
   * criterion's evidence on the current snapshot. A pass answers the criterion as a person's
   * evidence would; a failure or a missing browser leaves it to the person, with the record.
   */
  private async measureLayout(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    pending: Spec["criteria"],
    signal: AbortSignal,
  ): Promise<{ criteria: string[]; record: unknown } | null> {
    const check = policy.layoutCheck;
    const snapshotId = state.snapshotId;
    const ids = layoutCriteria({ criteria: pending });
    if (!check || !snapshotId || !ids.length) return null;
    const result = await (this.layoutProbe ?? browserLayoutProbe).measure(
      runRoot(this.store.workspace, state),
      check,
      signal,
    );
    const verdict = layoutVerdict(result);
    const { screenshot, ...measurement } =
      result.status === "measured" ? result : { ...result, screenshot: undefined };
    const record = { criteria: ids, ...verdict, measurement };
    this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "diagnostic",
        `layout/${snapshotId}.json`,
        canonical(record),
      );
      if (screenshot)
        this.store.artifact(runId, "diagnostic", `layout/${snapshotId}.png.b64`, screenshot);
      if (!verdict.passed) return;
      const evidenceId = this.store.addEvidence(runId, "command", snapshotId, artifact.id);
      for (const id of ids) state.manualCriteria[id] = { evidenceId, snapshotId };
    });
    return { criteria: ids, record };
  }
  private failsAsBaseline(
    runId: string,
    state: RuntimeState,
    check: Check,
    output: string,
  ): boolean {
    const artifact = this.store.latestArtifact(runId, CHECK_BASELINE_PATH);
    if (!artifact) return false;
    const before = (
      JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
        failures?: Record<string, string>;
      }
    ).failures?.[commandKey(check)];
    // A failure without output tells nothing about its cause, so it is never matched.
    return !!before && before === failureSignature(output, runRoot(this.store.workspace, state));
  }
  /** The IDs of the required checks that failed before any change, from the check baseline. */
  private baselineFailingChecks(runId: string, policy: RunPolicy): string[] {
    const artifact = this.store.latestArtifact(runId, CHECK_BASELINE_PATH);
    if (!artifact) return [];
    const failures =
      (
        JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
          failures?: Record<string, string>;
        }
      ).failures ?? {};
    return policy.checks
      .filter((check) => check.required && commandKey(check) in failures)
      .map((check) => check.id);
  }
  /** The diagnostics each whole-unit check reported before the run, by command key. */
  private baselineDiagnostics(runId: string): Record<string, string[]> {
    const artifact = this.store.latestArtifact(runId, CHECK_BASELINE_PATH);
    return artifact
      ? ((
          JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
            diagnostics?: Record<string, string[]>;
          }
        ).diagnostics ?? {})
      : {};
  }
  /**
   * Attribution of a `request_check` run of a whole-unit check the task names but that runs in
   * the checks stage (#799): the planner lists `cargo fmt` or clippy on the tasks of a
   * skeleton-first Rust plan, and in the task's directory they fail on the modules that later
   * tasks write (bench round 12, mdrefs: T004 spent 1.87M against checks that could not pass).
   * The implementer gets the errors in its own files, as for the task-end check.
   */
  private attributeCheck(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
  ): (check: Check, output: string) => string[] | null {
    const perTask = new Set(taskChecks(policy, task).map((c) => c.id));
    return (check, output) => {
      if (perTask.has(check.id) || !isWholeUnitCheck(check)) return null;
      return taskErrors(output, {
        written: writtenCodePaths(task),
        pending: pendingCodePaths(
          state.rootGraph ?? state.graph,
          this.store.tasks(runId),
          state.taskGates,
          task,
        ),
        baseline: this.baselineDiagnostics(runId)[commandKey(check)] ?? [],
      });
    };
  }
  /**
   * The task-end whole-unit check of a task that writes code (#673): the run's feature-scope type
   * checks, run once in the task's directory, keeping the errors in the task's own files that
   * neither the baseline nor a pending sibling task explains. Advisory: the checks stage still
   * runs these checks on the integrated change.
   */
  private taskEndCheck(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
  ): ((root: string, signal: AbortSignal) => Promise<string[]>) | undefined {
    // A formatter reports no type errors to keep, so it would only cost a run (#842).
    const checks = policy.checks.filter(
      (c) => c.scope === "feature" && isWholeUnitCheck(c) && !isWholeUnitFormatter(c),
    );
    const written = writtenCodePaths(task);
    if (!checks.length || !written.length) return undefined;
    return async (root, signal) => {
      const baseline = this.baselineDiagnostics(runId);
      const pending = pendingCodePaths(
        state.rootGraph ?? state.graph,
        this.store.tasks(runId),
        state.taskGates,
        task,
      );
      const errors: string[] = [];
      const results: { checkId: string; status: string; errors: string[] }[] = [];
      for (const check of checks) {
        const result = await this.checks.measure(
          check,
          signal,
          root,
          runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
        );
        const found =
          result.status === "failed"
            ? taskErrors(result.output, {
                written,
                pending,
                baseline: baseline[commandKey(check)] ?? [],
              })
            : [];
        results.push({ checkId: check.id, status: result.status, errors: found });
        errors.push(...found.map((line) => `${check.id}: ${line}`));
      }
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "diagnostic",
          `tasks/${task.id}/task-end-check-${newId()}.json`,
          canonical({ taskId: task.id, pending, results }),
        ),
      );
      return errors.slice(0, TASK_END_ERRORS);
    };
  }
  /**
   * The files a corrective task's findings name, as they were before its first attempt (#1517),
   * so its repro check can tell a correction that changed only comments and docstrings.
   */
  private recordFindingFiles(runId: string, task: Task, root: string): void {
    if (task.origin === "planned" || !task.findingIds.length) return;
    const path = `tasks/${task.id}/${FINDING_FILES}`;
    if (this.store.latestArtifact(runId, path)) return;
    if (uncommittedEdits(this.store, runId, task.id).length) return;
    const files: Record<string, string> = {};
    for (const finding of this.store.findings(runId)) {
      if (!task.findingIds.includes(finding.id)) continue;
      const file = (JSON.parse(finding.body_json) as { file?: unknown }).file;
      if (typeof file !== "string" || file in files || codeWithoutComments(file, "") === null)
        continue;
      const text = readText(workspacePath(root, file));
      if (text !== null) files[file] = text;
    }
    if (!Object.keys(files).length) return;
    this.store.transaction(() =>
      this.store.artifact(runId, "diagnostic", path, canonical({ taskId: task.id, files })),
    );
  }
  /** The files `recordFindingFiles` kept for a task, by path; empty when it kept none. */
  private findingFiles(runId: string, task: Task): Record<string, string> {
    const row = this.store.latestArtifact(runId, `tasks/${task.id}/${FINDING_FILES}`);
    if (!row) return {};
    const body = JSON.parse(this.store.readArtifact(runId, row.id)) as {
      files?: Record<string, string>;
    };
    return body.files ?? {};
  }
  /**
   * The repro check of a corrective task (#1158): runs the repro of each finding the task corrects
   * in `root` and describes the ones that still show the reported behavior. stmtsplit-update
   * T007 and T008 closed a reproduced finding as already_satisfied twice (546k tokens) while its
   * repro still reproduced. Undefined when no finding of the task has a repro the run can start.
   */
  private reproCheck(
    runId: string,
    policy: RunPolicy,
    task: Task,
  ): ((root: string, signal: AbortSignal) => Promise<string[]>) | undefined {
    if (task.origin === "planned" || !task.findingIds.length) return undefined;
    const executables = reproExecutables(policy.checks);
    // The repros of earlier findings on the same symbol are a regression set: a rewrite that
    // fixes this finding must not bring one of them back (#1330).
    const regression = new Set(
      [
        ...recurringFindings(this.store, runId, task),
        ...sameFileFindings(this.store, runId, task),
      ].map((f) => f.id),
    );
    // A finding a person's spec conflict answer decided is no longer the gate (#1350).
    const decided = decidedFindingIds(this.store, runId);
    const repros = this.store
      .findings(runId)
      .filter((f) => task.findingIds.includes(f.id) || regression.has(f.id))
      .filter((f) => !decided.has(f.id))
      .flatMap((f) => {
        const body = JSON.parse(f.body_json) as { repro?: unknown; file?: unknown };
        const repro = ReproSchema.safeParse(body.repro);
        // A document finding's repro that runs code shows the claim but no edit of the document
        // can change it (#1375).
        return repro.success &&
          executables.includes(repro.data.executable) &&
          !reproCannotSeeCorrection(typeof body.file === "string" ? body.file : null, repro.data)
          ? [{ findingId: f.id, repro: repro.data, file: body.file }]
          : [];
      });
    const before = this.findingFiles(runId, task);
    // A repro that runs a copy of the file the task fixes cannot see the fix (#1348).
    const writes = task.writes.map((w) => w.path);
    if (!repros.length) return undefined;
    return async (root, signal) => {
      const outcomes: { findingId: string; repro: Repro; outcome: ReproOutcome }[] = [];
      // A correction that changed only the comments and docstrings of the finding's file cannot
      // change what its repro prints: the repro is evidence, not a gate (#1517).
      const evidenceOnly: string[] = [];
      for (const { findingId, repro, file } of repros) {
        const original = typeof file === "string" ? before[file] : undefined;
        if (typeof file === "string" && original !== undefined) {
          const now = readText(workspacePath(root, file));
          if (
            now !== null &&
            reproCannotSeeCorrection(file, repro, { before: original, after: now })
          ) {
            evidenceOnly.push(findingId);
            continue;
          }
        }
        outcomes.push({
          findingId,
          repro,
          outcome: await runRepro(this.processes, repro, {
            root,
            executables,
            generated: generatedPaths(policy),
            signal,
            sandbox: runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
            shadows: typeof file === "string" ? [file, ...writes] : writes,
          }),
        });
      }
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "repro",
          `tasks/${task.id}/repro-check-${newId()}.json`,
          canonical({
            taskId: task.id,
            outcomes: outcomes.map(({ findingId, outcome }) => ({ findingId, ...outcome })),
            ...(evidenceOnly.length ? { evidenceOnly } : {}),
          }),
        ),
      );
      return outcomes
        .filter(({ outcome }) => outcome.status === "reproduced")
        .map(
          ({ findingId, repro, outcome }) =>
            `Finding ${findingId} still reproduces: \`${[repro.executable, ...repro.args].join(" ")}\` prints "${repro.actual}" where "${repro.expected}" is expected.${reproInputs(repro)} Output:\n${outcome.output.slice(-1500)}`,
        );
    };
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
  /** The implementation profile a v2 definition's tasks stage names (#832), if any. */
  private tasksProfile(runId: string): string | undefined {
    const parsed = parseRunDefinition(this.store.run(runId).definition_json);
    if (parsed.schemaVersion !== 2) return undefined;
    const stage = parsed.definition.stages.find((s) => s.type === "tasks");
    return stage?.type === "tasks" ? stage.profileId : undefined;
  }
  /** Every package problem the scheduler would reject, as messages the planner can act on. */
  private planProblems(
    runId: string,
    spec: Spec,
    plan: { markdown: string; taskGraph: TaskGraph },
    policy: RunPolicy,
    profiles: AgentProfile[],
  ): string[] {
    const graph = planGraph(spec, plan, policy, profiles, this.tasksProfile(runId));
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
    if (presetOf(parseRunDefinition(this.store.run(runId).definition_json)) === HARDEN_PRESET)
      problems.push(...hardenPlanProblems(graph.tasks));
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
   * A route without effort uses the profile's own `effort`, if it sets one.
   */
  private route(
    runId: string,
    stepId: string,
    profile: AgentProfile,
  ): { models: string[]; effort?: RouteEffort; context?: RouteContext } {
    const candidate = this.stepModels.get(stepId);
    if (candidate) return { models: [candidate] };
    return this.stageRoute(runId, this.store.rootStage(runId, stepId), profile);
  }
  private stageRoute(
    runId: string,
    stage: string | null | undefined,
    profile: AgentProfile,
  ): { models: string[]; effort?: RouteEffort; context?: RouteContext } {
    const routing = this.routingRecord(runId);
    if (!routing)
      return { models: [profile.model], ...(profile.effort ? { effort: profile.effort } : {}) };
    // The critic judges the task stage's work, so the stage's route does not apply to it.
    const staged = stage && profile.output !== "critique" ? routing.stages[stage] : undefined;
    const own = routing.profiles[profile.id];
    const entry = staged ?? own;
    // The frozen profile keeps its start model; a reroute changes only the record.
    return {
      models: [staged?.model ?? own?.model ?? profile.model, ...(entry?.fallback ?? [])],
      ...(entry?.effort || profile.effort ? { effort: entry?.effort ?? profile.effort } : {}),
      ...(entry?.context !== undefined ? { context: entry.context } : {}),
    };
  }
  /** The plan approval's priced plan and its warnings: tokens over the ceiling, dollars over the cap. */
  private approvalCost(
    runId: string,
    policy: RunPolicy,
  ): { planCost: ReturnType<typeof planCostOf>; budgetWarning?: string } {
    const planCost = planCostOf(this.store, runId);
    const dollars = planCostWarning(
      planCost,
      currentCostCap(this.store, runId, policy),
      costToleranceOf(this.store, runId, policy),
      policy.sizing?.maxRunCostUsd,
    );
    const tokens = overCeilingOf(this.store, runId).budgetWarning;
    const budgetWarning = [tokens, dollars].filter(Boolean).join(" ");
    return { planCost, ...(budgetWarning ? { budgetWarning } : {}) };
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
  /**
   * The profile running on the model at `index` of its route's chain; `larger` runs that model
   * with the largest window it offers (`context: auto`, #1256).
   */
  private routed(
    runId: string,
    stepId: string,
    profile: AgentProfile,
    index = 0,
    larger = false,
  ): AgentProfile {
    const named = this.route(runId, stepId, profile).models[index] ?? profile.model;
    const model = larger ? (largerContextModel(named) ?? named) : named;
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
      const parsed = parseRunDefinition(run.definition_json);
      const stage =
        parsed.schemaVersion === 1
          ? parsed.definition.stages.find((s) => s.kind === "task-graph")?.id
          : parsed.definition.stages.find((s) => stageKind(s) === "task-graph")?.id;
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
      const outside = differing.filter(
        (path) => runWrittenHash(this.store, runId, path) !== (files[path] ?? null),
      );
      const listed = `${outside.slice(0, 10).join(", ")}${outside.length > 10 ? `, and ${String(outside.length - 10)} more` : ""}`;
      throw new WorkflowFault(
        "INPUT_CHANGED",
        `Files changed outside the run: ${listed}. Keep the changes with \`baked workflow resume RUN_ID --accept-workspace\` (Accept changes in the terminal UI and the desktop app), or restore them and resume, or fork the run`,
        { paths: outside },
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
      /** The model runs with its largest window: its context did not fit (`context: auto`). */
      largerWindow?: boolean;
      /** The context did not fit and nothing larger is left: its run-level documents are shortened. */
      compact?: boolean;
      /**
       * Set on the retries after a response ran past the provider's output cap, with the effort
       * they run at: one step below the previous call's, or its own when none is lower.
       */
      outputLimit?: { effort?: RouteEffort; tries: number };
    } = {},
  ): Promise<unknown> {
    const route = this.route(runId, stepId, stageProfile);
    const effort = placement.outputLimit ? placement.outputLimit.effort : route.effort;
    const fallbackIndex = placement.fallbackIndex ?? 0;
    const largerWindow = placement.largerWindow === true;
    const profile = this.routed(runId, stepId, stageProfile, fallbackIndex, largerWindow);
    // Under `context: auto` a step whose context does not fit tries the model's largest window
    // once, before the next model of the route (#1256).
    const upgrade = (): Promise<unknown> | null =>
      route.context === "auto" &&
      !largerWindow &&
      !signal.aborted &&
      largerContextModel(profile.model) !== null
        ? this.call(
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
              ...(fallbackIndex ? { fallbackIndex } : {}),
              ...(placement.primaryError !== undefined
                ? { primaryError: placement.primaryError }
                : {}),
              largerWindow: true,
            },
          )
        : null;
    const compact = placement.compact === true;
    let prompt: string;
    try {
      prompt = this.promptFor(runId, state, policy, profile, extra, compact);
    } catch (error) {
      if (!isContextWindowFault(error) || signal.aborted) throw error;
      const larger = upgrade();
      if (larger) return larger;
      // A context too large for this model's window goes to the next model of the route, as a
      // window the provider rejects does below.
      if (route.models[fallbackIndex + 1] !== undefined)
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
            fallbackIndex: fallbackIndex + 1,
            primaryError: placement.primaryError ?? error,
          },
        );
      // Nothing larger is left: the step runs with its run-level documents shortened before the
      // run stops for the window (#1244).
      if (compact) throw error;
      return this.call(
        runId,
        stepId,
        state,
        policy,
        stageProfile,
        extra,
        signal,
        task,
        retry,
        validate,
        limits,
        hostTools,
        { ...placement, compact: true },
      );
    }
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
    const taskEndCheck =
      task && profile.output === "implementation"
        ? this.taskEndCheck(runId, state, policy, task)
        : undefined;
    const attributeCheck =
      task && profile.output === "implementation"
        ? this.attributeCheck(runId, state, policy, task)
        : undefined;
    if (task && profile.output === "implementation")
      this.recordFindingFiles(runId, task, placement.root ?? runRoot(this.store.workspace, state));
    const reproCheck =
      task && profile.output === "implementation"
        ? this.reproCheck(runId, policy, task)
        : undefined;
    const caseCheck =
      task && profile.output === "implementation"
        ? criteriaCaseCheck(state.spec, task, {
            checks: policy.checks,
            tasks: (state.rootGraph ?? state.graph)?.tasks ?? [],
          })
        : undefined;
    // A digested spec (#1019) comes with the tool that reads its criteria in full.
    const digested =
      digestsSpec(state.spec, profile, policy) ||
      (compact && mayDigestSpec(state.spec, profile, policy));
    const host =
      hostTools || digested
        ? {
            ...(hostTools ? hostTools(attempt) : {}),
            ...(digested && state.spec ? { [READ_CRITERION]: readCriterionTool(state.spec) } : {}),
          }
        : undefined;
    try {
      if (task && profile.output === "implementation") {
        // Save what this attempt receives, before it can fail or the findings change (#1566).
        // Both serial tasks and task worktrees, including retries, pass through here.
        const context = (extra ?? {}) as Record<string, unknown>;
        const keys = [
          "recurringFindings",
          "siblingFindings",
          "correctionFocus",
          "cutOffChecks",
          "earlierEdits",
        ];
        this.store.transaction(() =>
          this.store.artifact(
            runId,
            "attempt-context",
            `attempts/${attempt}/context.json`,
            canonical({
              schemaVersion: 1,
              taskId: task.id,
              findingIds: task.findingIds,
              ...Object.fromEntries(
                keys.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]),
              ),
            }),
          ),
        );
      }
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
        ...(taskEndCheck ? { taskEndCheck } : {}),
        ...(reproCheck ? { reproCheck } : {}),
        ...(caseCheck ? { caseCheck } : {}),
        ...(task && task.origin !== "planned"
          ? { writtenTests: this.writtenTestWrites(runId, state, task) }
          : {}),
        ...(attributeCheck ? { attributeCheck } : {}),
        ...(this.formatHints(runId, state, profile.output, task)
          ? { formatHints: this.formatHints(runId, state, profile.output, task) }
          : {}),
        ...(host ? { hostTools: host } : {}),
        ...(effort ? { effort } : {}),
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
          result.usageComplete === false && !result.usageEstimated
            ? null
            : result.inputTokens === null || result.outputTokens === null
              ? this.store.recordedUsage(runId, attempt)
              : result.inputTokens + result.outputTokens,
          result.usageEstimated === true,
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
            false,
            error,
          ),
        );
      const wrote = this.store.effects(runId).some((effect) => effect.attempt_id === attempt);
      const editedFiles = () =>
        this.store
          .effects(runId)
          .some((effect) => effect.attempt_id === attempt && effect.kind === "file_patch");
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
          `${profile.model} refused the request: ${refusalAdvice(refusal, error)}, or move the run to another model with baked workflow reroute ${runId} --model ID --expected-revision N. ${error instanceof Error ? error.message : String(error)}`,
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
            ...(largerWindow ? { largerWindow } : {}),
            stepRetry: true,
          },
        );
      }
      // Commands and artifacts are not edits: a stage agent that ran checks or a repro still gets
      // the retry; an attempt that changed files continues on them instead (`capEndResult`, #1478).
      if (
        error instanceof WorkflowFault &&
        (error.details.reason === "no_submission" || error.details.reason === "step_cap") &&
        !placement.stepRetry &&
        !signal.aborted &&
        !editedFiles()
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
            ...(largerWindow ? { largerWindow } : {}),
            stepRetry: true,
          },
        );
      }
      // A response past the provider's output cap is not an outage: the step is tried again at
      // once, one effort step lower each time and told why, instead of blocking on the outage
      // ladder with the same prompt and effort (bench round 41, fpbits: 20 minutes lost, #1479).
      // A route without effort gets one retry with the notice; after `OUTPUT_LIMIT_RETRIES` the
      // failure takes the usual path.
      if (isOutputLimit(error) && !signal.aborted && !wrote) {
        const lower = lowerEffort(effort);
        const tries = placement.outputLimit?.tries ?? 0;
        if (tries === 0 || (lower && tries < OUTPUT_LIMIT_RETRIES)) {
          const notice =
            "Your previous response for this step ran past the provider's output limit and was discarded. Keep each response short: reason briefly, and split large files or edits into several smaller tool calls instead of one long one.";
          const retryExtra =
            extra && typeof extra === "object" && !Array.isArray(extra)
              ? { ...extra, outputLimit: notice }
              : { input: extra, outputLimit: notice };
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
              ...(largerWindow ? { largerWindow } : {}),
              ...(placement.stepRetry ? { stepRetry: true } : {}),
              ...(placement.compact ? { compact: true } : {}),
              outputLimit: {
                ...((lower ?? effort) ? { effort: lower ?? effort } : {}),
                tries: tries + 1,
              },
            },
          );
        }
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
            ...(largerWindow && index === fallbackIndex ? { largerWindow } : {}),
          },
        );
      if (delay !== null && !signal.aborted && !wrote) {
        await abortableDelay(delay, signal);
        return again(retry + 1, fallbackIndex, placement.primaryError);
      }
      // A model that keeps failing, or whose window cannot hold the prompt, hands the step to the
      // next model of its route. Nothing is handed over once the attempt has changed files.
      const windowTooSmall = isContextWindowFault(error) || isInputTooLarge(error);
      const larger = windowTooSmall && !wrote ? upgrade() : null;
      if (larger) return larger;
      if (next !== undefined && !signal.aborted && !wrote && (isTransient(error) || windowTooSmall))
        return again(0, fallbackIndex + 1, placement.primaryError ?? error);
      // A request too large for the provider is an error of the prompt, not a lost worker: a
      // restart on the same history failed the same way (#997). One fresh session, which does
      // not carry that history, is tried; then the step stops for the size.
      if (isInputTooLarge(error) && !signal.aborted) {
        if (!placement.stepRetry && !wrote)
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
              ...(fallbackIndex ? { fallbackIndex } : {}),
              ...(placement.primaryError !== undefined
                ? { primaryError: placement.primaryError }
                : {}),
              ...(largerWindow ? { largerWindow } : {}),
              stepRetry: true,
              // The fresh session also gets the shortened documents (#1244).
              compact: true,
            },
          );
        throw new WorkflowFault(
          "BUDGET_EXHAUSTED",
          `The model input exceeded the limit of ${profile.model}: ${error instanceof Error ? error.message : String(error)}`,
          { reason: "context_window" },
        );
      }
      if (placement.primaryError !== undefined && !signal.aborted) {
        const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `${route.models[0]} failed: ${message(placement.primaryError)}; last fallback ${profile.model} failed: ${message(error)}`,
          { reason: "provider_unavailable" },
        );
      }
      if (!(error instanceof WorkflowFault) && !signal.aborted && TRACE_RUN_BLOCKS)
        process.stderr.write(
          `[agent-call-error] ${runId} ${stepId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
      if (!(error instanceof WorkflowFault) && !signal.aborted)
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          error instanceof Error ? error.message : String(error),
          {
            reason: "provider_unavailable",
            // Where it was thrown, so a defect in BAKED's own code is not hidden as a lost worker (#929).
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          },
        );
      throw error;
    }
  }
  /** The prompt an agent call gets: the run context, the stage input and the execution contract. */
  /** The prompt a step will send, for a reservation: shortened when the whole one does not fit. */
  private estimatePrompt(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profile: AgentProfile,
    extra: unknown,
  ): string {
    try {
      return this.promptFor(runId, state, policy, profile, extra);
    } catch (error) {
      if (!isContextWindowFault(error)) throw error;
      return this.promptFor(runId, state, policy, profile, extra, true);
    }
  }
  private promptFor(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profile: AgentProfile,
    extra: unknown,
    compact = false,
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
    // What tasks' conflicts settled outranks a finding's suggested fix (#1519).
    const settled =
      profile.context === "review" || profile.context === "convergence"
        ? settledConflicts(this.store, runId)
        : [];
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
    // Property-based tests (#637): the spec author marks criteria, the planner and implementer
    // only hear of it once a criterion is marked.
    const marked = state.spec?.criteria.some((c) => c.property) ?? false;
    const propertyNote =
      (profile.output === "spec" || marked) &&
      propertyTestsOf(
        policy,
        presetOf(parseRunDefinition(this.store.run(runId).definition_json)),
        state.requestText || state.prompt,
      ) === "auto"
        ? propertyTestsNote(profile.output, this.propertyLibraries(runId, state))
        : null;
    const crossPlatform =
      profile.output === "spec"
        ? crossPlatformNote(state.requestText || state.prompt, runRoot(this.store.workspace, state))
        : null;
    const specSize =
      profile.output === "spec" ? specSizeNote(state.requestText || state.prompt) : null;
    // Under assume the authors settle questions with defaults in their first submission instead of
    // learning it from a rejection: three blocking questions per spec cost a retry each (#1046).
    const assumeDefaults =
      policy.clarification === "assume" &&
      (profile.output === "spec" || profile.output === "research")
        ? `No person answers questions in this run. For a question that would block: ${ASSUME_NOTE}`
        : null;
    const hardening =
      presetOf(parseRunDefinition(this.store.run(runId).definition_json)) === HARDEN_PRESET
        ? hardenNote(profile.output)
        : null;
    const { [DIFF_REVIEW]: diffOnly, ...input } = (
      extra && typeof extra === "object" ? extra : { input: extra }
    ) as Record<string, unknown>;
    return buildWorkflowContext(
      state,
      profile,
      {
        ...input,
        ...(propertyNote ? { propertyTests: propertyNote } : {}),
        ...(crossPlatform ? { crossPlatform } : {}),
        ...(specSize ? { specSize } : {}),
        ...(assumeDefaults ? { assumeDefaults } : {}),
        ...(hardening ? { hardening } : {}),
        ...(rules ? { learnedRules: rules } : {}),
        ...(workingSet ? { projectWorkingSet: workingSet } : {}),
        ...(memory ? { projectMemory: memory } : {}),
        ...(risks && diffOnly !== true ? { knownRisks: risks } : {}),
        ...(settled.length && diffOnly !== true ? { settledConflicts: settled } : {}),
        executionContract: {
          checks: policy.checks,
          // An implementer works alone; the other agents' tools are only resent on every step.
          profiles: ProfileSchema.array()
            .parse(JSON.parse(this.store.run(runId).profiles_json))
            .filter((p) => profile.context !== "implementation" || p.id === profile.id)
            // The approval reviewer takes no part in a run's work, only in its approvals.
            .filter((p) => p.output !== "approval-review" || p.id === profile.id)
            .map((p) => ({ id: p.id, role: p.role, allowedTools: p.allowedTools })),
          policy: { allowedTools: policy.allowedTools, network: policy.network },
        },
      },
      knownModelContextWindow(profile.model),
      diffOnly === true,
      diffOnly !== true &&
        (digestsSpec(state.spec, profile, policy) ||
          (compact && mayDigestSpec(state.spec, profile, policy))),
      compact,
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
      loopShares: loopHistory(this.store.workspace, policy),
      tokenRates: rateHistory(this.store.workspace, policy),
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
        const note = splitNote(report, plannerSizing(policy, samples, model).maxCodeFilesPerTask);
        // Under `revision: "patch"` the planner splits the oversized tasks with edit operations;
        // a whole new plan cost ratesim 029a5aec 170k tokens to split one skeleton task (#1112).
        this.pendPatch(
          state,
          policy,
          [
            {
              kind: "sizing",
              refs: ["tasks.json", `sizing/plan-${String(state.sizingReplans)}.json`],
              description: note,
            },
          ],
          ["plan"],
        );
        state.sizingReplans = 1;
        state.prompt += `
${note}`;
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
    state.activeTime = report.activeTime;
    this.raiseBudget(runId, state, policy, report);
    return "continue";
  }
  /**
   * Grows the run budget to the sized price, up to the policy's ceiling, and the active-time cap
   * to the time that budget needs at the observed rate. A plan sent back to be
   * split is raised too: the price only grows with the re-plan, and a run on a provider with a
   * high per-step cost otherwise ran out before its plan was accepted (expenses-py-r4).
   */
  private raiseBudget(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    report: SizingReport,
  ): void {
    const tokens = report.budgetAfter > policy.maxTotalTokens;
    const time = report.activeTime.after > policy.maxActiveMs;
    if (!tokens && !time) return;
    const before = hashJson(policy);
    // The sized tokens bring their dollars: a cap that may grow follows them, as on auto-growth;
    // otherwise a sized feature stopped on its starting cap at about half its tokens (#1411).
    const maxCostUsd = tokens ? grownCostCap(policy, report.budgetAfter) : policy.maxCostUsd;
    const changed = {
      ...(tokens ? { maxTotalTokens: report.budgetAfter } : {}),
      ...(time ? { maxActiveMs: report.activeTime.after } : {}),
      ...(maxCostUsd !== policy.maxCostUsd ? { maxCostUsd } : {}),
    };
    const after = PolicySchema.parse({ ...policy, ...changed });
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
          previous: Object.fromEntries(
            Object.keys(changed).map((key) => [key, policy[key as keyof typeof changed]]),
          ),
          next: changed,
        }),
      );
      this.store.setPolicy(runId, after);
    });
    // The drive keeps this policy object; the rest of the run sees the sized limits.
    policy.maxTotalTokens = after.maxTotalTokens;
    policy.maxActiveMs = after.maxActiveMs;
    policy.maxCostUsd = after.maxCostUsd;
    state.manifest.policyHash = hashJson(after);
    if (time) this.rearmDeadline();
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
    const early = this.criticEarlyStop(runId, state, policy, findings);
    if (early) {
      this.store.transaction(() => {
        this.store.artifact(
          runId,
          "critic-early-stop",
          `critic/early-stop-${String(this.store.run(runId).convergence_rounds)}.json`,
          canonical({ ...early, findingIds: findings.map((f) => f.id) }),
        );
        acceptResidual(this.store, runId, state, { findings }, "critic");
        noteStoppedInconclusive(state, this.store.run(runId).convergence_rounds);
      });
      return "accepted";
    }
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
        noteStoppedInconclusive(state, this.store.run(runId).convergence_rounds);
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
  /**
   * The first drive of a fork made with `fromStage` (#855): the workspace goes back to the
   * parent's base content of each file the parent changed, which becomes the fork's baseline, and
   * the parent's changes are written again as the fork's own journaled edits, so the review
   * bundle, undo and delivery see them as this run's change. The tasks count as implemented. When
   * the content is the parent's snapshot, the parent's check results and manual evidence and,
   * for a fork at the convergence, its reviews are carried over.
   */
  private async seedFork(runId: string, policy: RunPolicy, signal: AbortSignal): Promise<void> {
    const row = this.store.latestArtifact(runId, FORK_SEED_ARTIFACT);
    if (!row || this.store.latestArtifact(runId, FORK_SEEDED_ARTIFACT)) return;
    const seed = JSON.parse(this.store.readArtifact(runId, row.id)) as ForkSeed;
    const state = this.store.state(runId);
    const root = runRoot(this.store.workspace, state);
    signal.throwIfAborted();
    const published = new Set(
      this.store
        .effects(runId)
        .filter((e) => e.kind === "file_patch" && ["applied", "reconciled"].includes(e.status))
        .map((e) => (JSON.parse(e.intent_json) as { path: string }).path),
    );
    if (!state.manifest.baselineSnapshotId) {
      for (const file of seed.files) {
        const absolute = workspacePath(root, file.path);
        const before = seedBytes(file.before);
        if (fileHash(absolute) === (before === null ? null : hashBytes(before))) continue;
        if (before === null) rmSync(absolute, { force: true });
        else {
          mkdirSync(dirname(absolute), { recursive: true });
          writeFileSync(absolute, before);
        }
      }
      const baseline = await this.snapshot(runId, state, policy, signal);
      const repository = await gitBaseline(root);
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "baseline",
          `baselines/${baseline.id}.json`,
          canonical({ snapshotId: baseline.id, repository }),
        ),
      );
      state.manifest.baselineSnapshotId = baseline.id;
      this.store.transaction(() => this.store.saveState(runId, state));
      await this.measureQualityBaseline(runId, state, policy, signal);
      await this.recordCheckBaseline(runId, state, policy, signal);
    }
    const stepId = this.store.transaction(() => this.store.beginStep(runId, "fork-seed"));
    const attempt = this.store.reserve(runId, stepId, null, 0, policy);
    for (const file of seed.files) {
      if (published.has(file.path)) continue;
      const absolute = workspacePath(root, file.path);
      const before = this.store.transaction(() => capturePreImage(this.store, runId, absolute));
      this.journal.publish(
        runId,
        attempt,
        file.path,
        seedBytes(file.content),
        before,
        "file_patch",
        root,
      );
    }
    this.store.transaction(() => {
      this.store.finishAttempt(runId, attempt, "completed", 0);
      this.store.finishStep(runId, stepId, "completed");
    });
    const snapshot = await this.snapshot(runId, state, policy, signal);
    this.store.transaction(() => {
      for (const task of state.graph?.tasks ?? [])
        this.store.taskStatus(runId, task.id, "implemented", snapshot.id);
      const parent = seed.parentSnapshotId;
      const same = parent !== null && snapshot.hash === seed.parentSnapshotHash;
      if (same) {
        const artifacts = new Map(this.store.artifacts(seed.parentRunId).map((a) => [a.id, a]));
        for (const evidence of currentEvidence(this.store, seed.parentRunId, parent)) {
          const artifact = artifacts.get(evidence.artifact_id);
          const kind = evidence.kind;
          // The fork builds its own review bundle; check results and manual evidence carry over.
          if (!artifact || !(kind === "command" || kind === "manual")) continue;
          const copy = this.store.artifact(
            runId,
            artifact.kind,
            artifact.logical_path,
            this.store.readArtifact(seed.parentRunId, artifact.id),
          );
          const id = this.store.addEvidence(runId, kind, snapshot.id, copy.id);
          this.store.copyCheckResults(seed.parentRunId, evidence.id, runId, id);
        }
        const definition = parseRunDefinition(this.store.run(runId).definition_json);
        const converge =
          definition.schemaVersion === 1
            ? definition.definition.stages[state.stageIndex]?.kind === "converge"
            : definition.definition.stages.some(
                (s) => s.id === state.position?.stageId && stageKind(s) === "converge",
              );
        if (converge) {
          const reviews = this.store.state(seed.parentRunId).reviews;
          for (const [key, review] of Object.entries(reviews))
            if (review.snapshotHash === snapshot.hash) state.reviews[key] = review;
        }
      }
      this.store.artifact(
        runId,
        "fork",
        FORK_SEEDED_ARTIFACT,
        canonical({
          files: seed.files.length,
          snapshotId: snapshot.id,
          carriedEvidence: same,
        }),
      );
      this.store.saveState(runId, state);
    });
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
          readyTasks(state.graph, rows, state.taskGates, state.waitingFor),
        ))
      )
        continue;
      const ready = checking
        ? []
        : this.testsFirstReady(
            runId,
            state,
            policy,
            readyTasks(state.graph, rows, state.taskGates, state.waitingFor),
          );
      // The tests are put to a person; the code tasks wait for the approval.
      if (ready === null) return;
      const task = checking ?? ready[0];
      if (!task) {
        // Owners that cannot run leave their waiting tasks checked as they are, and repaired if they fail.
        if (this.releaseDeferred(state)) continue;
        break;
      }
      signal.throwIfAborted();
      await this.implementTask(runId, stepId, state, policy, profiles, signal, task, !!checking);
      if (this.queued.length) return;
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
  /** Ends every wait of a deferred check or a deferred task; true when one was waiting. */
  private releaseDeferred(state: RuntimeState): boolean {
    const waiting = Object.keys(state.deferredChecks);
    for (const id of waiting) delete state.deferredChecks[id];
    const tasks = Object.keys(state.waitingFor ?? {});
    for (const id of tasks) delete state.waitingFor[id];
    return waiting.length + tasks.length > 0;
  }
  /** The unfinished tasks that write a file a blocked task's account names (`missingArtifactOwners`). */
  private missingArtifactOwnersOf(
    runId: string,
    state: RuntimeState,
    task: Task,
    account: { summary: string; unresolved: string[] },
  ): string[] {
    if (!state.graph) return [];
    return missingArtifactOwners(
      state.graph,
      this.store.tasks(runId),
      task,
      account,
      state.waitingFor,
    );
  }
  /**
   * Defers a task that reported `blocked` without changing a file because a file it names is
   * written by a task still to run: it waits for that task instead of blocking the run. True
   * when it was deferred; the caller leaves the task ready again.
   */
  private deferOnMissingArtifact(
    runId: string,
    state: RuntimeState,
    stepId: string,
    task: Task,
    result: { outcome: string; summary: string; unresolved: string[] },
    changed: readonly string[],
  ): boolean {
    if (result.outcome !== "blocked" || changed.length > 0) return false;
    const owners = this.missingArtifactOwnersOf(runId, state, task, result);
    if (!owners.length) return false;
    state.waitingFor[task.id] = [...(state.waitingFor[task.id] ?? []), ...owners];
    this.store.artifact(
      runId,
      "recovery",
      `tasks/waits/${task.id}.json`,
      canonical({ taskId: task.id, stepId, waitsFor: owners, summary: result.summary }),
    );
    return true;
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
    const firstRun = this.store.tasks(runId).find((t) => t.id === task.id)?.status === "pending";
    const child = this.store.transaction(() => {
      if (!checking) this.store.taskStatus(runId, task.id, "running");
      return this.store.beginStep(runId, `task-${task.id}`, stepId);
    });
    let integrity: Review["findings"] = [];
    let reported: { summary: string; unresolved: string[] } | undefined;
    let unresolvedAccount: { summary: string; unresolved: string[] } | undefined;
    if (
      !checking &&
      (task.writes.length === 0 ||
        hostWritten(task) ||
        (firstRun && (await this.correctionPassing(runId, child, state, policy, task, signal))))
    ) {
      // A task that may not write, a task whose files the host writes, or a correction whose
      // failing checks already pass, has nothing for a model to do: its task checks decide it,
      // and the checks stage covers the rest.
      if (hostWritten(task)) this.writeHostFiles(runId, child, state, policy, task);
      await this.snapshot(runId, state, policy, signal);
      this.store.transaction(() => {
        this.store.taskStatus(runId, task.id, "implemented", state.snapshotId);
        this.store.saveState(runId, state);
      });
    } else if (!checking) {
      const root = runRoot(this.store.workspace, state);
      if (await this.affectedBaseline(runId, child, state, policy, task, signal, root))
        this.store.transaction(() => this.store.saveState(runId, state));
      const before = await sourceManifest(root, generatedPaths(policy), signal);
      // Inline, the root is the user's working copy: a change there may be the user's own edit,
      // which is never put back, so only a worktree run reverts unjournaled changes (#1188).
      const kept =
        root === this.store.workspace
          ? undefined
          : keepOutside(root, before, new Set(task.writes.map((w) => w.path)));
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
      const diagnostics = staticCorrection(this.store, runId, policy, task);
      const narrow = state.widenedCorrections.includes(task.id)
        ? null
        : narrowCorrectionWrites(task, focus.files, !diagnostics);
      // The task as this attempt may write it: a correction's first attempt only where its
      // findings point.
      const scoped: Task = narrow ? { ...task, writes: narrow } : task;
      if (narrow) state.narrowedCorrections[task.id] ??= narrow.map((w) => w.path);
      const preloaded = await preloadTaskFiles(
        root,
        focus.files.length ? focusFirst(scoped.writes, focus.files) : scoped.writes,
        `${task.title}\n${task.description}\n${focus.symbols.join(" ")}`,
      );
      // The source manifest cannot see git-ignored files (a docs directory in .gitignore), but the
      // effect journal recorded every file this task changed, so it counts as well.
      const journaled = (): string[] => [
        ...this.store
          .effects(runId)
          .filter(
            (e) =>
              !knownEffects.has(e.id) &&
              e.kind === "file_patch" &&
              ["applied", "reconciled"].includes(e.status) &&
              e.before_hash !== e.after_hash,
          )
          .map((e) => (JSON.parse(e.intent_json) as { path: string }).path),
        ...stillEdited(),
      ];
      const currentChanges = async (): Promise<{
        after: Record<string, string>;
        changed: string[];
      }> => {
        const now = await sourceManifest(root, generatedPaths(policy), signal);
        return {
          after: now,
          changed: [...new Set([...changedPaths(before, now), ...journaled()])],
        };
      };
      let proseEnd = false;
      const fresh = this.freshStart(runId, state, task);
      const result = this.settleSizeTargets(
        runId,
        task.id,
        ImplementationSchema.parse(
          await this.call(
            runId,
            child,
            state,
            policy,
            this.requireProfile(profiles.find((p) => p.id === task.profileId)),
            {
              task: scoped,
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
              ...(await this.libraryDocsContext(runId, policy, root, task)),
              ...this.previousAttempt(runId, task.id),
              ...this.recurringContext(runId, task),
              ...this.cutOffChecks(runId, task.id),
              ...(focus.files.length
                ? {
                    correctionFocus: {
                      files: focus.files,
                      symbols: focus.symbols,
                      note: "The findings this task corrects point at these files and symbols; they come first in taskFiles. Start the fix there and read the other written files only when the fix needs them.",
                      ...(diagnostics
                        ? {
                            diagnostics: STATIC_DIAGNOSTICS,
                          }
                        : {}),
                      ...(narrow ? { scope: correctionScope(task, narrow) } : {}),
                    },
                  }
                : {}),
              ...this.affectedTestsContext(root, state, policy, task),
              ...this.writtenTestsContext(state, policy, task),
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
            scoped,
          ).catch(async (error: unknown) => {
            if (capEnded(error))
              return this.capEndResult(
                runId,
                state,
                child,
                task,
                error,
                async () => (await currentChanges()).changed,
              );
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
        ),
      );
      if (result.outcome === "spec_conflict" && result.taskId === task.id) {
        this.specConflict(runId, state, policy, child, task, result);
        return;
      }
      if (result.outcome === "implemented")
        await this.fixTaskFiles(runId, child, root, policy, scoped, signal);
      if (kept)
        await this.revertUnjournaled(
          runId,
          child,
          task,
          root,
          kept,
          before,
          await currentChanges(),
          new Set(journaled()),
        );
      const { after, changed } = await currentChanges();
      const outside = changed.filter((path) => !task.writes.some((w) => w.path === path));
      if (outside.length)
        throw new WorkflowFault(
          "INPUT_CHANGED",
          `Task changed ${outside.length} file(s) outside its write scope: ${outside
            .slice(0, 5)
            .map((path) => describeChange(path, before, after))
            .join(", ")}${outside.length > 5 ? ", ..." : ""}`,
        );
      const reproduced = await this.stillReproduces(
        runId,
        policy,
        task,
        result,
        changed,
        root,
        signal,
      );
      const correction =
        reproduced ??
        (result.outcome === "implemented" && changed.length === 0 && task.writes.length > 0
          ? await this.correctionSatisfied(runId, state, child, policy, task, result, signal, root)
          : true);
      if (correction instanceof WorkflowFault) {
        this.store.transaction(() => this.store.taskStatus(runId, task.id, "blocked"));
        throw correction;
      }
      const ownFailures = ownCheckFailures(task, result, changed);
      if (
        result.taskId !== task.id ||
        ["blocked", "failed"].includes(result.outcome) ||
        (result.unresolved.length > 0 && !ownFailures) ||
        correction !== true
      ) {
        if (this.fallBackFromQuickFix(state, task)) {
          // The quick fix did not finish: the next attempt has the usual budget and every file of
          // the correction, and keeps this attempt's edits.
          this.store.transaction(() => {
            this.store.taskStatus(runId, task.id, "interrupted", null, {
              cause: "widened_correction",
              detail: "quick fix did not finish",
              carried: changed.length > 0,
            });
            this.store.finishStep(runId, child, "failed");
            this.store.saveState(runId, state);
          });
          return;
        }
        if (narrow) {
          // The fix may need another file of the correction's scope: the next attempt may write
          // all of them, and keeps this attempt's edits.
          this.store.transaction(() => {
            state.widenedCorrections.push(task.id);
            this.store.taskStatus(runId, task.id, "interrupted", null, {
              cause: "widened_correction",
              carried: changed.length > 0,
            });
            this.store.finishStep(runId, child, "failed");
            this.store.saveState(runId, state);
          });
          return;
        }
        const restartReason = this.blockedRestartReason(
          runId,
          state,
          policy,
          child,
          task,
          result,
          changed,
          proseEnd,
          reproduced,
        );
        const account = {
          summary: result.summary,
          unresolved: reproduced ? [...result.unresolved, reproduced] : result.unresolved,
        };
        // A task blocked on a file a task still to run writes waits for it; a restart now would block again.
        if (
          this.store.transaction(() => {
            if (!this.deferOnMissingArtifact(runId, state, child, task, result, changed))
              return false;
            this.store.taskStatus(runId, task.id, "interrupted", null, {
              cause: "waits_for_artifact",
            });
            this.store.finishStep(runId, child, "failed");
            this.store.saveState(runId, state);
            return true;
          })
        )
          return;
        if (
          restartReason &&
          changed.length === 0 &&
          this.restartOnce(runId, state, child, task.id, restartReason, [], account)
        ) {
          // A fresh session gets the task again; a session without its edit tool stays without it.
          this.store.transaction(() => {
            this.store.taskStatus(runId, task.id, "interrupted", null, {
              cause: "restart",
              detail: restartReason,
            });
            this.store.finishStep(runId, child, "failed");
            this.store.saveState(runId, state);
          });
          return;
        }
        const atCap =
          changed.length > 0 &&
          (this.continueAtCap(runId, state, child, task) ||
            this.progressAttempt(runId, state, child, task));
        if (
          atCap ||
          (changed.length > 0 &&
            restartReason !== null &&
            this.restartOnce(runId, state, child, task.id, restartReason, changed, account))
        ) {
          // The task is ready again and the next pass of the task loop continues it.
          this.store.transaction(() => {
            this.store.taskStatus(
              runId,
              task.id,
              "interrupted",
              null,
              atCap
                ? { cause: "continue_at_cap" }
                : { cause: "restart", detail: restartReason ?? undefined, carried: true },
            );
            this.store.finishStep(runId, child, "failed");
            this.store.saveState(runId, state);
          });
          return;
        }
        this.store.transaction(() => {
          this.store.taskStatus(runId, task.id, "blocked");
          this.recordUnfinished(runId, child, task.id, result, changed);
        });
        const refused = takeHashRefusals(root);
        throw new WorkflowFault(
          "OUTPUT_INVALID",
          `Task ${task.id} did not complete its implementation${incompleteReason(result.unresolved)}${correctionReason(correction)}${refusedReason(refused)}`,
          refused.length
            ? { reason: "input_changed", paths: refused }
            : { unfinishedTask: task.id },
        );
      }
      if (
        await this.cutOffCheckFailures(
          runId,
          state,
          policy,
          child,
          task,
          changed,
          signal,
          root,
          (check) => this.runTaskCheck(runId, child, check, policy, signal, root),
        )
      ) {
        this.store.transaction(() => {
          this.store.taskStatus(runId, task.id, "interrupted", null, {
            cause: "continue_at_cap",
          });
          this.store.finishStep(runId, child, "failed");
          this.store.saveState(runId, state);
        });
        return;
      }
      if (result.outcome === "already_satisfied")
        this.validateSatisfiedEvidence(runId, state, after, result);
      reported = { summary: result.summary, unresolved: result.unresolved };
      if (ownFailures) unresolvedAccount = reported;
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
      integrity = this.integrityFailures(runId, state, policy, task, root, beforeHashes, changed);
    }
    const taskFailures: Review["findings"] = [...integrity];
    const checkEvidence: string[] = [];
    let inconclusive: string | undefined;
    const taskRoot = runRoot(this.store.workspace, state);
    const taskResults: WorkerCheck[] = [];
    for (const check of this.gatedChecks(runId, state, policy, task, taskRoot)) {
      const checked = await this.runTaskCheck(runId, child, check, policy, signal, taskRoot);
      taskResults.push({ check, checked });
    }
    if (this.testsPending(state, policy) && isTestTask(task)) {
      this.settleRed(runId, state, policy, task, child, taskResults, taskFailures);
      return;
    }
    const settled = await this.fixFailedTaskChecks(
      runId,
      child,
      state,
      policy,
      task,
      taskResults,
      signal,
      taskRoot,
    );
    for (const { check, checked } of settled)
      inconclusive ??= this.applyTaskCheck(
        runId,
        state,
        task,
        check,
        checked,
        taskFailures,
        checkEvidence,
        policy,
      );
    this.inconclusiveTaskCheck(inconclusive, taskFailures);
    await this.spawnedCheckOutput(runId, child, policy, settled, taskFailures, signal, taskRoot);
    if (unresolvedAccount && !taskFailures.length && !taskResults.length)
      taskFailures.push(...this.unresolvedFindings(runId, state, task, unresolvedAccount));
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
    if (!taskFailures.length && reported && !unresolvedAccount)
      await this.routeReportedDefect(runId, state, policy, task, child, reported, signal, taskRoot);
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
      const all = readyTasks(current, rows, state.taskGates, state.waitingFor).filter(
        (t) => !lost.has(t.id),
      );
      const runnable = checking ? all : this.testsFirstReady(runId, state, policy, all);
      if (runnable === null) return;
      const ready = runnable;
      if (!checking && (await this.hostFirstReruns(runId, stepId, state, policy, signal, ready)))
        continue;
      const single = checking ?? ready.find((t) => t.writes.length === 0 || hostWritten(t));
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
        if (this.queued.length) return;
        continue;
      }
      const contested = this.contestedTask(runId, state, policy, ready);
      if (contested) {
        await this.implementCandidates(runId, stepId, state, policy, profiles, signal, contested, {
          worktree,
          checks,
          lost,
        });
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
        // A rejected task does not keep the others of its batch out of the run worktree. Neither
        // does one stopped at its token or step cap: the run itself can go on, and the resume
        // would otherwise run its finished siblings again (#1056, #1478).
        const fatal = outcomes.find((outcome) => outcome.kind === "fatal");
        if (fatal) failure = fatal.error;
        const integrate = outcomes.every(
          (outcome) => outcome.kind !== "fatal" || capEnded(outcome.error),
        );
        for (const outcome of outcomes) {
          if (outcome.kind === "fatal") continue;
          const error = await this.settleOutcome(
            runId,
            state,
            policy,
            profiles,
            outcome,
            !integrate,
            lost,
            signal,
          );
          failure ??= error;
          await this.releaseTaskWorktree(runId, outcome.entry);
        }
      } finally {
        for (const entry of batch) await this.releaseTaskWorktree(runId, entry);
      }
      if (failure) throw failure;
      if (this.queued.length) return;
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
   * The ready task best-of-N runs next (#642): a planned task with files to write that has no
   * selection yet and no edits carried from an earlier attempt. A restart or a repair of a task
   * runs once. Undefined when the run has one candidate per task.
   */
  private contestedTask(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    ready: Task[],
  ): Task | undefined {
    if (candidateCount(policy) < 2) return undefined;
    return ready.find(
      (t) =>
        t.origin === "planned" &&
        t.writes.length > 0 &&
        !state.taskCarry[t.id] &&
        (state.taskRestarts[t.id] ?? 0) === 0 &&
        !this.store.latestArtifact(runId, `tasks/${t.id}/selection.json`),
    );
  }
  /**
   * Best-of-N (#642): implements one planned task as several candidates, each in its own worktree
   * from the same base and with the task's checks, selects one (candidates.ts) and integrates
   * only that one. Each candidate is kept as `tasks/TASK/candidates/N.json` with its patch and
   * `tasks/TASK/selection.json` records the choice and why. When no candidate finished, the first
   * one's ending is handled as a single task's would be.
   */
  private async implementCandidates(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    signal: AbortSignal,
    task: Task,
    batchContext: {
      worktree: NonNullable<RuntimeState["worktree"]>;
      checks: Semaphore;
      lost: Map<string, string>;
    },
  ): Promise<void> {
    const { worktree, checks, lost } = batchContext;
    const mainRoot = join(this.store.workspace, worktree.path);
    const batch = this.reserveBatch(
      runId,
      stepId,
      state,
      policy,
      profiles,
      Array.from({ length: candidateCount(policy) }, () => task),
    );
    for (const [i, entry] of batch.entries()) {
      const model = candidateModel(policy, i + 1);
      if (!model) continue;
      entry.profile = { ...entry.profile, model };
      this.stepModels.set(entry.child, model);
    }
    const base = await runContentCommit(this.store, runId, worktree);
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "batch",
        `tasks/batches/${newId()}.json`,
        canonical({
          base,
          tasks: [task.id],
          candidates: batch.length,
          deferredByOverlap: [],
          deferredByBudget: [],
        }),
      ),
    );
    let failure: unknown = null;
    try {
      for (const [i, entry] of batch.entries()) {
        entry.path = await createTaskWorktree(
          this.store,
          runId,
          `${task.id}-c${String(i + 1)}`,
          base,
          task.writes.map((w) => w.path),
        );
        this.leases.acquire(entry.lease(), runId, { isolated: true });
      }
      const outcomes = await Promise.all(
        batch.map((entry) => this.runTaskWorker(runId, state, policy, entry, checks, signal)),
      );
      const fatal = outcomes.find((outcome) => outcome.kind === "fatal");
      if (fatal) failure = fatal.error;
      else {
        const results = await Promise.all(
          outcomes.map((outcome, i) => this.candidateResult(outcome, i + 1, mainRoot)),
        );
        const criticDecides =
          policy.critic === "select" && this.criticCalibration(runId).calibrated;
        const distinction = criticDecides
          ? null
          : await this.distinguishFinalists(runId, stepId, state, policy, profiles, task, {
              batch,
              results,
              signal,
            });
        const narrowed =
          distinction &&
          distinction.matching.length > 0 &&
          distinction.matching.length < distinction.finalists.length
            ? distinction.matching
            : null;
        const critic = this.criticOf(runId, policy, profiles);
        if (critic)
          for (const index of candidatesToJudge(
            results.map((r) => r.result),
            criticDecides,
          ).filter((i) => !narrowed || (narrowed.length > 1 && narrowed.includes(i)))) {
            const candidate = results[index - 1];
            const entry = batch[index - 1];
            if (!candidate || !entry) continue;
            candidate.result.score = await this.scoreCandidate(
              runId,
              entry.child,
              state,
              policy,
              critic,
              task,
              candidate.patch,
              signal,
            );
          }
        const selection = selectCandidate(
          results.map((r) => r.result),
          criticDecides,
          distinction?.matching ?? null,
        );
        this.recordSelection(runId, task, batch, results, selection, distinction);
        const chosen =
          selection.winner !== null
            ? outcomes[selection.winner - 1]
            : outcomes.find((outcome) => outcome.kind !== "fatal");
        for (const outcome of outcomes) {
          if (outcome === chosen || outcome.kind === "fatal") continue;
          this.store.transaction(() =>
            this.store.finishStep(
              runId,
              outcome.entry.child,
              outcome.kind === "done"
                ? "completed"
                : outcome.kind === "interrupted"
                  ? "interrupted"
                  : "failed",
            ),
          );
          await this.releaseTaskWorktree(runId, outcome.entry);
        }
        if (chosen && chosen.kind !== "fatal") {
          failure = await this.settleOutcome(
            runId,
            state,
            policy,
            profiles,
            chosen,
            false,
            lost,
            signal,
          );
          await this.releaseTaskWorktree(runId, chosen.entry);
        }
      }
    } finally {
      for (const entry of batch) {
        this.stepModels.delete(entry.child);
        await this.releaseTaskWorktree(runId, entry);
      }
    }
    if (failure) throw failure;
  }
  /**
   * The distinguishing test of a tied vote (#769, after S*): the `distinction` profile reads the
   * finalists' patches and the task's criteria and writes one command with the line the spec
   * requires; the host runs it in each finalist's worktree as a probe (programs the checks start,
   * no file changes) and keeps those whose output shows that line. Null when the vote decided, no
   * profile or program is available, or the profile failed.
   */
  private async distinguishFinalists(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    task: Task,
    candidates: {
      batch: BatchEntry[];
      results: { result: CandidateResult; patch: string }[];
      signal: AbortSignal;
    },
  ): Promise<DistinctionRecord | null> {
    const { batch, results, signal } = candidates;
    const finalists = candidatesToJudge(
      results.map((r) => r.result),
      false,
    );
    const profile = profiles.find((p) => p.output === "distinction");
    const executables = reproExecutables(policy.checks);
    if (finalists.length < 2 || !profile || !executables.length) return null;
    const child = this.store.transaction(() => this.store.beginStep(runId, "distinguish", stepId));
    let test: Distinction;
    try {
      test = DistinctionSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          profile,
          {
            task,
            criteria: (state.spec?.criteria ?? []).filter((c) => task.criterionIds.includes(c.id)),
            executables,
            finalists: finalists.map((index) => ({
              candidate: index,
              patch: results[index - 1]?.patch ?? "",
            })),
          },
          signal,
        ),
      );
      this.store.transaction(() => this.store.finishStep(runId, child, "completed"));
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof WorkflowFault &&
        ["BUDGET_EXHAUSTED", "CHECKPOINT_REACHED"].includes(error.code)
      )
        throw error;
      this.store.transaction(() => this.store.finishStep(runId, child, "failed"));
      return null;
    }
    const runs: DistinctionRecord["runs"] = [];
    for (const index of finalists) {
      const entry = batch[index - 1];
      if (!entry) continue;
      const root = join(this.store.workspace, entry.path);
      const outcome = await runProbe(
        this.processes,
        { executable: test.executable, args: test.args },
        {
          root,
          executables,
          generated: generatedPaths(policy),
          signal,
          sandbox: runSandbox(policy, root),
        },
      );
      runs.push({
        candidate: index,
        status: outcome.status,
        shows: outcome.status === "ran" && outputShows(outcome.output, test.expected),
        exitCode: outcome.exitCode ?? null,
        output: outcome.output.slice(-2000),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });
    }
    return {
      test,
      finalists,
      runs,
      matching: runs.filter((r) => r.shows).map((r) => r.candidate),
    };
  }
  /** What the selection sees of one candidate, with its patch against the run worktree. */
  private async candidateResult(
    outcome: WorkerOutcome,
    index: number,
    mainRoot: string,
  ): Promise<{ result: CandidateResult; patch: string; changed: string[] }> {
    const error =
      outcome.kind === "done"
        ? undefined
        : outcome.kind === "interrupted"
          ? outcome.reason
          : outcome.kind === "conflict"
            ? `Spec conflict: ${outcome.result.summary}`
            : outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error);
    if (outcome.kind !== "done")
      return {
        result: {
          index,
          outcome: outcome.kind === "interrupted" ? "interrupted" : "rejected",
          failedChecks: [],
          fingerprint: null,
          changedLines: 0,
          score: null,
          ...(error ? { error } : {}),
        },
        patch: "",
        changed: outcome.kind === "rejected" ? (outcome.edits?.changed ?? []) : [],
      };
    const root = join(this.store.workspace, outcome.entry.path);
    const read = (from: string, path: string): Buffer | null => {
      const absolute = workspacePath(from, path);
      return existsSync(absolute) ? readFileSync(absolute) : null;
    };
    const parts: string[] = [];
    for (const path of outcome.changed)
      parts.push(await unifiedDiff(path, read(mainRoot, path), read(root, path)));
    const patch = parts.filter(Boolean).join("\n");
    return {
      result: {
        index,
        outcome: "done",
        failedChecks: outcome.checks
          .filter(({ check, checked }) => check.required && checked.status !== "passed")
          .map(({ check }) => check.id),
        fingerprint: normalizedFingerprint(
          outcome.changed.map((path) => [path, read(root, path)?.toString("utf8") ?? null]),
        ),
        changedLines: changedLineCount(patch),
        score: null,
      },
      patch:
        patch.length > MAX_PATCH_CHARS
          ? `${patch.slice(0, MAX_PATCH_CHARS)}\n... patch cut at ${MAX_PATCH_CHARS} characters`
          : patch,
      changed: outcome.changed,
    };
  }
  /**
   * The critic's score of one candidate, which breaks a tie in the vote or, calibrated in
   * `select` mode, picks among the passing candidates. A critic that fails leaves it unscored.
   */
  private async scoreCandidate(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    critic: AgentProfile,
    task: Task,
    patch: string,
    signal: AbortSignal,
  ): Promise<number | null> {
    const child = this.store.transaction(() => this.store.beginStep(runId, "critic", stepId));
    try {
      const output = CritiqueSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          critic,
          { task, patch, failedChecks: [] },
          signal,
        ),
      );
      this.store.transaction(() => this.store.finishStep(runId, child, "completed"));
      return output.score;
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof WorkflowFault &&
        ["BUDGET_EXHAUSTED", "CHECKPOINT_REACHED"].includes(error.code)
      )
        throw error;
      this.store.transaction(() => this.store.finishStep(runId, child, "failed"));
      return null;
    }
  }
  /** Keeps every candidate of a task and the selection, with what decided it. */
  private recordSelection(
    runId: string,
    task: Task,
    batch: BatchEntry[],
    results: { result: CandidateResult; patch: string; changed: string[] }[],
    selection: CandidateSelection,
    distinction: DistinctionRecord | null = null,
  ): void {
    this.store.transaction(() => {
      for (const { result, patch, changed } of results)
        this.store.artifact(
          runId,
          "candidate",
          `tasks/${task.id}/candidates/${String(result.index)}.json`,
          canonical({
            taskId: task.id,
            ...result,
            selected: result.index === selection.winner,
            model: batch[result.index - 1]?.profile.model ?? null,
            changed,
            patch,
          }),
        );
      this.store.artifact(
        runId,
        "candidate-selection",
        `tasks/${task.id}/selection.json`,
        canonical({
          taskId: task.id,
          candidates: results.length,
          ...selection,
          // The oracle rate's numerator: some candidate passed; the selected rate's: the winner did.
          oracle: selection.passing.length > 0,
          selectedPassed: selection.winner !== null && selection.passing.includes(selection.winner),
          ...(distinction ? { distinction } : {}),
        }),
      );
    });
  }
  /**
   * Records how one task worker of a batch ended: a finished task is integrated (unless another
   * worker of the batch stopped the run), a lost one may restart, a rejected one may continue or
   * restart once. Returns the error that stops the run, or null.
   */
  private async settleOutcome(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    outcome: Exclude<WorkerOutcome, { kind: "fatal" }>,
    fatal: boolean,
    lost: Map<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { entry } = outcome;
    let failure: unknown = null;
    if (outcome.kind === "conflict")
      this.specConflict(runId, state, policy, entry.child, entry.task, outcome.result);
    else if (outcome.kind === "done") {
      if (!fatal) await this.integrateTask(runId, state, policy, profiles, outcome, signal);
      delete state.taskCarry[entry.task.id];
    } else if (outcome.kind === "interrupted") {
      const restart = !fatal && this.restartLostTask(runId, state, outcome);
      if (restart && outcome.edits) this.carryEdits(runId, state, entry, outcome.edits);
      if (!restart) lost.set(entry.task.id, outcome.reason);
      this.store.transaction(() => {
        this.store.taskStatus(runId, entry.task.id, "interrupted", null, {
          cause: outcome.cause,
          detail: outcome.reason,
          ...(outcome.stack ? { stack: outcome.stack } : {}),
          carried: restart && outcome.edits !== undefined,
        });
        this.store.finishStep(runId, entry.child, "interrupted");
      });
    } else if (outcome.kind === "rejected") {
      // A cut-off attempt whose check failed already continues at its cap (#1329).
      const cause: InterruptCause | null = outcome.continued
        ? "continue_at_cap"
        : this.fallBackFromQuickFix(state, entry.task) ||
            this.widenCorrection(state, entry, outcome)
          ? "widened_correction"
          : outcome.blocked !== undefined &&
              this.deferOnMissingArtifact(
                runId,
                state,
                entry.child,
                entry.task,
                outcome.blocked,
                [],
              )
            ? "waits_for_artifact"
            : outcome.edits !== undefined &&
                this.continueAtCap(runId, state, entry.child, entry.task)
              ? "continue_at_cap"
              : outcome.restart !== undefined &&
                  this.restartOnce(
                    runId,
                    state,
                    entry.child,
                    entry.task.id,
                    outcome.restart.reason,
                    outcome.edits?.changed ?? [],
                    outcome.restart.account,
                  )
                ? "restart"
                : outcome.edits !== undefined &&
                    this.progressAttempt(runId, state, entry.child, entry.task)
                  ? "continue_at_cap"
                  : null;
      const again = cause !== null;
      if (again && outcome.edits) this.carryEdits(runId, state, entry, outcome.edits);
      if (!again) failure ??= outcome.error;
      this.store.transaction(() => {
        if (cause)
          this.store.taskStatus(runId, entry.task.id, "interrupted", null, {
            cause,
            ...(cause === "restart" && outcome.restart ? { detail: outcome.restart.reason } : {}),
            carried: outcome.edits !== undefined,
          });
        else {
          this.store.taskStatus(runId, entry.task.id, "blocked");
          if (
            outcome.error instanceof WorkflowFault &&
            outcome.error.details.unfinishedTask === entry.task.id &&
            outcome.account
          )
            this.recordUnfinished(
              runId,
              entry.child,
              entry.task.id,
              outcome.account,
              outcome.edits?.changed ?? [],
            );
        }
        this.store.finishStep(runId, entry.child, "failed");
        if (again) this.store.saveState(runId, state);
      });
    }
    return failure;
  }
  /**
   * A correction whose narrowed first attempt in its worktree did not finish runs again with every
   * file of its scope, keeping that attempt's edits, as on the single-writer path.
   */
  private widenCorrection(
    state: RuntimeState,
    entry: BatchEntry,
    outcome: Extract<WorkerOutcome, { kind: "rejected" }>,
  ): boolean {
    if (!outcome.narrowed || state.widenedCorrections.includes(entry.task.id)) return false;
    state.widenedCorrections.push(entry.task.id);
    return true;
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
  /**
   * The required checks the step's attempts last ran red, with the first lines of their output
   * (#1516): a restart or resume after a watcher stop starts from the failure itself, not only
   * from the stopped worker's account of it.
   */
  private failedChecksOf(
    runId: string,
    stepId: string,
    taskId: string,
  ): { id: string; output: string }[] {
    const last = new Map<string, { status: string; artifactId: string }>();
    for (const row of this.store.taskCheckRuns(runId, taskId))
      if (row.step_id === stepId)
        last.set(row.check_id, { status: row.status, artifactId: row.artifact_id });
    const failed: { id: string; output: string }[] = [];
    for (const [id, row] of last) {
      if (row.status !== "failed") continue;
      let output = "";
      try {
        output = String(
          (JSON.parse(this.store.readArtifact(runId, row.artifactId)) as { output?: unknown })
            .output ?? "",
        );
      } catch {}
      failed.push({ id, output: output.split("\n").slice(0, FAILED_CHECK_LINES).join("\n") });
    }
    return failed;
  }
  /**
   * Keeps the account of a task's attempt that blocked the run unfinished (#1516) where the next
   * session's prompt reads it (`previousAttempt`), so a resume starts from that attempt, not from
   * the one the restart replaced.
   */
  private recordUnfinished(
    runId: string,
    stepId: string,
    taskId: string,
    result: { summary: string; unresolved: string[] },
    changed: string[],
  ): void {
    const failedChecks = this.failedChecksOf(runId, stepId, taskId);
    this.store.artifact(
      runId,
      "recovery",
      `tasks/restarts/${taskId}.json`,
      canonical({
        taskId,
        stepId,
        reason: "blocked unfinished",
        carriedPaths: changed,
        summary: result.summary,
        unresolved: result.unresolved,
        ...(failedChecks.length ? { failedChecks } : {}),
      }),
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
    // A failed edit of the task's own file gets one attempt of its own, also after a restart (#1036).
    const editRetry = reason.startsWith(EDIT_RETRY);
    if (editRetry && (state.taskEditRetries[taskId] ?? 0) > 0) return false;
    if (!editRetry && (state.taskRestarts[taskId] ?? 0) > 0) return false;
    if (editRetry) state.taskEditRetries[taskId] = 1;
    // What the restart reuses of the attempt it replaces (#843): the files it carries and the
    // tokens that attempt spent, which count as reused only when files are carried.
    const interruptedTokens = this.store
      .attempts(runId)
      .filter((attempt) => attempt.step_id === stepId)
      .reduce((sum, attempt) => sum + (attempt.used_tokens ?? 0), 0);
    const failedChecks = this.failedChecksOf(runId, stepId, taskId);
    this.store.transaction(() => {
      state.taskRestarts[taskId] = 1;
      this.store.artifact(
        runId,
        "recovery",
        `tasks/restarts/${taskId}.json`,
        canonical({
          taskId,
          stepId,
          reason,
          carriedPaths,
          interruptedTokens,
          carriedTokens: carriedPaths.length ? interruptedTokens : 0,
          ...account,
          ...(failedChecks.length ? { failedChecks } : {}),
        }),
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
        ...this.cutOffChecks(runId, task.id),
      };
      const needed = reserveTokens(
        this.estimatePrompt(runId, state, policy, profile, extra),
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
      const kept = keepOutside(root, before, new Set(task.writes.map((w) => w.path)));
      await this.affectedBaseline(runId, entry.child, state, policy, task, signal, root);
      const earlierEdits = await this.applyCarry(runId, state, entry, root);
      // A correction's first attempt writes only where its findings point, as on the single-writer
      // path: parallel correctives had every file of their scope (url-shortener b69757cd T006 and
      // T007, md-site 11b11f19 T013 and T014, #1285).
      const narrow = state.widenedCorrections.includes(task.id)
        ? null
        : narrowCorrectionWrites(
            task,
            correctionFocus(this.store, runId, state, task).files,
            !staticCorrection(this.store, runId, policy, task),
          );
      const scoped: Task = narrow ? { ...task, writes: narrow } : task;
      if (narrow) state.narrowedCorrections[task.id] ??= narrow.map((w) => w.path);
      const currentChanges = async (): Promise<{
        after: Record<string, string>;
        changed: string[];
      }> => {
        const now = await sourceManifest(root, generatedPaths(policy), signal);
        return { after: now, changed: this.workerChanges(runId, entry, known, before ?? {}, now) };
      };
      let proseEnd = false;
      const result = this.settleSizeTargets(
        runId,
        task.id,
        ImplementationSchema.parse(
          await this.call(
            runId,
            entry.child,
            state,
            policy,
            entry.profile,
            entry.extra && typeof entry.extra === "object"
              ? {
                  ...entry.extra,
                  task: scoped,
                  ...(await this.correctionContext(runId, state, policy, root, task, narrow)),
                  ...this.recurringContext(runId, task),
                  ...(await this.libraryDocsContext(runId, policy, root, task)),
                  ...(earlierEdits ? { earlierEdits } : {}),
                  ...this.affectedTestsContext(root, state, policy, task),
                  ...this.writtenTestsContext(state, policy, task),
                }
              : entry.extra,
            signal,
            scoped,
            0,
            undefined,
            undefined,
            undefined,
            { root, attemptId: entry.attemptId },
          ).catch(async (error: unknown) => {
            if (capEnded(error))
              return this.capEndResult(
                runId,
                state,
                entry.child,
                task,
                error,
                async () => (await currentChanges()).changed,
              );
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
        ),
      );
      if (result.outcome === "spec_conflict" && result.taskId === task.id)
        return { kind: "conflict", entry, result };
      if (result.outcome === "implemented")
        await this.fixTaskFiles(runId, entry.child, root, policy, task, signal);
      await this.revertUnjournaled(
        runId,
        entry.child,
        task,
        root,
        kept,
        before,
        await currentChanges(),
        new Set(this.workerJournaled(runId, entry, known)),
      );
      const { after, changed } = await currentChanges();
      const outside = changed.filter((path) => !task.writes.some((w) => w.path === path));
      if (outside.length)
        return {
          kind: "rejected",
          entry,
          error: new WorkflowFault(
            "INPUT_CHANGED",
            `Task ${task.id} changed ${outside.length} file(s) outside its write scope: ${outside
              .slice(0, 5)
              .map((path) => describeChange(path, before ?? {}, after))
              .join(", ")}${outside.length > 5 ? ", ..." : ""}; its result is not integrated`,
          ),
        };
      const reproduced = await this.stillReproduces(
        runId,
        policy,
        task,
        result,
        changed,
        root,
        signal,
      );
      const restartReason = this.blockedRestartReason(
        runId,
        state,
        policy,
        entry.child,
        task,
        result,
        changed,
        proseEnd,
        reproduced,
      );
      const account = {
        summary: result.summary,
        unresolved: reproduced ? [...result.unresolved, reproduced] : result.unresolved,
      };
      const waits =
        changed.length === 0 && result.outcome === "blocked"
          ? this.missingArtifactOwnersOf(runId, state, task, result)
          : [];
      // A narrowed correction widens before it restarts, as on the single-writer path.
      if (restartReason && changed.length === 0 && !waits.length && !narrow)
        return {
          kind: "interrupted",
          entry,
          leaseLost: false,
          cause: "restart",
          reason: restartReason,
          account,
        };
      const refused = takeHashRefusals(root);
      const correction =
        reproduced ??
        (result.outcome === "implemented" && changed.length === 0
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
          : true);
      if (correction instanceof WorkflowFault)
        return { kind: "rejected", entry, error: correction };
      if (
        result.taskId !== task.id ||
        ["blocked", "failed"].includes(result.outcome) ||
        (result.unresolved.length > 0 && !ownCheckFailures(task, result, changed)) ||
        correction !== true
      )
        return {
          kind: "rejected",
          entry,
          ...(narrow ? { narrowed: true } : {}),
          ...(restartReason ? { restart: { reason: restartReason, account } } : {}),
          ...(changed.length ? { edits: { before, changed } } : { blocked: result }),
          error: new WorkflowFault(
            "OUTPUT_INVALID",
            `Task ${task.id} did not complete its implementation${incompleteReason(result.unresolved)}${correctionReason(correction)}${refusedReason(refused)}`,
            refused.length
              ? { reason: "input_changed", paths: refused }
              : { unfinishedTask: task.id },
          ),
          account: { summary: result.summary, unresolved: result.unresolved },
        };
      if (
        await this.cutOffCheckFailures(
          runId,
          state,
          policy,
          entry.child,
          task,
          changed,
          signal,
          root,
          (check) =>
            checks.run(() => this.runTaskCheck(runId, entry.child, check, policy, signal, root)),
        )
      )
        return {
          kind: "rejected",
          entry,
          continued: true,
          edits: { before, changed },
          error: new WorkflowFault(
            "OUTPUT_INVALID",
            `Task ${task.id} failed a required check after edits its cut-off attempt did not check`,
          ),
        };
      if (result.outcome === "already_satisfied")
        this.validateSatisfiedEvidence(runId, state, after, result);
      const results: WorkerCheck[] = [];
      for (const check of this.gatedChecks(runId, state, policy, task, root, changed)) {
        const checked = await checks.run(() =>
          this.runTaskCheck(runId, entry.child, check, policy, signal, root),
        );
        results.push({ check, checked });
      }
      return {
        kind: "done",
        entry,
        before,
        after,
        changed,
        checks: results,
        account: { summary: result.summary, unresolved: result.unresolved },
      };
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
          cause: leaseLost ? "lease_lost" : "worker_lost",
          ...(!leaseLost && before
            ? await this.lostWorkerEdits(runId, policy, entry, known, before)
            : {}),
          // An error of BAKED's own code is journaled with its stack, so its caller is known (#929).
          ...(thrownStack(error) ? { stack: thrownStack(error) } : {}),
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
    const journaled = this.workerJournaled(runId, entry, known);
    return [...new Set([...changedPaths(before, after), ...journaled])].sort();
  }
  /**
   * Puts back the files outside the task's writes that changed without a journaled edit of this
   * attempt, before the scope check (#1188): nothing the task wrote can have changed them, so a
   * stop on them blames the task for a host process and a plain resume repeats it. The put-back
   * paths are recorded with their hashes; a path with a journaled edit still fails the check.
   */
  private async revertUnjournaled(
    runId: string,
    stepId: string,
    task: Task,
    root: string,
    kept: ReadonlyMap<string, Buffer>,
    before: Record<string, string>,
    current: { after: Record<string, string>; changed: string[] },
    journaled: ReadonlySet<string>,
  ): Promise<string[]> {
    const stray = unjournaledOutside(
      current.changed,
      new Set(task.writes.map((w) => w.path)),
      journaled,
    );
    if (!stray.length) return stray;
    restoreOutside(root, kept, stray);
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        `tasks/${task.id}/reverted-outside-${stepId}.json`,
        canonical({
          taskId: task.id,
          stepId,
          reverted: stray.map((path) => ({
            path,
            before: before[path] ?? null,
            after: current.after[path] ?? null,
          })),
          note: "Changed outside the task's writes without a journaled edit of the attempt; put back before the scope check.",
        }),
      ),
    );
    return stray;
  }
  /** The paths the journaled edits of a worker's attempt changed in its worktree. */
  private workerJournaled(runId: string, entry: BatchEntry, known: Set<string>): string[] {
    return this.store
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
      ? await this.recheck(runId, state, entry, policy, signal, mainRoot)
      : outcome.checks;
    const failures: Review["findings"] = this.integrityFailures(
      runId,
      state,
      policy,
      task,
      mainRoot,
      Object.fromEntries(outcome.changed.map((p) => [p, outcome.before[p] ?? null])),
      outcome.changed,
    );
    if (this.testsPending(state, policy) && isTestTask(task)) {
      this.settleRed(runId, state, policy, task, entry.child, results, failures);
      return;
    }
    const evidence: string[] = [];
    let inconclusive: string | undefined;
    const settled = await this.fixFailedTaskChecks(
      runId,
      entry.child,
      state,
      policy,
      task,
      results,
      signal,
      mainRoot,
    );
    for (const { check, checked } of settled)
      inconclusive ??= this.applyTaskCheck(
        runId,
        state,
        task,
        check,
        checked,
        failures,
        evidence,
        policy,
      );
    this.inconclusiveTaskCheck(inconclusive, failures);
    await this.spawnedCheckOutput(runId, entry.child, policy, settled, failures, signal, mainRoot);
    if (outcome.account.unresolved.length && !failures.length && !results.length)
      failures.push(...this.unresolvedFindings(runId, state, task, outcome.account));
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
    if (!failures.length && !outcome.account.unresolved.length)
      await this.routeReportedDefect(
        runId,
        state,
        policy,
        task,
        entry.child,
        outcome.account,
        signal,
        mainRoot,
      );
  }
  /**
   * A required task check that failed and declares a fixer gets one host repair before it becomes
   * a finding and an LLM repair task: the fixer runs on every file the task writes (documentation
   * and data files too, which the fixer pass before the checks skips) and a check that sees a
   * changed file runs again. Only what the fixer cannot fix is repaired by a model (bench round 07,
   * pkgdrift T004 54k and md-site T009 71k for whitespace and lint findings).
   */
  /**
   * The output of a project check that a failing test runs as a child process (#1285). md-site
   * d486645a (bench round 34): the test `bun run typecheck exits successfully` failed with only
   * `Received: 2`, since the test printed the exit code and not the tsc diagnostics, so three
   * correctives in a row could not see the cause. When a failing test's name names the command of
   * another policy check, the host runs that check; when it fails too, its output becomes evidence
   * of the findings of the failed check, and their impact quotes its tail.
   */
  private async spawnedCheckOutput(
    runId: string,
    child: string,
    policy: RunPolicy,
    results: WorkerCheck[],
    failures: Review["findings"],
    signal: AbortSignal,
    root: string,
  ): Promise<void> {
    for (const { check, checked } of results) {
      if (checked.status !== "failed" || !checked.output) continue;
      const cited = failures.filter((f) => f.evidenceIds.includes(checked.evidenceId));
      if (!cited.length) continue;
      const tests = failingTestNames(checked.output);
      const spawned = policy.checks.find(
        (c) => c.id !== check.id && tests.some((name) => namesCheckCommand(name, c)),
      );
      if (!spawned) continue;
      const ran = await this.runTaskCheck(runId, child, spawned, policy, signal, root);
      if (ran.status !== "failed" || !ran.output?.trim()) continue;
      const tail = ran.output.trim().slice(-SPAWNED_OUTPUT_CHARS);
      for (const finding of cited) {
        finding.evidenceIds.push(ran.evidenceId);
        finding.impact =
          `${finding.impact}. The failing test runs the project's ${spawned.id} check (${[spawned.executable, ...spawned.args].join(" ")}); run on its own it fails with:\n${tail}`.slice(
            0,
            16000,
          );
      }
    }
  }
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
    state: RuntimeState,
    entry: BatchEntry,
    policy: RunPolicy,
    signal: AbortSignal,
    root: string,
  ): Promise<WorkerCheck[]> {
    const results: WorkerCheck[] = [];
    for (const check of this.gatedChecks(runId, state, policy, entry.task, root)) {
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
      writes: conflicts.map((path) => {
        const reason = task.writes.find((w) => w.path === path)?.reason;
        return {
          path,
          action: existsSync(workspacePath(mainRoot, path)) ? "modify" : "create",
          ...(reason ? { reason } : {}),
        };
      }),
    };
    const writers = (state.graph?.tasks ?? []).filter((candidate) =>
      candidate.writes.some((w) => conflicts.includes(w.path)),
    );
    const profile = this.requireProfile(profiles.find((p) => p.id === task.profileId));
    const before = await sourceManifest(mainRoot, generatedPaths(policy), signal);
    const known = new Set(this.store.effects(runId).map((e) => e.id));
    // A missed size target in the merged file is a note like a worker's, not an unresolved conflict (#1414).
    const result = this.settleSizeTargets(
      runId,
      task.id,
      ImplementationSchema.parse(
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
      ["blocked", "failed", "spec_conflict"].includes(result.outcome) ||
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
    const resolved = resolveEvidenceIds(
      [...currentEvidence(this.store, runId, run), ...currentEvidence(this.store, runId, current)],
      result.evidenceIds,
    );
    // An id that names no evidence of the run at all, such as the provider's id of the worker's
    // own probe call (md-site 337d16db T013 cited `exec-...`, #1281), is dropped when another id
    // still backs the result; a stale entry of the run is still rejected.
    const known = new Set(this.store.evidence(runId).map((e) => e.id));
    const rows = resolved.filter((id) => known.has(id));
    result.evidenceIds = rows.length ? rows : resolved;
    validateEvidence(this.store, runId, [run, current], result.evidenceIds);
  }
  /**
   * A task whose attempt changed nothing is satisfied, not blocked, when the checks it was created
   * for pass on the current files: a sibling task or an earlier correction already fixed the
   * cause (zoneslot 51f9d664 T007 and md-site 93fbee70 T010 reported passing tests and stopped the
   * run). The checks are the task's own and the ones its findings name. A planned task counts
   * only on a rerun (generation above 0): a repair invalidated it though it was already correct
   * (md-site 2707d602 T004 generation 3 blocked the run), while a first run that changed nothing
   * did not do its work. A rerun with no such check counts when its files are unchanged since its
   * last implementation. Otherwise it returns why the result is not accepted, for the message.
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
  ): Promise<true | string | WorkflowFault> {
    const rerun = (this.store.tasks(runId).find((t) => t.id === task.id)?.generation ?? 0) > 0;
    // An empty reason: the caller's message already says what the result left unfinished.
    if (
      result.taskId !== task.id ||
      result.outcome !== "implemented" ||
      result.unresolved.length > 0
    )
      return "";
    // A planned test task sent back with its tests-written failures (#1518) wrote its files in the
    // earlier attempt; one that keeps them leaves the failure to a correction.
    if (task.origin === "planned" && this.writtenTestsContinuation(runId, state, task)) return true;
    if (task.origin === "planned" && !rerun)
      return "it reported implemented but changed none of its files";
    const named = new Set(
      this.store
        .findings(runId)
        .filter((f) => task.findingIds.includes(f.id))
        .map((f) => /^Required check (\S+) failed$/.exec(JSON.parse(f.body_json).claim)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
    const regression = this.affectedRecord(state, task)?.checkId;
    const checks = [
      ...policy.checks.filter(
        (c) =>
          c.required && (named.has(c.id) || taskChecks(policy, task).some((t) => t.id === c.id)),
      ),
      ...this.gatedChecks(runId, state, policy, task, root).filter((c) => c.id === regression),
    ];
    if (!checks.length)
      return rerun && (await this.unchangedSinceImplemented(runId, task, policy, root, signal))
        ? true
        : "it changed none of its files and no required check of it confirms the work is already done";
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
      const named = checked.output
        ? failingFilesInOutput(checked.output, state.graph?.tasks ?? [])
        : [];
      return `it changed none of its files and check ${check.id} still fails${named.length ? ` on ${named.slice(0, 5).join(", ")}` : ""} (evidence ${checked.evidenceId})`;
    }
    return true;
  }
  /**
   * A corrective result that changed nothing, or reports the task already satisfied, is not
   * accepted while a finding it corrects still reproduces (#1158): the attempt's own refusals
   * are bounded, and an executor may not run them. Returns why the result is refused, or null.
   */
  private async stillReproduces(
    runId: string,
    policy: RunPolicy,
    task: Task,
    result: { taskId: string; outcome: string },
    changed: string[],
    root: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (result.taskId !== task.id) return null;
    if (
      result.outcome !== "already_satisfied" &&
      !(result.outcome === "implemented" && changed.length === 0)
    )
      return null;
    const live = (await this.reproCheck(runId, policy, task)?.(root, signal)) ?? [];
    if (!live.length) return null;
    return `it reported ${result.outcome.replace("_", " ")} but ${live.map((line) => line.split("\n")[0]?.replace(/^Finding /, "finding ")).join("; ")}`;
  }
  /**
   * Whether every file a rerun task writes is still what an earlier implementation of it left:
   * a repair invalidated the task for a change elsewhere, so its work is already done. Covers the
   * tasks with no required check to confirm it, such as a README and licence task (cimatrix
   * 5670e55c T010 stopped the run with an empty rerun, #1144).
   */
  private async unchangedSinceImplemented(
    runId: string,
    task: Task,
    policy: RunPolicy,
    root: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const written = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
    if (!written.length) return false;
    const left = new Map<string, string | null>();
    const diffs = this.store
      .artifacts(runId)
      .filter((a) => a.logical_path === `tasks/${task.id}/diff.json`)
      .sort((a, b) => a.revision - b.revision);
    for (const row of diffs) {
      const diff = JSON.parse(this.store.readArtifact(runId, row.id)) as {
        after?: Record<string, string | null>;
      };
      for (const [path, hash] of Object.entries(diff.after ?? {})) left.set(path, hash);
    }
    if (!written.every((path) => left.get(path))) return false;
    const now = await sourceManifest(root, generatedPaths(policy), signal);
    return written.every((path) => now[path] === left.get(path));
  }
  /**
   * Whether a correction's failing checks pass before its first attempt: another correction
   * already fixed the cause, so a worker would only confirm it (expenses-py e0c0447d T009 and
   * T010, 110k and 140k tokens for `already_satisfied`, #1033). Only a correction whose findings
   * are all failed required checks qualifies; the passing runs are kept as its evidence.
   */
  private async correctionPassing(
    runId: string,
    child: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (task.origin === "planned" || !task.findingIds.length) return false;
    if (uncommittedEdits(this.store, runId, task.id).length) return false;
    const findings = this.store.findings(runId).filter((f) => task.findingIds.includes(f.id));
    const named = findings.map((f) => {
      const claim = (JSON.parse(f.body_json) as { claim?: unknown }).claim;
      return typeof claim === "string"
        ? (/^Required check (\S+) failed$/.exec(claim)?.[1] ?? taskCheckOfClaim(claim))
        : null;
    });
    if (findings.length !== task.findingIds.length || named.some((id) => !id)) return false;
    // Only files that changed since the failures can have fixed them; a correction that starts
    // right after its failure would only run the check a second time.
    const failedOn = new Map(this.store.evidence(runId).map((e) => [e.id, e.snapshot_id]));
    const changedSince = findings.every((f) => {
      const evidence = (JSON.parse(f.body_json) as { evidenceIds?: string[] }).evidenceIds ?? [];
      const snapshots = evidence.map((id) => failedOn.get(id)).filter(Boolean);
      return snapshots.length > 0 && !snapshots.includes(state.snapshotId ?? "");
    });
    if (!changedSince) return false;
    const checks = policy.checks.filter((c) => c.required && named.includes(c.id));
    if (checks.length !== new Set(named).size) return false;
    const root = runRoot(this.store.workspace, state);
    const evidenceIds: string[] = [];
    for (const check of checks) {
      const checked = await this.runTaskCheck(runId, child, check, policy, signal, root);
      if (checked.status !== "passed") return false;
      evidenceIds.push(checked.evidenceId);
    }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        `tasks/${task.id}/already-passing.json`,
        canonical({ taskId: task.id, checks: checks.map((c) => c.id), evidenceIds }),
      ),
    );
    return true;
  }
  /**
   * A corrective task in its own worktree gets the files its findings point at, preloaded in
   * its worktree, as a single-writer run gives them; planned tasks of a batch are unchanged.
   */
  private async correctionContext(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    root: string,
    task: Task,
    narrow: Task["writes"] | null,
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
        ...(staticCorrection(this.store, runId, policy, task)
          ? { diagnostics: STATIC_DIAGNOSTICS }
          : {}),
        ...(narrow ? { scope: correctionScope(task, narrow) } : {}),
      },
    };
  }
  /**
   * The existing tests that reach the task's files (#634), for the implementer's context, with
   * the check that runs only them when a test check of the policy takes test files.
   */
  private affectedTestsContext(
    root: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
  ): { affectedTests?: { paths: string[]; checkId: string | null; note: string } } {
    if (!task.writes.length) return {};
    const record = this.affectedRecord(state, task);
    const found = record ? null : affectedTestsFor(root, policy.checks, task.writes);
    const paths = record?.paths ?? found?.tests.map((t) => t.path) ?? [];
    const checkId = record ? record.checkId : (found?.check?.id ?? null);
    if (!paths.length) return {};
    const intro = "Existing tests that exercise the files this task changes, nearest first.";
    let note = checkId
      ? `${intro} Keep them passing: run them with request_check ${checkId} after your edits and fix what your change broke before submitting.`
      : `${intro} Keep them passing: read the ones that cover the code you change before editing it.`;
    if (record?.baseline === "passed")
      note += ` They passed before this task, so ${checkId ?? "their check"} is required after it.`;
    else if (record?.baseline === "failed")
      note += ` They already failed before this task (evidence ${record.evidenceId ?? "none"}); do not take those failures for yours.`;
    return { affectedTests: { paths, checkId, note } };
  }
  /**
   * For a planned task that writes test files, the check of those files the host runs after it
   * (#1518). Bench round 43: the bun plans gave their test tasks only typecheck and lint, the
   * workers did not know they could run `tests-written`, and its failures after the attempts
   * became cold corrective tasks (41 percent of url-shortener, 23 percent of md-site).
   */
  private writtenTestsContext(
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
  ): { writtenTestsCheck?: { checkId: string; paths: string[]; note: string } } {
    if (task.origin !== "planned" || this.testsPending(state, policy)) return {};
    const planned = plannedWrittenTests(policy.checks, task.writes);
    if (!planned) return {};
    const checkId = planned.id;
    const suite = checkId.replace(/-written$/, "");
    if (taskChecks(policy, task).some((c) => c.id === suite)) return {};
    const paths = planned.paths;
    const seconds = Math.round(planned.timeoutMs / 1000);
    return {
      writtenTestsCheck: {
        checkId,
        paths,
        note: `After this task the host runs ${checkId}, required: the test files this task writes, on their own, within ${seconds} s. The host uses the same 30 s per-test default for this check and the full suite for bun test, jest and vitest, unless the project sets its own timeout. Run request_check ${checkId} once they are written and fix what fails before you submit: a test that fails or runs too long after you submit sends the task back to you with the output.`,
      },
    };
  }
  /** The affected-test record of a task, or of the task a corrective task repairs. */
  private affectedRecord(
    state: RuntimeState,
    task: Task,
  ): RuntimeState["affectedTests"][string] | undefined {
    const own = state.affectedTests[task.id];
    if (own) return own;
    for (const findingId of task.findingIds) {
      const base = state.repairPredecessors[findingId];
      const inherited = base ? state.affectedTests[base] : undefined;
      if (inherited) return inherited;
    }
    return undefined;
  }
  /**
   * Before a task's first attempt, records the existing tests that reach its files and runs the
   * check that runs only them, so a failure after the task can be told from one it found (#634).
   */
  private async affectedBaseline(
    runId: string,
    child: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    signal: AbortSignal,
    root: string,
  ): Promise<boolean> {
    if (!task.writes.length || this.affectedRecord(state, task)) return false;
    const { tests, check } = affectedTestsFor(root, policy.checks, task.writes);
    const checked = check
      ? await this.runTaskCheck(runId, child, check, policy, signal, root)
      : null;
    state.affectedTests[task.id] = {
      paths: tests.map((t) => t.path),
      checkId: check?.id ?? null,
      baseline: checked?.status ?? null,
      evidenceId: checked?.evidenceId ?? null,
    };
    return true;
  }
  /**
   * The task checks run after a task: its own, and the affected-test check, required, when it
   * passed before the task's first attempt and the task's checks do not already run that suite.
   */
  private gatedChecks(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    root: string,
    changed: readonly string[] = [],
  ): Check[] {
    const own = taskChecks(policy, task);
    const written = this.writtenTestsCheck(runId, state, policy, task, root, own, changed);
    const gated = written ? [...own, written] : own;
    const record = this.affectedRecord(state, task);
    if (record?.baseline !== "passed" || !record.checkId) return gated;
    const suite = record.checkId.replace(/-affected$/, "");
    if (own.some((c) => c.id === suite)) return gated;
    const gate = affectedTestCheck(
      policy.checks,
      record.paths.filter((path) => existsSync(workspacePath(root, path))),
    );
    return gate ? [...gated, { ...gate, required: true }] : gated;
  }
  /**
   * The test files a task writes, run on their own and required after it (#1271). url-shortener
   * aa8fbd5d (bench round 29): three test tasks had only typecheck and lint, so the property test
   * one of them wrote first ran in the final 300 s `tests` check, failed on its own size guard and
   * hung there, and the run blocked without a repair. A failing or hanging file now becomes a
   * correction of the task that wrote it, with a short timeout. Not under tests first, where the
   * new tests are meant to fail, and not while another task still writes code they may import.
   */
  private writtenTestsCheck(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    root: string,
    own: readonly Check[],
    changed: readonly string[],
  ): Check | null {
    if (this.testsPending(state, policy)) return null;
    const writes = this.writtenTestWrites(runId, state, task, changed);
    const gate = writtenTestsCheck(root, policy.checks, writes, taskCaseText(task));
    if (!gate) return null;
    const suite = gate.id.replace(/-written$/, "");
    if (own.some((c) => c.id === suite)) return null;
    const rows = this.store.tasks(runId);
    const done = (id: string): boolean =>
      rows.some(
        (r) =>
          r.id === id &&
          (r.status === "verified" ||
            (r.status === "implemented" && hasTaskGate(r, state.taskGates))),
      );
    const sources = (state.rootGraph ?? state.graph)?.tasks ?? [];
    const compiled = writes.some((w) => isCompiledTestFile(w.path));
    if (
      sources.some(
        (t) =>
          t.id !== task.id &&
          !done(t.id) &&
          t.writes.some(
            (w) => w.action !== "delete" && holdsWrittenTests(w.path, compiled, task.readHints),
          ),
      )
    )
      return null;
    return gate;
  }
  /**
   * The writes whose test files a task's tests-written check runs. A correction may write every
   * file of the tasks it repairs, so the check of all its test files ran the failing tests of
   * siblings still in flight and opened a correction of the correction (md-site T008 to T009,
   * 4.31M tokens; ranktally T011 to T012; bench round 37, #1373). A correction's check runs only
   * the test files its findings point at and the ones it changed itself (`changed`, before the
   * attempt's diff is recorded).
   */
  private writtenTestWrites(
    runId: string,
    state: RuntimeState,
    task: Task,
    changed: readonly string[] = [],
  ): Task["writes"] {
    if (task.origin === "planned" || !task.findingIds.length) return task.writes;
    const tests = task.writes.filter((w) => isWrittenTestFile(w.path));
    if (!tests.length) return tests;
    const scope = new Set([...correctionFocus(this.store, runId, state, task).files, ...changed]);
    for (const row of this.store.artifacts(runId)) {
      if (row.logical_path !== `tasks/${task.id}/diff.json`) continue;
      const diff = JSON.parse(this.store.readArtifact(runId, row.id)) as { changed?: string[] };
      for (const path of diff.changed ?? []) scope.add(path);
    }
    return tests.filter((w) => scope.has(w.path));
  }
  /**
   * Docs for the locked versions of the libraries a task uses, from the run's `libraryDocs`
   * source (#741); nothing without a source or when the source has no docs for them. Each lookup
   * is journaled with the task, found or not.
   */
  private async libraryDocsContext(
    runId: string,
    policy: RunPolicy,
    root: string,
    task: Task,
  ): Promise<Record<string, unknown>> {
    const source = policy.libraryDocs;
    if (!source) return {};
    const libraries = taskLibraries(root, task, lockedLibraries(root));
    if (!libraries.length) return {};
    const docs: (LockedLibrary & { docs: string })[] = [];
    for (const library of libraries) {
      const text = await fetchLibraryDocs(this.store.workspace, source, library, this.mcpCall);
      if (text) docs.push({ ...library, docs: text });
    }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        `tasks/${task.id}/library-docs-${newId()}.json`,
        canonical({
          taskId: task.id,
          libraries: libraries.map((library) => ({
            ...library,
            found: docs.some((d) => d.ecosystem === library.ecosystem && d.name === library.name),
          })),
        }),
      ),
    );
    return docs.length
      ? {
          libraryDocs: {
            libraries: docs,
            note: "Docs for the library versions the project's lockfile pins. Use the APIs they describe instead of what you remember from other versions.",
          },
        }
      : {};
  }
  /**
   * Writes a host-written task's files with the content its plan fixed, journaled as the task's
   * own edits so review, undo and delivery see them, with no agent attempt (#1460). A file that
   * already has that content is left as it is.
   */
  private writeHostFiles(
    runId: string,
    child: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
  ): void {
    const root = runRoot(this.store.workspace, state);
    const attempt = this.store.reserve(runId, child, null, 0, policy);
    for (const write of task.writes) {
      const content = Buffer.from(write.content ?? "", "utf8");
      const absolute = workspacePath(root, write.path);
      if (fileHash(absolute) === hashBytes(content)) continue;
      const before = this.store.transaction(() => capturePreImage(this.store, runId, absolute));
      this.journal.publish(runId, attempt, write.path, content, before, "file_patch", root);
    }
    this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
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
   * The test-integrity findings of a task's changes (#631). Each is recorded in
   * `tasks/TASK_ID/integrity.json`; under `testIntegrity: "block"` (the default) each becomes a
   * task failure that a repair must undo, under `warn` it stays a record.
   */
  /** Every path the task graph writes, for telling a task's own files from the others. */
  private plannedPaths(state: RuntimeState): string[] {
    return [...new Set((state.graph?.tasks ?? []).flatMap((t) => t.writes.map((w) => w.path)))];
  }
  /**
   * The failing tests or lint findings a task reported unresolved in its own files, as findings
   * of a corrective task when no task check ran to show them (#1110). The account is the evidence.
   */
  private unresolvedFindings(
    runId: string,
    state: RuntimeState,
    task: Task,
    account: { summary: string; unresolved: string[] },
  ): Review["findings"] {
    const writes = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
    // A failure that names another task's file (a README assertion before the README task ran)
    // is left to the checks and review of the whole feature: the task cannot fix it in its files.
    const others = this.plannedPaths(state).filter((path) => !writes.includes(path));
    const items = account.unresolved.filter(
      (item) => !others.some((path) => namesPath(item, path)),
    );
    if (!items.length) return [];
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "diff",
        `tasks/${task.id}/unresolved.json`,
        canonical({ taskId: task.id, ...account }),
      );
      return this.store.addEvidence(runId, "diff", state.snapshotId ?? "", artifact.id);
    });
    return items.map((item) => ({
      id: newId(),
      kind: "partial" as const,
      severity: "medium" as const,
      requirementIds: task.requirementIds,
      criterionIds: task.criterionIds,
      file: writes.find((path) => namesPath(item, path)) ?? writes[0] ?? null,
      symbol: null,
      evidenceIds: [evidenceId],
      claim: `Task ${task.id} reported unresolved in its own files: ${item.slice(0, 1500)}`,
      impact: "The task's own tests or lint fail, so its work is not done",
      suggestedFix: `Run the failing tests or lint of ${task.id}'s files, fix the cause and rerun them. Keep every test that matches the spec as written.`,
    }));
  }
  /**
   * Records the tests a correction added, by file and name, with the findings it corrects
   * (#1519): a later correction of another finding may not remove them. Tests it retitled or
   * merged are recorded with their new names, so that protection follows them (#1532).
   */
  private recordAddedTests(
    runId: string,
    task: Task,
    changes: readonly { path: string; before: string | null | undefined; after: string | null }[],
  ): void {
    const added: Record<string, string[]> = {};
    const renamed: Record<string, Record<string, string>> = {};
    for (const change of changes) {
      const tests = testChanges(change);
      if (tests?.added.length) added[change.path] = tests.added;
      if (tests && Object.keys(tests.renamed).length) renamed[change.path] = tests.renamed;
    }
    const path = `tasks/${task.id}/tests.json`;
    if (
      !Object.keys(added).length &&
      !Object.keys(renamed).length &&
      !this.store.latestArtifact(runId, path)
    )
      return;
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        path,
        canonical({ taskId: task.id, findingIds: task.findingIds, added, renamed }),
      ),
    );
  }
  /**
   * The tests that corrections of other findings added to the files a correction changed, with
   * who added them for which finding (#1519). intsmith ca6f3023 (bench round 43): T011 added the
   * width-10000 interval test for F1, T012 corrected F2 with every file of the feature in scope
   * and replaced it with a scalar test, and two more correctives (1.37M tokens) brought it back.
   * A protected test keeps its protection under the name a later task gave it, and the tests of
   * findings a settled conflict decided are not protected: the settlement may change them (#1532).
   */
  private correctionTests(
    runId: string,
    task: Task,
    changed: readonly string[],
  ): Map<string, Map<string, string>> {
    const own = new Set(task.findingIds);
    const decided = decidedFindingIds(this.store, runId);
    const files = new Set(changed);
    const protects = new Map<string, Map<string, string>>();
    for (const row of this.store.artifacts(runId)) {
      const match = /^tasks\/([^/]+)\/tests\.json$/.exec(row.logical_path);
      if (!match || match[1] === task.id) continue;
      const latest = this.store.latestArtifact(runId, row.logical_path);
      if (latest?.id !== row.id) continue;
      const body = JSON.parse(this.store.readArtifact(runId, row.id)) as {
        taskId?: string;
        findingIds?: string[];
        added?: Record<string, string[]>;
        renamed?: Record<string, Record<string, string>>;
      };
      for (const [path, renames] of Object.entries(body.renamed ?? {})) {
        const byName = protects.get(path);
        if (!byName) continue;
        for (const [from, to] of Object.entries(renames)) {
          const origin = byName.get(from);
          if (origin === undefined) continue;
          byName.delete(from);
          byName.set(to, origin);
        }
      }
      const findingIds = body.findingIds ?? [];
      if (
        !findingIds.length ||
        findingIds.some((id) => own.has(id)) ||
        findingIds.every((id) => decided.has(id))
      )
        continue;
      for (const [path, names] of Object.entries(body.added ?? {})) {
        if (!files.has(path)) continue;
        const byName = protects.get(path) ?? new Map<string, string>();
        for (const name of names)
          byName.set(name, `${body.taskId ?? match[1]} for finding ${findingIds.join(", ")}`);
        protects.set(path, byName);
      }
    }
    return protects;
  }
  private integrityFailures(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    root: string,
    before: Record<string, string | null>,
    changed: string[],
  ): Review["findings"] {
    const read = (path: string): string | null => {
      const absolute = workspacePath(root, path);
      if (!existsSync(absolute)) return null;
      const bytes = readFileSync(absolute);
      return bytes.length > MAX_INTEGRITY_BYTES ? null : bytes.toString("utf8");
    };
    const changes = changed.map((path) => {
      const hash = before[path] ?? null;
      // Earlier content that was not kept still existed: a deletion is reported, counts are not.
      const kept = hash === null ? null : readKept(this.store, runId, hash)?.toString("utf8");
      return { path, before: kept, after: read(path) };
    });
    const testSources = task.readHints
      .filter((path) => isTestPath(path) && !changed.includes(path))
      .slice(0, 20)
      .flatMap((path) => read(path) ?? []);
    // A correction of a spec amendment changes the tests that served the amended wording.
    const amendments = this.amendments(runId);
    const amending = amendments.some((a) => task.findingIds.includes(a.findingId));
    // A correction whose finding asks for its test file to be rewritten may drop assertions.
    const ownFindings = this.store
      .findings(runId)
      .filter((f) => task.findingIds.includes(f.id))
      .map((f) => JSON.parse(f.body_json) as Review["findings"][number]);
    const corrective = task.origin !== "planned" && task.findingIds.length > 0;
    if (corrective) this.recordAddedTests(runId, task, changes);
    const found = scanTestIntegrity(changes, {
      protects: corrective ? this.correctionTests(runId, task, changed) : undefined,
      rewrites: task.origin === "planned" ? new Set() : rewriteTargets(ownFindings),
      strengthens: task.origin === "planned" ? new Set() : strengthenTargets(ownFindings),
      reasoned: new Set([
        ...task.writes
          .filter((w) => w.reason || (amending && isTestPath(w.path)))
          .map((w) => w.path),
        ...amendments.flatMap((a) => a.paths),
      ]),
      testSources,
      specText: integrityRequirementText(state),
    });
    if (!found.length) return [];
    const mode = testIntegrityOf(policy);
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "diagnostic",
        `tasks/${task.id}/integrity.json`,
        canonical({ taskId: task.id, mode, findings: found }),
      );
      return this.store.addEvidence(runId, "diff", state.snapshotId ?? "", artifact.id);
    });
    if (mode === "warn") return [];
    return found.map((finding) => ({
      id: newId(),
      kind: "correctness" as const,
      severity: "high" as const,
      requirementIds: task.requirementIds,
      criterionIds: task.criterionIds,
      file: finding.path,
      symbol: null,
      evidenceIds: [evidenceId],
      claim: `Test integrity (${finding.rule}): task ${task.id} ${finding.detail} in ${finding.path}`,
      impact: "The tests no longer verify the behavior the spec requires",
      suggestedFix: integrityFix(finding),
    }));
  }
  /** Tests first is on and a person has not approved the tests yet. */
  private testsPending(state: RuntimeState, policy: RunPolicy): boolean {
    return testsFirstOf(policy) !== "off" && state.testsFirst?.approved !== true;
  }
  /**
   * The tasks that may run under tests first: only test tasks until a person approved the tests.
   * Once every test task has failed for the right reason and none is left, the tests are put to a
   * person and null is returned: the caller stops and the run waits. Auto-approved runs approve
   * the tests the same way.
   */
  private testsFirstReady(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    ready: Task[],
  ): Task[] | null {
    if (!this.testsPending(state, policy) || !state.graph) return ready;
    const tests = ready.filter(isTestTask);
    if (tests.length) return tests;
    const rows = this.store.tasks(runId);
    const all = state.graph.tasks.filter(isTestTask);
    const done = all.every((t) =>
      rows.some(
        (r) =>
          r.id === t.id &&
          ["implemented", "verified"].includes(r.status) &&
          hasTaskGate(r, state.taskGates),
      ),
    );
    if (!done) return [];
    const root = runRoot(this.store.workspace, state);
    const entries = all.map((task) => ({
      taskId: task.id,
      title: task.title,
      criterionIds: task.criterionIds,
      files: task.writes
        .filter((w) => w.action !== "delete")
        .map((w) => {
          const absolute = workspacePath(root, w.path);
          const content = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
          return { path: w.path, content: content.slice(0, MAX_TEST_CHARS) };
        }),
    }));
    const files = [...new Set(entries.flatMap((t) => t.files.map((f) => f.path)))];
    const digest = testsDigest(entries.flatMap((t) => t.files));
    const criteria = new Set(entries.flatMap((t) => t.criterionIds));
    const body = {
      testsFirst: {
        mode: testsFirstOf(policy),
        criteria: (state.spec?.criteria ?? [])
          .filter((c) => criteria.has(c.id))
          .map((c) => ({ id: c.id, text: `Given ${c.given}, when ${c.when}, then ${c.then}` })),
        tests: entries,
      },
    };
    const auto = this.store
      .requests(runId)
      .some(
        (r) =>
          r.kind === "approval" &&
          r.status === "accepted" &&
          r.actor === "auto-approval" &&
          !r.body_json.includes('"testsFirst"'),
      );
    state.testsFirst = { files, digest, approved: auto };
    if (auto) {
      this.store.transaction(() => {
        const id = this.store.request(runId, "approval", digest, body);
        this.store.decideRequest(runId, id, "accepted", { digest }, true);
        this.store.saveState(runId, state);
      });
      return ready;
    }
    this.queued.push({ kind: "approval", digest, body });
    return null;
  }
  /**
   * Settles a test task under tests first: its checks must show the new tests failing for the
   * right reason on the code as it is (tests-first.ts). Then the task gets its gate; otherwise the
   * reason becomes a finding that a correction of the tests must fix.
   */
  private settleRed(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    child: string,
    results: WorkerCheck[],
    failures: Review["findings"],
  ): void {
    const runs = results.map(({ check, checked }) => ({
      checkId: check.id,
      status: checked.status,
      ...(checked.output ? { output: checked.output } : {}),
    }));
    const problem = redProblem(task, runs);
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "diagnostic",
        `tests-first/${task.id}.json`,
        canonical({
          taskId: task.id,
          red: problem === null,
          problem,
          checks: runs.map((r) => ({ ...r, output: r.output?.slice(-4000) ?? null })),
        }),
      );
      return this.store.addEvidence(runId, "command", state.snapshotId ?? "", artifact.id);
    });
    const all = [...failures];
    if (problem)
      all.push({
        id: newId(),
        kind: "correctness",
        severity: "high",
        requirementIds: task.requirementIds,
        criterionIds: task.criterionIds,
        file: task.writes.find((w) => w.action !== "delete")?.path ?? null,
        symbol: null,
        evidenceIds: [evidenceId],
        claim: `Tests first: ${problem}`,
        impact: "The code would be written against tests that do not check the missing behavior",
        suggestedFix: `Rewrite the tests of ${task.id} so that they fail on the current code because the behavior of ${task.criterionIds.join(", ")} is missing, and pass once it is implemented.`,
      });
    if (all.length)
      this.store.transaction(() =>
        this.store.taskStatus(runId, task.id, "blocked", state.snapshotId),
      );
    this.settleTask(
      runId,
      state,
      policy,
      task,
      child,
      all,
      all.length ? [] : [evidenceId, ...results.map(({ checked }) => checked.evidenceId)],
    );
  }
  /**
   * The test-integrity scan at feature scope: every file the run changed, from its content before
   * the run to now, so a problem a repair left in place or one spread over several tasks is still
   * found. Recorded in `integrity/run.json`; under `block` the findings are recorded and repaired
   * like failed checks.
   */
  private runIntegrityFailures(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
  ): Review["findings"] {
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    if (!tasks.length) return [];
    const root = runRoot(this.store.workspace, state);
    const rootId = rootField(this.store.workspace, root).root ?? "";
    const baseline = new Map<string, string | null>();
    for (const effect of this.store.effects(runId)) {
      if (
        effect.kind !== "file_patch" ||
        !["applied", "reconciled"].includes(effect.status) ||
        intentRoot(effect.intent_json) !== rootId
      )
        continue;
      const path = (JSON.parse(effect.intent_json) as { path: string }).path;
      if (!baseline.has(path)) baseline.set(path, effect.before_hash);
    }
    // A change the journal did not see (a check fixer, a tool outside it) is in the task diffs.
    for (const artifact of this.store.artifacts(runId)) {
      if (!/^tasks\/[^/]+\/diff\.json$/.test(artifact.logical_path)) continue;
      const diff = JSON.parse(this.store.readArtifact(runId, artifact.id)) as {
        before?: Record<string, string | null>;
      };
      for (const [path, hash] of Object.entries(diff.before ?? {}))
        if (!baseline.has(path)) baseline.set(path, hash);
    }
    const changed = [...baseline.keys()].filter(
      (path) => fileHash(workspacePath(root, path)) !== baseline.get(path),
    );
    if (!changed.length) return [];
    const read = (path: string): string | null => {
      const absolute = workspacePath(root, path);
      if (!existsSync(absolute)) return null;
      const bytes = readFileSync(absolute);
      return bytes.length > MAX_INTEGRITY_BYTES ? null : bytes.toString("utf8");
    };
    // The findings of the run's corrections say which test files they may rewrite or strengthen.
    const corrected = this.store
      .findings(runId)
      .filter((f) =>
        (state.graph?.tasks ?? []).some(
          (t) => t.origin !== "planned" && t.findingIds.includes(f.id),
        ),
      )
      .map((f) => JSON.parse(f.body_json) as Review["findings"][number]);
    const found = scanTestIntegrity(
      changed.map((path) => {
        const hash = baseline.get(path) ?? null;
        const kept = hash === null ? null : readKept(this.store, runId, hash)?.toString("utf8");
        return { path, before: kept, after: read(path) };
      }),
      {
        rewrites: rewriteTargets(corrected),
        strengthens: strengthenTargets(corrected),
        reasoned: new Set([
          ...tasks.flatMap((t) => t.writes.filter((w) => w.reason).map((w) => w.path)),
          ...this.amendments(runId).flatMap((a) => a.paths),
        ]),
        specText: integrityRequirementText(state),
      },
    );
    if (!found.length) return [];
    const mode = testIntegrityOf(policy);
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "diagnostic",
        "integrity/run.json",
        canonical({ mode, findings: found }),
      );
      return this.store.addEvidence(runId, "diff", state.snapshotId ?? "", artifact.id);
    });
    if (mode === "warn") return [];
    const failures = found.flatMap((finding) => {
      const owner = tasks.findLast((t) => t.writes.some((w) => w.path === finding.path));
      if (!owner) return [];
      return [
        {
          id: newId(),
          kind: "correctness" as const,
          severity: "high" as const,
          requirementIds: owner.requirementIds,
          criterionIds: owner.criterionIds,
          file: finding.path,
          symbol: null,
          evidenceIds: [evidenceId],
          claim: `Test integrity (${finding.rule}): the run ${finding.detail} in ${finding.path}`,
          impact: "The tests no longer verify the behavior the spec requires",
          suggestedFix: integrityFix(finding),
        },
      ];
    });
    if (!failures.length) return [];
    return this.recordFindings(runId, {
      schemaVersion: 1,
      snapshotHash: state.workspaceHash ?? "",
      verdict: "changes_requested",
      coverage: [],
      findings: failures,
    });
  }
  /**
   * A task reported that the spec and the tests cannot both hold. It stops without fitting the
   * tests: it is ready again, and the run asks a person which one is right. The answer joins the
   * request the task's next attempt reads. Under `clarification: assume` too, since every default
   * here would be to fit the tests or to drop a requirement, unless one side of the conflict is what
   * the request states: then the request wins once per task, as a person answered "defer to the
   * brief" in bench round 15 (envguard 8b8b7022, structpad 6c8758ed), and the decision is recorded.
   * When the other side is a test an implemented test task of the plan wrote, the approved spec
   * wins over that test, also once per task: the task may then write the test file and runs
   * again (#967, cfgtrace 49dbf63b: correctives that could only change the source asked a person
   * three times about tests that contradicted the spec). A documentation task whose report sets
   * the rule for examples against the request's worked example copies that example (#992).
   */
  private specConflict(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    child: string,
    task: Task,
    result: Implementation,
  ): void {
    const account = { taskId: task.id, summary: result.summary, unresolved: result.unresolved };
    const report = [result.summary, ...result.unresolved].join(" ");
    const assumedPath = `assumptions/conflicts/${task.id}.json`;
    const first =
      policy.clarification === "assume" && !this.store.latestArtifact(runId, assumedPath);
    // A documentation task torn between the rule for examples and the request's worked example
    // copies the request's example (#992).
    const example = first && writesOnlyDocs(task) && namesExampleRule(report);
    const assume = first && (example || namesRequestSide(report));
    // One side is what the platform cannot do at all: no person can choose it, so the nearest
    // feasible behavior the task named holds (#1384).
    const platform = first && !assume && namesPlatformLimit(report);
    // The test files of the conflict: those the report names, and those the task's last failing
    // check names, since reports often cite a test by function only (tonemath 241fc475, #1459).
    const failing = this.failedCheckOutput(runId, task.id);
    const named = (tasks: Task[]): string[] => [
      ...new Set([
        ...pathsInOutput(report, tasks),
        ...(failing ? failingFilesInOutput(failing, tasks) : []),
      ]),
    ];
    // The conflict is with a reviewer's repro: it still reproduces while every required check
    // passes, so its expected value is the finding's claim, not the spec (intsmith ca6f3023,
    // #1517). The approved spec and the request win over it.
    const reproduced =
      first && !assume && !platform && !failing ? this.reproducedFindings(runId, task) : [];
    const repro = reproduced.length > 0;
    const tests =
      first && !assume && !platform && !repro
        ? this.conflictingTests(runId, state, task, named)
        : [];
    const own =
      first && !assume && !platform && !repro && !tests.length
        ? this.ownRunTests(runId, state, task, named)
        : [];
    // Two parts of the approved spec disagree, a criterion and a requirement: the requirement
    // wins, unless a test the run did not write is involved, which stays a question (#1459).
    const ranked =
      first && !assume && !platform && !repro && state.spec
        ? criterionAgainstRequirement(state.spec, report)
        : null;
    const foreign = named((state.rootGraph ?? state.graph)?.tasks ?? [task]).filter(
      (path) =>
        isTestPath(path) &&
        (state.testsFirst?.files.includes(path) || !this.createdByRun(runId, state, path)),
    );
    const amended = ranked && !foreign.length ? ranked : null;
    const byRequirement = amended && !tests.length && !own.length;
    const amendmentPath = `amendments/conflict-${task.id}.json`;
    const amendment: SpecAmendment | null = amended && {
      findingId: `conflict-${task.id}`,
      criterionIds: amended.criterionIds,
      requirementIds: amended.requirementIds,
      paths: [...own, ...tests.map((t) => t.path)],
      claim: report.slice(0, 1500),
      suggestedFix: `Read ${amended.criterionIds.join(", ")} as ${amended.requirementIds.join(", ")} state.`,
      authority: "requirement",
    };
    const assumed = example
      ? "The request's worked example is authoritative: copy it verbatim"
      : assume
        ? "The request is authoritative"
        : platform
          ? "The platform cannot carry or represent what one side demands: the nearest feasible behavior the task named holds"
          : repro
            ? `The approved spec and the request win over the repros of ${reproduced.join(", ")}: they still print the finding's claim while every required check passes`
            : byRequirement
              ? `The requirements ${amended.requirementIds.join(", ")} win over the criteria ${amended.criterionIds.join(", ")} that contradict them`
              : null;
    const freed = task.findingIds.length
      ? ` The repros of ${task.findingIds.join(", ")} no longer gate the task.`
      : "";
    this.store.transaction(() => {
      this.store.artifact(
        runId,
        "diagnostic",
        `tasks/conflicts/${task.id}.json`,
        canonical(account),
      );
      if (assumed) {
        this.store.artifact(runId, "assumption", assumedPath, canonical({ ...account, assumed }));
        // Like a person's answer, the assumption decides the findings the task corrects, so a
        // repro that expects what the assumption overrules no longer gates it (#1350, #1407).
        recordConflictDecision(this.store, runId, {
          requestId: `assumed-${task.id}`,
          taskId: task.id,
          findingIds: task.findingIds,
          answer: `Assumed under clarification assume (${assumedPath}): ${assumed}.`,
        });
      }
      if (amendment) this.store.artifact(runId, "assumption", amendmentPath, canonical(amendment));
      this.store.taskStatus(runId, task.id, "interrupted", null, { cause: "spec_conflict" });
      this.store.finishStep(runId, child, "failed");
    });
    // Every later agent reads the amendment, so reviews do not raise the criterion again.
    if (amendment) state.prompt += `\n${amendmentNote(amendmentPath, amendment)}`;
    if (byRequirement) {
      state.prompt += `\nAssumed under clarification assume (${assumedPath}): task ${task.id} reported that criteria of the approved spec contradict its requirements: ${report.slice(0, 1500)} ${assumed} (${amendmentPath}): implement what ${amended.requirementIds.join(", ")} state, and where a test this run wrote follows the contradicting criterion, change only that assertion to what the requirements state; weaken no other test.${freed} Report implemented or already_satisfied, not spec_conflict.`;
      return;
    }
    if (repro) {
      state.prompt += `\nAssumed under clarification assume (${assumedPath}): task ${task.id} reported that a reviewer's repro contradicts the approved spec: ${report.slice(0, 1500)} ${assumed}. Keep the behavior the spec and the checks require, correct what the finding's claim says is wrong (a comment, a docstring or a stated bound may be the only thing to fix), and do not change the code to print the repro's expected value.${freed} Report implemented or already_satisfied, not spec_conflict.`;
      return;
    }
    if (platform) {
      state.prompt += `\nAssumed under clarification assume (${assumedPath}): task ${task.id} reported that the platform cannot do what a criterion, a test or a finding demands: ${report.slice(0, 1500)} Implement the nearest feasible behavior the report names (for a value a protocol cannot carry, its standard serialized form). Where a test this run wrote asserts the impossible value, change only that assertion to the feasible behavior; weaken no other test.${freed} Report implemented or already_satisfied, not spec_conflict.`;
      return;
    }
    if (example) {
      state.prompt += `\nAssumed under clarification assume (${assumedPath}): task ${task.id} reported that the rule for documentation examples contradicts the request: ${report.slice(0, 1500)} The request is authoritative: copy every example output the request or the spec gives into the documentation exactly as given, even when its files are not in the workspace, and name the copied examples in the summary. Run probes only for examples the request does not give.${freed}`;
      return;
    }
    if (assume) {
      state.prompt += `\nAssumed under clarification assume (${assumedPath}): task ${task.id} reported that the spec or its tests contradict the request: ${report.slice(0, 1500)} The request is authoritative: follow what it states. Where a criterion, a requirement or a test says otherwise, the request wins; a test that contradicts the request is changed to what the request states, and no other test is weakened.${freed}`;
      return;
    }
    if (own.length) {
      // md-site a652d8fc (bench round 22): a correction met a test this run generated and could
      // rewrite, but stopped rather than change a test. Two things the run wrote are never a
      // question for a person: the spec and the request win, and the task corrects its test.
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "assumption",
          assumedPath,
          canonical({
            ...account,
            assumed: `The approved spec and the request win over ${own.join(", ")}, which this run wrote`,
            tests: own,
          }),
        ),
      );
      state.prompt += `\nAssumed under clarification assume (${assumedPath}): task ${task.id} reported that tests this run wrote contradict the approved spec: ${report.slice(0, 1500)} The approved spec and the request win over ${own.join(", ")}, which this run wrote and ${task.id} may write: change only the assertions there that contradict them to what they state, keep every other assertion and test, and make the code pass.`;
      return;
    }
    if (tests.length) {
      const paths = tests.map((t) => t.path);
      const findings = this.recordFindings(runId, {
        schemaVersion: 1,
        snapshotHash: state.workspaceHash ?? "",
        verdict: "changes_requested",
        coverage: [],
        findings: tests.map(({ path, owner }) => ({
          id: newId(),
          kind: "correctness" as const,
          severity: "high" as const,
          requirementIds: owner.requirementIds,
          criterionIds: owner.criterionIds,
          file: path,
          symbol: null,
          evidenceIds: [],
          claim: `${path} contradicts the approved spec (reported by ${task.id}): ${report.slice(0, 1200)}`,
          impact: `${task.id} cannot satisfy both the spec and this test`,
          suggestedFix: `Change only the assertions in ${path} that contradict the approved spec to what the spec states. Keep every other assertion; weaken or remove none.`,
        })),
      });
      this.store.transaction(() => {
        this.store.artifact(
          runId,
          "assumption",
          assumedPath,
          canonical({
            ...account,
            assumed: `The approved spec wins over ${tests.map((t) => `${t.path} (written by ${t.owner.id})`).join(", ")}`,
            tests: paths,
          }),
        );
        const before = new Set(state.graph?.tasks.map((t) => t.id));
        this.repair(runId, state, policy, findings, "repair", "task");
        // The task runs again once the tests that contradicted the spec are corrected.
        const correctives = (state.graph?.tasks ?? []).filter((t) => !before.has(t.id));
        state.waitingFor[task.id] = [
          ...(state.waitingFor[task.id] ?? []),
          ...correctives.map((t) => t.id),
        ];
      });
      state.prompt += `\nAssumed under clarification assume (${assumedPath}): task ${task.id} reported that tests contradict the approved spec: ${report.slice(0, 1500)} The approved spec wins over ${paths.join(", ")}: a correction of the test task changes only the assertions that contradict the spec, and ${task.id} runs again after it.`;
      return;
    }
    // A person already answered a conflict of this task: the task runs once more under that
    // answer instead of asking the same question again (#1350, url-shortener asked it 3 times).
    const answered = conflictDecisions(this.store, runId).filter((d) => d.taskId === task.id);
    const last = answered.at(-1);
    const reapplied = last && `tasks/conflicts/${task.id}-under-${last.requestId}.json`;
    if (last && reapplied && !this.store.latestArtifact(runId, reapplied)) {
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "assumption",
          reapplied,
          canonical({ ...account, decision: `${CONFLICT_DECISION_PREFIX}${last.requestId}.json` }),
        ),
      );
      state.prompt += `\nTask ${task.id} reported the spec conflict a person already answered (${CONFLICT_DECISION_PREFIX}${last.requestId}.json): ${last.answer.slice(0, 1500)} That answer is final and the question is not asked again: finish ${task.id} under it, reporting implemented or already_satisfied, not spec_conflict.`;
      return;
    }
    this.wait("clarification", state, {
      questions: [
        {
          id: `SPEC-CONFLICT-${task.id}`,
          question: `Task ${task.id} (${task.title}) reports that the spec and the tests cannot both hold: ${result.summary}${result.unresolved.length ? ` ${result.unresolved.join(" ")}` : ""} Which one is right? The task runs again with your answer; it may not weaken the tests to fit.${last ? ` It already ran under your earlier answer and reported the conflict again; earlier answer: ${last.answer.slice(0, 800)}` : ""}`,
          blocking: true,
        },
      ],
      specConflict: account,
    });
  }
  /**
   * The findings of a corrective task whose repros still reproduced in its latest repro check
   * (#1517). Empty for a planned task or one whose repros were never run.
   */
  private reproducedFindings(runId: string, task: Task): string[] {
    if (!task.findingIds.length) return [];
    const row = this.store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith(`tasks/${task.id}/repro-check-`))
      .at(-1);
    if (!row) return [];
    const body = JSON.parse(this.store.readArtifact(runId, row.id)) as {
      outcomes?: { findingId?: unknown; status?: unknown }[];
    };
    return (body.outcomes ?? [])
      .filter((o) => o.status === "reproduced" && typeof o.findingId === "string")
      .map((o) => o.findingId as string)
      .filter((id) => task.findingIds.includes(id));
  }
  /**
   * The test files a conflict report names that the task itself may write and that this run
   * created: absent from the baseline snapshot (or, without one, created by a task of the plan).
   * Tests written first and approved by a person, and tests that existed before the run, stay a
   * question.
   */
  private ownRunTests(
    runId: string,
    state: RuntimeState,
    task: Task,
    named: (tasks: Task[]) => string[],
  ): string[] {
    const found = named([task]);
    // A test task whose conflict names no file conflicts with the tests it writes (#1459).
    const paths = found.length || !isTestTask(task) ? found : task.writes.map((w) => w.path);
    return paths.filter(
      (path) =>
        isTestPath(path) &&
        task.writes.some((w) => w.path === path && w.action !== "delete") &&
        !state.testsFirst?.files.includes(path) &&
        this.createdByRun(runId, state, path),
    );
  }
  /**
   * Whether this run created a file: absent from the baseline snapshot, or, without one, created
   * by a task of the plan.
   */
  private createdByRun(runId: string, state: RuntimeState, path: string): boolean {
    const baselineId = state.manifest.baselineSnapshotId;
    const baseline = baselineId ? this.store.snapshotFiles(runId, baselineId) : null;
    if (baseline) return !(path in baseline);
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    return tasks.some((t) => t.writes.some((w) => w.path === path && w.action === "create"));
  }
  /** The output of the checks whose latest run in a task's attempts failed, joined (#1459). */
  private failedCheckOutput(runId: string, taskId: string): string {
    const latest = new Map<string, { status: string; artifact_id: string }>();
    for (const row of this.store.taskCheckRuns(runId, taskId)) latest.set(row.check_id, row);
    const outputs: string[] = [];
    for (const row of latest.values()) {
      if (row.status !== "failed") continue;
      try {
        outputs.push(
          String(
            (JSON.parse(this.store.readArtifact(runId, row.artifact_id)) as { output?: unknown })
              .output ?? "",
          ),
        );
      } catch {}
    }
    return outputs.join("\n");
  }
  /**
   * The test files a conflict report names that the task cannot write and that an implemented test
   * task of the plan wrote. Tests written first and approved by a person stay a question.
   */
  private conflictingTests(
    runId: string,
    state: RuntimeState,
    task: Task,
    named: (tasks: Task[]) => string[],
  ): { path: string; owner: Task }[] {
    const root = state.rootGraph ?? state.graph;
    if (!root) return [];
    const implemented = new Set(
      this.store
        .tasks(runId)
        .filter((t) => t.status === "implemented")
        .map((t) => t.id),
    );
    return named(root.tasks).flatMap((path) => {
      if (task.writes.some((w) => w.path === path) || state.testsFirst?.files.includes(path))
        return [];
      const owner = root.tasks.find(
        (t) =>
          t.id !== task.id &&
          implemented.has(t.id) &&
          isTestTask(t) &&
          t.writes.some((w) => w.path === path && w.action !== "delete"),
      );
      return owner ? [{ path, owner }] : [];
    });
  }
  /**
   * The open correctives of a sibling test task's failed check whose failing tests import a source
   * that the failing tests of planned test task `task` import too: one defect there fails both.
   */
  private sharedSourceCorrections(
    runId: string,
    state: RuntimeState,
    task: Task,
    check: Check,
    output: string,
  ): string[] {
    if (task.origin !== "planned" || !isTestCheck(check) || !state.graph) return [];
    const rootTasks = (state.rootGraph ?? state.graph).tasks;
    const failing = failingFilesInOutput(output, rootTasks).filter(
      (path) => isTestPath(path) && task.writes.some((w) => w.path === path),
    );
    if (!failing.length) return [];
    const root = runRoot(this.store.workspace, state);
    const sources = [
      ...new Set(
        rootTasks.flatMap((t) =>
          t.writes.filter((w) => w.action !== "delete" && !isTestPath(w.path)).map((w) => w.path),
        ),
      ),
    ];
    const mine = new Set(importedFiles(root, failing, sources, 1));
    if (!mine.size) return [];
    const status = new Map(this.store.tasks(runId).map((r) => [r.id, r.status]));
    return state.graph.tasks
      .filter(
        (t) =>
          t.origin !== "planned" &&
          ["pending", "running", "invalidated", "interrupted"].includes(
            status.get(t.id) ?? "pending",
          ) &&
          t.findingIds.some((id) => {
            const predecessor = rootTasks.find((p) => p.id === state.repairPredecessors[id]);
            if (!predecessor || predecessor.id === task.id || !isTestTask(predecessor))
              return false;
            const tests = (state.repairScope[id] ?? []).filter(isTestPath);
            return importedFiles(root, tests, sources, 1).some((path) => mine.has(path));
          }),
      )
      .map((t) => t.id);
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
    policy?: RunPolicy,
  ): string | undefined {
    if (checked.status === "passed") checkEvidence.push(checked.evidenceId);
    if (!check.required || checked.status === "passed") return undefined;
    if (
      checked.status === "failed" &&
      checked.output &&
      this.staticDebt(runId, state, policy, check, checked.output, checked.evidenceId)
    )
      return undefined;
    // The check fails exactly as before any change and names no file the task writes: the task
    // did not cause it and a correction could not reach it (dur 741547f0: Biome rejected the
    // scaffold's `biome.json`, which no task writes; T004 spent 38k tokens on `src/duration.ts`,
    // #1218). The checks stage still runs the check and stops with `baseline_failure`.
    if (
      checked.status === "failed" &&
      checked.output &&
      !failingFilesInOutput(checked.output, [task]).length &&
      this.failsAsBaseline(runId, state, check, checked.output)
    )
      return undefined;
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
    // A corrective task that fails only on test files other correctives are fixing waits for them
    // instead of opening a corrective of itself (#1285).
    if (!owners.length && checked.status === "failed" && checked.output)
      owners.push(
        ...siblingCorrections(
          state.graph,
          this.store.tasks(runId),
          task,
          checked.output,
          state.repairPredecessors,
        ),
      );
    // A test task whose failing tests reach a source a sibling's open corrective is already fixing
    // waits for it: one defect failed two parallel test tasks and opened two correctives
    // (url-shortener b69757cd T006 and T007, 634k tokens, #1285). Its check runs again afterwards.
    if (!owners.length && checked.status === "failed" && checked.output)
      owners.push(...this.sharedSourceCorrections(runId, state, task, check, checked.output));
    if (owners.length) {
      // contrastgrid d372ea22: main.tsx imported App.tsx of a task that had not run, and a repair
      // agent started for a failure the owner resolves. The check runs again when the owners are done.
      state.deferredChecks[task.id] = owners;
      this.store.transaction(() =>
        this.store.taskStatus(runId, task.id, "implemented", state.snapshotId),
      );
      return undefined;
    }
    const updaters =
      checked.status === "failed" && checked.output
        ? testUpdateOwners(
            state.rootGraph ?? state.graph,
            this.store.tasks(runId),
            state.taskGates,
            task,
            checked.output,
          )
        : [];
    if (updaters.length) {
      // mdtoc-update (bench round 14): the change breaks expectations a later task of the plan
      // updates; a corrective task rewrote that task's tests. That task's own checks run them.
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "diagnostic",
          `tasks/handoffs/${task.id}.json`,
          canonical({
            taskId: task.id,
            checkId: check.id,
            evidenceId: checked.evidenceId,
            owners: updaters,
          }),
        ),
      );
      return undefined;
    }
    this.store.transaction(() =>
      this.store.taskStatus(runId, task.id, "blocked", state.snapshotId),
    );
    if (checked.status === "inconclusive") return check.id;
    // The existing tests that reach the task's files passed before it: the task's change broke
    // them, so its repair fixes that change even when the failing tests are files it may not write.
    const regression = check.id === this.affectedRecord(state, task)?.checkId;
    // Files the output names that this task may not write: a repair of the task gets the ones
    // the run's other tasks own (commitbump cd842f0f: fmt of tests/docs.rs failed on src/*.rs).
    const rootTasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    const named = checked.output ? failingFilesInOutput(checked.output, rootTasks) : [];
    const outside = named.filter((path) => !task.writes.some((w) => w.path === path));
    // A regression's repair fixes the task's change, so it leaves alone the tests that planned
    // tasks still to run update (#972).
    const owned = outside.filter(
      (path) =>
        rootTasks.some(
          (t) => t.profileId === task.profileId && t.writes.some((w) => w.path === path),
        ) &&
        !(
          regression &&
          pendingWriters(
            state.rootGraph ?? state.graph,
            this.store.tasks(runId),
            state.taskGates,
            task,
            path,
          ).length
        ),
    );
    // Every file the output names is one this task cannot get write access to: a repair would
    // end "outside this task's approved write scope" after attempts that change nothing.
    if (!regression && named.length && outside.length === named.length && !owned.length)
      throw new WorkflowFault(
        "RECOVERY_REQUIRED",
        `out_of_scope_failure: check ${check.id} fails on ${outside.slice(0, 5).join(", ")}, which ${task.id} may not write and no task of its profile owns (evidence ${checked.evidenceId}). Fix those files or revise the plan, then resume.`,
        { reason: "no_progress" },
      );
    // A linter or formatter names each file it rejects, and its diagnostics are fixed in those
    // lines: the correction starts there, not from the whole task (cfgtrace 424e275b T013: 1.56M
    // tokens and two new test files for three ruff rules, #1067).
    const diagnosed =
      !regression && isStaticCheck(check) && !isTestCheck(check)
        ? named.filter((path) => task.writes.some((w) => w.path === path))
        : [];
    const findingId = newId();
    // A failing test of the task reaches the code it tests through its imports: the correction's
    // first attempt writes the failing tests and those planned sources, not every file of the
    // related tasks (md-site 337d16db: three correctives with 8 or 9 paths each, #1285).
    // Output that names no file (a timeout, a bare assertion) still fails on the task's own
    // tests: the ones the check's arguments name, or the only test file the task writes
    // (url-shortener 4c3137f0, bench round 36: a timed-out tests-written check of one property test
    // file opened a correction of five files, 1.52M tokens, #1285).
    const ownTests = task.writes
      .filter((w) => w.action !== "delete" && isTestPath(w.path))
      .map((w) => w.path);
    const argued = ownTests.filter((path) => check.args.some((arg) => arg.includes(path)));
    const failingTests =
      !regression && isTestCheck(check)
        ? named.some(isTestPath)
          ? named.filter((path) => isTestPath(path) && task.writes.some((w) => w.path === path))
          : argued.length
            ? argued
            : ownTests.length === 1
              ? ownTests
              : []
        : [];
    const sources = failingTests.length
      ? importedFiles(runRoot(this.store.workspace, state), failingTests, [
          ...new Set(
            rootTasks.flatMap((t) =>
              t.writes
                .filter((w) => w.action !== "delete" && !isTestPath(w.path))
                .map((w) => w.path),
            ),
          ),
        ])
      : [];
    const scope = [
      ...new Set([...diagnosed, ...owned, ...(sources.length ? failingTests : []), ...sources]),
    ];
    if (scope.length) state.repairScope[findingId] = scope;
    const signature = checked.output ? failingLines(checked.output) : "";
    taskFailures.push({
      id: findingId,
      kind: "correctness",
      severity: "high",
      requirementIds: task.requirementIds,
      criterionIds: task.criterionIds,
      // One failing test file is where the failure shows, and the correction starts there.
      file: failingTests.length === 1 && sources.length ? (failingTests[0] ?? null) : null,
      symbol: null,
      evidenceIds: [checked.evidenceId],
      claim: regression
        ? `Task ${task.id} broke existing tests: check ${check.id} passed before the task and fails after it`
        : `Task ${task.id} required check ${check.id} failed`,
      // The failing lines identify the defect, so a correction of a correction that leaves the
      // same failure is recognized as a repeat (#1285).
      impact: signature
        ? `Dependent tasks cannot run. Failing: ${signature}`
        : "Dependent tasks cannot run",
      suggestedFix: regression
        ? `Fix the change ${task.id} made so the existing tests pass again and repeat ${check.id}; change a test only when the task's requirements change the behavior it expects.`
        : diagnosed.length
          ? `Fix the ${check.id} diagnostics in the files the check output names (${scope.slice(0, 5).join(", ")}) and repeat ${check.id}. Change only what the diagnostics require: no behavior changes and no new tests.`
          : owned.length
            ? `Fix ${task.id} and the files the check output names (${owned.slice(0, 5).join(", ")}) and repeat ${check.id}.`
            : `Fix ${task.id} within its approved paths and repeat ${check.id}.`,
    });
    // A correction keeps the generated inputs the task requires, and its own check knows the
    // number from this text (#1367). Only after a timeout: on an assertion failure the note sent
    // the correction after speed instead of the defect (#1373).
    const last = taskFailures.at(-1);
    const timedOut = /timed out after|did not finish within/.test(checked.output ?? "");
    if (last && !regression && timedOut && check.minCases !== undefined)
      last.suggestedFix += ` Keep at least ${String(check.minCases)} generated inputs, as ${task.id} requires: make each case cheap so ${check.id} finishes within ${String(check.timeoutMs)} ms rather than generating fewer.`;
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
   * any other mode on; without the field it runs only on a vendor other than the implementation's
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
    if (policy.critic) return critic;
    const routing = this.routingRecord(runId);
    const modelOf = (profile: AgentProfile) =>
      routing?.profiles[profile.id]?.model ?? profile.model;
    const implementation = profiles
      .filter((p) => p.output === "implementation")
      .map((p) => modelVendor(modelOf(p)));
    return implementation.includes(modelVendor(modelOf(critic))) ? null : critic;
  }
  /**
   * The run's critic calibration, computed once from the project's outcome log (earlier runs
   * only) and frozen as `critic/calibration.json`, with the examples the critic is shown.
   */
  private criticCalibration(
    runId: string,
  ): CriticCalibration & { examples: ReturnType<typeof criticExamples> } {
    const path = "critic/calibration.json";
    const kept = this.store.latestArtifact(runId, path);
    if (kept)
      return JSON.parse(this.store.readArtifact(runId, kept.id)) as CriticCalibration & {
        examples: ReturnType<typeof criticExamples>;
      };
    const rows = this.store.criticOutcomes().filter((r) => r.run_id !== runId);
    const calibration = { ...calibrateCritic(rows), examples: criticExamples(rows) };
    this.store.transaction(() =>
      this.store.artifact(runId, "critic-calibration", path, canonical(calibration)),
    );
    return calibration;
  }
  /**
   * Why `critic: earlyStop` accepts the remaining convergence findings instead of another repair,
   * or null when it does not: the critic must be calibrated, every required check must pass, every
   * scored task's latest attempt must score at the calibrated threshold, and no finding may be
   * critical, a security finding or high with a reproduction the host ran.
   */
  private criticEarlyStop(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    findings: Review["findings"],
  ): { threshold: number; scores: Record<string, number>; why: string } | null {
    if (policy.critic !== "earlyStop" || !findings.length) return null;
    const calibration = this.criticCalibration(runId);
    if (!calibration.calibrated || calibration.threshold === null) return null;
    if (!requiredChecksPass(this.store, runId, state, policy)) return null;
    if (
      findings.some(
        (f) =>
          f.severity === "critical" ||
          f.kind === "security" ||
          (f.severity === "high" && f.repro !== undefined),
      )
    )
      return null;
    const scores: Record<string, number> = {};
    for (const task of state.graph?.tasks ?? []) {
      const kept = this.store.latestArtifact(runId, `tasks/${task.id}/critique.json`);
      if (!kept) continue;
      const record = JSON.parse(this.store.readArtifact(runId, kept.id)) as {
        critique?: { score: number };
      };
      if (!record.critique) return null;
      scores[task.id] = record.critique.score;
    }
    const values = Object.values(scores);
    const threshold = calibration.threshold;
    if (!values.length || values.some((v) => v < threshold)) return null;
    return {
      threshold,
      scores,
      why: `Every required check passes and every task scores at least ${threshold.toFixed(2)} (calibrated on ${String(calibration.samples)} attempts, AUC ${(calibration.auc ?? 0).toFixed(2)}); ${String(findings.length)} finding(s) none critical, security or high with a reproduction are accepted instead of another repair.`,
    };
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
    const examples = policy.critic === "off" ? [] : this.criticCalibration(runId).examples;
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
            ...(examples.length
              ? {
                  earlierAttempts: {
                    examples,
                    note: "Scored attempts of this project and how they turned out: held up (checks passed and the code stayed) or did not (repaired, rejected, reverted or mostly rewritten). Use them to judge what this project keeps.",
                  },
                }
              : {}),
          },
          signal,
        ),
      );
      const critique = { ...output, taskId: task.id };
      record({ critique });
      this.store.transaction(() =>
        this.store.recordCriticScore(
          runId,
          task.id,
          attempt,
          critic.model,
          critique.score,
          critique.rubric,
        ),
      );
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
   * Routes a defect a task names in another task's file to that file's owner at once (#839). A
   * test task may not edit the source it exposes a defect in, so it names the file in its summary
   * and reports implemented; until now nothing acted on that before the checks stage, and every
   * later test task paid for the same failure (cfgtrace 276e4858: four test tasks, 1.94M tokens,
   * named env_source.py). When the account names a file an implemented task writes, the run's
   * required feature checks run once; the findings of a failing one on the named files become a
   * corrective task of their owner, with the failing check as the repro. A failing check with a
   * fixer first runs it on the named files and runs again (#969). The account alone starts
   * nothing: without a failing check there is no evidence of a defect.
   */
  private async routeReportedDefect(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    task: Task,
    child: string,
    account: { summary: string; unresolved: string[] },
    signal: AbortSignal,
    root: string,
  ): Promise<void> {
    const graph = state.graph;
    if (!graph || !state.rootGraph) return;
    const rows = this.store.tasks(runId);
    if (rows.find((r) => r.id === task.id)?.status !== "implemented") return;
    if (this.store.latestArtifact(runId, `tasks/defects/${task.id}.json`)) return;
    const done = new Set(
      rows.filter((r) => ["implemented", "verified"].includes(r.status)).map((r) => r.id),
    );
    const text = [account.summary, ...account.unresolved].join("\n");
    const files = [
      ...new Set(
        graph.tasks
          .filter((t) => t.id !== task.id && done.has(t.id))
          .flatMap((t) => t.writes.filter((w) => w.action !== "delete").map((w) => w.path))
          .filter((path) => !task.writes.some((w) => w.path === path) && namesPath(text, path)),
      ),
    ];
    if (!files.length) return;
    const findings: Review["findings"] = [];
    const ran: { checkId: string; status: string; evidenceId: string; fixed?: true }[] = [];
    // Each named file belongs to the last implemented task that writes it, as in the checks stage.
    const owners = new Map<string, string>();
    for (const t of graph.tasks)
      if (t.id !== task.id && done.has(t.id))
        for (const write of t.writes)
          if (files.includes(write.path) && write.action !== "delete") owners.set(write.path, t.id);
    // A plan that writes the tests last has none on disk yet: a test runner that collects no test
    // then fails (pytest exit 5) without any defect in the named files (#1031).
    const plannedTests = graph.tasks.flatMap((t) =>
      t.writes.filter((w) => w.action !== "delete" && isTestPath(w.path)).map((w) => w.path),
    );
    const testsPending =
      plannedTests.length > 0 &&
      !plannedTests.some((path) => existsSync(workspacePath(root, path)));
    // Findings not yet resolved, in correction (`confirmed`) or waiting for it: a failure they name is not
    // charged to this report again (#1146).
    const open = this.store
      .findings(runId)
      .filter((f) => f.status === "open" || f.status === "confirmed")
      .map((f) => JSON.parse(f.body_json) as Review["findings"][number]);
    const covered: { checkId: string; findingIds: string[] }[] = [];
    for (const check of policy.checks.filter((c) => c.required && c.scope === "feature")) {
      let checked = await this.runTaskCheck(runId, child, check, policy, signal, root);
      if (checked.status === "failed" && testsPending && noTestsCollected(checked.output ?? "")) {
        ran.push({ checkId: check.id, status: "no_tests", evidenceId: checked.evidenceId });
        continue;
      }
      // A failure the check's fixer settles (`cargo fmt` on the named files) is no defect to route:
      // run the fixer as the checks stage does, journaled as `apply_fix`, and rerun the check
      // once; only what remains becomes a corrective task (#969).
      let fixed = false;
      if (
        checked.status === "failed" &&
        check.fix &&
        (await this.fixFiles(runId, child, root, policy, [check], owners, signal))
      ) {
        fixed = true;
        await this.snapshot(runId, state, policy, signal);
        checked = await this.runTaskCheck(runId, child, check, policy, signal, root);
      }
      ran.push({
        checkId: check.id,
        status: checked.status,
        evidenceId: checked.evidenceId,
        ...(fixed ? { fixed: true as const } : {}),
      });
      if (checked.status !== "failed") continue;
      const claim = `Required check ${check.id} failed`;
      if (failuresCovered(checked.output ?? "", open)) {
        covered.push({ checkId: check.id, findingIds: open.map((f) => f.id) });
        continue;
      }
      // A file whose failure of this check is already an open finding is in correction.
      const pending = files.filter(
        (file) => !open.some((f) => f.claim === claim && f.file === file),
      );
      if (!pending.length) {
        covered.push({
          checkId: check.id,
          findingIds: open.filter((f) => f.claim === claim).map((f) => f.id),
        });
        continue;
      }
      const failed = failedCheckFindings(
        check,
        checked.evidenceId,
        checked.output ?? "",
        state.rootGraph.tasks,
        task,
        `${task.id} reported a defect in ${files.join(", ")}: ${account.summary.slice(0, 600)} Run the failing tests of evidence ${checked.evidenceId} first and fix the cause in the source; the tests stay as written.`,
        newId,
      );
      // Output that names planned files decides who owns the failure; output that names none
      // (a bare assertion) is the reporting task's account of where the defect is.
      const named = failed.filter((f) => f.file !== null && pending.includes(f.file));
      const unnamed = failed.every((f) => f.file === null);
      // A failure placed on a named file is the file's owner's, with its requirements: the
      // reporting task wrote none of it.
      const owned = (file: string, f: Review["findings"][number]) => {
        const owner = graph.tasks.find((t) => t.id === owners.get(file));
        return owner
          ? {
              ...f,
              id: newId(),
              file,
              requirementIds: owner.requirementIds,
              criterionIds: owner.criterionIds,
            }
          : { ...f, id: newId(), file };
      };
      findings.push(
        ...(named.length || !unnamed
          ? named
          : pending.flatMap((file) => failed.map((f) => owned(file, f)))),
      );
    }
    this.store.transaction(() =>
      this.store.artifact(
        runId,
        "diagnostic",
        `tasks/defects/${task.id}.json`,
        canonical({
          taskId: task.id,
          files,
          checks: ran,
          findings: findings.map((f) => f.id),
          ...(covered.length ? { covered } : {}),
        }),
      ),
    );
    if (!findings.length) return;
    const recorded = this.recordFindings(runId, {
      schemaVersion: 1,
      snapshotHash: state.workspaceHash ?? "",
      verdict: "changes_requested",
      coverage: [],
      findings,
    });
    this.repair(runId, state, policy, recorded, "repair", "task");
    this.store.transaction(() => this.store.saveState(runId, state));
  }
  /**
   * Whether a correction whose own checks failed goes back to itself once, with the failures,
   * instead of opening a correction of the correction (#1285). The new correction started over
   * without the earlier one's context, from the union of the plan's files: bench round 35,
   * url-shortener 651b2693 T007 broke a property test and T008 was opened for it with all 7
   * files; round 34 chained md-site d486645a T008 -> T011 -> T012 on one failing test. Only
   * failures of the task's checks qualify, each with its command output; a failure the
   * continuation leaves opens the correction of the correction as before.
   */
  private continueCorrection(
    runId: string,
    state: RuntimeState,
    task: Task,
    child: string,
    failures: Review["findings"],
  ): boolean {
    if ((state.taskContinuations[task.id] ?? 0) > 0) return false;
    // A planned task that writes tests continues on its own test files' failures (#1518).
    const planned = task.origin === "planned";
    if (planned && !task.writes.some((w) => isWrittenTestFile(w.path))) return false;
    // The checks the correction was opened for, and the files it changed: a failure of another
    // check on files it did not touch belongs to that file's correction, not to this one.
    const openedFor = new Set(
      this.store
        .findings(runId)
        .filter((row) => task.findingIds.includes(row.id))
        .flatMap((row) => {
          const claim = (JSON.parse(row.body_json) as { claim?: unknown }).claim;
          const check =
            typeof claim === "string"
              ? (/^Required check (\S+) failed$/.exec(claim)?.[1] ?? taskCheckOfClaim(claim))
              : null;
          return check ? [check] : [];
        }),
    );
    const diff = this.store.latestArtifact(runId, `tasks/${task.id}/diff.json`);
    const changed = diff
      ? ((JSON.parse(this.store.readArtifact(runId, diff.id)) as { changed?: string[] }).changed ??
        [])
      : [];
    const graph = state.graph;
    const failed: { id: string; output: string }[] = [];
    for (const finding of failures) {
      const check = taskCheckOfClaim(finding.claim);
      const output = check ? this.commandOutput(runId, finding.evidenceIds) : null;
      if (!check || !output) return false;
      const regression = finding.claim.includes(" broke existing tests: ");
      const touched =
        graph !== null &&
        failingFilesInOutput(output, graph.tasks).some((path) => changed.includes(path));
      if (planned ? !check.endsWith("-written") : !regression && !openedFor.has(check) && !touched)
        return false;
      failed.push({
        id: check,
        output: `${finding.claim}. ${finding.impact}\n${output}`.slice(-CONTINUED_OUTPUT_CHARS),
      });
    }
    this.store.transaction(() => {
      state.taskContinuations[task.id] = 1;
      delete state.deferredChecks[task.id];
      this.store.artifact(
        runId,
        "recovery",
        `tasks/${task.id}/cut-off-checks.json`,
        canonical({
          taskId: task.id,
          stepId: child,
          finalizedBy: null,
          reason: planned ? "written_tests" : "correction",
          failed,
        }),
      );
      this.store.taskStatus(runId, task.id, "interrupted", null, { cause: "continue_at_cap" });
      this.store.finishStep(runId, child, "failed");
      this.store.saveState(runId, state);
    });
    return true;
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
    if (taskFailures.length && this.continueCorrection(runId, state, task, child, taskFailures))
      return;
    this.store.transaction(() =>
      this.store.criticTaskResult(runId, task.id, taskFailures.length ? "repaired" : "passed"),
    );
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
      this.repair(runId, state, policy, recorded, "repair", "task");
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
        // The task checks a corrective task was created for passed: the host's finding that they
        // failed no longer holds. A run without a review stage has nothing else to close it (#866).
        const passed = new Set(
          this.store
            .checks(runId)
            .filter((c) => checkEvidence.includes(c.evidence_id))
            .map((c) => c.check_id),
        );
        for (const finding of this.store.findings(runId)) {
          const failed = taskCheckOfClaim(JSON.parse(finding.body_json).claim);
          if (
            task.findingIds.includes(finding.id) &&
            ["open", "confirmed"].includes(finding.status) &&
            failed &&
            passed.has(failed)
          )
            this.store.findingStatus(runId, finding.id, "resolved");
        }
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
            // A task only reached through an import keeps its implementation too when a check
            // guards it: its own checks of any scope, or a required feature check, which the checks
            // stage runs on the result; a failure becomes a repair. Rerunning its agent repeats
            // work the import did not change (cfgtrace b4427c85: one file of T024 reran five
            // tasks for 2.0M tokens, one with an empty diff, #1248).
            const reach =
              finished && changedFiles ? changeReach(root, candidate, changedFiles) : null;
            // A task whose every written file a corrective task rewrote is superseded there: its
            // agent would start from its original description and overwrite the correction
            // (md-site a586cde0 T003 ran three times, T006 four). Its checks decide instead.
            // Any declared check counts: a test task whose only check is a feature-scope build or
            // test command (Java `verify`) is protected by it too (propdrift 90c09da7 T006, 114k).
            // A documentation task is rechecked unless the repair changed a file it writes: the
            // README reads the code it documents, and its agent reran after correctives that left
            // the documented usage as it was (idpeek a270ff5a T021: 645k tokens across two reruns,
            // one only reporting already_satisfied, #1211). The review stages still read the
            // README and run its examples in the host.
            const documented =
              finished &&
              changedFiles !== null &&
              documentsOnly(candidate) &&
              !candidate.writes.some((write) => changedFiles.has(write.path));
            const superseded =
              reach === "named" &&
              rewritten !== null &&
              declaredChecks(policy, candidate).length > 0 &&
              ownsOnly(candidate, rewritten);
            if (
              reach === "none" ||
              documented ||
              superseded ||
              (reach === "imports" &&
                (declaredChecks(policy, candidate).length > 0 ||
                  policy.checks.some((check) => check.scope === "feature" && check.required)))
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
      if (
        result.status === "failed" &&
        check.required &&
        this.staticDebt(runId, state, policy, check, result.output, result.evidenceId)
      ) {
        passedIds.push(check.id);
        continue;
      }
      if ((result.status === "failed" || regression) && check.required) {
        if (!regression)
          this.assertNotBaselineFailure(runId, state, check, result.output, result.evidenceId);
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
      failures.push(...(await this.qualityFindings(runId, stepId, state, policy, signal)));
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
    const kept = keepOutside(root, before, new Set(owners.keys()));
    const attempt = this.store.beginHostAttempt(runId, stepId);
    const scope = new ProcessScope();
    let changed = false;
    // Unsignalled, so the put-back also runs after the pass was aborted.
    const changedOutside = async () =>
      changedPaths(before, await sourceManifest(root, generated)).filter(
        (path) => !owners.has(path),
      );
    // The pre-image of every owner file, kept current across the pass: a fixer that formats more
    // than its path (`cargo fmt -- <path>` formats the whole crate) rewrites later files in an
    // earlier file's run, and each of those changes is journaled with its true before hash. A
    // pre-image taken right before a file's own run already held the formatted content, so its
    // edit read before == after and a restarted task saw the file as changed outside it (#1269).
    const images = new Map(
      paths.map((path) => [path, capturePreImage(this.store, runId, workspacePath(root, path))]),
    );
    const journal = (path: string, check: Check, preImage: string | null) =>
      this.store.transaction(() =>
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
      try {
        for (const check of fixable) {
          // One fixer run on `targets`, each journaled with its pre-image; a change it makes to
          // another owner file is journaled too, with that file's true before hash.
          const run = async (
            command: { executable: string; args: string[] },
            targets: string[],
          ) => {
            signal.throwIfAborted();
            this.leases.assert(lease);
            const effects = targets.map((path) => ({
              path,
              id: journal(path, check, images.get(path) ?? null),
            }));
            try {
              // A fixer that cannot fix everything exits non-zero; the rerun check decides.
              await executeCheckCommand(
                scope,
                command.executable === "bun" ? process.execPath : command.executable,
                command.args,
                {
                  cwd: check.cwd === "." ? root : workspacePath(root, check.cwd),
                  env: buildCheckEnv(check),
                  timeoutMs: check.timeoutMs,
                  signal,
                  sandbox: runSandbox(policy, root, { gitWrite: root !== this.store.workspace }),
                },
              );
            } catch (error) {
              for (const effect of effects)
                this.store.transaction(() => this.store.effectStatus(runId, effect.id, "unknown"));
              throw error;
            }
            for (const effect of effects) {
              const target = workspacePath(root, effect.path);
              const after = fileHash(target);
              this.store.transaction(() => this.store.finishFileEffect(runId, effect.id, after));
              if (after === (images.get(effect.path) ?? null)) continue;
              changed = true;
              images.set(effect.path, capturePreImage(this.store, runId, target));
            }
            for (const other of paths) {
              if (targets.includes(other)) continue;
              const otherTarget = workspacePath(root, other);
              const otherAfter = fileHash(otherTarget);
              const otherBefore = images.get(other) ?? null;
              if (otherAfter === otherBefore) continue;
              const otherId = journal(other, check, otherBefore);
              this.store.transaction(() => this.store.finishFileEffect(runId, otherId, otherAfter));
              images.set(other, capturePreImage(this.store, runId, otherTarget));
              changed = true;
            }
          };
          for (const fix of fixerTiers(check)) {
            // A whole-unit formatter (`cargo fmt`) rewrites the whole crate whatever file it is
            // given: one run for all the code files instead of one per file (#1269, #842).
            if (isWholeUnitFixer(fix)) {
              const code = paths.filter(isCodePath);
              if (code.length) await run(wholeUnitFixerCommand(fix, code), code);
              continue;
            }
            for (const path of paths) await run(fixerCommand(fix, path), [path]);
          }
        }
      } finally {
        // Also when a fixer run throws: a whole-crate formatter may already have rewritten files.
        restoreOutside(root, kept, await changedOutside());
      }
      // Judged on the whole pass too: `cargo fmt -- <path>` formats the whole crate, so the run on
      // an already formatted file can rewrite a later one, whose own run then finds nothing to do
      // (bytelens-update a11ea789 T004, #1228).
      if (!changed)
        changed = changedPaths(before, await sourceManifest(root, generated, signal)).some((path) =>
          owners.has(path),
        );
      const outside = await changedOutside();
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
    // A harden run's score before: the module's mutants against the tests it starts with.
    const preset = presetOf(parseRunDefinition(this.store.run(runId).definition_json));
    if (
      preset === HARDEN_PRESET &&
      mutationOf(policy, preset) !== "off" &&
      !this.store.latestArtifact(runId, QUALITY_MUTATION_BASELINE)
    ) {
      const before = await this.mutate(
        runId,
        state,
        policy,
        "advisory",
        await this.hardenModule(state),
        signal,
      );
      this.store.transaction(() =>
        this.store.artifact(runId, "quality", QUALITY_MUTATION_BASELINE, canonical(before)),
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
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<Review["findings"]> {
    const blocking = [
      ...(await this.duplicationFindings(runId, state, policy)),
      ...(await this.ruleFindings(runId, state, policy)),
      ...(await this.sastFindings(runId, state, policy)),
    ];
    blocking.push(...this.propertyFindings(runId, state, policy));
    // Mutants run the tests many times; code that is about to change again is not worth it.
    if (!blocking.length)
      blocking.push(...(await this.mutationFindings(runId, stepId, state, policy, signal)));
    return blocking.slice(0, 100);
  }
  /**
   * The property library of each language the project has, found once per run and kept in
   * `quality/property-libraries.json`, so every agent and every gate of the run sees the same.
   */
  private propertyLibraries(runId: string, state: RuntimeState): Record<string, boolean> {
    const kept = this.store.latestArtifact(runId, QUALITY_PROPERTY_LIBRARIES);
    if (kept) return JSON.parse(this.store.readArtifact(runId, kept.id)) as Record<string, boolean>;
    const root = runRoot(this.store.workspace, state);
    const libraries = propertyLibraries({
      ...libraryFiles(root),
      pythonImports: (module) => {
        const python =
          process.platform === "win32"
            ? (Bun.which("python") ?? Bun.which("py"))
            : (Bun.which("python3") ?? Bun.which("python"));
        if (!python) return null;
        const probe = Bun.spawnSync([python, "-c", `import ${module}`], {
          cwd: root,
          env: buildSafeEnv(),
          stdout: "ignore",
          stderr: "ignore",
          timeout: 5_000,
        });
        return probe.exitCode === 0;
      },
    });
    this.store.transaction(() =>
      this.store.artifact(runId, "quality", QUALITY_PROPERTY_LIBRARIES, canonical(libraries)),
    );
    return libraries;
  }
  /**
   * Property-based tests (#637): every criterion the spec marks with `property` needs a property
   * test in a test file of a task that covers it. A missing one is a blocking finding on that
   * file, so the correction writes it; the result is kept for the run report.
   */
  private propertyFindings(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
  ): Review["findings"] {
    const mode = propertyTestsOf(
      policy,
      presetOf(parseRunDefinition(this.store.run(runId).definition_json)),
      state.requestText || state.prompt,
    );
    const criteria = state.spec?.criteria ?? [];
    if (mode === "off" || !state.snapshotId || !criteria.some((c) => c.property)) return [];
    const root = runRoot(this.store.workspace, state);
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    const result = checkPropertyTests(
      mode,
      criteria,
      tasks,
      (path) => {
        try {
          return readFileSync(workspacePath(root, path), "utf8");
        } catch {
          return null;
        }
      },
      this.propertyLibraries(runId, state),
    );
    const evidenceId = this.store.transaction(() => {
      const artifact = this.store.artifact(runId, "quality", QUALITY_PROPERTIES, canonical(result));
      return this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
    });
    const missing = result.criteria.filter((c) => c.status === "missing");
    if (!missing.length) {
      this.resolveClaims(runId, propertyClaim);
      return [];
    }
    return missing.map((c) => {
      const owner = tasks.find((t) => t.criterionIds.includes(c.id));
      const file =
        c.tests[0]?.file ?? owner?.writes.find((w) => w.action !== "delete")?.path ?? null;
      const finding = this.qualityFinding(state, {
        kind: "missing",
        file: file ?? "",
        evidenceId,
        claim: `Property test missing for ${c.id}: the criterion holds over ${c.domain} inputs, and no test file of its tasks has a property-based test`,
        impact: "Example tests miss edge inputs of the domain the criterion covers.",
        suggestedFix: `${c.note ? `Remove the fallback: ${c.note}. ` : ""}Add a property-based test for ${c.id}${file ? ` in ${file}` : ""} with the property library the project has (fast-check, Hypothesis, proptest, jqwik, rapid, FsCheck), or without one a generator with a fixed seed in the project's test framework, that generates inputs over the whole ${c.domain} domain and asserts the criterion, or a loop over every value of a bounded domain of at least 100 values. Do not add a dependency for it.`,
      });
      return {
        ...finding,
        file,
        criterionIds: [c.id],
        requirementIds:
          state.spec?.criteria.find((x) => x.id === c.id)?.requirementIds ?? finding.requirementIds,
      };
    });
  }
  /**
   * The mutation gate (#636): plants small faults in the lines the run added, one at a time,
   * and runs the policy's required test checks against each, or lets an installed ecosystem tool
   * do it (#702). Surviving mutants are blocking findings under `required`, owned by the task
   * that writes a related test file so the correction adds a test that kills them; a survivor
   * the equivalence check finds cannot change behavior is dropped first. Under `advisory` they
   * are notes in the run report.
   */
  private async mutationFindings(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<Review["findings"]> {
    const preset = presetOf(parseRunDefinition(this.store.run(runId).definition_json));
    const mode = mutationOf(policy, preset);
    if (mode === "off" || !state.snapshotId) return [];
    // A harden run changes no code: its mutants go into the module its tasks test.
    const harden = preset === HARDEN_PRESET;
    const files = harden
      ? await this.hardenModule(state)
      : await this.changedFiles(runId, state, isCodePath);
    // Nothing waits for an advisory score, so the review starts while it runs in a copy (#1147).
    if (mode === "advisory" && !harden && (await this.mutateBeside(runId, state, policy, files)))
      return [];
    // A harden run compares its score with the module's before it, so both use the same mutants.
    let result = await this.mutate(runId, state, policy, mode, files, signal, {
      ...(mode === "required" && !harden ? { proposeIn: stepId } : {}),
    });
    const record = (value: MutationResult) =>
      this.store.transaction(() => {
        const artifact = this.store.artifact(runId, "quality", QUALITY_MUTATION, canonical(value));
        return this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
      });
    let evidenceId = record(result);
    if (result.mutants.some((m) => m.blocking)) {
      const judged = await this.equivalentMutants(
        runId,
        stepId,
        state,
        policy,
        result,
        files,
        evidenceId,
        signal,
      );
      if (judged.equivalent.size || judged.note) {
        result = scoreMutants(
          {
            ...result,
            mutants: result.mutants.map((m) => {
              const why = judged.equivalent.get(m.id);
              return why ? { ...m, status: "equivalent" as const, equivalence: why } : m;
            }),
            ...(judged.note ? { note: [result.note, judged.note].filter(Boolean).join("; ") } : {}),
          },
          files,
          policy.mutationThresholds,
        );
        evidenceId = record(result);
      }
    }
    const blocking = result.mutants.filter((m) => m.blocking);
    if (!blocking.length) {
      this.resolveClaims(runId, mutationClaim);
      return [];
    }
    return this.mutantFindings(state, blocking.slice(0, MAX_MUTANTS), evidenceId, result.engine);
  }
  /**
   * Starts the advisory mutation gate in a task worktree checked out from the run's current
   * content, so mutants planted there never reach the files the review reads. Returns false
   * when no copy can be made (no Git history, say); the caller then runs the gate in place. A
   * gate already running for the run is stopped: its code is about to change.
   */
  private async mutateBeside(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    files: ChangedFile[],
  ): Promise<boolean> {
    await this.settleMutation(runId, true);
    const root = runRoot(this.store.workspace, state);
    // The copy checks out the whole repository, so it stands in for the run only at its top.
    const top = await git(root, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || realpathSync.native(top.stdout.trim()) !== realpathSync.native(root))
      return false;
    let path: string;
    try {
      const base = await runContentCommit(this.store, runId, {
        path: relative(this.store.workspace, root),
      });
      path = await createTaskWorktree(this.store, runId, MUTATION_COPY, base);
    } catch {
      return false;
    }
    const copy = join(this.store.workspace, path);
    for (const name of [".venv", "venv"]) {
      const source = join(root, name);
      if (existsSync(source) && !existsSync(join(copy, name)))
        try {
          symlinkSync(source, join(copy, name), process.platform === "win32" ? "junction" : "dir");
        } catch {
          // Without the link the copy's baseline test run fails and the gate says so.
        }
    }
    const controller = new AbortController();
    const done = (async () => {
      try {
        const result = await this.mutate(
          runId,
          state,
          policy,
          "advisory",
          files,
          controller.signal,
          { root: copy },
        );
        this.store.transaction(() => {
          const artifact = this.store.artifact(
            runId,
            "quality",
            QUALITY_MUTATION,
            canonical(result),
          );
          this.store.addEvidence(runId, "review", state.snapshotId ?? "", artifact.id);
        });
      } catch {
        // Stopped with its run, or failed: an advisory score is only missing from the report.
      } finally {
        await removeTaskWorktree(this.store.workspace, path);
        // An inline run leaves no worktree folder behind; rmdir only removes an empty folder.
        for (const folder of [dirname(copy), dirname(dirname(copy))])
          try {
            rmdirSync(folder);
          } catch {
            break;
          }
      }
    })();
    this.backgroundMutations.set(runId, { controller, done });
    return true;
  }
  /** Waits for the run's background mutation gate, stopping it first when `stop` is set. */
  private async settleMutation(runId: string, stop: boolean): Promise<void> {
    const job = this.backgroundMutations.get(runId);
    if (!job) return;
    if (stop) job.controller.abort(new Error("The run's code changes"));
    await job.done;
    if (this.backgroundMutations.get(runId) === job) this.backgroundMutations.delete(runId);
  }
  /** The module a harden run tests, read whole: every line of it may take a mutant. */
  private async hardenModule(state: RuntimeState): Promise<ChangedFile[]> {
    const targets = hardenTargets((state.rootGraph ?? state.graph)?.tasks ?? []);
    const code = await readCodeFiles(runRoot(this.store.workspace, state), targets);
    return [...code.files].map(([path, content]) => ({ path, content, before: "" }));
  }
  /**
   * Mutates `files` with the ecosystem tool the project has installed, or else plants each
   * built-in mutant in turn (with the agent's proposed ones when `proposeIn` names the step that
   * may call it), runs the policy's required test checks against it and restores the file byte
   * for byte, also from `quality/mutation-pending.json` after a crash.
   */
  private async mutate(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    mode: MutationMode,
    changed: ChangedFile[],
    signal: AbortSignal,
    options: { proposeIn?: string; root?: string } = {},
  ): Promise<MutationResult> {
    // A copy of the run (`root`) is thrown away afterwards, so nothing needs restoring after a crash.
    const copy = options.root !== undefined;
    const root = options.root ?? runRoot(this.store.workspace, state);
    const tests = policy.checks.filter((check) => check.required && isTestCheck(check));
    const scope = new ProcessScope();
    const toolScope = new ProcessScope();
    const shell = this.toolShell(runId, policy, root, toolScope, tests[0], signal);
    const tool = policy.mutationEngine === "built-in" ? null : detectMutationTool(changed, shell);
    let fallback: string | null = null;
    // Kept until the gate restores the files, so a host that stops mid-mutant restores them on the next drive.
    const pending = (files: Map<string, Buffer>) =>
      copy ||
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
    const read = (paths: string[]) =>
      new Map(paths.map((path) => [path, readFileSync(workspacePath(root, path))]));
    if (tool) {
      // Some tools (go-mutesting) write each mutant into the file itself.
      const originals = read(tool.files.map((f) => f.path));
      pending(originals);
      try {
        const run = await runMutationTool(
          tool.tool,
          tool.files,
          shell,
          policy.mutationBudgetMs ?? DEFAULT_MUTATION_BUDGET_MS,
        );
        if ("mutants" in run)
          return scoreMutants(
            {
              schemaVersion: 1,
              mode,
              engine: run.tool,
              tests: [run.tool],
              mutants: run.mutants.map((m, i) => ({ ...m, id: `M${i + 1}`, blocking: false })),
              score: null,
              ...(run.note
                ? { note: run.note }
                : !run.mutants.length
                  ? { note: `${run.tool} made no mutant on the added lines` }
                  : {}),
            },
            changed,
            policy.mutationThresholds,
          );
        fallback = `${run.tool} failed (${run.failure.slice(0, 300)}); the built-in engine ran instead`;
      } finally {
        await toolScope.stop();
        for (const [path, bytes] of originals) {
          const target = workspacePath(root, path);
          if (!existsSync(target) || !readFileSync(target).equals(bytes))
            writeFileSync(target, bytes);
        }
        pending(new Map());
      }
    }
    const operators = tests.length ? generateMutants(changed) : [];
    const proposed =
      tests.length && options.proposeIn
        ? await this.proposeMutants(
            runId,
            options.proposeIn,
            state,
            policy,
            changed,
            operators,
            signal,
          )
        : { mutants: [] };
    const mutants = [...operators, ...proposed.mutants];
    const originals = read([...new Set(mutants.map((m) => m.file))]);
    const runTests = async (
      timeLeftMs: number,
    ): Promise<{ status: "passed" | "timeout" } | { status: "failed"; check: string }> => {
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
            sandbox: runSandbox(policy, root, {
              gitWrite: root !== this.store.workspace,
            }),
          },
        );
        if (outcome.timedOut) return { status: "timeout" };
        if (outcome.exitCode !== 0) return { status: "failed", check: check.id };
      }
      return { status: "passed" };
    };
    // In a copy, files Git ignores (a build, a virtualenv) may be missing: tests that fail there
    // without a mutant would count every mutant as killed.
    const budgetMs = policy.mutationBudgetMs ?? DEFAULT_MUTATION_BUDGET_MS;
    const baselineStarted = Date.now();
    const baseline = copy && mutants.length && tests.length ? await runTests(budgetMs) : null;
    // How long the suite takes green, so one mutant that hangs it cannot take the budget (#1534).
    const greenMs =
      baseline?.status === "passed"
        ? Date.now() - baselineStarted
        : greenSuiteMs(
            this.store.checkDetails(runId),
            tests.map((check) => check.id),
          );
    if (baseline && baseline.status !== "passed") {
      await scope.stop();
      return {
        schemaVersion: 1,
        mode,
        engine: "built-in",
        tests: tests.map((check) => check.id),
        mutants: [],
        score: null,
        note: `${baseline.status === "failed" ? `check ${baseline.check} fails` : "the tests time out"} in a copy of the run without any mutant, so no mutant ran`,
      };
    }
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
              test: runTests,
              now: () => Date.now(),
            },
            {
              ...(policy.mutationBudgetMs ? { budgetMs: policy.mutationBudgetMs } : {}),
              ...(greenMs !== undefined ? { greenMs } : {}),
              ...(policy.mutationThresholds ? { thresholds: policy.mutationThresholds } : {}),
              signal,
            },
          )
        : {
            schemaVersion: 1,
            mode,
            engine: "built-in",
            tests: [],
            mutants: [],
            score: null,
            note: "no required test check in the policy",
          };
    } finally {
      await scope.stop();
      if (originals.size) pending(new Map());
    }
    const notes = [result.note, proposed.note, fallback].filter(Boolean);
    return notes.length ? { ...result, note: notes.join("; ") } : result;
  }
  /**
   * The machine as a mutation tool sees it: commands run in the run's root with the environment
   * of the policy's first test check, and the tool's incremental state stays outside the
   * workspace, in the system's temporary directory.
   */
  private toolShell(
    runId: string,
    policy: RunPolicy,
    root: string,
    scope: ProcessScope,
    test: RunPolicy["checks"][number] | undefined,
    signal: AbortSignal,
  ): ToolShell {
    const scratch = join(tmpdir(), "baked-mutation", runId);
    mkdirSync(scratch, { recursive: true });
    const sandbox = runSandbox(policy, root);
    return {
      root,
      scratch: scratch.replaceAll("\\", "/"),
      platform: process.platform,
      run: async (executable, args, timeoutMs) => {
        const outcome = await executeCheckCommand(scope, executable, args, {
          cwd: root,
          env: test ? buildCheckEnv(test) : buildSafeEnv(),
          timeoutMs: Math.max(1000, timeoutMs),
          signal,
          // The tool's incremental state lives in `scratch`, outside the root.
          sandbox: sandbox ? { ...sandbox, writable: [...sandbox.writable, scratch] } : null,
        });
        return { exitCode: outcome.exitCode, output: outcome.output, timedOut: outcome.timedOut };
      },
      ...toolShellFiles(root),
      remove: (path) => rmSync(workspacePath(root, path), { recursive: true, force: true }),
      which: (command) => Bun.which(command),
      now: () => Date.now(),
    };
  }
  /**
   * Mutants the `mutant-author` profile proposes for the spec's criteria on the lines the run added,
   * checked against the files; kept while the code stays the same, so a later gate does not ask
   * again. An agent that fails is noted and the gate goes on with the operator mutants.
   */
  private async proposeMutants(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    files: ChangedFile[],
    existing: Mutant[],
    signal: AbortSignal,
  ): Promise<{ mutants: Mutant[]; note?: string }> {
    const profiles = ProfileSchema.array().parse(JSON.parse(this.store.run(runId).profiles_json));
    const author = profiles.find((p) => p.output === "mutants");
    const criteria = (state.spec?.criteria ?? []).filter((c) => c.method === "automated");
    const listed = proposalFiles(files);
    if (!author || !criteria.length || !listed.length) return { mutants: [] };
    const key = hashJson(listed);
    const kept = this.store.latestArtifact(runId, QUALITY_MUTATION_PROPOSALS);
    if (kept) {
      const earlier = JSON.parse(this.store.readArtifact(runId, kept.id)) as {
        key: string;
        proposals: MutantProposal["mutants"];
      };
      if (earlier.key === key)
        return { mutants: proposedMutants(earlier.proposals, files, existing) };
    }
    const child = this.store.transaction(() => this.store.beginStep(runId, "mutants", stepId));
    try {
      const output = MutantProposalSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          author,
          {
            // A criterion is shown as one sentence: its Given/When/Then contract stays in the spec.
            criteria: criteria.map((c) => ({
              id: c.id,
              text: `Given ${c.given}, when ${c.when}, then ${c.then}`,
            })),
            files: listed,
          },
          signal,
        ),
      );
      this.store.transaction(() => {
        this.store.artifact(
          runId,
          "quality",
          QUALITY_MUTATION_PROPOSALS,
          canonical({ key, proposals: output.mutants }),
        );
        this.store.finishStep(runId, child, "completed");
      });
      return { mutants: proposedMutants(output.mutants, files, existing) };
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof WorkflowFault &&
        ["BUDGET_EXHAUSTED", "CHECKPOINT_REACHED"].includes(error.code)
      )
        throw error;
      this.store.transaction(() => this.store.finishStep(runId, child, "failed"));
      return {
        mutants: [],
        note: `no agent mutants (${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`,
      };
    }
  }
  /**
   * The blocking survivors the policy's skeptic judges equivalent (no input makes the mutated
   * line behave differently), with its explanation. Verdicts are kept by mutant and file content,
   * so a later gate asks only about new survivors, at most `MAX_EQUIVALENCE_CHECKS` per gate. A
   * check that fails keeps the survivor and is noted.
   */
  private async equivalentMutants(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    result: MutationResult,
    files: ChangedFile[],
    evidenceId: string,
    signal: AbortSignal,
  ): Promise<{ equivalent: Map<string, string>; note?: string }> {
    const profiles = ProfileSchema.array().parse(JSON.parse(this.store.run(runId).profiles_json));
    const skeptic = profiles.find(
      (p) => p.id === policy.skepticProfileId && p.output === "refutation",
    );
    const row = this.store.latestArtifact(runId, QUALITY_MUTATION_EQUIVALENCE);
    const verdicts: Record<string, { equivalent: boolean; explanation: string }> = row
      ? JSON.parse(this.store.readArtifact(runId, row.id))
      : {};
    const content = new Map(files.map((f) => [f.path, hashBytes(f.content)]));
    const equivalent = new Map<string, string>();
    let asked = 0;
    let failed = 0;
    for (const mutant of result.mutants.filter((m) => m.blocking)) {
      const key = hashJson({
        file: mutant.file,
        line: mutant.line,
        mutated: mutant.mutated,
        description: mutant.description ?? null,
        content: content.get(mutant.file) ?? null,
      });
      if (!verdicts[key] && skeptic && asked < MAX_EQUIVALENCE_CHECKS) {
        asked++;
        const verdict = await this.judgeMutant(
          runId,
          stepId,
          state,
          policy,
          skeptic,
          mutant,
          evidenceId,
          signal,
        );
        if (verdict) verdicts[key] = verdict;
        else failed++;
      }
      const verdict = verdicts[key];
      if (verdict?.equivalent) equivalent.set(mutant.id, verdict.explanation);
    }
    if (asked)
      this.store.transaction(() =>
        this.store.artifact(runId, "quality", QUALITY_MUTATION_EQUIVALENCE, canonical(verdicts)),
      );
    return {
      equivalent,
      ...(failed ? { note: `the equivalence check failed for ${failed} survivor(s)` } : {}),
    };
  }
  /** The skeptic's verdict on one surviving mutant, or null when the check failed. */
  private async judgeMutant(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    skeptic: AgentProfile,
    mutant: MutationResult["mutants"][number],
    evidenceId: string,
    signal: AbortSignal,
  ): Promise<{ equivalent: boolean; explanation: string } | null> {
    const finding = this.mutantFindings(state, [mutant], evidenceId, undefined)[0];
    if (!finding) return null;
    const child = this.store.transaction(() =>
      this.store.beginStep(runId, "mutant-equivalence", stepId),
    );
    try {
      const output = RefutationSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          skeptic,
          {
            finding,
            mutant: {
              file: mutant.file,
              line: mutant.line,
              original: mutant.original,
              mutated: mutant.mutated,
              ...(mutant.description ? { description: mutant.description } : {}),
            },
            question:
              "Is this mutant equivalent? Refute the finding when no input can make the mutated line behave differently from the original; confirm it when some input would.",
            // The gate's result is the evidence; the skeptic reads the code it needs itself.
            evidence: this.evidenceContext(runId, state, {
              reads: false,
              only: new Set([evidenceId]),
            }),
          },
          signal,
        ),
      );
      if (output.findingId !== finding.id)
        throw new WorkflowFault("OUTPUT_INVALID", "Skeptic returned another finding ID");
      const snapshotId = state.snapshotId ?? "";
      validateEvidence(
        this.store,
        runId,
        snapshotId,
        resolveEvidenceIds(currentEvidence(this.store, runId, snapshotId), output.evidenceIds),
        output.decision !== "inconclusive",
      );
      this.store.transaction(() => this.store.finishStep(runId, child, "completed"));
      return { equivalent: output.decision === "refuted", explanation: output.explanation };
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof WorkflowFault &&
        ["BUDGET_EXHAUSTED", "CHECKPOINT_REACHED"].includes(error.code)
      )
        throw error;
      this.store.transaction(() => this.store.finishStep(runId, child, "failed"));
      return null;
    }
  }
  /** Blocking findings for surviving mutants, each on a test file the correction may write. */
  private mutantFindings(
    state: RuntimeState,
    blocking: MutationResult["mutants"],
    evidenceId: string,
    engine: MutationResult["engine"],
  ): Review["findings"] {
    const tasks = (state.rootGraph ?? state.graph)?.tasks ?? [];
    const by = engine && engine !== "built-in" ? ` (${engine})` : "";
    return blocking.map((m) => {
      // The task that writes the mutated file, or in a harden run the one that tests it.
      const owner =
        tasks.find((t) => t.writes.some((w) => w.path === m.file)) ??
        tasks.find(
          (t) => t.readHints.includes(m.file) && t.writes.some((w) => isTestCodePath(w.path)),
        );
      // The test file of a related task, so the correction may write the test that kills it.
      const testFile = tasks
        .filter(
          (t) =>
            t === owner || (owner && t.criterionIds.some((id) => owner.criterionIds.includes(id))),
        )
        .flatMap((t) => t.writes.map((w) => w.path))
        .find((path) => isTestCodePath(path) && isCodePath(path));
      const change = m.description
        ? `mutated${by} (${m.description.slice(0, 160)}) at \`${m.original.trim().slice(0, 160)}\``
        : `changed${by} from \`${m.original.trim().slice(0, 160)}\` to \`${m.mutated.trim().slice(0, 160)}\``;
      return this.qualityFinding(state, {
        kind: "correctness",
        file: testFile ?? m.file,
        evidenceId,
        claim: `Surviving mutant ${m.id}: ${m.file}:${m.line} ${change} and every test check still passed${m.criterionId ? ` (it breaks ${m.criterionId})` : ""}`,
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
  /** The paths the run changed since its baseline, as far as the run knows them. */
  private runChangedPaths(runId: string, state: RuntimeState): string[] {
    const baselineId = state.manifest.baselineSnapshotId;
    const before = (baselineId && this.store.snapshotFiles(runId, baselineId)) || {};
    return changedPaths(before, state.expectedFiles ?? {});
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
      kind: "correctness" | "security" | "missing";
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
    // `allowNewDependencies` is always false: a package added to an existing manifest needs the
    // request or the approved spec to name it (#802). A scaffold baseline is still being set up.
    // A property criterion asks for the ecosystem's property-test library.
    const requested = this.baselineScaffold(runId, state)
      ? undefined
      : [
          state.requestText,
          state.spec ? canonical(state.spec) : "",
          ...(state.spec?.criteria.some((c) => c.property) ? PROPERTY_LIBRARY_PACKAGES : []),
        ].join("\n");
    const result = await checkDependencies(changed, known, {
      lookups: policy.registryLookups !== false,
      ...(this.registryFetch ? { fetcher: this.registryFetch } : {}),
      aliases,
      ...(requested !== undefined ? { requested } : {}),
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
          d.verdict === "unrequested"
            ? "The run adds a dependency nobody asked for to an existing project; the policy forbids new dependencies."
            : "Installing a package that does not exist or imitates a popular one can run an attacker's code.",
        suggestedFix:
          d.verdict === "unrequested"
            ? `Remove ${d.name} from ${d.file} and the code that uses it; implement the behavior with the dependencies the project already has.`
            : d.verdict === "missing"
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
    const result = await runSast(
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
    const result = await checkQualityRules(root, changed, policy.qualityRules ?? {});
    // A deterministic rule that still matches the same text after its correction would only ask
    // again: it stays in the report and becomes a known limitation (#845).
    const earlier = new Map<string, ReturnType<WorkflowStore["findings"]>[number]>();
    for (const finding of this.store.findings(runId)) {
      const key = ruleClaimKey(JSON.parse(finding.body_json).claim);
      if (key && !earlier.has(key)) earlier.set(key, finding);
    }
    for (const match of result.findings) {
      const before = match.blocking ? earlier.get(ruleFindingKey(match)) : undefined;
      if (!before) continue;
      match.blocking = false;
      match.kept = true;
      if (state.limitations.some((l) => l.findingId === before.id)) continue;
      const body = JSON.parse(before.body_json) as Review["findings"][number];
      state.limitations.push({
        findingId: before.id,
        severity: body.severity,
        kind: body.kind,
        criterionIds: body.criterionIds,
        file: body.file,
        symbol: body.symbol,
        claim: body.claim,
        impact: "The rule still matched the same text after its correction",
        decidedBy: "rule",
        round: this.store.run(runId).convergence_rounds,
      });
    }
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
        claim: ruleClaimText(match),
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
  /**
   * The command examples of the documents the run changed, run by the host in a copy of the
   * workspace with the output each printed, kept per snapshot so a resumed review does not run
   * them again (#750).
   */
  private async documentedExamples(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    executables: string[],
    signal: AbortSignal,
  ): Promise<DocExampleResult[]> {
    if (!state.snapshotId || !state.expectedFiles || !executables.length) return [];
    const logicalPath = `reviews/examples-${state.snapshotId}.json`;
    const kept = this.store.latestArtifact(runId, logicalPath);
    if (kept)
      return (
        JSON.parse(this.store.readArtifact(runId, kept.id)) as { examples: DocExampleResult[] }
      ).examples;
    const root = runRoot(this.store.workspace, state);
    const docs = [...journaledBaseHashes(this.store, runId).keys()]
      .filter(isDocFile)
      .flatMap((path) => {
        const absolute = workspacePath(root, path);
        return existsSync(absolute) ? [{ path, text: readFileSync(absolute, "utf8") }] : [];
      });
    if (!docs.length) return [];
    const examples = await runDocExamples(this.processes, docs, {
      root,
      files: Object.keys(state.expectedFiles),
      executables,
      signal,
      sandbox: (dir) => runSandbox(policy, dir),
    });
    // Documents without command examples run nothing, so there is nothing to keep.
    if (!examples.length) return [];
    this.store.transaction(() =>
      this.store.artifact(runId, "diagnostic", logicalPath, canonical({ examples })),
    );
    return examples;
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
    const severities = repairSeverities(
      this.store.run(runId),
      policy,
      inCostWrapUp(this.store, runId, policy),
    );
    const reviewSpec = state.spec;
    const reviewSnapshotId = state.snapshotId;
    const reviewSnapshotHash = state.workspaceHash;
    const executables = reproExecutables(policy.checks);
    const touched = this.runChangedPaths(runId, state);
    const repro = (r: Repro, file?: string | null) =>
      runRepro(this.processes, r, {
        root: runRoot(this.store.workspace, state),
        executables,
        generated: generatedPaths(policy),
        signal,
        sandbox: runSandbox(policy, runRoot(this.store.workspace, state), {
          gitWrite: Boolean(state.worktree),
        }),
        shadows: file ? [file, ...touched] : touched,
      });
    // The workspace the run started from had no source code: the reviewers judge the whole program.
    const greenfield = this.baselineScaffold(runId, state);
    const references = state.graph ? fileReferences(state.graph) : {};
    const examples = reviewers.some((r) => r.dimension === "correctness")
      ? await this.documentedExamples(runId, state, policy, executables, signal)
      : [];
    const runReviewer = async (reviewer: Reviewer) => {
      // A review of this very snapshot that an earlier, interrupted round finished is kept.
      const kept = state.reviews[reviewer.key];
      if (kept && kept.snapshotHash === reviewSnapshotHash && kept.verdict !== "inconclusive")
        return { reviewer, result: kept };
      // After a correction, a dimension that passed and whose files did not change keeps its
      // review, as does one that only repeated its notes (#1016); one that runs again is told
      // what it found and what changed (#713).
      const prior = state.priorReviews[reviewer.key];
      const changed =
        prior && state.expectedFiles ? changedSince(prior.files, state.expectedFiles) : null;
      if (prior && changed && carriesOver(reviewer.dimension, prior, changed, state.reviewNotes)) {
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
      // Criteria that count or list files are settled from the host's file list (#1506).
      const inventory = diffOnly
        ? undefined
        : workspaceInventory(runRoot(this.store.workspace, state));
      const ask = async (
        extra: Record<string, unknown>,
        maxSteps = REVIEW_ATTEMPT_STEPS,
      ): Promise<Review> => {
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
              ...(reviewer.dimension === "correctness" && Object.keys(references).length
                ? { references }
                : {}),
              // Named in the prompt as well as the tool list: round 11 reviewers said no tool was
              // available while run_repro was offered (#528).
              ...(canRepro ? { reproTool: { name: "run_repro", programs: executables } } : {}),
              ...(reviewer.dimension === "correctness" && examples.length
                ? { documentedExamples: examples }
                : {}),
              ...(inventory ? { workspaceInventory: inventory } : {}),
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
              const advice = [
                ...missingReproAdvice(output as Review, executables, prior?.review),
                ...unconfidentReproAdvice(
                  output as Review,
                  policy.reviewMinConfidence ?? DEFAULT_REVIEW_MIN_CONFIDENCE,
                ),
              ];
              if (advice.length) reproAdvised = true;
              return advice;
            },
            {
              maxSteps: Math.min(profile.maxSteps, policy.maxAgentSteps, maxSteps),
              maxTokens: undefined,
            },
            canRepro ? () => ({ run_repro: reproTool(executables, repro) }) : undefined,
          ),
        );
        carryNoRepro(answer, prior?.review);
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
        // A criterion whose explanation already names evidence the reviewer cannot produce is
        // not asked again (#1506): the same tools give the same answer, and it goes to the
        // converge stage as an evidence gap. The second question gets half the steps.
        const open = reaskableCriteria(result.coverage);
        if (open.length) {
          result = await ask(
            {
              inconclusiveCriteria: {
                note: "Your review was inconclusive on these criteria. Settle each from the code, the evidence and extra.workspaceInventory, using run_repro where it helps, or say in the explanation which test or check would establish it. Do not leave a criterion inconclusive without a reason.",
                criteria: open.map((c) => ({
                  criterionId: c.criterionId,
                  explanation: c.explanation,
                })),
              },
            },
            Math.ceil(REVIEW_ATTEMPT_STEPS / 2),
          );
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
        if (!gaps.length)
          throw new WorkflowFault("OUTPUT_INVALID", `${reviewer.dimension} review inconclusive`);
        if (routeGaps) {
          state.reviewGaps[reviewer.key] = gaps.map((c) => ({
            criterionId: c.criterionId,
            explanation: c.explanation,
          }));
          result.verdict = result.findings.length ? "changes_requested" : "pass";
        } else {
          // Without a converge stage (`quick`), a review with no finding has no defect to repair:
          // when the required checks pass, its open criteria become known limitations instead of
          // blocking the run on a verdict word (envguard-update f67dcde0, 445k tokens, #841).
          if (result.findings.length || !requiredChecksPass(this.store, runId, state, policy))
            throw new WorkflowFault("OUTPUT_INVALID", `${reviewer.dimension} review inconclusive`);
          noteInconclusiveReview(
            state,
            reviewer.dimension,
            gaps,
            this.store.run(runId).convergence_rounds,
          );
          result.verdict = "pass";
          delete state.reviewGaps[reviewer.key];
        }
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
        // Below the severity floor, a spec-based finding with a repro still competes: it repairs
        // when the host reproduces it (#801). So does a claim kept a note only for its confidence,
        // as in the converge stage (#1210, #1415).
        const unconfident = (f: Review["findings"][number]): boolean =>
          confidenceOnlyNote(f, policy.reviewMinConfidence);
        const candidates = reviewer.required
          ? result.findings.filter(
              (f) =>
                reviewer.blocking.includes(f.severity) &&
                (severities.includes(f.severity) || confirmableSpecFinding(f)) &&
                (findingBlocks(f, policy.reviewMinConfidence) || unconfident(f)),
            )
          : [];
        // A claim starts a correction only when its repro shows it (#155).
        const outcomes = new Map<string, ReproOutcome>();
        for (const finding of candidates)
          if (finding.repro && executables.length)
            outcomes.set(finding.id, await repro(finding.repro, finding.file));
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
          severities.includes(f.severity) && !unconfident(f)
            ? reproAllows(f, outcomes.get(f.id)?.status, executables.length > 0)
            : outcomes.get(f.id)?.status === "reproduced",
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
   * Asks the `approval-reviewer` profile about a package auto approval declined only for its
   * size or paths. It sees the request, the spec and the writes; it cannot change any of them.
   */
  private async reviewApproval(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    declined: string[],
    signal: AbortSignal,
  ): Promise<{ review: ApprovalReview } | { reviewError: string }> {
    const profile = profiles.find((p) => p.id === APPROVAL_REVIEWER);
    if (profile?.output !== "approval-review")
      return { reviewError: `profile ${APPROVAL_REVIEWER} is not available` };
    const spec = state.spec;
    try {
      const output = await this.call(
        runId,
        stepId,
        state,
        policy,
        profile,
        {
          approval: {
            request: state.requestText ?? state.prompt,
            spec: spec
              ? {
                  title: spec.title,
                  outcome: spec.outcome,
                  inScope: spec.inScope,
                  outOfScope: spec.outOfScope,
                  requirements: spec.requirements.map((r) => ({ id: r.id, text: r.text })),
                }
              : null,
            tasks: (state.graph?.tasks ?? []).map((t) => ({
              id: t.id,
              title: t.title,
              writes: t.writes,
            })),
            declined,
            limits: policy.autoApproval?.limits ?? null,
          },
        },
        signal,
      );
      return { review: ApprovalReviewSchema.parse(output) };
    } catch (error) {
      if (signal.aborted) throw error;
      return { reviewError: error instanceof Error ? error.message : String(error) };
    }
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
      if (!result.reason && !regression)
        this.assertNotBaselineFailure(runId, state, check, result.output ?? "", result.evidenceId);
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
      failures.push(...(await this.qualityFindings(runId, stepId, state, policy, signal)));
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
        if ((await this.checks.probe(runId, check, signal, root, left)) !== "passed")
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
      if (findings.length && target?.type === "tasks") this.amendSpec(runId, state, findings);
      if (findings.length && target?.type === "tasks")
        appendCorrections(
          this.store,
          runId,
          state,
          policy,
          findings,
          position.repairKind ?? "repair",
          // A review's corrections count review rounds, not the checks stage's repair rounds.
          stageKind(v2.stage) === "review" ? "review" : "round",
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
        // "One more round" at a convergence decision allows the loop one more pass as well, and
        // so does a checks repair round granted for a regression after a correction (#1272).
        const bound =
          transition.loop.maxIterations +
          (position.repairKind === "convergence"
            ? state.extraConvergenceRounds
            : stageKind(v2.stage) === "checks"
              ? (state.extraRepairRounds ?? 0)
              : 0);
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
   * Marks analysis findings for revision by patch when the policy asks for it and few block; the
   * spec, then the plan, answer them with edit operations (see patchRevision).
   */
  private pendPatch(
    state: RuntimeState,
    policy: RunPolicy,
    findings: readonly { kind: string; refs: string[]; description: string }[],
    targets: RevisionTarget[],
  ): void {
    if (policy.revision !== "patch" || !findings.length || findings.length > MAX_PATCH_FINDINGS)
      return;
    state.pendingPatch = {
      findings: findings.map(({ kind, refs, description }) => ({ kind, refs, description })),
      targets,
    };
  }
  /** The planner's last accepted plan, which a revision by patch edits; null before one. */
  private planBase(runId: string): unknown {
    const base = this.store.latestArtifact(runId, PLAN_BASE);
    return base ? (JSON.parse(this.store.readArtifact(runId, base.id)) as unknown) : null;
  }
  /**
   * Revision by patch (#1058): when analysis sent findings back under `revision: "patch"`, the
   * author answers them with edit operations on `current`, and the host applies them. `check`
   * validates the patched artifact as a submission would be. Null when no patch is pending for
   * `target`, or when the patch does not apply or validate: the stage then writes the artifact
   * again as before.
   */
  private async patchRevision(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profile: AgentProfile,
    target: RevisionTarget,
    current: unknown,
    check: (artifact: unknown) => string[],
    signal: AbortSignal,
  ): Promise<unknown | null> {
    const pending = state.pendingPatch;
    if (!pending?.targets.includes(target) || current === null) return null;
    pending.targets = pending.targets.filter((t) => t !== target);
    const patched = (output: unknown) => {
      const parsed = RevisionSchema.safeParse(output);
      if (!parsed.success) return { value: null, errors: [parsed.error.message] };
      const applied = applyRevision(current, parsed.data.operations);
      return applied.errors.length
        ? applied
        : { value: applied.value, errors: check(applied.value) };
    };
    const round = this.store
      .artifacts(runId)
      .filter(
        (a) => a.kind === "diagnostic" && a.logical_path.startsWith(`revisions/${target}-`),
      ).length;
    const record = (body: Record<string, unknown>) =>
      this.store.transaction(() =>
        this.store.artifact(
          runId,
          "diagnostic",
          `revisions/${target}-${String(round + 1)}.json`,
          canonical({ findings: pending.findings, ...body }),
        ),
      );
    let output: unknown;
    try {
      output = await this.call(
        runId,
        stepId,
        state,
        policy,
        { ...profile, output: "revision" },
        {
          revision: {
            artifact: target,
            instruction: revisionNote(target),
            findings: pending.findings,
          },
        },
        signal,
        undefined,
        0,
        (submitted) => patched(submitted).errors,
      );
    } catch (error) {
      if (!(error instanceof WorkflowFault) || error.code !== "OUTPUT_INVALID") throw error;
      record({ accepted: false, problems: [error.message] });
      return null;
    }
    const result = patched(output);
    record({
      accepted: result.errors.length === 0,
      operations: (output as { operations?: unknown }).operations ?? [],
      ...(result.errors.length ? { problems: result.errors } : {}),
    });
    return result.errors.length ? null : result.value;
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
    scope: "round" | "task" | "review" = "round",
  ): void {
    // During the implement stage a finding that already has a corrective task waiting or running
    // gets no second one: several test tasks reporting one source defect recorded the same finding
    // four times, and each report opened its own corrective task (expenses-py e0c0447d, #1033).
    const open = scope === "task" ? this.openCorrections(runId, state) : new Set<string>();
    const fresh = findings.filter((f) => !open.has(f.id));
    if (!fresh.length) return;
    this.store.transaction(() => {
      this.amendSpec(runId, state, fresh);
      appendCorrections(this.store, runId, state, policy, fresh, kind, scope);
      this.markQuickFixes(runId, state, policy, fresh);
      // A v2 run keeps its position: a task's repair runs in the tasks stage it is in, and a
      // stage's failure goes back along the definition's repair transition (#853).
      const parsed = parseRunDefinition(this.store.run(runId).definition_json);
      if (parsed.schemaVersion === 1)
        state.stageIndex = parsed.definition.stages.findIndex((s) => s.kind === "task-graph");
    });
  }
  /**
   * A correction whose findings are all low, or all point at one file, starts as a quick fix when
   * the policy asks for it (#1001): its first attempt gets a small step and token cap and only the
   * files the findings name. A low README sentence cost 546k tokens as a full correction
   * (stmtsplit-update cae4291d). A correction of a quick fix whose check then failed is a full one.
   */
  private markQuickFixes(
    runId: string,
    state: RuntimeState,
    policy: RunPolicy,
    findings: Review["findings"],
  ): void {
    if (policy.quickFix !== "on") return;
    const ids = new Set(findings.map((f) => f.id));
    for (const task of state.graph?.tasks ?? []) {
      if (task.origin === "planned" || state.quickFixes[task.id]) continue;
      if (!task.findingIds.length || !task.findingIds.every((id) => ids.has(id))) continue;
      const own = findings.filter((f) => task.findingIds.includes(f.id));
      const afterQuick = task.findingIds.some((id) => {
        const predecessor = state.repairPredecessors[id];
        return predecessor !== undefined && state.quickFixes[predecessor] !== undefined;
      });
      if (afterQuick) continue;
      const focus = correctionFocus(this.store, runId, state, task).files;
      if (!own.every((f) => f.severity === "low") && focus.length !== 1) continue;
      state.quickFixes[task.id] = "quick";
      state.taskSteps[task.id] = Math.min(QUICK_FIX_STEPS, policy.maxAgentSteps);
      state.taskBudgets[task.id] = Math.min(
        QUICK_FIX_TOKENS,
        policy.maxAttemptTokens ?? QUICK_FIX_TOKENS,
      );
    }
  }
  /**
   * A quick fix that did not finish falls back once to a full attempt: the usual step and token
   * cap of the task it corrects, and every file of the correction (#1001).
   */
  private fallBackFromQuickFix(state: RuntimeState, task: Task): boolean {
    if (state.quickFixes[task.id] !== "quick") return false;
    state.quickFixes[task.id] = "full";
    delete state.taskSteps[task.id];
    delete state.taskBudgets[task.id];
    if (!state.widenedCorrections.includes(task.id)) state.widenedCorrections.push(task.id);
    return true;
  }
  /** The findings of corrective tasks that have not finished: pending, running or interrupted. */
  private openCorrections(runId: string, state: RuntimeState): Set<string> {
    const unfinished = new Set(
      this.store
        .tasks(runId)
        .filter((t) => ["pending", "running", "interrupted"].includes(t.status))
        .map((t) => t.id),
    );
    return new Set(
      (state.graph?.tasks ?? [])
        .filter((t) => t.origin !== "planned" && unfinished.has(t.id))
        .flatMap((t) => t.findingIds),
    );
  }
  /**
   * Review findings that put the spec against the request record a spec amendment (#1034): the
   * request wins over the criteria they name, every later agent reads that with the request, and
   * the test-integrity guard accepts the tests their correction changes. A finding on a run
   * document (`spec.json`, `plan.md`) records one in which the implementation wins (#1066).
   */
  private amendSpec(runId: string, state: RuntimeState, findings: Review["findings"]): void {
    if (!state.spec) return;
    const planned = (state.rootGraph?.tasks ?? []).flatMap((t) => t.writes.map((w) => w.path));
    for (const finding of findings) {
      const amendment = namesRunDocument(finding, planned)
        ? documentAmendmentOf(finding, state.spec)
        : specAmendmentOf(finding, state.spec);
      if (!amendment) continue;
      const path = `amendments/${finding.id}.json`;
      if (this.store.latestArtifact(runId, path)) continue;
      this.store.artifact(runId, "assumption", path, canonical(amendment));
      // A repeated finding of a later round names the same contradiction: one note is enough.
      if (!state.prompt.includes(amendment.claim.slice(0, 1000)))
        state.prompt += `\n${amendmentNote(path, amendment)}`;
    }
  }
  /** Analysis findings on the spec that the request settles record amendments (#1120). */
  private amendFromAnalysis(
    runId: string,
    state: RuntimeState,
    findings: { id: string; refs: string[]; description: string }[],
  ): void {
    if (!state.spec) return;
    for (const finding of findings) {
      const amendment = analysisAmendmentOf(finding, state.spec);
      if (!amendment) continue;
      const path = `amendments/${amendment.findingId}.json`;
      if (this.store.latestArtifact(runId, path)) continue;
      this.store.artifact(runId, "assumption", path, canonical(amendment));
      // The return notes already quote the finding, so only the note itself is checked.
      const note = amendmentNote(path, amendment);
      if (!state.prompt.includes(note)) state.prompt += `\n${note}`;
    }
  }
  /** The run's spec amendments (`amendments/*.json`). */
  private amendments(runId: string): SpecAmendment[] {
    return this.store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("amendments/"))
      .map((a) => JSON.parse(this.store.readArtifact(runId, a.id)) as SpecAmendment);
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
/** The last name of a symbol a reviewer reported: `Parser.parseInline()` is `parseInline`. */
const symbolKey = (symbol: string | null | undefined): string =>
  (symbol ?? "")
    .replace(/\(.*$/s, "")
    .split(/[.:#\s]+/)
    .filter(Boolean)
    .at(-1) ?? "";

/**
 * The earlier findings of the run that a correction's findings recur on: the same symbol in the
 * same file, or the finding one of them names in `repeatOf`, when a correction that finished
 * already corrected them. md-site 11b11f19 (bench round 33) got five findings on its inline and
 * front matter parsers over four passes, each patched where the last patch left off (5.44M
 * tokens of corrections, #1330).
 */
export function recurringFindings(
  store: WorkflowStore,
  runId: string,
  task: Task,
): { id: string; symbol: string; claim: string; repro?: Repro }[] {
  if (task.origin === "planned" || !task.findingIds.length) return [];
  const findings = store.findings(runId).map((f) => ({
    id: f.id,
    body: JSON.parse(f.body_json) as {
      file?: string | null;
      symbol?: string | null;
      claim?: string;
      repeatOf?: string | null;
      repro?: unknown;
    },
  }));
  const own = findings.filter((f) => task.findingIds.includes(f.id));
  const symbols = new Set(own.map((f) => symbolKey(f.body.symbol)).filter(Boolean));
  const repeated = new Set(own.flatMap((f) => (f.body.repeatOf ? [f.body.repeatOf] : [])));
  const corrected = new Set(
    store
      .tasks(runId)
      .filter((row) => row.id !== task.id && ["implemented", "verified"].includes(row.status))
      .flatMap((row) => (JSON.parse(row.definition_json) as Task).findingIds ?? []),
  );
  return findings.flatMap((f) => {
    if (task.findingIds.includes(f.id) || !corrected.has(f.id)) return [];
    const key = symbolKey(f.body.symbol);
    const sameSymbol =
      key !== "" &&
      symbols.has(key) &&
      own.some(
        (o) =>
          symbolKey(o.body.symbol) === key &&
          (!o.body.file || !f.body.file || o.body.file === f.body.file),
      );
    if (!sameSymbol && !repeated.has(f.id)) return [];
    const repro = ReproSchema.safeParse(f.body.repro);
    return [
      {
        id: f.id,
        symbol: key || (f.body.file ?? ""),
        claim: f.body.claim ?? "",
        ...(repro.success ? { repro: repro.data } : {}),
      },
    ];
  });
}
/**
 * The earlier findings of the run in the same file as a correction's findings, on another symbol
 * or none, that a correction which finished already corrected; those `recurringFindings` names are
 * left out. md-site ec3c22bf (bench round 39) got three findings about multiline inline code in
 * `src/markdown.ts` one review round after another (emphasis inside the span, lost newlines, the
 * same inside blockquotes), 1.85M tokens of corrections for cases one pass could cover (#1397).
 */
export function sameFileFindings(
  store: WorkflowStore,
  runId: string,
  task: Task,
): { id: string; file: string; claim: string; repro?: Repro }[] {
  if (task.origin === "planned" || !task.findingIds.length) return [];
  const findings = store.findings(runId).map((f) => ({
    id: f.id,
    body: JSON.parse(f.body_json) as { file?: string | null; claim?: string; repro?: unknown },
  }));
  const files = new Set(
    findings.flatMap((f) => (task.findingIds.includes(f.id) && f.body.file ? [f.body.file] : [])),
  );
  if (!files.size) return [];
  const recurring = new Set(recurringFindings(store, runId, task).map((f) => f.id));
  const corrected = new Set(
    store
      .tasks(runId)
      .filter((row) => row.id !== task.id && ["implemented", "verified"].includes(row.status))
      .flatMap((row) => (JSON.parse(row.definition_json) as Task).findingIds ?? []),
  );
  return findings.flatMap((f) => {
    const file = f.body.file;
    if (!file || !files.has(file) || task.findingIds.includes(f.id)) return [];
    if (!corrected.has(f.id) || recurring.has(f.id)) return [];
    const repro = ReproSchema.safeParse(f.body.repro);
    return [
      {
        id: f.id,
        file,
        claim: f.body.claim ?? "",
        ...(repro.success ? { repro: repro.data } : {}),
      },
    ];
  });
}
/** Characters of each repro input file or stdin a corrective worker is shown. */
const REPRO_INPUT_CHARS = 8000;

/**
 * The input a repro runs on, for the worker that must make it pass (#1283): the reviewer's
 * program is often a file in a temporary directory (`go -C {files} run .` with a main.go), which
 * the command line alone does not show.
 */
export function reproInputs(repro: Repro): string {
  const cut = (text: string) =>
    text.length > REPRO_INPUT_CHARS
      ? `${text.slice(0, REPRO_INPUT_CHARS)}\n[${text.length - REPRO_INPUT_CHARS} more characters]`
      : text;
  const files = (repro.files ?? []).map(
    (file) => `\n{files}/${file.name}:\n\`\`\`\n${cut(file.content)}\n\`\`\``,
  );
  const stdin = repro.stdin === undefined ? [] : [`\nstdin:\n\`\`\`\n${cut(repro.stdin)}\n\`\`\``];
  if (!files.length && !stdin.length) return "";
  const where = files.length ? " {files} is a temporary directory holding the files below." : "";
  return `${where}${files.join("")}${stdin.join("")}\n`;
}
/**
 * The writes of a correction's first attempt (#765): the files its findings point at and their
 * planned tests. Null when that is every file it may write, or when nothing says where the
 * findings point. A correction carries every file of the tasks it corrects (cfgtrace 4018a791:
 * 18 files, LICENSE among them), so the first attempt starts small and a failed one widens.
 */
export function narrowCorrectionWrites(
  task: Task,
  focus: string[],
  tests = true,
): Task["writes"] | null {
  if (task.origin === "planned" || !focus.length) return null;
  const narrow = task.writes.filter(
    (w) => focus.includes(w.path) || (tests && focus.some((source) => isTestOf(w.path, source))),
  );
  return narrow.length && narrow.length < task.writes.length ? narrow : null;
}

/** What a correction's narrowed first attempt may write now, and what the next attempt adds. */
function correctionScope(task: Task, narrow: Task["writes"]): Record<string, unknown> {
  return {
    writable: narrow.map((w) => w.path),
    later: task.writes.filter((w) => !narrow.includes(w)).map((w) => w.path),
    note: "This attempt may write only the writable files. If the fix needs a file in later, it is unresolved (unlike other files outside your write scope): report blocked and name that file in unresolved. The next attempt may write all of them.",
  };
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
/** The check a host finding says a task failed (`applyTaskCheck`), or null for another claim. */
/** The step and token cap of a quick fix's attempt (#1001). */
const QUICK_FIX_STEPS = 16;
const QUICK_FIX_TOKENS = 150_000;
const STATIC_DIAGNOSTICS =
  "Every finding is a linter, formatter or type checker diagnostic in these files. Fix the reported lines and rerun the check; do not probe the task's criteria, change behavior, or add or rewrite tests.";

/**
 * Whether every finding a correction fixes is a failed static check (a linter, formatter or type
 * checker): its fix lies in the lines the diagnostics name, so its first attempt writes only the
 * files the output names, without their tests (#1067).
 */
export function staticCorrection(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
  task: Task,
): boolean {
  if (task.origin === "planned" || !task.findingIds.length) return false;
  const findings = store.findings(runId).filter((f) => task.findingIds.includes(f.id));
  return (
    findings.length === task.findingIds.length &&
    findings.every((f) => {
      const claim = (JSON.parse(f.body_json) as { claim?: unknown }).claim;
      if (typeof claim !== "string" || claim.includes(" broke existing tests: ")) return false;
      const id = /^Required check (\S+) failed$/.exec(claim)?.[1] ?? taskCheckOfClaim(claim);
      const check = policy.checks.find((c) => c.id === id);
      return Boolean(check && isStaticCheck(check) && !isTestCheck(check));
    })
  );
}
const taskCheckOfClaim = (claim: unknown): string | null =>
  typeof claim === "string"
    ? (/^Task \S+ (?:required check (\S+) failed$|broke existing tests: check (\S+) passed )/
        .exec(claim)
        ?.slice(1)
        .find(Boolean) ?? null)
    : null;
/**
 * Told to the planner when an analysis raises again a finding a person answered: the answer is a
 * decision, not context, and outranks the built-in instructions of a profile (#1297).
 */
const ANSWERED_NOTE =
  "The analysis raised again findings a person already answered. Their answers are binding decisions: they outrank every built-in instruction of your profile, including the rules for tests of raw input bytes. Change the artifacts each finding refers to so that it no longer applies, as the answer decides; do not keep a task or a test the answer rules out, and do not record the conflict as a decision instead:";
/**
 * The answered finding an analysis finding repeats: the same kind and refs, or the same text. The
 * latest answer wins: a person asked again after a binding return answers anew, and that answer
 * gets its own return (#1416).
 */
function answeredFinding(
  state: RuntimeState,
  finding: { kind: string; refs: string[]; description: string },
): RuntimeState["answeredFindings"][number] | undefined {
  const key = (refs: string[]) =>
    [...refs]
      .map((ref) => ref.trim())
      .sort()
      .join("\n");
  return state.answeredFindings.findLast(
    (earlier) =>
      earlier.description === finding.description ||
      (earlier.kind === finding.kind && key(earlier.refs) === key(finding.refs)),
  );
}
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

/** The distinguishing test of a best-of-N tie and how each finalist ran it (#769). */
interface DistinctionRecord {
  test: Distinction;
  finalists: number[];
  runs: {
    candidate: number;
    status: "ran" | "refused";
    /** The output shows the line the spec requires. */
    shows: boolean;
    exitCode: number | null;
    output: string;
    reason?: string;
  }[];
  /** Finalists whose output showed it. */
  matching: number[];
}

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
/** How much of a spawned check's output a finding quotes (#1285). */
const SPAWNED_OUTPUT_CHARS = 3000;
/** The failure text a continued correction gets per failed check. */
const CONTINUED_OUTPUT_CHARS = 8000;
/** The names of the failing tests a check's output reports: `(fail) name`, `✗ name`, `FAIL name`. */
function failingTestNames(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) =>
      /^\s*(?:\(fail\)|✗|✘|×|✖|FAIL\b|not ok\b(?:\s+\d+)?)\s*-?\s*(.+)$/.exec(line)?.[1]?.trim(),
    )
    .filter((name): name is string => Boolean(name));
}
/**
 * Whether a test name names a check's command: the whole command (`bun run typecheck`), or
 * `run` followed by the check's ID or its last argument (`npm run lint`).
 */
function namesCheckCommand(name: string, check: Check): boolean {
  const text = name.toLowerCase();
  const command = [check.executable, ...check.args].join(" ").toLowerCase();
  if (command.length > 3 && text.includes(command)) return true;
  const words = [...new Set([check.id, check.args.at(-1) ?? ""])]
    .filter((w) => w.length > 2)
    .map((w) => w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.some((w) => new RegExp(`\\brun\\s+${w}\\b`).test(text));
}
/**
 * Whether an attempt's last edit came after its last request_check, from the tool names its usage
 * record keeps; false for a record written before step tools were recorded.
 */
function editedAfterLastCheck(record: AttemptUsageRecord): boolean {
  let edit = -1;
  let check = -1;
  record.steps.forEach((step, index) => {
    if (step.tools?.some((tool) => EDIT_TOOLS.has(tool))) edit = index;
    if (step.tools?.includes("request_check")) check = index;
  });
  return edit > check;
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
      /** The worker's summary and unresolved items, for a defect it names in another task's file. */
      account: { summary: string; unresolved: string[] };
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
      /** The task already continues at its cap: its cut-off attempt failed a required check (#1329). */
      continued?: true;
      /** The worker's result when it changed nothing, for a deferral on a missing artifact. */
      blocked?: { outcome: string; summary: string; unresolved: string[] };
      /** The attempt was a correction's narrowed first attempt: the next one may write its scope. */
      narrowed?: true;
      /** The worker's account of an unfinished attempt, kept when it blocks the run (#1516). */
      account?: { summary: string; unresolved: string[] };
    }
  /** The task's worker reported that the spec and the tests cannot both hold. */
  | { kind: "conflict"; entry: BatchEntry; result: Implementation }
  /** The task's worker or worktree lease was lost; only this task stops. */
  | {
      kind: "interrupted";
      entry: BatchEntry;
      /** Why the worker stopped: a restart it asked for, or a lost worker or worktree lease. */
      cause: InterruptCause;
      reason: string;
      /** The stack of an error thrown by BAKED's own code rather than a workflow fault. */
      stack?: string;
      /** Another owner took the task worktree's lease, so the worktree is not this run's to reuse. */
      leaseLost: boolean;
      /** What the worker said when it ended without a complete implementation, for the restart. */
      account?: { summary: string; unresolved: string[] };
      /** The files the lost worker had changed in its worktree, with the manifest before it. */
      edits?: { before: Record<string, string>; changed: string[] };
    }
  /** The whole run stops: it was aborted or its budget is used up. */
  | { kind: "fatal"; entry: BatchEntry; error: unknown };

/**
 * The stack of an error that is not a workflow fault of its own: thrown directly, or wrapped as
 * `provider_unavailable` by the agent call.
 */
function thrownStack(error: unknown): string | undefined {
  if (!(error instanceof WorkflowFault)) return error instanceof Error ? error.stack : undefined;
  return typeof error.details.stack === "string" ? error.details.stack : undefined;
}

function isContextWindowFault(error: unknown): boolean {
  return (
    error instanceof WorkflowFault &&
    error.code === "BUDGET_EXHAUSTED" &&
    error.details.reason === "context_window"
  );
}

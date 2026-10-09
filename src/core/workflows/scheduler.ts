import { join } from "node:path";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { renderSpec, renderTasks } from "../specs/render.js";
import { validatePackage, workspacePath } from "../specs/validate.js";
import { assertAcceptance, assertAcceptanceV2 } from "../verification/acceptance.js";
import { CheckRunner } from "../verification/check-runner.js";
import { appendCorrections } from "../verification/convergence.js";
import { validateEvidence } from "../verification/evidence.js";
import { fingerprint, requiresSecurityReview } from "../verification/findings.js";
import { validateReview } from "../verification/review.js";
import { changedPaths, gitBaseline, sourceManifest } from "../verification/snapshot.js";
import { outputSchemas } from "./agent-executor.js";
import { approvalDigest } from "./approval.js";
import { evaluateAutoApproval, policyDecisions } from "./auto-approval.js";
import { budgetUsage, reserveTokens } from "./budget.js";
import { validateChecks } from "./check-policy.js";
import { deferredBlockingProblems, demoteDeferred, researchBudget } from "./clarification.js";
import { assertFrozenInputs, buildWorkflowContext } from "./context.js";
import { dependencyContracts } from "./dependencies.js";
import { EffectJournal, fileHash, intentRoot } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import {
  InitiativePlanSchema,
  MAX_FEATURES,
  MIN_FEATURES,
  planStructureProblems,
} from "./initiatives/plan.js";
import { mutationLeaseFor, type WorkspaceLeases, withinWorkflow } from "./leases.js";
import { PLAN_CONSISTENCY_CHECKS, planConsistencyProblems } from "./plan-consistency.js";
import { ProcessScope } from "./process-scope.js";
import { recoverRun } from "./recovery.js";
import { abortableDelay, retryDelay } from "./retry.js";
import { createdByRunLineage, runWrittenHash, uncommittedEdits } from "./rollback.js";
import {
  type AgentProfile,
  AnalysisSchema,
  executionModeOf,
  ImplementationSchema,
  PlanSchema,
  PolicySchema,
  ProfileSchema,
  ReasonCode,
  RefutationSchema,
  ReportSchema,
  ResearchSchema,
  type Review,
  ReviewSchema,
  type RunPolicy,
  type Spec,
  SpecSchema,
  type TaskGraph,
  WorkflowSchema,
} from "./schemas.js";
import { type LeaseResource, newId, type WorkflowStore } from "./store.js";
import { hasTaskGate, readyTasks } from "./task-graph.js";
import type { AgentExecutor, Check, RuntimeState, Task } from "./types.js";
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
  commitRunBranch,
  ensureRunWorktree,
  runRoot,
  userChangesInScope,
  worktreePath,
} from "./worktree.js";

/** Severity of a review finding. */
type Severity = Review["findings"][number]["severity"];
const ALL_SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

/** The task graph as the scheduler stores it: hashes are bound to the accepted spec and plan. */
function planGraph(spec: Spec, plan: { markdown: string; taskGraph: TaskGraph }): TaskGraph {
  return { ...plan.taskGraph, specHash: hashJson(spec), planHash: hashBytes(plan.markdown) };
}

export class WorkflowScheduler {
  dispose(): void {
    this.executor.dispose?.();
  }
  readonly processes = new ProcessScope();
  readonly journal: EffectJournal;
  readonly checks: CheckRunner;
  /** The mutation lease of the root the driven run writes: the project or its worktree. */
  private mutation: LeaseResource = "mutation";
  constructor(
    private store: WorkflowStore,
    private leases: WorkspaceLeases,
    private executor: AgentExecutor,
  ) {
    this.journal = new EffectJournal(store, leases);
    this.checks = new CheckRunner(store, this.processes);
  }
  async drive(runId: string, outerSignal: AbortSignal): Promise<void> {
    const policy = PolicySchema.parse(JSON.parse(this.store.run(runId).policy_json));
    // A worktree run holds the lease of its worktree; the project working copy stays free.
    this.mutation =
      executionModeOf(policy) === "worktree"
        ? mutationLeaseFor(this.store.workspace, join(this.store.workspace, worktreePath(runId)))
        : "mutation";
    this.leases.acquire("execution", runId);
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
    const timeout = setTimeout(
      () => controller.abort(new WorkflowFault("BUDGET_EXHAUSTED", "Active deadline exhausted")),
      Math.max(1, policy.maxActiveMs - this.store.run(runId).active_ms),
    );
    // Management commands from another process must stop this owner before the next effect.
    const poll = setInterval(() => {
      if (["paused", "cancelled"].includes(this.store.run(runId).status))
        controller.abort(new Error("Run management command"));
    }, 100);
    let stepId: string | null = null;
    try {
      if (!recoverRun(this.store, this.journal, runId)) return;
      if (executionModeOf(policy) === "worktree") await ensureRunWorktree(this.store, runId);
      this.store.transaction(() => this.store.transition(runId, "running"));
      await withinWorkflow(this.leases.owner, async () => {
        while (this.store.run(runId).status === "running") {
          signal.throwIfAborted();
          this.leases.assert("execution");
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
          let repairFindings: {
            findings: Review["findings"];
            kind: "repair" | "convergence";
          } | null = null;
          switch (stage.kind) {
            case "research": {
              const researcher = this.requireProfile(profile);
              const budget = researchBudget(state.prompt, researcher, policy);
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
                  },
                  signal,
                  undefined,
                  0,
                  (output) => {
                    const parsed = ResearchSchema.safeParse(output);
                    return parsed.success
                      ? deferredBlockingProblems(
                          parsed.data.unknowns,
                          (_, index) => parsed.data.unknowns[index]?.question ?? "",
                        )
                      : [];
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
                this.wait(runId, "clarification", state, { questions: research.unknowns });
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
                  { featureId: run.feature_id },
                  signal,
                ),
              );
              if (state.spec.featureId !== run.feature_id)
                throw new WorkflowFault("OUTPUT_INVALID", "Spec feature ID differs from the run");
              // An initiative decides which contracts a feature depends on, not the spec author.
              if (state.hostDependencies)
                state.spec = { ...state.spec, dependencies: state.hostDependencies };
              state.manifest.specHash = hashJson(state.spec);
              this.store.transaction(() =>
                this.store.artifact(runId, "spec", "spec.json", canonical(state.spec)),
              );
              if (state.spec.openQuestions.some((q) => q.blocking)) {
                this.wait(runId, "clarification", state, { questions: state.spec.openQuestions });
                advance = false;
              }
              break;
            }
            case "plan": {
              const spec = state.spec;
              if (!spec)
                throw new WorkflowFault("ARTIFACT_MISSING", "Spec required before planning");
              const plan = PlanSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  { checks: policy.checks, profiles },
                  signal,
                  undefined,
                  0,
                  // The planner sees package errors at submission and can correct them in place.
                  (output) => {
                    const parsed = PlanSchema.safeParse(output);
                    return parsed.success
                      ? this.planProblems(runId, spec, parsed.data, policy, profiles)
                      : [parsed.error.message];
                  },
                ),
              );
              state.plan = plan.markdown;
              state.graph = planGraph(spec, plan);
              const problems = this.planProblems(runId, spec, plan, policy, profiles);
              if (problems.length)
                throw new WorkflowFault("INVALID_REFERENCE", problems.join("\n"));
              state.rootGraph = structuredClone(state.graph);
              state.manifest.planHash = hashBytes(state.plan);
              state.manifest.rootGraphHash = hashJson(state.graph);
              state.manifest.effectiveGraphHash = hashJson(state.graph);
              this.store.transaction(() => {
                this.store.artifact(runId, "plan", "plan.md", state.plan ?? "");
                this.store.artifact(runId, "tasks", "tasks.json", canonical(state.graph));
                this.store.syncTasks(runId, plan.taskGraph);
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
                this.wait(runId, "clarification", state, {
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
                  { verifiedByRuntime: PLAN_CONSISTENCY_CHECKS },
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
              if (analysis.inputHash !== hashJson(state.manifest))
                throw new WorkflowFault("OUTPUT_INVALID", "Analysis refers to stale inputs");
              // Findings about check outcomes stay in the record as notes; checks run later.
              const findings = demoteDeferred(analysis.findings, (f) => f.description);
              const blocking = findings.some((f) => f.blocking);
              const onlyDeferred = !blocking && analysis.findings.some((f) => f.blocking);
              state.analysisPassed =
                !blocking &&
                (analysis.verdict === "pass" ||
                  (analysis.verdict === "needs_revision" && onlyDeferred));
              if (!state.analysisPassed) {
                this.wait(runId, "clarification", state, { findings });
                advance = false;
              }
              break;
            }
            case "approve": {
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
                const digest = approvalDigest(state);
                // A v2 approval stage marked human never approves on its own.
                const human = v2?.stage.type === "approval" && v2.stage.decision === "human";
                const auto = human
                  ? { approval: null, reasons: [] }
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
                  boundedCorrection: true,
                  ...(policy.autoApproval
                    ? { autoApproval: auto.approval ?? { declined: auto.reasons } }
                    : {}),
                };
                this.store.transaction(() => {
                  const requestId = this.store.request(runId, "approval", digest, body);
                  if (!auto.approval) {
                    this.store.transition(runId, "waiting", "approval");
                    return;
                  }
                  // The host signs the same digest a person would; post-release criteria never get here.
                  this.store.decideRequest(
                    runId,
                    requestId,
                    "accepted",
                    { digest, autoApproval: auto.approval },
                    true,
                  );
                  this.store.setApproval(runId, digest);
                  state.approvalRoot = digest;
                  state.deferredCriteria = [];
                });
                if (!auto.approval) advance = false;
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
                  this.wait(runId, "manual_evidence", state, {
                    criterionId: `dependency-${dependency.featureId}`,
                    snapshotId: state.snapshotId,
                    dependency,
                    question:
                      "Provide evidence that this dependency is ready for downstream execution.",
                  });
                advance = false;
                break;
              }
              await this.implement(runId, stepId, state, policy, profiles, signal);
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
              const failures = await this.review(
                runId,
                stepId,
                state,
                policy,
                profiles,
                signal,
                v2 ? this.v2Reviewers(runId, state, v2) : this.v1Reviewers(state, policy),
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
              const review = ReviewSchema.parse(
                await this.call(
                  runId,
                  stepId,
                  state,
                  policy,
                  this.requireProfile(profile),
                  { evidence: this.evidenceContext(runId, state) },
                  signal,
                ),
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
              const findings = this.recordFindings(runId, review);
              if (findings.length) {
                repairFindings = { findings, kind: "convergence" };
                advance = false;
              } else if (
                review.coverage.some(
                  (c) =>
                    c.verdict === "fail" ||
                    (c.verdict === "inconclusive" &&
                      state.spec?.criteria.find((s) => s.id === c.criterionId)?.method ===
                        "automated"),
                )
              )
                throw new WorkflowFault(
                  "OUTPUT_INVALID",
                  "Coverage is incomplete without an actionable finding",
                );
              else {
                const pending = state.spec.criteria.filter(
                  (c) =>
                    c.method === "manual" &&
                    state.manualCriteria[c.id]?.snapshotId !== state.snapshotId,
                );
                if (pending.length) {
                  for (const criterion of pending)
                    this.wait(runId, "manual_evidence", state, {
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
          if (repairFindings && !v2)
            this.repair(runId, state, policy, repairFindings.findings, repairFindings.kind);
          signal.throwIfAborted();
          await this.assertWorkspace(runId, state, policy, signal);
          if (v2 && state.position && this.store.run(runId).status === "running") {
            // The visit is decided; the next pass takes the transition that answers it.
            state.position.outcome = this.outcomeOf(v2.stage, repairFindings !== null);
            state.position.findings = repairFindings?.findings.map((f) => f.id) ?? [];
            state.position.repairKind = repairFindings?.kind ?? null;
          } else if (advance && !v2) state.stageIndex++;
          this.store.transaction(() => {
            this.store.saveState(runId, state);
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
                    : "invalid_output";
        this.store.artifact(
          runId,
          "diagnostic",
          `errors/${newId()}.txt`,
          fault instanceof Error ? fault.message : String(fault),
        );
        this.store.transition(
          runId,
          outerSignal.aborted ? "paused" : "blocked",
          outerSignal.aborted ? "user_pause" : reason,
        );
      });
    } finally {
      clearInterval(poll);
      clearTimeout(timeout);
      outerSignal.removeEventListener("abort", abort);
      leaseSignal.removeEventListener("abort", leaseLost);
      await this.processes.stop();
      try {
        this.store.transaction(() => this.store.addActiveTime(runId, performance.now() - started));
      } finally {
        this.leases.release();
      }
    }
  }
  /** Every package problem the scheduler would reject, as messages the planner can act on. */
  private planProblems(
    runId: string,
    spec: Spec,
    plan: { markdown: string; taskGraph: TaskGraph },
    policy: RunPolicy,
    profiles: AgentProfile[],
  ): string[] {
    const graph = planGraph(spec, plan);
    const problems: string[] = [];
    const root = this.rootOf(runId);
    try {
      validatePackage(root, spec, plan.markdown, graph);
    } catch (error) {
      problems.push(...(error instanceof Error ? error.message : String(error)).split("\n"));
    }
    problems.push(
      ...planConsistencyProblems(root, spec, plan.markdown, graph, (path) =>
        createdByRunLineage(this.store, runId, path, fileHash(workspacePath(root, path))),
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
      policy.checks.flatMap((c) => c.writes),
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
      policy.checks.flatMap((c) => c.writes),
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
    profile: AgentProfile,
    extra: unknown,
    signal: AbortSignal,
    task?: Task,
    retry = 0,
    validate?: (output: unknown) => string[],
    limits?: { maxSteps: number; maxTokens: number | undefined },
  ): Promise<unknown> {
    const prompt = buildWorkflowContext(state, profile, {
      ...(extra && typeof extra === "object" ? extra : { input: extra }),
      executionContract: {
        checks: policy.checks,
        profiles: ProfileSchema.array()
          .parse(JSON.parse(this.store.run(runId).profiles_json))
          .map((p) => ({ id: p.id, role: p.role, allowedTools: p.allowedTools })),
        policy: { allowedTools: policy.allowedTools, network: policy.network },
      },
    });
    const inputHash = this.store.run(runId).input_hash;
    const attempt = this.store.reserve(
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
        root: runRoot(this.store.workspace, state),
        maxSteps: limits?.maxSteps ?? Math.min(profile.maxSteps, policy.maxAgentSteps),
        ...(limits?.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
        ...(validate ? { validate } : {}),
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
          result.inputTokens === null || result.outputTokens === null
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
      const delay = retryDelay(error, retry);
      if (
        delay !== null &&
        !signal.aborted &&
        !this.store.effects(runId).some((effect) => effect.attempt_id === attempt)
      ) {
        await abortableDelay(delay, signal);
        return this.call(
          runId,
          stepId,
          state,
          policy,
          profile,
          extra,
          signal,
          task,
          retry + 1,
          validate,
          limits,
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
  private wait(
    runId: string,
    kind: "clarification" | "manual_evidence",
    state: RuntimeState,
    body: unknown,
  ): void {
    this.store.transaction(() => {
      this.store.request(runId, kind, hashJson(state.manifest), body);
      this.store.transition(runId, "waiting", kind);
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
      const relative = `specs/${state.spec.featureId}/${name}`;
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
   * Current evidence handed to an agent with its content. An implementer does not need the
   * research-phase file reads (up to 16 KB each, resent on every step); it reads what it edits
   * itself and cites its own evidence. Reviewers and auditors get everything.
   */
  private evidenceContext(
    runId: string,
    state: RuntimeState,
    options: { reads: boolean } = { reads: true },
  ): unknown[] {
    return this.store
      .evidence(runId)
      .filter((e) => e.snapshot_id === state.snapshotId && e.validity === "current")
      .filter((e) => options.reads || e.kind !== "read")
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        content: this.store.readArtifact(runId, e.artifact_id).slice(0, 16000),
      }));
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
      const checking = state.graph.tasks.find((candidate) =>
        rows.some(
          (row) =>
            row.id === candidate.id &&
            row.status === "implemented" &&
            !hasTaskGate(row, state.taskGates),
        ),
      );
      const task = checking ?? readyTasks(state.graph, rows, state.taskGates)[0];
      if (!task) break;
      signal.throwIfAborted();
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
        const before = await sourceManifest(
          root,
          policy.checks.flatMap((c) => c.writes),
          signal,
        );
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
        const result = ImplementationSchema.parse(
          await this.call(
            runId,
            child,
            state,
            policy,
            this.requireProfile(profiles.find((p) => p.id === task.profileId)),
            {
              task,
              evidence: this.evidenceContext(runId, state, { reads: false }),
              unresolvedMeans: UNRESOLVED_MEANING,
              ...(inherited.length
                ? {
                    earlierEdits: {
                      paths: inherited,
                      note: "These files already contain edits from an earlier attempt of this task in this run. Read their current content before editing; keep what is correct.",
                    },
                  }
                : {}),
            },
            signal,
            task,
          ),
        );
        const after = await sourceManifest(
          root,
          policy.checks.flatMap((c) => c.writes),
          signal,
        );
        // The source manifest cannot see git-ignored files (a docs directory in .gitignore), but the
        // effect journal recorded every file this task changed, so it counts as well.
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
        const changed = [
          ...new Set([...changedPaths(before, after), ...journaled, ...stillEdited()]),
        ];
        const outside = changed.filter((path) => !task.writes.some((w) => w.path === path));
        if (outside.length)
          throw new WorkflowFault(
            "INPUT_CHANGED",
            `Task changed ${outside.length} file(s) outside its write scope: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}`,
          );
        if (
          result.taskId !== task.id ||
          ["blocked", "failed"].includes(result.outcome) ||
          result.unresolved.length > 0 ||
          (result.outcome === "implemented" && changed.length === 0 && task.writes.length > 0)
        ) {
          this.store.transaction(() => this.store.taskStatus(runId, task.id, "blocked"));
          throw new WorkflowFault(
            "OUTPUT_INVALID",
            `Task ${task.id} did not complete its implementation`,
          );
        }
        if (result.outcome === "already_satisfied")
          validateEvidence(this.store, runId, state.snapshotId ?? "", result.evidenceIds);
        await this.snapshot(runId, state, policy, signal);
        this.store.transaction(() => {
          const diff = this.store.artifact(
            runId,
            "diff",
            `tasks/${task.id}/diff.json`,
            canonical({
              changed,
              before: Object.fromEntries(
                changed.map((p) => [p, earlier.has(p) ? earlier.get(p) : (before[p] ?? null)]),
              ),
              after: Object.fromEntries(changed.map((p) => [p, after[p] ?? null])),
            }),
          );
          this.store.addEvidence(runId, "diff", state.snapshotId ?? "", diff.id);
          this.store.taskStatus(runId, task.id, "implemented", state.snapshotId);
          this.store.saveState(runId, state);
        });
      }
      const taskFailures: Review["findings"] = [];
      const checkEvidence: string[] = [];
      for (const check of policy.checks.filter(
        (c) => c.scope === "task" && task.checkIds.includes(c.id),
      )) {
        const attempt = this.store.reserve(runId, child, null, 0, policy);
        const checked = await this.checks.run(
          runId,
          attempt,
          check,
          signal,
          runRoot(this.store.workspace, state),
        );
        if (checked.status === "passed") checkEvidence.push(checked.evidenceId);
        this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
        if (check.required && checked.status !== "passed") {
          this.store.transaction(() =>
            this.store.taskStatus(runId, task.id, "blocked", state.snapshotId),
          );
          if (checked.status === "inconclusive")
            throw new WorkflowFault("OUTPUT_INVALID", `Task check ${check.id} is inconclusive`, {
              reason: "verification_failed",
            });
          taskFailures.push({
            id: newId(),
            kind: "correctness",
            severity: "high",
            requirementIds: task.requirementIds,
            criterionIds: task.criterionIds,
            file: null,
            symbol: null,
            evidenceIds: [checked.evidenceId],
            claim: `Task ${task.id} required check ${check.id} failed`,
            impact: "Dependent tasks cannot run",
            suggestedFix: `Fix ${task.id} within its approved paths and repeat ${check.id}.`,
          });
        }
      }
      if (taskFailures.length) {
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
          const affected = new Set(restored);
          for (let changed = true; changed; ) {
            changed = false;
            for (const candidate of graph.tasks) {
              if (
                !affected.has(candidate.id) &&
                candidate.dependsOn.some((id) => affected.has(id))
              ) {
                affected.add(candidate.id);
                changed = true;
              }
            }
          }
          for (const entry of this.store.tasks(runId))
            if (
              !restored.has(entry.id) &&
              affected.has(entry.id) &&
              ["implemented", "verified"].includes(entry.status)
            )
              this.store.taskStatus(runId, entry.id, "invalidated");
          this.store.finishStep(runId, child, "completed");
          this.store.saveState(runId, state);
        });
      }
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
  private async runChecks(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    signal: AbortSignal,
  ): Promise<Review["findings"]> {
    await this.snapshot(runId, state, policy, signal);
    const failures: Review["findings"] = [];
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
      if (result.status === "inconclusive" && check.required)
        throw new WorkflowFault("OUTPUT_INVALID", `Required check ${check.id} is inconclusive`, {
          reason: "verification_failed",
        });
      if (result.status === "failed" && check.required) {
        const task =
          state.graph?.tasks.find((t) => t.checkIds.includes(check.id)) ?? state.graph?.tasks[0];
        if (!task)
          throw new WorkflowFault("OUTPUT_INVALID", "Check failed without an associated task");
        failures.push({
          id: newId(),
          kind: "correctness",
          severity: "high",
          requirementIds: task.requirementIds,
          criterionIds: task.criterionIds,
          file: null,
          symbol: null,
          evidenceIds: [result.evidenceId],
          claim: `Required check ${check.id} failed`,
          impact: "Implementation cannot be accepted",
          suggestedFix: `Inspect command evidence ${result.evidenceId} and correct the implementation within approved scope.`,
        });
      }
    }
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
    const dimensions = [
      "correctness",
      ...(requiresSecurityReview(
        state.graph?.tasks.flatMap((t) => t.writes.map((w) => w.path)) ?? [],
        policy.forceSecurityReview,
      )
        ? ["security"]
        : []),
      ...(policy.reviewProfiles.language ? ["language"] : []),
    ] as (keyof RunPolicy["reviewProfiles"])[];
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
  ): Promise<Review["findings"]> {
    if (!state.spec || !state.snapshotId || !state.workspaceHash)
      throw new WorkflowFault("ARTIFACT_MISSING", "Review snapshot missing");
    const findings: Review["findings"] = [];
    const owners = new Map<string, Reviewer>();
    const reviewSpec = state.spec;
    const reviewSnapshotId = state.snapshotId;
    const reviewSnapshotHash = state.workspaceHash;
    const runReviewer = async (reviewer: Reviewer) => {
      const child = this.store.transaction(() =>
        this.store.beginStep(runId, `dimension-${reviewer.key}`, stepId),
      );
      const profile = this.requireProfile(profiles.find((p) => p.id === reviewer.profileId));
      const result = ReviewSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          profile,
          { dimension: reviewer.dimension, evidence: this.evidenceContext(runId, state) },
          signal,
        ),
      );
      validateReview(
        this.store,
        runId,
        reviewSnapshotId,
        reviewSnapshotHash,
        reviewSpec,
        result,
        reviewer.dimension === "correctness" && result.verdict === "pass",
      );
      if (result.verdict === "inconclusive" && reviewer.required)
        throw new WorkflowFault("OUTPUT_INVALID", `${reviewer.dimension} review inconclusive`);
      this.store.transaction(() => this.store.finishStep(runId, child, "completed"));
      return { reviewer, result };
    };
    for (let offset = 0; offset < reviewers.length; offset += policy.maxConcurrentReadAgents) {
      const batch = await Promise.allSettled(
        reviewers.slice(offset, offset + policy.maxConcurrentReadAgents).map(runReviewer),
      );
      for (const outcome of batch) {
        if (outcome.status === "rejected") throw outcome.reason;
        const { reviewer, result } = outcome.value;
        state.reviews[reviewer.key] = result;
        // Advisory reviewers and findings below the blocking severities are recorded, not repaired.
        const blocking = reviewer.required
          ? result.findings.filter((f) => reviewer.blocking.includes(f.severity))
          : [];
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
    return stage.type === "check" ? "failed" : "changes_requested";
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
  }> {
    let attempts = 0;
    let unstable = false;
    for (;;) {
      attempts++;
      const attempt = this.store.reserve(runId, stepId, null, 0, policy);
      const result = await this.checks.run(runId, attempt, check, signal, this.rootOf(runId));
      this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
      if (result.status === "passed")
        return { status: "passed", evidenceId: result.evidenceId, attempts, flaky: unstable };
      unstable = true;
      const retryable = gate.retries.retryOn.some((on) =>
        result.status === "failed" ? on === "failed" : on === "inconclusive" || on === "timeout",
      );
      if (!retryable || attempts > gate.retries.max)
        return { status: result.status, evidenceId: result.evidenceId, attempts, flaky: false };
    }
  }
  /**
   * A v2 check stage: its command gates in the listed order, required ones first. A required
   * failure becomes a finding for the failed outcome, an inconclusive required gate blocks, and an
   * advisory gate is recorded and never blocks.
   */
  private async runCheckStage(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    v2: { stage: Stage; gates: Gate[] },
    signal: AbortSignal,
  ): Promise<Review["findings"]> {
    if (v2.stage.type !== "check") return [];
    await this.snapshot(runId, state, policy, signal);
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
    for (const { gate, check } of ordered) {
      const result = await this.runCommandGate(runId, stepId, check, gate, policy, signal);
      this.recordGate(runId, state, gate.id, null, {
        status: result.status,
        mode: check.required ? "required" : "advisory",
        evidenceId: result.evidenceId,
        attempts: result.attempts,
        flaky: result.flaky,
      });
      if (!check.required || result.status === "passed") continue;
      if (result.status === "inconclusive")
        throw new WorkflowFault("OUTPUT_INVALID", `Required check ${check.id} is inconclusive`, {
          reason: "verification_failed",
        });
      const task =
        state.graph?.tasks.find((t) => t.checkIds.includes(check.id)) ?? state.graph?.tasks[0];
      failures.push({
        id: newId(),
        kind: "correctness",
        severity: "high",
        requirementIds: task?.requirementIds ?? state.spec?.requirements.map((r) => r.id) ?? [],
        criterionIds: task?.criterionIds ?? [],
        file: null,
        symbol: null,
        evidenceIds: [result.evidenceId],
        claim: `Required check ${check.id} failed`,
        impact: "Implementation cannot be accepted",
        suggestedFix: `Inspect command evidence ${result.evidenceId} and correct the implementation within approved scope.`,
      });
    }
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
        this.recordGate(runId, state, gate.id, transition.id, { ...result, mode });
        if (mode === "required" && result.status !== "passed") {
          this.store.transaction(() => {
            this.store.finishStep(runId, stepId ?? "", "failed");
            this.store.saveState(runId, state);
          });
          throw new WorkflowFault(
            "OUTPUT_INVALID",
            `Gate ${gate.id} on ${transition.id} ${result.status}`,
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
        this.wait(runId, "manual_evidence", state, {
          criterionId,
          snapshotId: state.snapshotId,
          gateId: gate.id,
          transitionId: transition.id,
          question: gate.human.prompt,
          answer: gate.human.answer,
        });
        this.store.transaction(() => this.store.saveState(runId, state));
        return;
      } else {
        // An AI acceptance gate closes nothing until its walk-through is promoted to a command
        // test; it is recorded as skipped here.
        this.recordGate(runId, state, gate.id, transition.id, {
          status: "skipped",
          mode,
          evidenceId: null,
          attempts: 0,
          flaky: false,
        });
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
        state.prompt += `\nFindings of the ${v2.stage.id} stage to address:\n${canonical(
          findings.map((f) => ({ claim: f.claim, impact: f.impact, fix: f.suggestedFix })),
        )}`;
        for (const finding of findings) this.store.findingStatus(runId, finding.id, "resolved");
      }
      if (transition.loop) {
        const count = (position.loops[transition.id] ?? 0) + 1;
        if (count > transition.loop.maxIterations)
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
    const writes = definition.stages.some((s) => s.type === "tasks");
    const acceptable = (): void => {
      if (writes) assertAcceptanceV2(this.store, runId, state, policy, definition, gates);
      else if (this.store.requests(runId).some((request) => request.status === "pending"))
        throw new WorkflowFault("STALE_DECISION", "Pending decisions remain");
      if (this.store.effects(runId).some((e) => ["prepared", "unknown"].includes(e.status)))
        throw new WorkflowFault("RECOVERY_REQUIRED", "Unreconciled effects remain");
    };
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
      if (this.store.effects(runId).some((e) => ["prepared", "unknown"].includes(e.status)))
        throw new WorkflowFault("RECOVERY_REQUIRED", "Unreconciled effects remain");
    };
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

/** Logical path of the gates a v2 run froze when it started. */
export const GATES_ARTIFACT = "definition/gates.json";

const gateToRequired = (binding: { gateId: string; mode?: "required" | "advisory" }, gate: Gate) =>
  effectiveMode(binding, gate) === "required";

/** Told to the implementer with every task: unresolved blocks the task, so it must not carry other tasks' work. */
const UNRESOLVED_MEANING =
  "unresolved lists only parts of THIS task that you could not finish. Work that belongs to other tasks of the plan, to checks run later, or to documentation tasks is not unresolved: leave it out. Any entry blocks this task.";

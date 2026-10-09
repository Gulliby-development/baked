import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { renderSpec, renderTasks } from "../specs/render.js";
import { validatePackage, workspacePath } from "../specs/validate.js";
import { assertAcceptance } from "../verification/acceptance.js";
import { CheckRunner } from "../verification/check-runner.js";
import { appendCorrections } from "../verification/convergence.js";
import { validateEvidence } from "../verification/evidence.js";
import { fingerprint, requiresSecurityReview } from "../verification/findings.js";
import { validateReview } from "../verification/review.js";
import { changedPaths, gitBaseline, sourceManifest } from "../verification/snapshot.js";
import { outputSchemas } from "./agent-executor.js";
import { approvalDigest } from "./approval.js";
import { evaluateAutoApproval } from "./auto-approval.js";
import { reserveTokens } from "./budget.js";
import { validateChecks } from "./check-policy.js";
import { assertFrozenInputs, buildWorkflowContext } from "./context.js";
import { dependencyContracts } from "./dependencies.js";
import { EffectJournal, fileHash } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { type WorkspaceLeases, withinWorkflow } from "./leases.js";
import { PLAN_CONSISTENCY_CHECKS, planConsistencyProblems } from "./plan-consistency.js";
import { ProcessScope } from "./process-scope.js";
import { recoverRun } from "./recovery.js";
import { abortableDelay, retryDelay } from "./retry.js";
import {
  type AgentProfile,
  AnalysisSchema,
  ImplementationSchema,
  PlanSchema,
  PolicySchema,
  ProfileSchema,
  ReasonCode,
  RefutationSchema,
  ResearchSchema,
  type Review,
  ReviewSchema,
  type RunPolicy,
  type Spec,
  SpecSchema,
  type TaskGraph,
  WorkflowSchema,
} from "./schemas.js";
import { newId, type WorkflowStore } from "./store.js";
import { hasTaskGate, readyTasks } from "./task-graph.js";
import type { AgentExecutor, RuntimeState, Task } from "./types.js";

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
  constructor(
    private store: WorkflowStore,
    private leases: WorkspaceLeases,
    private executor: AgentExecutor,
  ) {
    this.journal = new EffectJournal(store, leases);
    this.checks = new CheckRunner(store, this.processes);
  }
  async drive(runId: string, outerSignal: AbortSignal): Promise<void> {
    this.leases.acquire("execution", runId);
    try {
      this.leases.acquire("mutation", runId);
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
    const policy = PolicySchema.parse(JSON.parse(this.store.run(runId).policy_json));
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
      this.store.transaction(() => this.store.transition(runId, "running"));
      await withinWorkflow(this.leases.owner, async () => {
        while (this.store.run(runId).status === "running") {
          signal.throwIfAborted();
          this.leases.assert("execution");
          this.leases.assert("mutation");
          const run = this.store.run(runId);
          const state = this.store.state(runId);
          const definition = WorkflowSchema.parse(JSON.parse(run.definition_json));
          assertFrozenInputs(state);
          if (state.approvalRoot) await this.assertWorkspace(runId, state, policy, signal);
          const stage = definition.stages[state.stageIndex];
          if (!stage) {
            await this.accept(runId, state, policy, signal);
            return;
          }
          stepId = this.store.transaction(() => {
            this.store.bump(runId, run.revision);
            return this.store.beginStep(runId, stage.id);
          });
          const profiles = ProfileSchema.array().parse(JSON.parse(run.profiles_json));
          const profile = profiles.find((p) => p.id === stage.profileId);
          let advance = true;
          switch (stage.kind) {
            case "research": {
              const research = ResearchSchema.parse(
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
                      ? this.planProblems(spec, parsed.data, policy, profiles)
                      : [parsed.error.message];
                  },
                ),
              );
              state.plan = plan.markdown;
              state.graph = planGraph(spec, plan);
              const problems = this.planProblems(spec, plan, policy, profiles);
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
                ),
              );
              if (analysis.inputHash !== hashJson(state.manifest))
                throw new WorkflowFault("OUTPUT_INVALID", "Analysis refers to stale inputs");
              state.analysisPassed =
                analysis.verdict === "pass" && !analysis.findings.some((f) => f.blocking);
              if (!state.analysisPassed) {
                this.wait(runId, "clarification", state, { findings: analysis.findings });
                advance = false;
              }
              break;
            }
            case "approve": {
              if (!state.analysisPassed || !state.spec || !state.graph || !state.plan)
                throw new WorkflowFault(
                  "OUTPUT_INVALID",
                  "Consistency analysis and artifacts required before approval",
                );
              validateChecks(this.store.workspace, policy, state.graph);
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
                const repository = await gitBaseline(this.store.workspace);
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
                const auto = evaluateAutoApproval(
                  policy,
                  state.manifest,
                  state.spec,
                  state.graph,
                  this.store.requests(runId),
                );
                const body = {
                  manifest: state.manifest,
                  writes: state.graph.tasks.flatMap((t) => t.writes),
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
              const failed = await this.runChecks(runId, stepId, state, policy, signal);
              if (failed.length) {
                this.repair(runId, state, policy, failed, "repair");
                advance = false;
              }
              break;
            }
            case "review": {
              const failures = await this.review(runId, stepId, state, policy, profiles, signal);
              if (failures.length) {
                this.repair(runId, state, policy, failures, "repair");
                advance = false;
              }
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
                this.repair(runId, state, policy, findings, "convergence");
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
          signal.throwIfAborted();
          await this.assertWorkspace(runId, state, policy, signal);
          if (advance) state.stageIndex++;
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
    spec: Spec,
    plan: { markdown: string; taskGraph: TaskGraph },
    policy: RunPolicy,
    profiles: AgentProfile[],
  ): string[] {
    const graph = planGraph(spec, plan);
    const problems: string[] = [];
    try {
      validatePackage(this.store.workspace, spec, plan.markdown, graph);
    } catch (error) {
      problems.push(...(error instanceof Error ? error.message : String(error)).split("\n"));
    }
    problems.push(...planConsistencyProblems(this.store.workspace, spec, plan.markdown, graph));
    for (const task of graph.tasks) {
      if (!profiles.some((p) => p.id === task.profileId && p.output === "implementation"))
        problems.push(`Unknown implementation profile ${task.profileId}`);
      if (task.checkIds.some((id) => !policy.checks.some((c) => c.id === id)))
        problems.push(`Unknown checks for ${task.id}`);
    }
    return problems;
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
      this.store.workspace,
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
      this.store.workspace,
      policy.checks.flatMap((c) => c.writes),
      signal,
    );
    if (hashJson(files) !== hashJson(state.expectedFiles)) {
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
        maxSteps: Math.min(profile.maxSteps, policy.maxAgentSteps),
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
            ? null
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
      if (this.store.attempts(runId).find((a) => a.id === attempt)?.status === "running")
        this.store.transaction(() =>
          this.store.finishAttempt(runId, attempt, signal.aborted ? "cancelled" : "failed", null),
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
    const files = {
      "spec.json": canonical(state.spec),
      "spec.md": renderSpec(state.spec),
      "plan.md": state.plan,
      "tasks.json": canonical(state.graph),
      "tasks.md": renderTasks(state.graph),
    };
    for (const [name, content] of Object.entries(files)) {
      const relative = `specs/${state.spec.featureId}/${name}`;
      const path = workspacePath(this.store.workspace, relative);
      const expected = state.published[relative] ?? null;
      if (fileHash(path) === hashBytes(content)) {
        state.published[relative] = hashBytes(content);
        continue;
      }
      this.journal.publish(runId, attempt, relative, content, expected);
      state.published[relative] = hashBytes(content);
    }
    this.store.transaction(() => this.store.finishAttempt(runId, attempt, "completed", 0));
    await this.snapshot(runId, state, policy, signal);
  }
  private evidenceContext(runId: string, state: RuntimeState): unknown[] {
    return this.store
      .evidence(runId)
      .filter((e) => e.snapshot_id === state.snapshotId && e.validity === "current")
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
        const before = await sourceManifest(
          this.store.workspace,
          policy.checks.flatMap((c) => c.writes),
          signal,
        );
        const result = ImplementationSchema.parse(
          await this.call(
            runId,
            child,
            state,
            policy,
            this.requireProfile(profiles.find((p) => p.id === task.profileId)),
            { task, evidence: this.evidenceContext(runId, state) },
            signal,
            task,
          ),
        );
        const after = await sourceManifest(
          this.store.workspace,
          policy.checks.flatMap((c) => c.writes),
          signal,
        );
        const changed = changedPaths(before, after);
        if (changed.some((path) => !task.writes.some((w) => w.path === path)))
          throw new WorkflowFault("INPUT_CHANGED", "Task changed files outside its write scope");
        if (
          result.taskId !== task.id ||
          ["blocked", "failed"].includes(result.outcome) ||
          result.unresolved.length > 0 ||
          (result.outcome === "implemented" && changed.length === 0)
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
              before: Object.fromEntries(changed.map((p) => [p, before[p] ?? null])),
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
        const checked = await this.checks.run(runId, attempt, check, signal);
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
      const result = await this.checks.run(runId, attempt, check, signal);
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
  private recordFindings(runId: string, review: Review): Review["findings"] {
    return this.store.transaction(() => {
      const artifact = this.store.artifact(
        runId,
        "review",
        `reviews/${newId()}.json`,
        canonical(review),
      );
      return review.findings.map((finding) => ({
        ...finding,
        id: this.store.addFinding(runId, finding, fingerprint(finding), artifact.id),
      }));
    });
  }
  private async review(
    runId: string,
    stepId: string,
    state: RuntimeState,
    policy: RunPolicy,
    profiles: AgentProfile[],
    signal: AbortSignal,
  ): Promise<Review["findings"]> {
    if (!state.spec || !state.graph || !state.snapshotId || !state.workspaceHash)
      throw new WorkflowFault("ARTIFACT_MISSING", "Review snapshot missing");
    const dimensions = [
      "correctness",
      ...(requiresSecurityReview(
        state.graph.tasks.flatMap((t) => t.writes.map((w) => w.path)),
        policy.forceSecurityReview,
      )
        ? ["security"]
        : []),
      ...(policy.reviewProfiles.language ? ["language"] : []),
    ] as (keyof RunPolicy["reviewProfiles"])[];
    const findings: Review["findings"] = [];
    const reviewSpec = state.spec;
    const reviewSnapshotId = state.snapshotId;
    const reviewSnapshotHash = state.workspaceHash;
    const runDimension = async (dimension: keyof RunPolicy["reviewProfiles"]) => {
      const child = this.store.transaction(() =>
        this.store.beginStep(runId, `dimension-${dimension}`, stepId),
      );
      const profile = this.requireProfile(
        profiles.find((p) => p.id === policy.reviewProfiles[dimension]),
      );
      const result = ReviewSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          profile,
          { dimension, evidence: this.evidenceContext(runId, state) },
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
        dimension === "correctness" && result.verdict === "pass",
      );
      if (result.verdict === "inconclusive")
        throw new WorkflowFault("OUTPUT_INVALID", `${dimension} review inconclusive`);
      this.store.transaction(() => this.store.finishStep(runId, child, "completed"));
      return { dimension, result };
    };
    for (let offset = 0; offset < dimensions.length; offset += policy.maxConcurrentReadAgents) {
      const batch = await Promise.allSettled(
        dimensions.slice(offset, offset + policy.maxConcurrentReadAgents).map(runDimension),
      );
      for (const outcome of batch) {
        if (outcome.status === "rejected") throw outcome.reason;
        state.reviews[outcome.value.dimension] = outcome.value.result;
        findings.push(...this.recordFindings(runId, outcome.value.result));
      }
    }
    for (const finding of findings.filter((f) => ["critical", "high"].includes(f.severity))) {
      const child = this.store.transaction(() =>
        this.store.beginStep(runId, `skeptic-${fingerprint(finding).slice(0, 24)}`, stepId),
      );
      const result = RefutationSchema.parse(
        await this.call(
          runId,
          child,
          state,
          policy,
          this.requireProfile(profiles.find((p) => p.id === policy.skepticProfileId)),
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
    return findings.filter(
      (f) => this.store.findings(runId).find((entry) => entry.id === f.id)?.status !== "refuted",
    );
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
    this.store.transaction(() => {
      assertAcceptance(this.store, runId, state, policy);
      if (this.store.effects(runId).some((e) => ["prepared", "unknown"].includes(e.status)))
        throw new WorkflowFault("RECOVERY_REQUIRED", "Unreconciled effects remain");
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
        }),
      );
      this.store.saveState(runId, state);
      this.store.bump(runId, this.store.run(runId).revision);
      this.store.transition(runId, "completed");
    });
  }
}

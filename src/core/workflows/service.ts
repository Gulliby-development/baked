import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../types/index.js";
import { ProfileRegistry } from "../agents/profiles/registry.js";
import type { ContextManager } from "../context/manager.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { validatePackage } from "../specs/validate.js";
import { NativeAgentExecutor } from "./agent-executor.js";
import { approvalDigest } from "./approval.js";
import {
  type BudgetLimits,
  budgetUsage,
  limitsOf,
  MAX_EXTENDED_MS,
  MAX_EXTENDED_TOKENS,
  proposeExtension,
} from "./budget.js";
import { sddWorkflow } from "./builtin/sdd.js";
import { validateChecks } from "./check-policy.js";
import { clarificationResumeIndex } from "./clarification.js";
import { assertFrozenInputs, frozenInstructions } from "./context.js";
import { decideDelivery, isDeliveryRequest } from "./delivery.js";
import { WorkflowFault } from "./errors.js";
import { estimateStart, readHistory, type SavedEstimate } from "./estimate.js";
import { replayEvents } from "./events.js";
import {
  commandProcessMayRun,
  leaseOwnerAlive,
  releaseDeadOwnerLeases,
  WorkspaceLeases,
} from "./leases.js";
import { undoRunEdits } from "./rollback.js";
import { WorkflowScheduler } from "./scheduler.js";
import {
  type CommandIdentity,
  type Decision,
  PolicySchema,
  ResearchSchema,
  type RunPolicy,
  type RunSnapshot,
  type RunState,
  SafeId,
  type StartRequest,
  validateWorkflow,
  WorkflowConfigSchema,
  WorkflowSchema,
  type WorkflowService,
} from "./schemas.js";
import { assertMutable } from "./state-machine.js";
import { newId, WorkflowStore } from "./store.js";
import { type AgentExecutor, type RuntimeState, RuntimeStateSchema } from "./types.js";

export class NativeWorkflowService implements WorkflowService {
  readonly store: WorkflowStore;
  readonly leases: WorkspaceLeases;
  readonly scheduler: WorkflowScheduler;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<RunSnapshot> }
  >();
  constructor(
    readonly workspace: string,
    readonly config: AppConfig,
    executor?: AgentExecutor,
    readonly = false,
    parentContext?: ContextManager,
  ) {
    this.store = new WorkflowStore(workspace, readonly);
    this.leases = new WorkspaceLeases(this.store);
    this.scheduler = new WorkflowScheduler(
      this.store,
      this.leases,
      executor ?? new NativeAgentExecutor(this.store, this.leases, config, parentContext),
    );
  }
  private enabled(): void {
    if (!this.config.workflows || !WorkflowConfigSchema.parse(this.config.workflows).enabled)
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        "Workflows are disabled. Enable workflows.enabled in project configuration to opt in.",
      );
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
    const model = request.model ?? this.config.defaultModel;
    if (!model?.trim() || model.trim() === "none")
      throw new WorkflowFault("INVALID_DEFINITION", "Select a model before starting a workflow");
    const policy = PolicySchema.parse(request.policy);
    validateChecks(this.workspace, policy);
    if (policy.maxCostUsd !== null)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "A dollar cap requires verified model pricing; use the token/time limits with maxCostUsd=null",
      );
    const registry = new ProfileRegistry(this.workspace, {
      active: model,
      coding: this.config.taskRouter?.ember ?? this.config.taskRouter?.coding ?? undefined,
      review: this.config.taskRouter?.verify ?? undefined,
    });
    let workflow = sddWorkflow;
    const definitionPath = join(this.workspace, "baked", "workflows", `${request.workflowId}.json`);
    if (existsSync(definitionPath))
      workflow = WorkflowSchema.parse(JSON.parse(readFileSync(definitionPath, "utf8")));
    else if (request.workflowId !== "sdd")
      throw new WorkflowFault("NOT_FOUND", `Unknown workflow ${request.workflowId}`);
    const validation = validateWorkflow(workflow);
    if (validation.length) throw new WorkflowFault("INVALID_DEFINITION", validation.join("\n"));
    const profiles = registry.list().map((p) => p.profile);
    const outputs: Record<string, string> = {
      research: "research",
      specify: "spec",
      plan: "plan",
      analyze: "analysis",
      review: "review",
      converge: "convergence",
    };
    for (const stage of workflow.stages)
      if (stage.profileId && registry.get(stage.profileId).output !== outputs[stage.kind])
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Profile output does not match stage ${stage.id}`,
        );
    for (const id of Object.values(policy.reviewProfiles))
      if (id && registry.get(id).output !== "review")
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Review profile ${id} has an incompatible output`,
        );
    if (registry.get(policy.skepticProfileId).output !== "refutation")
      throw new WorkflowFault("INVALID_DEFINITION", "Skeptic must return RefutationSchema");
    const instructions = frozenInstructions(this.workspace, this.config.instructionFiles);
    const skillHashes: Record<string, string> = {};
    for (const profile of profiles)
      for (const skill of profile.skills) {
        const path = join(this.workspace, "baked", "skills", skill.id, "SKILL.md");
        if (!existsSync(path) || hashBytes(readFileSync(path)) !== skill.hash)
          throw new WorkflowFault("INPUT_CHANGED", `Missing or changed skill ${skill.id}`);
        skillHashes[skill.id] = skill.hash;
        instructions.files[path] = skill.hash;
      }
    if (existsSync(definitionPath))
      instructions.files[definitionPath] = hashBytes(readFileSync(definitionPath));
    for (const entry of registry.list())
      if (entry.source !== "builtin")
        instructions.files[entry.source] = hashBytes(readFileSync(entry.source));
    const state: RuntimeState = {
      prompt: request.prompt,
      ownerLabel: request.ownerLabel,
      stageIndex: 0,
      manifest: {
        schemaVersion: 1,
        featureId: request.featureId,
        workflowHash: hashJson(workflow),
        policyHash: hashJson(policy),
        profileHashes: Object.fromEntries(profiles.map((p) => [p.id, hashJson(p)])),
        skillHashes,
        instructionHashes: instructions.hashes,
        constitutionHash: instructions.files[join(this.workspace, "baked/constitution.md")] ?? null,
        specHash: null,
        planHash: null,
        rootGraphHash: null,
        effectiveGraphHash: null,
        correctionHashes: [],
        baselineSnapshotId: null,
        dependencyContracts: [],
      },
      spec: null,
      plan: null,
      graph: null,
      rootGraph: null,
      research: null,
      analysisPassed: false,
      snapshotId: null,
      workspaceHash: null,
      expectedFiles: null,
      reviews: {},
      convergence: null,
      approvalRoot: null,
      correctionHashes: [],
      published: {},
      manualCriteria: {},
      deferredCriteria: [],
      previousFindingSet: null,
      noProgressRounds: 0,
      verificationState: "not_verified",
      instructionText: instructions.text,
      frozenFiles: instructions.files,
      repairPredecessors: {},
      taskGates: {},
    };
    return this.store.transaction(() => {
      const duplicate = this.store.previousCommand(request.commandId, request);
      if (duplicate) return duplicate;
      const id = newId();
      this.store.create(id, request.featureId, workflow, profiles, policy, state);
      this.saveEstimate(id, policy);
      const snapshot = this.store.snapshot(id);
      this.store.saveCommand(request.commandId, request, snapshot);
      return snapshot;
    });
  }
  /** Keeps the expectation made at creation, so a finished run can be compared with it. */
  private saveEstimate(runId: string, policy: RunPolicy): void {
    try {
      const estimate = estimateStart(readHistory(this.store));
      const saved: SavedEstimate = {
        schemaVersion: 1,
        at: Date.now(),
        tokens: estimate.tokens,
        basis: estimate.basis,
        samples: estimate.samples,
        maxTokens: policy.maxTotalTokens,
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
  async drive(runId: string, signal: AbortSignal): Promise<RunSnapshot> {
    this.enabled();
    assertMutable(this.store.run(runId).status);
    if (this.store.requests(runId).some((r) => r.status === "pending"))
      return this.store.snapshot(runId);
    if (this.active.has(runId))
      throw new WorkflowFault("WORKSPACE_BUSY", "Run already executing in this process");
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const promise = this.scheduler
      .drive(runId, controller.signal)
      .then(() => this.store.snapshot(runId));
    this.active.set(runId, { controller, promise });
    try {
      return await promise;
    } finally {
      this.active.delete(runId);
      signal.removeEventListener("abort", abort);
    }
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
    active?.controller.abort();
    if (active) await active.promise;
    return result;
  }
  async resume(runId: string, command: CommandIdentity): Promise<RunSnapshot> {
    this.enabled();
    return this.store.command(runId, command, { runId, ...command, action: "resume" }, () => {
      assertMutable(this.store.run(runId).status);
      if (this.store.requests(runId).some((r) => r.status === "pending"))
        throw new WorkflowFault("STALE_DECISION", "Resolve pending requests before resuming");
      assertFrozenInputs(this.store.state(runId));
      const lease = this.store.lease("execution");
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
            });
          this.store.transition(runId, "waiting", "interrupted_effect");
          return;
        }
      }
      this.store.transition(runId, "paused", "none");
    });
  }
  async decide(runId: string, command: CommandIdentity, decision: Decision): Promise<RunSnapshot> {
    return this.store.command(runId, command, { runId, ...command, decision }, () => {
      const named = this.store.requests(runId).find((r) => r.id === decision.requestId);
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
      if (decision.kind === "approve") {
        assertFrozenInputs(state);
        if (
          request.kind !== "approval" ||
          request.digest !== decision.digest ||
          decision.digest !== approvalDigest(state)
        )
          throw new WorkflowFault(
            "STALE_DECISION",
            "Approval digest does not match current inputs",
          );
        for (const [path, hash] of Object.entries(state.published))
          if (
            !existsSync(join(this.workspace, path)) ||
            hashBytes(readFileSync(join(this.workspace, path))) !== hash
          )
            throw new WorkflowFault("INPUT_CHANGED", `Published artifact changed: ${path}`);
        state.approvalRoot = decision.digest;
        state.deferredCriteria =
          state.spec?.criteria.filter((c) => c.method === "post-release").map((c) => c.id) ?? [];
        this.store.setApproval(runId, decision.digest);
        state.stageIndex++;
      } else if (decision.kind === "answer") {
        if (request.kind !== "clarification" || Object.keys(decision.answers).length === 0)
          throw new WorkflowFault("STALE_DECISION", "Clarification answers required");
        const stages = WorkflowSchema.parse(
          JSON.parse(this.store.run(runId).definition_json),
        ).stages;
        const asking = stages[state.stageIndex];
        state.prompt += `\nUser clarification${asking ? ` (answers the questions of the ${asking.id} stage; they are resolved)` : ""}:\n${canonical(decision.answers)}`;
        // Answered research questions no longer block; the report itself stays valid.
        if (asking?.kind === "research" && state.research) {
          const research = ResearchSchema.parse(JSON.parse(state.research));
          state.research = canonical({
            ...research,
            unknowns: research.unknowns.map((q) => ({ ...q, blocking: false })),
          });
        }
        state.analysisPassed = false;
        state.stageIndex = clarificationResumeIndex(stages, state.stageIndex, body);
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
        }
      } else if (decision.kind === "recovery") {
        const effect = this.store.effects(runId).find((entry) => entry.id === decision.effectId);
        const child = effect ? (JSON.parse(effect.intent_json) as { pid?: number }).pid : undefined;
        if (effect && child !== undefined && commandProcessMayRun(effect.intent_json))
          throw new WorkflowFault(
            "WORKSPACE_BUSY",
            "Recovery must wait until the command process is confirmed stopped",
          );
        if (
          request.kind !== "recovery" ||
          body.effectId !== decision.effectId ||
          !decision.evidence.trim()
        )
          throw new WorkflowFault(
            "STALE_DECISION",
            "Recovery evidence required for the requested effect",
          );
        const lease = this.store.lease("execution");
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
          for (const resource of ["execution", "mutation"] as const) {
            const held = this.store.lease(resource);
            if (!held || held.run_id !== runId) continue;
            if (leaseOwnerAlive(held) !== false)
              throw new WorkflowFault(
                "WORKSPACE_BUSY",
                "Recovery cannot release a live mutation owner",
              );
            this.store.releaseLease(resource, held.owner_id, held.owner_epoch);
          }
          this.store.transition(runId, "cancelled", "user_pause");
        } else
          this.store.effectStatus(
            runId,
            decision.effectId,
            decision.resolution === "record-applied" ? "reconciled" : "failed",
          );
      } else if (decision.kind === "continue") {
        if (request.kind !== "checkpoint")
          throw new WorkflowFault("STALE_DECISION", "Only a token checkpoint can be continued");
      } else if (decision.kind === "reject") accepted = false;
      this.store.decideRequest(runId, request.id, accepted ? "accepted" : "rejected", decision);
      const pending = this.store.requests(runId).some((r) => r.status === "pending");
      if (
        decision.kind === "manual-evidence" &&
        accepted &&
        !pending &&
        WorkflowSchema.parse(JSON.parse(this.store.run(runId).definition_json)).stages[
          state.stageIndex
        ]?.kind === "converge"
      )
        state.stageIndex++;
      this.store.saveState(runId, state);
      if (this.store.run(runId).status !== "cancelled")
        this.store.transition(
          runId,
          pending ? "waiting" : "paused",
          accepted ? "none" : "user_pause",
        );
    });
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
      };
      if (candidate.expectedInputHash !== this.store.run(runId).input_hash)
        throw new WorkflowFault("INPUT_CHANGED", "Revision candidate was built from stale inputs");
      const state = RuntimeStateSchema.parse(candidate.state);
      if (!state.spec || !state.plan || !state.graph)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          "Revision requires a complete spec, plan and task package",
        );
      validatePackage(this.workspace, state.spec, state.plan, state.graph);
      const policy = PolicySchema.parse(candidate.policy);
      validateChecks(this.workspace, policy, state.graph);
      for (const request of this.store.requests(runId).filter((r) => r.status === "pending"))
        this.store.decideRequest(runId, request.id, "superseded", { candidateHash });
      if (state.snapshotId) this.store.invalidateEvidence(runId, state.snapshotId, "input_changed");
      state.stageIndex = 3;
      state.analysisPassed = false;
      state.approvalRoot = null;
      state.reviews = {};
      state.convergence = null;
      state.manualCriteria = {};
      state.correctionHashes = [];
      state.repairPredecessors = {};
      state.taskGates = {};
      state.previousFindingSet = null;
      state.noProgressRounds = 0;
      state.manifest.correctionHashes = [];
      state.rootGraph = structuredClone(state.graph);
      state.manifest.rootGraphHash = hashJson(state.graph);
      state.manifest.effectiveGraphHash = hashJson(state.graph);
      state.expectedFiles = null;
      state.verificationState = "stale";
      this.store.setApproval(runId, null);
      this.store.setPolicy(runId, policy);
      this.store.syncTasks(runId, state.graph, true);
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
    requested: Partial<BudgetLimits> = {},
  ): Promise<RunSnapshot> {
    this.enabled();
    return this.store.command(
      runId,
      command,
      { runId, ...command, action: "extend-budget", requested },
      () => {
        const row = this.store.run(runId);
        if (row.status !== "blocked" || row.reason !== "budget_exhausted")
          throw new WorkflowFault(
            "STALE_DECISION",
            "Only a run that stopped on its budget can be extended",
          );
        const before = PolicySchema.parse(JSON.parse(row.policy_json));
        const proposal = proposeExtension(limitsOf(before), budgetUsage(this.store, row));
        const limits: BudgetLimits = {
          maxTotalTokens:
            requested.maxTotalTokens ?? proposal?.maxTotalTokens ?? before.maxTotalTokens,
          maxAgentCalls: requested.maxAgentCalls ?? proposal?.maxAgentCalls ?? before.maxAgentCalls,
          maxActiveMs: requested.maxActiveMs ?? proposal?.maxActiveMs ?? before.maxActiveMs,
        };
        const current = limitsOf(before);
        for (const key of Object.keys(current) as (keyof BudgetLimits)[])
          if (limits[key] < current[key])
            throw new WorkflowFault("INVALID_DEFINITION", "Limits can only be raised");
        if (
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
            previous: current,
            next: limitsOf(after),
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
  async fork(runId: string, command: CommandIdentity): Promise<RunSnapshot> {
    this.enabled();
    const body = { runId, ...command, action: "fork" };
    return this.store.transaction(() => {
      const old = this.store.previousCommand(command.commandId, body);
      if (old) return old;
      const run = this.store.run(runId);
      if (run.revision !== command.expectedRevision)
        throw new WorkflowFault("REVISION_CONFLICT", "Run changed before fork");
      const state = this.store.state(runId);
      const id = newId();
      state.stageIndex = state.spec && state.graph && state.plan ? 3 : 0;
      state.approvalRoot = null;
      state.snapshotId = null;
      state.workspaceHash = null;
      state.expectedFiles = null;
      state.reviews = {};
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
      state.taskGates = {};
      state.previousFindingSet = null;
      state.noProgressRounds = 0;
      this.store.create(
        id,
        run.feature_id,
        WorkflowSchema.parse(JSON.parse(run.definition_json)),
        JSON.parse(run.profiles_json),
        PolicySchema.parse(JSON.parse(run.policy_json)),
        state,
        runId,
      );
      if (state.graph) this.store.syncTasks(id, state.graph);
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
    this.leases.acquire("execution", runId);
    try {
      this.leases.acquire("mutation", runId);
      undoRunEdits(this.store, this.leases, runId, paths);
    } finally {
      this.leases.release();
    }
    return this.store.command(runId, command, body, () => {});
  }
  events(runId: string, afterSeq: number, signal: AbortSignal) {
    return replayEvents(this.store, runId, afterSeq, signal);
  }
  async shutdown(): Promise<void> {
    for (const active of this.active.values())
      active.controller.abort(new Error("Application shutdown"));
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
  }
  close(): void {
    if (this.active.size)
      throw new WorkflowFault(
        "WORKSPACE_BUSY",
        "Stop active runs before closing the workflow service",
      );
    this.leases.release();
    this.scheduler.dispose();
    this.store.close();
  }
}

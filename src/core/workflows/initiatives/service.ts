/**
 * Initiatives (docs/workflows/runtime.md, "Initiatives"): a large request split
 * into 3..12 features with contracts and a dependency DAG, one approval of the split, and feature
 * runs executed one at a time in dependency order on the existing workflow runtime. The
 * initiative owns no execution of its own: it starts, rebases and drives ordinary runs, and its
 * readiness rules are the existing `contractHash` dependency mechanism.
 */
import { hashJson } from "../../specs/hash.js";
import { type BudgetLimits, budgetUsage, limitsOf } from "../budget.js";
import { type AcceptedContract, acceptedContract } from "../dependencies.js";
import { WorkflowFault } from "../errors.js";
import {
  type CommandIdentity,
  PolicySchema,
  type RunPolicy,
  type RunSnapshot,
  SafeId,
} from "../schemas.js";
import type { NativeWorkflowService } from "../service.js";
import { terminalStates } from "../state-machine.js";
import { newId } from "../store.js";
import { DefinitionAutoApprovalSchema } from "../v2/definition.js";
import { loadDefinition } from "../v2/definitions.js";
import { autoApprovalPolicy } from "../v2/runtime.js";
import { DECOMPOSE_WORKFLOW_ID } from "./decompose.js";
import {
  applySplitEdit,
  featureDigest,
  type InitiativeFeature,
  InitiativeId,
  type InitiativePlan,
  InitiativePlanSchema,
  planSizeProblem,
  type SplitEdit,
  SplitEditSchema,
  topologicalOrder,
  validateInitiativePlan,
} from "./plan.js";
import {
  type BudgetLimitsValue,
  type InitiativeEvent,
  type InitiativeRow,
  type InitiativeRunRow,
  type InitiativeSettings,
  InitiativeStore,
} from "./store.js";

export interface InitiativeStartRequest {
  commandId: string;
  initiativeId: string;
  /** The large request, kept as the source of every feature run's prompt. */
  prompt: string;
  /** A split given by the user. Without it the `decomposer` proposes one in a decompose run. */
  plan?: InitiativePlan;
  /** The policy every feature run starts from before its budget share. */
  policy: RunPolicy;
  /** The workflow each feature runs; defaults to `sdd`. */
  workflowId?: string;
  /** The shared budget; omitted, it is derived from the policy (see `planBudget`). */
  budget?: BudgetLimits | null;
  /** Tiered approval; omitted or null keeps every feature spec approval with a person. */
  featureAutoApproval?: { maxTasks: number; maxFiles: number } | null;
  /** The confirmation of a v2 feature workflow's own auto approval limits (see `start`). */
  autoApprovalConfirmation?: string | null;
  model?: string;
  ownerLabel: string;
}

export type FeatureState =
  | "proposed"
  | "waiting"
  | "ready"
  | "in_progress"
  | "needs_decision"
  | "paused"
  | "blocked"
  | "failed"
  | "stale"
  | "accepted";

export interface PendingDecision {
  scope: "initiative" | "feature" | "decompose";
  featureId: string | null;
  runId: string | null;
  requestId: string;
  kind: string;
  digest: string;
}

export interface UsageView {
  tokens: number;
  calls: number;
  activeMs: number;
}

export interface FeatureView {
  id: string;
  title: string;
  mandatory: boolean;
  dependsOn: string[];
  boundary: InitiativeFeature["boundary"];
  contract: string;
  /** The workflow feature ID of this feature's runs. */
  runFeatureId: string;
  state: FeatureState;
  runId: string | null;
  runStatus: string | null;
  runReason: string | null;
  /** Upstream contracts the current run is pinned to. */
  pinned: { featureId: string; contractHash: string }[];
  /** The accepted contract hash dependents build on, once accepted. */
  contractHash: string | null;
  /** Why the feature cannot continue now, in words. */
  blockers: string[];
  pendingRequests: PendingDecision[];
  /** Everything this feature's runs spent, superseded runs included. */
  usage: UsageView;
  runIds: string[];
}

export interface NextAction {
  kind:
    | "decompose"
    | "finish_decompose"
    | "await_split_approval"
    | "start"
    | "rebase"
    | "drive"
    | "decide"
    | "complete"
    | "blocked"
    | "paused"
    | "done";
  featureId: string | null;
  runId: string | null;
  message: string;
}

export interface InitiativeView {
  initiativeId: string;
  title: string;
  status: InitiativeRow["status"];
  reason: string;
  revision: number;
  eventSeq: number;
  planRevision: number;
  approvedPlanRevision: number | null;
  approvalDigest: string | null;
  /** Digest of the latest plan revision; the split approval must name it. */
  planDigest: string | null;
  goals: string[];
  completionCriteria: string[];
  workflowId: string;
  featureAutoApproval: InitiativeSettings["featureAutoApproval"];
  decompose: { runId: string; status: string; reason: string } | null;
  features: FeatureView[];
  pendingDecisions: PendingDecision[];
  budget: {
    limits: BudgetLimitsValue;
    used: UsageView;
    /** Limits of open runs not spent yet; they are held back from the shares of later features. */
    reserved: UsageView;
    remaining: UsageView;
    /** Features in the approved plan without a run yet; each gets an equal share. */
    unstartedFeatures: number;
    nextShare: UsageView | null;
    rule: string;
  };
  next: NextAction;
}

/** The workflow feature ID of an initiative feature's runs. `_` never occurs in either part. */
export const runFeatureId = (initiativeId: string, featureId: string): string =>
  `${initiativeId}_${featureId}`;
const decomposeFeatureId = (initiativeId: string): string => `${initiativeId}__decompose`;

/**
 * The shared budget when the user sets none: the per-run limits of the policy times the number
 * of features plus one (the decompose run and later re-plans take the extra share).
 */
export function planBudget(settings: InitiativeSettings, plan: InitiativePlan): BudgetLimitsValue {
  if (settings.budget) return settings.budget;
  const factor = plan.features.length + 1;
  const base = settings.basePolicy;
  return {
    maxTotalTokens: base.maxTotalTokens * factor,
    maxAgentCalls: base.maxAgentCalls * factor,
    maxActiveMs: base.maxActiveMs * factor,
  };
}

/** The smallest share a feature run can start with; below it the shared budget is exhausted. */
export const MIN_SHARE = { maxTotalTokens: 1000, maxAgentCalls: 1, maxActiveMs: 1000 } as const;

export const BUDGET_RULE =
  "Each feature run starts with an equal share of the remaining shared budget, rounded down: remaining = limit - (usage of finished runs + the limits of open runs, decompose and superseded runs included), divided by the features of the approved plan without a run. A rebased run takes one more share of the same split. Agent calls per run are capped at 1000.";

/** Digest a person approves for a plan revision: the plan, the budget and the frozen settings. */
export function splitDigest(
  initiativeId: string,
  revision: number,
  plan: InitiativePlan,
  budget: BudgetLimitsValue,
  settings: InitiativeSettings,
): string {
  return hashJson({
    initiativeId,
    revision,
    plan,
    budget,
    settings: {
      workflowId: settings.workflowId,
      policyHash: hashJson(settings.basePolicy),
      featureAutoApproval: settings.featureAutoApproval,
      autoApprovalConfirmation: settings.autoApprovalConfirmation,
      model: settings.model,
    },
  });
}

const share = (remaining: UsageView, parts: number): UsageView => ({
  tokens: Math.floor(remaining.tokens / parts),
  calls: Math.floor(remaining.calls / parts),
  activeMs: Math.floor(remaining.activeMs / parts),
});
const zero = (): UsageView => ({ tokens: 0, calls: 0, activeMs: 0 });
const add = (a: UsageView, b: UsageView): UsageView => ({
  tokens: a.tokens + b.tokens,
  calls: a.calls + b.calls,
  activeMs: a.activeMs + b.activeMs,
});

export class InitiativeService {
  readonly store: InitiativeStore;
  private active = new Map<string, AbortController>();
  constructor(readonly workflows: NativeWorkflowService) {
    this.store = new InitiativeStore(workflows.store);
  }

  // --- Commands --------------------------------------------------------------------------

  async start(request: InitiativeStartRequest): Promise<InitiativeView> {
    const id = InitiativeId.parse(request.initiativeId);
    SafeId.parse(request.commandId);
    if (!request.prompt.trim())
      throw new WorkflowFault("INVALID_DEFINITION", "Initiative request text is required");
    // Optional fields left undefined are dropped, so the stored body hashes like its replay.
    const body = JSON.parse(JSON.stringify({ action: "start", ...request })) as unknown;
    const previous = this.store.previousCommand<InitiativeView>(request.commandId, body);
    if (previous) return previous;
    if (this.store.exists(id))
      throw new WorkflowFault("INVALID_DEFINITION", `Initiative ${id} already exists`);
    const settings: InitiativeSettings = {
      workflowId: SafeId.parse(request.workflowId ?? "sdd"),
      basePolicy: PolicySchema.parse(request.policy),
      budget: request.budget ?? null,
      featureAutoApproval: request.featureAutoApproval ?? null,
      autoApprovalConfirmation: request.autoApprovalConfirmation ?? null,
      model: request.model ?? null,
      ownerLabel: request.ownerLabel,
    };
    this.checkWorkflow(settings);
    if (request.plan) {
      const plan = InitiativePlanSchema.parse(request.plan);
      const problems = validateInitiativePlan(plan);
      if (problems.length) throw new WorkflowFault("INVALID_DEFINITION", problems.join("\n"));
      return this.store.transaction(() => {
        this.store.create({
          id,
          title: plan.title,
          prompt: request.prompt,
          status: "awaiting_approval",
          settings,
          decomposeRunId: null,
        });
        this.propose(id, plan, "user", null);
        const view = this.view(id);
        this.store.saveCommand(request.commandId, id, body, view);
        return view;
      });
    }
    // The decompose run never writes files; auto approval has nothing to approve there.
    const run = await this.workflows.start({
      commandId: `${request.commandId}-decompose`.slice(0, 96),
      workflowId: DECOMPOSE_WORKFLOW_ID,
      featureId: decomposeFeatureId(id),
      prompt: request.prompt,
      policy: PolicySchema.parse({ ...settings.basePolicy, autoApproval: null }),
      ownerLabel: request.ownerLabel,
      ...(request.model ? { model: request.model } : {}),
    });
    return this.store.transaction(() => {
      this.store.create({
        id,
        title: request.prompt.trim().split("\n")[0]?.slice(0, 200) || id,
        prompt: request.prompt,
        status: "decomposing",
        settings,
        decomposeRunId: run.runId,
      });
      const view = this.view(id);
      this.store.saveCommand(request.commandId, id, body, view);
      return view;
    });
  }

  /** Merge, split, remove or rename features of the proposed split; a new revision and digest. */
  async edit(id: string, command: CommandIdentity, edit: SplitEdit): Promise<InitiativeView> {
    const parsed = SplitEditSchema.parse(edit);
    return this.command(id, command, { action: "edit", edit: parsed }, () => {
      const row = this.store.get(id);
      const editable =
        row.status === "awaiting_approval" ||
        (row.status === "paused" && row.approved_plan_revision !== null);
      if (!editable)
        throw new WorkflowFault(
          "STALE_DECISION",
          row.status === "active"
            ? "Pause the initiative before re-planning its split"
            : `The split cannot be edited while the initiative is ${row.status}`,
        );
      const latest = this.store.plan(this.store.revision(id, row.plan_revision));
      this.propose(id, applySplitEdit(latest, parsed), "user", parsed);
    });
  }

  /** The mandatory approval of the split, bound to the digest of the latest plan revision. */
  async approve(
    id: string,
    command: CommandIdentity,
    decision: { requestId: string; digest: string },
  ): Promise<InitiativeView> {
    await this.command(id, command, { action: "approve", ...decision }, () => {
      const row = this.store.get(id);
      if (row.status !== "awaiting_approval")
        throw new WorkflowFault("STALE_DECISION", "The initiative has no split to approve");
      const request = this.store
        .requests(id)
        .find((r) => r.id === decision.requestId && r.status === "pending");
      if (!request) throw new WorkflowFault("STALE_DECISION", "Pending request not found");
      const revision = this.store.revision(id, row.plan_revision);
      if (
        request.plan_revision !== row.plan_revision ||
        request.digest !== decision.digest ||
        decision.digest !== revision.digest
      )
        throw new WorkflowFault(
          "STALE_DECISION",
          "Approval digest does not match the current split",
        );
      this.store.decide(id, request.id, "accepted", decision);
      this.store.approve(id, revision.revision, revision.digest);
      // A re-plan keeps the results of features it did not change; changed or removed ones are
      // superseded and run again under the new revision.
      const plan = this.store.plan(revision);
      for (const link of this.store.links(id).filter((l) => l.superseded_at === null)) {
        const feature = plan.features.find((f) => f.id === link.feature_id);
        if (!feature)
          this.store.supersede(id, link.run_id, `removed by plan revision ${revision.revision}`);
        else if (featureDigest(feature) !== link.feature_digest)
          this.store.supersede(id, link.run_id, `changed by plan revision ${revision.revision}`);
      }
      this.store.setStatus(id, "active");
    });
    await this.settleSuperseded(id);
    return this.view(id);
  }

  async reject(
    id: string,
    command: CommandIdentity,
    decision: { requestId: string; reason: string },
  ): Promise<InitiativeView> {
    if (!decision.reason.trim())
      throw new WorkflowFault("INVALID_DEFINITION", "A rejection needs a reason");
    return this.command(id, command, { action: "reject", ...decision }, () => {
      const request = this.store
        .requests(id)
        .find((r) => r.id === decision.requestId && r.status === "pending");
      if (!request) throw new WorkflowFault("STALE_DECISION", "Pending request not found");
      this.store.decide(id, request.id, "rejected", decision);
      this.store.setStatus(
        id,
        "awaiting_approval",
        `Split rejected: ${decision.reason}. Edit the split to propose a new revision.`,
      );
    });
  }

  async pause(id: string, command: CommandIdentity): Promise<InitiativeView> {
    await this.command(id, command, { action: "pause" }, () => {
      const row = this.store.get(id);
      if (row.status !== "active" && row.status !== "decomposing")
        throw new WorkflowFault(
          "STALE_DECISION",
          `An initiative that is ${row.status} cannot be paused`,
        );
      this.store.setStatus(id, "paused", "user_pause");
    });
    this.active.get(id)?.abort(new Error("Initiative paused"));
    // A feature run executing in another process stops at its next poll.
    for (const runId of this.openRuns(id)) {
      const run = this.workflows.store.run(runId);
      if (run.status === "running")
        await this.workflows.pause(runId, { commandId: newId(), expectedRevision: run.revision });
    }
    return this.view(id);
  }

  async resume(id: string, command: CommandIdentity): Promise<InitiativeView> {
    return this.command(id, command, { action: "resume" }, () => {
      const row = this.store.get(id);
      if (row.status !== "paused")
        throw new WorkflowFault("STALE_DECISION", "Only a paused initiative can be resumed");
      this.store.setStatus(id, row.approved_plan_revision === null ? "decomposing" : "active");
    });
  }

  /**
   * Runs one feature again from research: its current run is superseded and the next drive starts
   * a new one. The finished results of other features stay; dependents whose pinned contract
   * changes when the new run is approved are rebased and re-approved.
   */
  async replan(id: string, command: CommandIdentity, featureId: string): Promise<InitiativeView> {
    await this.command(id, command, { action: "replan", featureId }, () => {
      const row = this.store.get(id);
      if (row.status !== "active" && row.status !== "paused")
        throw new WorkflowFault(
          "STALE_DECISION",
          `An initiative that is ${row.status} cannot re-plan`,
        );
      const plan = this.approvedPlan(row);
      if (!plan?.features.some((f) => f.id === featureId))
        throw new WorkflowFault("NOT_FOUND", `Unknown feature ${featureId}`);
      const link = this.store.current(id, featureId);
      if (!link) throw new WorkflowFault("STALE_DECISION", `Feature ${featureId} has no run yet`);
      if (this.workflows.store.run(link.run_id).status === "running")
        throw new WorkflowFault(
          "WORKSPACE_BUSY",
          "Pause the initiative before re-planning a running feature",
        );
      this.store.supersede(id, link.run_id, "re-planned by the user");
    });
    await this.settleSuperseded(id);
    return this.view(id);
  }

  /** Raises the shared budget; limits only go up. The command is the user's approval of it. */
  async extendBudget(
    id: string,
    command: CommandIdentity,
    requested: Partial<BudgetLimitsValue>,
  ): Promise<InitiativeView> {
    return this.command(id, command, { action: "extend", requested }, () => {
      const row = this.store.get(id);
      const settings = this.store.settings(row);
      const current = this.limits(row);
      const next = {
        maxTotalTokens: requested.maxTotalTokens ?? current.maxTotalTokens,
        maxAgentCalls: requested.maxAgentCalls ?? current.maxAgentCalls,
        maxActiveMs: requested.maxActiveMs ?? current.maxActiveMs,
      };
      if (
        next.maxTotalTokens < current.maxTotalTokens ||
        next.maxAgentCalls < current.maxAgentCalls ||
        next.maxActiveMs < current.maxActiveMs
      )
        throw new WorkflowFault("INVALID_DEFINITION", "Shared budget limits can only be raised");
      this.store.setSettings(id, { ...settings, budget: next });
      this.store.emit(id, "budget.extended", { previous: current, next });
    });
  }

  // --- Execution ---------------------------------------------------------------------------

  /**
   * Advances the initiative until it needs a person, is blocked, is paused or completes. Feature
   * runs execute one at a time in dependency order, so the workspace keeps one writer.
   */
  async drive(id: string, signal: AbortSignal): Promise<InitiativeView> {
    if (this.active.has(id))
      throw new WorkflowFault("WORKSPACE_BUSY", "Initiative already executing in this process");
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.active.set(id, controller);
    try {
      await this.settleSuperseded(id);
      for (let step = 0; step < 500 && !controller.signal.aborted; step++) {
        const next = this.view(id).next;
        switch (next.kind) {
          case "decompose":
          case "drive": {
            const runId = next.runId ?? "";
            const before = this.workflows.store.run(runId);
            await this.driveRun(runId, controller.signal);
            const after = this.workflows.store.run(runId);
            // Nothing moved (for example a lost lease): report instead of spinning.
            if (after.revision === before.revision) return this.view(id);
            break;
          }
          case "finish_decompose":
            this.finishDecompose(id);
            break;
          case "start":
            await this.startFeature(id, next.featureId ?? "");
            break;
          case "rebase":
            await this.rebaseFeature(id, next.featureId ?? "");
            break;
          case "complete":
            this.store.transaction(() => {
              this.store.setStatus(id, "completed");
              this.store.emit(id, "initiative.completed", {
                features: this.view(id).features.map((f) => ({
                  id: f.id,
                  runId: f.runId,
                  contractHash: f.contractHash,
                })),
              });
            });
            return this.view(id);
          default:
            return this.view(id);
        }
      }
      return this.view(id);
    } finally {
      this.active.delete(id);
      signal.removeEventListener("abort", abort);
    }
  }

  private async driveRun(runId: string, signal: AbortSignal): Promise<RunSnapshot> {
    const run = this.workflows.store.run(runId);
    if (run.status === "paused")
      await this.workflows.resume(runId, { commandId: newId(), expectedRevision: run.revision });
    return this.workflows.drive(runId, signal);
  }

  private finishDecompose(id: string): void {
    const row = this.store.get(id);
    const state = this.workflows.store.state(row.decompose_run_id ?? "");
    if (!state.initiativePlan)
      throw new WorkflowFault("ARTIFACT_MISSING", "The decompose run has no initiative plan");
    const plan = InitiativePlanSchema.parse(JSON.parse(state.initiativePlan));
    this.store.transaction(() => {
      const size = planSizeProblem(plan);
      if (size) {
        this.store.emit(id, "split.refused", {
          reason: size,
          features: plan.features.map((f) => ({ id: f.id, title: f.title })),
        });
        this.store.setStatus(id, "refused", size);
        return;
      }
      this.store.setTitle(id, plan.title);
      this.propose(id, plan, "decomposer", null);
    });
  }

  private async startFeature(id: string, featureId: string): Promise<void> {
    const row = this.store.get(id);
    const plan = this.approvedPlan(row);
    const feature = plan?.features.find((f) => f.id === featureId);
    if (!plan || !feature) throw new WorkflowFault("NOT_FOUND", `Unknown feature ${featureId}`);
    const settings = this.store.settings(row);
    const upstream = this.upstreamContracts(id, feature);
    const share = this.view(id).budget.nextShare;
    if (!share) throw new WorkflowFault("BUDGET_EXHAUSTED", "No budget share is available");
    const previous = this.store.links(id).filter((l) => l.feature_id === featureId).length;
    const runFeature = runFeatureId(id, featureId);
    // A derived command ID makes a start after a crash return the same run instead of a second one.
    const snapshot = await this.workflows.start({
      commandId: `i-${hashJson({ id, featureId, previous, revision: row.approved_plan_revision }).slice(0, 48)}`,
      workflowId: settings.workflowId,
      featureId: runFeature,
      prompt: featurePrompt(row, plan, feature, upstream),
      policy: featurePolicy(settings, share, feature, false),
      ownerLabel: settings.ownerLabel,
      dependencies: upstream.map((u) => ({
        featureId: u.contract.featureId,
        contractHash: u.contract.contractHash,
      })),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.autoApprovalConfirmation
        ? { autoApprovalConfirmation: settings.autoApprovalConfirmation }
        : {}),
    });
    this.store.transaction(() => {
      if (this.store.links(id).some((l) => l.run_id === snapshot.runId)) return;
      this.store.link(
        id,
        featureId,
        snapshot.runId,
        row.approved_plan_revision ?? 0,
        featureDigest(feature),
        previous ? "replan" : "start",
      );
    });
  }

  /**
   * An upstream contract changed under a feature's run: its evidence is invalidated, the run (if
   * still open) is cancelled, and a fork pinned to the new contracts starts again at analysis.
   * Its approval always goes to a person, whatever the tiered approval setting.
   */
  private async rebaseFeature(id: string, featureId: string): Promise<void> {
    const row = this.store.get(id);
    const plan = this.approvedPlan(row);
    const feature = plan?.features.find((f) => f.id === featureId);
    const link = this.store.current(id, featureId);
    if (!plan || !feature || !link)
      throw new WorkflowFault("NOT_FOUND", `Feature ${featureId} has no run to rebase`);
    const settings = this.store.settings(row);
    const upstream = this.upstreamContracts(id, feature);
    const old = this.workflows.store.run(link.run_id);
    if (!terminalStates.includes(old.status))
      await this.workflows.cancel(link.run_id, {
        commandId: newId(),
        expectedRevision: old.revision,
      });
    const oldState = this.workflows.store.state(link.run_id);
    const pinned = oldState.hostDependencies ?? [];
    const changed = upstream
      .filter(
        (u) =>
          !pinned.some(
            (p) =>
              p.featureId === u.contract.featureId && p.contractHash === u.contract.contractHash,
          ),
      )
      .map((u) => u.feature.id);
    this.workflows.store.transaction(() => {
      if (oldState.snapshotId)
        this.workflows.store.invalidateEvidence(link.run_id, oldState.snapshotId, "input_changed");
    });
    // The rebased run shares what is left with the features that have not started yet.
    const budget = this.view(id).budget;
    const rebaseShare = share(budget.remaining, budget.unstartedFeatures + 1);
    const dependencies = upstream.map((u) => ({
      featureId: u.contract.featureId,
      contractHash: u.contract.contractHash,
    }));
    const current = this.workflows.store.run(link.run_id);
    const snapshot = await this.workflows.rebase(
      link.run_id,
      {
        commandId: `r-${hashJson({ runId: link.run_id, dependencies }).slice(0, 48)}`,
        expectedRevision: current.revision,
      },
      { dependencies, policy: featurePolicy(settings, rebaseShare, feature, true) },
    );
    this.store.transaction(() => {
      this.store.emit(id, "feature.invalidated", {
        featureId,
        runId: link.run_id,
        changedUpstream: changed,
      });
      this.store.supersede(id, link.run_id, `upstream contract changed: ${changed.join(", ")}`);
      this.store.link(
        id,
        featureId,
        snapshot.runId,
        row.approved_plan_revision ?? 0,
        featureDigest(feature),
        "rebase",
      );
    });
  }

  /** Superseded runs that are still open are cancelled, so they hold no publication or lease. */
  private async settleSuperseded(id: string): Promise<void> {
    for (const link of this.store.links(id).filter((l) => l.superseded_at !== null)) {
      const run = this.workflows.store.run(link.run_id);
      if (terminalStates.includes(run.status) || run.status === "running") continue;
      await this.workflows.cancel(link.run_id, {
        commandId: newId(),
        expectedRevision: run.revision,
      });
    }
  }

  /**
   * Tiered approval narrows auto approval to each feature's boundary through the run policy, which
   * a schema 1 workflow (such as `sdd`) honors. A v2 definition takes auto approval from the
   * definition only (`autoApprovalOf`), so the flag would silently do nothing there; it is refused.
   */
  private checkWorkflow(settings: InitiativeSettings): void {
    const loaded = loadDefinition(
      this.workflows.workspace,
      settings.workflowId,
      settings.basePolicy,
    );
    if (settings.featureAutoApproval && loaded.schemaVersion === 2)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Tiered approval needs a schema 1 feature workflow such as sdd; ${settings.workflowId} takes auto approval from its definition`,
      );
  }

  // --- Reading -------------------------------------------------------------------------------

  list(): InitiativeView[] {
    return this.store.list().map((row) => this.view(row.id));
  }

  events(id: string, after = 0, limit = 200): InitiativeEvent[] {
    this.store.get(id);
    return this.store.events(id, after, limit);
  }

  /** What the initiative is, where every feature stands and why, and what happens next. */
  view(id: string): InitiativeView {
    const row = this.store.get(id);
    const settings = this.store.settings(row);
    const latest = row.plan_revision ? this.store.revision(id, row.plan_revision) : null;
    const latestPlan = latest ? this.store.plan(latest) : null;
    const approved = this.approvedPlan(row);
    const plan = approved ?? latestPlan;
    const features = plan ? this.featureViews(row, plan, approved !== null) : [];
    const decompose = row.decompose_run_id ? this.workflows.store.run(row.decompose_run_id) : null;
    const runIds = [
      ...(decompose ? [decompose.id] : []),
      ...this.store.links(id).map((l) => l.run_id),
    ];
    const used = runIds.map((runId) => this.usage(runId)).reduce(add, zero());
    const committed = runIds.map((runId) => this.committed(runId)).reduce(add, zero());
    const limits = this.limits(row);
    const remaining = {
      tokens: Math.max(0, limits.maxTotalTokens - committed.tokens),
      calls: Math.max(0, limits.maxAgentCalls - committed.calls),
      activeMs: Math.max(0, limits.maxActiveMs - committed.activeMs),
    };
    const unstarted = approved ? features.filter((f) => f.runId === null).length : 0;
    const nextShare = unstarted ? share(remaining, unstarted) : null;
    const pendingDecisions: PendingDecision[] = [
      ...this.store
        .requests(id)
        .filter((r) => r.status === "pending")
        .map((r) => ({
          scope: "initiative" as const,
          featureId: null,
          runId: null,
          requestId: r.id,
          kind: r.kind,
          digest: r.digest,
        })),
      ...(decompose ? this.runRequests(decompose.id, "decompose", null) : []),
      ...features.flatMap((f) => f.pendingRequests),
    ];
    const view: InitiativeView = {
      initiativeId: row.id,
      title: row.title,
      status: row.status,
      reason: row.reason,
      revision: row.revision,
      eventSeq: row.event_seq,
      planRevision: row.plan_revision,
      approvedPlanRevision: row.approved_plan_revision,
      approvalDigest: row.approval_digest,
      planDigest: latest?.digest ?? null,
      goals: plan?.goals ?? [],
      completionCriteria: plan?.completionCriteria ?? [],
      workflowId: settings.workflowId,
      featureAutoApproval: settings.featureAutoApproval,
      decompose: decompose
        ? { runId: decompose.id, status: decompose.status, reason: decompose.reason }
        : null,
      features,
      pendingDecisions,
      budget: {
        limits,
        used,
        reserved: {
          tokens: committed.tokens - used.tokens,
          calls: committed.calls - used.calls,
          activeMs: committed.activeMs - used.activeMs,
        },
        remaining,
        unstartedFeatures: unstarted,
        nextShare,
        rule: BUDGET_RULE,
      },
      next: { kind: "done", featureId: null, runId: null, message: "" },
    };
    view.next = this.nextAction(row, view);
    return view;
  }

  private nextAction(row: InitiativeRow, view: InitiativeView): NextAction {
    const action = (
      kind: NextAction["kind"],
      message: string,
      feature: FeatureView | null = null,
      runId: string | null = feature?.runId ?? null,
    ): NextAction => ({ kind, featureId: feature?.id ?? null, runId, message });
    switch (row.status) {
      case "completed":
        return action("done", "Every mandatory feature has an accepted result.");
      case "refused":
        return action("done", row.reason);
      case "paused":
        return action("paused", "The initiative is paused; resume it to continue.");
      case "awaiting_approval":
        return action(
          "await_split_approval",
          view.pendingDecisions.some((d) => d.scope === "initiative")
            ? `Approve the split (plan revision ${row.plan_revision}) or edit it.`
            : row.reason || "Edit the split to propose a new revision.",
        );
      case "decomposing": {
        const run = view.decompose;
        if (!run) return action("blocked", "The initiative has no decompose run");
        if (run.status === "completed")
          return action("finish_decompose", "Read the proposed split", null, run.runId);
        if (view.pendingDecisions.some((d) => d.scope === "decompose"))
          return action("decide", "The decompose run waits for a decision", null, run.runId);
        if (run.status === "blocked")
          return action(
            "blocked",
            `The decompose run is blocked (${run.reason}); resolve it with baked workflow resume ${run.runId}`,
            null,
            run.runId,
          );
        if (run.status === "failed" || run.status === "cancelled")
          return action(
            "blocked",
            `The decompose run ${run.status}; start the initiative again`,
            null,
            run.runId,
          );
        return action("decompose", "Propose the split", null, run.runId);
      }
      case "active":
        break;
    }
    // One feature run is open at a time: the runtime guards each run's source snapshot, so a
    // second open run's edits would block the first. An open run that waits for a person stops the
    // drive until the decision is made.
    const open = view.features.filter(
      (f) => f.runStatus !== null && !terminalStates.includes(f.runStatus as RunSnapshot["status"]),
    );
    for (const feature of open) {
      if (feature.state === "waiting") continue;
      if (feature.state === "stale")
        return action("rebase", `Rebase ${feature.id} on the changed upstream contract`, feature);
      if (feature.state === "needs_decision")
        return action("decide", `Feature ${feature.id} waits for a decision`, feature);
      if (feature.state === "blocked")
        return action("blocked", `Feature ${feature.id}: ${feature.blockers.join("; ")}`, feature);
      return action("drive", `Continue feature ${feature.id}`, feature);
    }
    for (const feature of view.features) {
      if (feature.state === "stale")
        return action("rebase", `Rebase ${feature.id} on the changed upstream contract`, feature);
      if (feature.state !== "ready") continue;
      const share = view.budget.nextShare;
      if (
        !share ||
        share.tokens < MIN_SHARE.maxTotalTokens ||
        share.calls < MIN_SHARE.maxAgentCalls ||
        share.activeMs < MIN_SHARE.maxActiveMs
      )
        return action(
          "blocked",
          `The shared budget is exhausted: ${feature.id} would start with ${share?.tokens ?? 0} tokens, ${share?.calls ?? 0} calls and ${share?.activeMs ?? 0} ms. Raise it with baked workflow initiative extend.`,
          feature,
        );
      return action("start", `Start feature ${feature.id}`, feature);
    }
    const missing = view.features.filter((f) => f.mandatory && f.state !== "accepted");
    if (missing.length === 0)
      return action("complete", "Every mandatory feature has an accepted result.");
    return action(
      "blocked",
      missing.map((f) => `${f.id}: ${f.blockers.join("; ") || f.state}`).join(" | "),
    );
  }

  private featureViews(row: InitiativeRow, plan: InitiativePlan, approved: boolean): FeatureView[] {
    const views = new Map<string, FeatureView>();
    for (const feature of topologicalOrder(plan)) {
      const runFeature = runFeatureId(row.id, feature.id);
      const runs = this.store.links(row.id).filter((l) => l.feature_id === feature.id);
      const view: FeatureView = {
        id: feature.id,
        title: feature.title,
        mandatory: feature.mandatory,
        dependsOn: feature.dependsOn,
        boundary: feature.boundary,
        contract: feature.contract,
        runFeatureId: runFeature,
        state: "proposed",
        runId: null,
        runStatus: null,
        runReason: null,
        pinned: [],
        contractHash: null,
        blockers: [],
        pendingRequests: [],
        usage: runs.map((l) => this.usage(l.run_id)).reduce(add, zero()),
        runIds: runs.map((l) => l.run_id),
      };
      views.set(feature.id, view);
      if (!approved) continue;
      const upstream = feature.dependsOn.map((d) => views.get(d)).filter((u) => u !== undefined);
      const waiting = upstream
        .filter((u) => u.state !== "accepted")
        .map((u) => `waits for ${u.id}'s contract (${u.id} is ${describe(u)})`);
      const link = this.store.current(row.id, feature.id);
      if (!link) {
        view.state = waiting.length ? "waiting" : "ready";
        view.blockers = waiting;
        continue;
      }
      const run = this.workflows.store.snapshot(link.run_id);
      const state = this.workflows.store.state(link.run_id);
      view.runId = link.run_id;
      view.runStatus = run.status;
      view.runReason = run.reason;
      view.pinned = state.hostDependencies ?? [];
      view.pendingRequests = this.runRequests(link.run_id, "feature", feature.id);
      const changed = upstream
        .filter((u) => u.state === "accepted")
        .filter(
          (u) =>
            !view.pinned.some(
              (p) => p.featureId === u.runFeatureId && p.contractHash === u.contractHash,
            ),
        )
        .map(
          (u) =>
            `${u.id}'s contract changed since this run was planned; the plan must be re-approved`,
        );
      if (run.status === "completed") {
        const accepted = acceptedContract(this.workflows.store, runFeature);
        if (waiting.length) {
          view.state = "waiting";
          view.blockers = [
            ...waiting,
            "the finished result is checked again once the upstream is accepted",
          ];
        } else if (changed.length) {
          view.state = "stale";
          view.blockers = changed;
        } else if (accepted?.runId !== link.run_id) {
          view.state = "blocked";
          view.blockers = [
            `run ${accepted?.runId ?? "none"} of ${runFeature} was approved outside the initiative; re-plan the feature`,
          ];
        } else if (run.verificationState !== "current") {
          view.state = "stale";
          view.blockers = [`the result's verification is ${run.verificationState}`];
        } else {
          view.state = "accepted";
          view.contractHash = accepted.contractHash;
        }
      } else if (run.status === "failed" || run.status === "cancelled") {
        view.state = "failed";
        view.blockers = [
          `run ${link.run_id} ${run.status} (${run.reason}); re-plan the feature to run it again`,
        ];
      } else if (changed.length) {
        view.state = "stale";
        view.blockers = changed;
      } else if (view.pendingRequests.length) {
        view.state = "needs_decision";
        view.blockers = view.pendingRequests.map(
          (r) => `run ${r.runId} waits for a ${r.kind} decision (request ${r.requestId})`,
        );
      } else if (waiting.length) {
        view.state = "waiting";
        view.blockers = waiting;
      } else if (run.status === "blocked") {
        view.state = "blocked";
        view.blockers = [
          `run ${link.run_id} is blocked (${run.reason}); resolve it with baked workflow resume ${link.run_id}`,
        ];
      } else view.state = run.status === "paused" ? "paused" : "in_progress";
    }
    return [...views.values()];
  }

  private runRequests(
    runId: string,
    scope: PendingDecision["scope"],
    featureId: string | null,
  ): PendingDecision[] {
    return this.workflows.store
      .requests(runId)
      .filter((r) => r.status === "pending")
      .map((r) => ({ scope, featureId, runId, requestId: r.id, kind: r.kind, digest: r.digest }));
  }

  private usage(runId: string): UsageView {
    const usage = budgetUsage(this.workflows.store, this.workflows.store.run(runId));
    return {
      tokens: usage.tokens + usage.heldTokens + usage.inFlightTokens,
      calls: usage.calls,
      activeMs: usage.activeMs,
    };
  }

  /** What a run takes from the shared budget: its usage once terminal, its limits while open. */
  private committed(runId: string): UsageView {
    const run = this.workflows.store.run(runId);
    const used = this.usage(runId);
    if (terminalStates.includes(run.status)) return used;
    const limits = limitsOf(PolicySchema.parse(JSON.parse(run.policy_json)));
    return {
      tokens: Math.max(used.tokens, limits.maxTotalTokens),
      calls: Math.max(used.calls, limits.maxAgentCalls),
      activeMs: Math.max(used.activeMs, limits.maxActiveMs),
    };
  }

  private limits(row: InitiativeRow): BudgetLimitsValue {
    const settings = this.store.settings(row);
    if (settings.budget) return settings.budget;
    const revision = row.approved_plan_revision ?? (row.plan_revision || null);
    if (revision !== null)
      return JSON.parse(this.store.revision(row.id, revision).budget_json) as BudgetLimitsValue;
    return {
      maxTotalTokens: settings.basePolicy.maxTotalTokens,
      maxAgentCalls: settings.basePolicy.maxAgentCalls,
      maxActiveMs: settings.basePolicy.maxActiveMs,
    };
  }

  private approvedPlan(row: InitiativeRow): InitiativePlan | null {
    return row.approved_plan_revision === null
      ? null
      : this.store.plan(this.store.revision(row.id, row.approved_plan_revision));
  }

  private upstreamContracts(
    id: string,
    feature: InitiativeFeature,
  ): { feature: { id: string }; contract: AcceptedContract }[] {
    return feature.dependsOn.map((dependency) => {
      const contract = acceptedContract(this.workflows.store, runFeatureId(id, dependency));
      if (!contract?.completed)
        throw new WorkflowFault("INVALID_REFERENCE", `No accepted contract of ${dependency} yet`);
      return { feature: { id: dependency }, contract };
    });
  }

  /** Runs of the initiative that are not terminal: the decompose run and current feature runs. */
  private openRuns(id: string): string[] {
    const row = this.store.get(id);
    return [
      ...(row.decompose_run_id ? [row.decompose_run_id] : []),
      ...this.store.links(id).map((l: InitiativeRunRow) => l.run_id),
    ].filter((runId) => !terminalStates.includes(this.workflows.store.run(runId).status));
  }

  /** A new plan revision with a pending split approval bound to its digest. */
  private propose(
    id: string,
    plan: InitiativePlan,
    source: "decomposer" | "user",
    edit: SplitEdit | null,
  ): void {
    const row = this.store.get(id);
    const settings = this.store.settings(row);
    const budget = planBudget(settings, plan);
    const revision = row.plan_revision + 1;
    const digest = splitDigest(id, revision, plan, budget, settings);
    for (const request of this.store.requests(id).filter((r) => r.status === "pending"))
      this.store.decide(id, request.id, "superseded", { planRevision: revision });
    this.store.addRevision(id, plan, budget, digest, source, edit);
    this.store.request(id, revision, digest);
    this.store.setStatus(id, "awaiting_approval");
  }

  private async command(
    id: string,
    command: CommandIdentity,
    body: Record<string, unknown>,
    action: () => void,
  ): Promise<InitiativeView> {
    SafeId.parse(command.commandId);
    return this.store.transaction(() => {
      const full = JSON.parse(JSON.stringify({ initiativeId: id, ...command, ...body })) as unknown;
      const previous = this.store.previousCommand<InitiativeView>(command.commandId, full);
      if (previous) return previous;
      this.store.bump(id, command.expectedRevision);
      action();
      const view = this.view(id);
      this.store.saveCommand(command.commandId, id, full, view);
      return view;
    });
  }
}

function describe(view: FeatureView): string {
  switch (view.state) {
    case "needs_decision":
      return "waiting for a decision";
    case "in_progress":
      return "in progress";
    case "waiting":
      return "waiting for its own upstream";
    case "ready":
      return "not started";
    default:
      return view.state.replace("_", " ");
  }
}

/**
 * The run policy of a feature: its budget share and, when tiered approval is on, auto approval
 * whose allowed paths are the feature's approved boundary. A feature without boundary paths, or
 * with more than auto approval accepts, and every rebased run (`humanOnly`) go to a person.
 */
export function featurePolicy(
  settings: InitiativeSettings,
  share: UsageView | typeof MIN_SHARE,
  feature: InitiativeFeature,
  humanOnly: boolean,
): RunPolicy {
  const tokens = "tokens" in share ? share.tokens : share.maxTotalTokens;
  const calls = "calls" in share ? share.calls : share.maxAgentCalls;
  const ms = "activeMs" in share ? share.activeMs : share.maxActiveMs;
  const base = settings.basePolicy;
  const maxTotalTokens = Math.max(MIN_SHARE.maxTotalTokens, tokens);
  const auto = settings.featureAutoApproval;
  const limits =
    auto && !humanOnly
      ? DefinitionAutoApprovalSchema.safeParse({
          enabled: true,
          maxTasks: auto.maxTasks,
          maxFiles: auto.maxFiles,
          allowedPaths: feature.boundary.paths,
          allowDelete: false,
          allowNewDependencies: false,
          maxTotalTokens,
        })
      : null;
  return PolicySchema.parse({
    ...base,
    maxTotalTokens,
    maxAgentCalls: Math.min(1000, Math.max(MIN_SHARE.maxAgentCalls, calls)),
    maxActiveMs: Math.max(MIN_SHARE.maxActiveMs, ms),
    autoApproval: limits?.success ? autoApprovalPolicy(limits.data) : null,
  });
}

/** The request a feature run starts from: its place in the initiative and the contracts around it. */
export function featurePrompt(
  row: InitiativeRow,
  plan: InitiativePlan,
  feature: InitiativeFeature,
  upstream: { feature: { id: string }; contract: AcceptedContract }[],
): string {
  const others = plan.features.filter((f) => f.id !== feature.id);
  const lines = [
    `This run implements feature ${feature.id} ("${feature.title}") of the initiative ${row.id} ("${plan.title}").`,
    "",
    "Initiative goals:",
    ...plan.goals.map((g) => `- ${g}`),
    "",
    `Boundary of this feature: ${feature.boundary.scope}`,
    feature.boundary.paths.length
      ? `Paths this feature may write: ${feature.boundary.paths.join(", ")}`
      : "The split names no paths for this feature; stay within the boundary above.",
    `Contract this feature provides to the features that depend on it: ${feature.contract}`,
  ];
  for (const { feature: dependency, contract } of upstream) {
    const definition = plan.features.find((f) => f.id === dependency.id);
    lines.push(
      `Upstream feature ${dependency.id} provides: ${definition?.contract ?? ""} Its accepted specification is specs/${contract.featureId}/spec.json (contract hash ${contract.contractHash}).`,
    );
  }
  if (others.length)
    lines.push(
      "",
      "Other features of the initiative own this work; do not implement it here:",
      ...others.map((f) => `- ${f.id}: ${f.title}`),
    );
  lines.push("", "The original request of the initiative:", row.prompt);
  return lines.join("\n");
}

import { canRepairRun } from "../repairable.js";
/**
 * Initiatives (docs/workflows/runtime.md, "Initiatives"): a large request split
 * into 3..12 features with contracts and a dependency DAG, one approval of the split, and feature
 * runs executed in dependency order on the existing workflow runtime: one at a time inline, and
 * independent features side by side when the feature workflow runs in worktrees. The
 * initiative owns no execution of its own: it starts, rebases and drives ordinary runs, and its
 * readiness rules are the existing `contractHash` dependency mechanism.
 */

import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ROUTING_ARTIFACT } from "../../llm/model-routing.js";
import { getCachedProviderStatuses } from "../../llm/provider.js";
import { availableVendorModels } from "../../llm/vendor-models.js";
import { matchGlob } from "../../platform/index.js";
import { canonical, hashBytes, hashJson } from "../../specs/hash.js";
import { specPublication } from "../../specs/render.js";
import { type BudgetLimits, budgetUsage, limitsOf } from "../budget.js";
import { autoCostTolerance } from "../cost-tolerance.js";
import { git } from "../delivery-git.js";
import {
  type AcceptedContract,
  acceptedContract,
  isHostRelease,
  providesContract,
} from "../dependencies.js";
import { WorkflowFault } from "../errors.js";
import {
  estimateHistory,
  estimatePreRun,
  historyStorePaths,
  type PastRun,
  type PlannedStage,
  type PreRunEstimate,
  rangeText,
  type TokenRange,
  tokenText,
} from "../estimate.js";
import { forecastSamples, forecastStageCost, runForecastStages } from "../forecast-price.js";
import { executingLeases } from "../leases.js";
import { plannedRunTokens } from "../plan-cost.js";
import { plannedStages } from "../pre-run.js";
import { type RecoveryAdvice, recoveryAdvice } from "../remedies.js";
import {
  explicitModelConfig,
  reviewIndependence,
  routedProfiles,
  routingRecord,
} from "../routing.js";
import {
  type CommandIdentity,
  executionModeOf,
  extendToOf,
  PolicySchema,
  parallelRunCap,
  type RunPolicy,
  type RunSnapshot,
  SafeId,
  specWritingRule,
} from "../schemas.js";
import type { NativeWorkflowService, PlannedReroute } from "../service.js";
import { sizingHistory, testCaseRate } from "../sizing.js";
import { terminalStates } from "../state-machine.js";
import { stopDetail, stopRecovery } from "../stop-detail.js";
import { recordWouldStop, type StopMode, stopFault, stopMode } from "../stop-reasons.js";
import { newId, WorkflowStore } from "../store.js";
import type { IssueSource } from "../types.js";
import { HOST_AUTO_APPROVAL_CEILING, HostAutoApprovalSchema } from "../v2/definition.js";
import { loadDefinition } from "../v2/definitions.js";
import { loadGateLibrary } from "../v2/library.js";
import { autoApprovalPolicy } from "../v2/runtime.js";
import { mergedBase, provisionalBase, worktreeBase } from "../worktree.js";
import { criticalPathSummary, planWidth, remainingPath } from "./critical-path.js";
import { DECOMPOSE_WORKFLOW_ID } from "./decompose.js";
import { type InitiativeDriveState, initiativeDriveState } from "./drive-state.js";
import {
  calibrationLagText,
  estimateInitiative,
  type FeatureRunSample,
  highCalibrationText,
  type InitiativeEstimate,
  type InitiativeProgress,
  MIN_CALIBRATION_FEATURES,
  SIZE_STAGE_FACTOR,
  SIZE_TASK_FACTOR,
  testVolumeText,
} from "./estimate.js";
import { initiativePriceSamples } from "./forecast.js";
import { costGrowthLimit, guardGrowth, openGuardRoom, refreshedGrowth } from "./growth.js";
import {
  applySplitEdit,
  boundaryPathCounts,
  type FeatureSize,
  featureDigest,
  foldSkeletonFeatures,
  type InitiativeFeature,
  InitiativeId,
  type InitiativePlan,
  InitiativePlanSchema,
  isGlobPath,
  mergeSmallSiblings,
  namedFiles,
  planSizeProblem,
  type SplitEdit,
  SplitEditSchema,
  sequenceDocumentation,
  sequenceSharedPaths,
  sizeWeight,
  stubFates,
  testOwnershipProblems,
  topologicalOrder,
  validateInitiativePlan,
} from "./plan.js";
import {
  type BudgetLimitsValue,
  CostBudgetSchema,
  type CostToleranceValue,
  FORECAST_BINDING_FEATURES,
  type InitiativeEvent,
  type InitiativeRow,
  type InitiativeRunRow,
  type InitiativeSettings,
  InitiativeStore,
} from "./store.js";
import {
  DEFAULT_EXTEND_WITHIN_DOLLARS,
  type ExtendWithinDollars,
  type PlanChargeView,
  type PoolExtension,
  type PoolFeature,
  type PoolInputs,
  planCharge,
  poolExtensionDecision,
  poolForecast,
  poolShortText,
  type TokenPoolView,
  tokenPool,
} from "./token-pool.js";
import { upstreamFiles, upstreamSymbolGaps } from "./upstream-symbols.js";
import {
  assignFeatureWorkflows,
  documentedLightLeaf,
  type FeatureWorkflow,
  featureWorkflow,
  featureWorkflowChoices,
  LIGHT_LEAF_WORKFLOW,
  lightenSmallLeaves,
  planWorkflowProblems,
  restoreContractWorkflows,
  withLightContract,
} from "./workflows.js";

export { costGrowthLimit, guardGrowth, refreshedGrowth } from "./growth.js";

export interface InitiativeStartRequest {
  commandId: string;
  initiativeId: string;
  /** The large request, kept as the source of every feature run's prompt. */
  prompt: string;
  /** A split given by the user. Without it the `decomposer` proposes one in a decompose run. */
  plan?: InitiativePlan;
  /** The policy every feature run starts from before its budget share. */
  policy: RunPolicy;
  /** The workflow of a feature that names none; defaults to `sdd`. */
  workflowId?: string;
  /** The shared budget; omitted, it is derived from the policy (see `planBudget`). */
  budget?: BudgetLimits | null;
  /** The dollar budget feature runs share; omitted or null leaves dollars to each run's policy. */
  costBudget?: { maxCostUsd: number; costTolerance?: CostToleranceValue } | null;
  /** Tiered approval; omitted or null keeps every feature spec approval with a person. */
  featureAutoApproval?: { maxTasks: number; maxFiles: number } | null;
  /** The confirmation of a v2 feature workflow's own auto approval limits (see `start`). */
  autoApprovalConfirmation?: string | null;
  model?: string;
  ownerLabel: string;
  /** The GitHub issue of each feature of `plan`; its runs start from it and delivery closes it. */
  featureIssues?: Record<string, IssueSource>;
  /** Hold feature starts while the estimate's low end is above the shared budget (#1312). */
  forecastStop?: boolean;
  /** Keep the decomposer's split as is instead of merging small siblings (#1352). */
  keepFeatures?: boolean;
  /** Ask the decomposer to split a feature that dominates the critical path (#1522). */
  splitCriticalPath?: boolean;
  /** Let a small feature that others depend on run the light workflow with a host-made contract (#1664). */
  lightContracts?: boolean;
}

/** What an initiative reroute did to one of its open runs (`initiative.rerouted` event). */
export interface RerouteResult {
  featureId: string | null;
  runId: string;
  result: "rerouted" | "unchanged" | "skipped";
  /** The run model before, for a rerouted run. */
  from?: string;
  reason?: string;
}

/** How often a drive with plan ahead looks for a feature that became ready to plan (#1834). */
const PLAN_AHEAD_POLL_MS = 1000;

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

/** The initiative's dollars (#1317): what its runs spent, and the cap they share when one is set. */
export interface CostView {
  /** The dollar cap (`--budget-usd`); null without one. */
  capUsd: number | null;
  /** The tolerance band as a share of the cap; 0 without a cap or with `costTolerance` off. */
  tolerance: number;
  /** The cap plus its band: past it no feature starts. Null without a cap. */
  ceilingUsd: number | null;
  /** What every run of the initiative spent, the decompose run and superseded runs included. */
  spentUsd: number;
  /** Dollars open runs may still spend under their caps; held back from later features' shares. */
  reservedUsd: number;
  /** cap - (spent of finished runs + caps of open runs); null without a cap. */
  remainingUsd: number | null;
  /**
   * The projected total once a feature is accepted (#1312): what was spent, plus the point
   * forecasts still to run at their stage and model prices, without a margin. Null
   * without a cap, before a feature is accepted, or while nothing is priced.
   */
  forecastUsd: number | null;
  /** Accepted features that are not a host-written skeleton: the forecast's measured samples. */
  measuredFeatures: number;
  /**
   * Whether a forecast above the ceiling stops the next feature: with `forecastStop` on, or once
   * `FORECAST_BINDING_FEATURES` features are measured. Before that the forecast is an
   * extrapolation, and the caps on spent and reserved dollars bound the money (#1659).
   */
  forecastBinding: boolean;
  /**
   * The mode of the `initiative-forecast` stop reason (#1714): outside `enforce` a binding
   * forecast above the ceiling records a `decision.would_stop` event and features keep starting.
   */
  forecastMode: StopMode;
  /** Why a forecast above the ceiling does not stop the initiative yet; null otherwise. */
  forecastNotice: string | null;
  /**
   * The mode of the `initiative-dollar-share` stop reason (#1890): in `enforce` a feature whose
   * spare dollars are below its priced low estimate does not start; otherwise it starts and a
   * `decision.would_stop` event records it. Absent on share-gate events recorded before #1890.
   */
  shareMode?: StopMode;
}

export interface FeatureView {
  repairRun?: RunSnapshot;
  id: string;
  title: string;
  mandatory: boolean;
  dependsOn: string[];
  boundary: InitiativeFeature["boundary"];
  /** Boundary files whose content the split fixes; the feature's run writes them in the host. */
  skeleton?: NonNullable<InitiativeFeature["skeleton"]>;
  contract: string;
  /** The workflow this feature's runs use: its own, or the initiative's default. */
  workflowId: string;
  size: NonNullable<InitiativeFeature["size"]>;
  /** The budget share the feature starts with now; null once it has a run or before approval. */
  share: UsageView | null;
  /**
   * The feature's estimated tokens (`initiative estimate`) when this project's run history prices
   * them; they weight its share and gate its start. Null otherwise, once it has a run or before
   * approval.
   */
  need: TokenRange | null;
  /** The dollar share the feature starts with, split like its token share; null without a cap. */
  shareUsd: number | null;
  /** Priced low and high estimates, independent of the allocated dollar share. */
  needUsd?: TokenRange | null;
  /** The workflow feature ID of this feature's runs. */
  runFeatureId: string;
  /** The GitHub issue the feature's runs start from and their delivery closes; null without one. */
  issue: IssueSource | null;
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
  recovery?: RecoveryAdvice;
  pendingRequests: PendingDecision[];
  /** Everything this feature's runs spent, superseded runs included. */
  usage: UsageView;
  /** The dollars this feature's runs spent, superseded runs included. */
  spentUsd: number;
  runIds: string[];
  /**
   * The decomposer's features merged into this one because each was too small for a run; absent
   * in views stored before merging existed.
   */
  mergedFrom?: string[];
  /** Why the decomposer kept a feature of the critical path whole (#1522). */
  serial?: string;
  /**
   * Under `workflows.planAhead` (#1834): the unfinished features whose approved specs this
   * feature plans against, before its run starts and until its run is released onto their results.
   */
  plannedAhead?: string[];
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
  recovery?: RecoveryAdvice;
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
  /** The workflow of a feature that names none. */
  workflowId: string;
  /** The model feature runs start with; null uses the configured default model. */
  model: string | null;
  featureAutoApproval: InitiativeSettings["featureAutoApproval"];
  /**
   * Feature runs that execute at once: 1 when a feature workflow runs inline, up to
   * `workflows.maxParallelRuns` when every feature runs in a worktree; with
   * `workflows.parallelRunsFromPlan`, the plan's width up to that cap (#1822).
   */
  parallelRuns: number;
  /**
   * The longest dependency chain of the latest plan, its share of the work by size and files, and
   * the most the split can gain over one feature at a time with `parallelRuns` (#1551); `chain` is
   * the decomposer's reason to keep a long chain. Null before a plan exists.
   */
  criticalPath: {
    features: string[];
    workShare: number;
    speedup: number;
    chain: string | null;
    /** The most features of the plan that can run at once (#1822). */
    width: number;
  } | null;
  decompose: { runId: string; status: string; reason: string } | null;
  features: FeatureView[];
  pendingDecisions: PendingDecision[];
  budget: {
    limits: BudgetLimitsValue;
    used: UsageView;
    /** Limits of open runs not spent yet; they are held back from the shares of later features. */
    reserved: UsageView;
    remaining: UsageView;
    /** Features in the approved plan without a run yet; they share what remains by size. */
    unstartedFeatures: number;
    /** The share of the next feature to start. */
    nextShare: UsageView | null;
    /** Dollars spent, and the dollar cap with what remains of it when one is set. */
    cost: CostView;
    /**
     * The token pool's forecast and what to extend it to (#2042): used plus each unfinished
     * feature's expected tokens at the measured ratio, against the pool. Null before approval.
     */
    pool: TokenPoolView | null;
    /**
     * What the pool would hold for open feature runs with a sized plan at their plan's need
     * instead of their limits (#2100, #2056), and the mode that decides which one it holds.
     * Null without such a run.
     */
    planCharge: PlanChargeView | null;
    /** The token forecast's notice (`pool.notice`): set while the forecast is above the pool. */
    forecastNotice: string | null;
    rule: string;
  };
  next: NextAction;
  /**
   * Whether a drive advances the initiative now (`driving`) or its ready work waits for one
   * (`idle`, with the command that continues it); null when a drive has nothing to do (#2024).
   */
  drive: InitiativeDriveState | null;
}

/** An initiative's next step, as the answer of a decision on one of its feature runs carries it. */
export interface InitiativeStep {
  initiativeId: string;
  status: InitiativeView["status"];
  next: NextAction;
  drive: InitiativeDriveState | null;
}

/** True when a feature would start with less than the smallest share a run can work with. */
function shareTooSmall(share: UsageView | null): boolean {
  return (
    !share ||
    share.tokens < MIN_SHARE.maxTotalTokens ||
    share.calls < MIN_SHARE.maxAgentCalls ||
    share.activeMs < MIN_SHARE.maxActiveMs
  );
}

/** Whether a binding dollar forecast is above the ceiling, whatever the stop's mode. */
function forecastOverCeiling(cost: CostView): boolean {
  return (
    cost.forecastUsd !== null &&
    cost.ceilingUsd !== null &&
    cost.forecastUsd > cost.ceilingUsd &&
    cost.forecastBinding
  );
}

/**
 * What the share gate reads of an initiative view. A feature start records it in the
 * `feature.share_gate` event, so bench traces replay the gate on what the round saw (#1707).
 */
export interface ShareGateView {
  initiativeId: string;
  /**
   * `limits`, `used` and `pool` are recorded from #2042 on, `planCharge` from #2100 on; older
   * events have none of them.
   */
  budget: Pick<InitiativeView["budget"], "remaining" | "cost"> &
    Partial<Pick<InitiativeView["budget"], "limits" | "used" | "pool" | "planCharge">>;
  /** `shareUsd` and `needUsd` are recorded from #1890 on; older events have neither. */
  features: (Pick<FeatureView, "id" | "state" | "share" | "need"> &
    Partial<Pick<FeatureView, "shareUsd" | "needUsd">>)[];
}

/** The `feature.share_gate` event: the gate's inputs and what it decided for one feature. */
export interface ShareGateRecord {
  featureId: string;
  verdict: "pass" | "park";
  /**
   * On a park from #2042 on: whether the host would extend the token pool inside the dollar cap
   * (`workflows.extendWithinDollars`), and the mode it ran in. Absent before #2042 and when off.
   */
  poolGrowth?: { mode: ExtendWithinDollars } & Pick<
    PoolExtension,
    "wouldExtend" | "toTokens" | "byTokens"
  >;
  view: ShareGateView;
  feature: Pick<FeatureView, "id" | "share" | "need" | "shareUsd"> &
    Partial<Pick<FeatureView, "needUsd">>;
}

/** The waiting features (no run yet) with an estimate, as the token pool reads them. */
function waitingNeeds(features: ShareGateView["features"]): PoolFeature[] {
  return features.flatMap((f) =>
    f.share !== null && f.need ? [{ id: f.id, low: f.need.low, high: f.need.high }] : [],
  );
}

/**
 * The token pool's inputs as a share-gate view holds them (#2042), or null in a record before
 * #2042 when the caller does not know the pool's limit (`limitTokens`). A record without a pool
 * counts open runs at the pool less what remains, and has no token forecast or used tokens.
 */
export function shareGatePool(
  view: ShareGateView,
  limitTokens: number | undefined = view.budget.limits?.maxTotalTokens,
): PoolInputs | null {
  const pool = view.budget.pool;
  const limit = pool?.limitTokens ?? limitTokens;
  if (limit === undefined) return null;
  return {
    initiativeId: view.initiativeId,
    limitTokens: limit,
    usedTokens: pool?.usedTokens ?? view.budget.used?.tokens ?? 0,
    committedTokens: pool?.committedTokens ?? limit - view.budget.remaining.tokens,
    forecastTokens: pool?.forecastTokens ?? null,
    ratio: pool?.ratio ?? null,
    features: view.features.length,
    waiting: waitingNeeds(view.features),
    cost: view.budget.cost,
  };
}

/** The extend command with the amounts that answer a block, and its remedy (#2042). */
function extendAdvice(
  initiativeId: string,
  message: string,
  summary: string,
  amounts: { tokens?: number | null; usd?: number | null; fallback?: string },
): RecoveryAdvice {
  const flags = [
    ...(amounts.tokens ? [`--tokens ${amounts.tokens}`] : []),
    ...(amounts.usd ? [`--budget-usd ${amounts.usd}`] : []),
  ];
  const command = [`baked workflow initiative extend ${initiativeId}`, ...flags];
  if (!flags.length && amounts.fallback) command.push(amounts.fallback);
  return recoveryAdvice(`${message} Raise it with ${command.join(" ")}.`, summary, {
    action: "extend",
    initiativeId,
    ...(amounts.tokens ? { suggestedTokens: amounts.tokens } : {}),
    ...(amounts.usd ? { suggestedUsd: amounts.usd } : {}),
  });
}

/**
 * Why a ready feature may not start, or null. Its low estimate must fit after reserving the
 * other waiting features' lows; a weighted share alone can be smaller even when the pool covers
 * them all (#1605). Exhausted token, call, time and dollar budgets still stop a start (#1311).
 * Every block names the amounts that answer it and puts them on its `extend` remedy (#2042).
 */
export function shareShortfall(
  view: ShareGateView,
  feature: Pick<FeatureView, "id" | "share" | "need" | "shareUsd"> &
    Partial<Pick<FeatureView, "needUsd">>,
): RecoveryAdvice | null {
  const cost = view.budget.cost;
  const id = view.initiativeId;
  if (cost.capUsd !== null && cost.ceilingUsd !== null) {
    const ceiling =
      cost.ceilingUsd > cost.capUsd
        ? `${usd(cost.ceilingUsd)} ceiling (the ${usd(cost.capUsd)} cap and its tolerance)`
        : `${usd(cost.capUsd)} cap`;
    if (
      cost.forecastUsd !== null &&
      cost.forecastUsd > cost.ceilingUsd &&
      cost.forecastBinding &&
      cost.forecastMode === "enforce"
    ) {
      const accepted = view.features.filter((f) => f.state === "accepted").length;
      const raise = Math.ceil(cost.forecastUsd);
      return recoveryAdvice(
        `The initiative's cost forecast is ${usd(cost.forecastUsd)}, above its ${ceiling}: ${usd(cost.spentUsd)} spent with ${accepted} of ${view.features.length} features accepted. Raise the dollar budget to at least ${usd(raise)} with baked workflow initiative extend ${id} --budget-usd ${raise} to start ${feature.id}, or pause the initiative.`,
        `The initiative's cost forecast is ${usd(cost.forecastUsd)}, above its ${ceiling}: ${usd(cost.spentUsd)} spent with ${accepted} of ${view.features.length} features accepted. Raise the dollar budget to at least ${usd(raise)} to start ${feature.id}, or pause the initiative.`,
        { action: "extend", initiativeId: id, suggestedUsd: raise },
      );
    }
    if ((feature.shareUsd ?? 0) < MIN_SHARE_USD) {
      // The cap that covers what open runs hold plus every waiting feature's priced high end.
      const waiting = view.features.filter((f) => f.share !== null);
      const highs = waiting.every((f) => f.needUsd)
        ? waiting.reduce((sum, f) => sum + (f.needUsd?.high ?? 0), 0)
        : null;
      const raise = highs === null ? null : centsUp(cost.capUsd - (cost.remainingUsd ?? 0) + highs);
      const summary = `The shared dollar budget is exhausted: ${feature.id} would start with ${usd(feature.shareUsd ?? 0)} of the ${ceiling}, ${usd(cost.spentUsd)} spent.${raise !== null && raise > cost.capUsd ? ` A cap of ${usd(raise)} covers the high estimates of the waiting features.` : ""}`;
      return extendAdvice(id, summary, summary, {
        usd: raise !== null && raise > cost.capUsd ? raise : null,
        fallback: "--budget-usd N",
      });
    }
    const short = dollarShortfall(view, feature);
    if (short && cost.shareMode === "enforce") {
      const raise = dollarRaise(view, feature);
      return extendAdvice(id, short, short, {
        usd: raise === null ? null : centsUp(cost.capUsd + raise),
        fallback: "--budget-usd N",
      });
    }
  }
  const share = feature.share;
  const inputs = shareGatePool(view);
  const pool = inputs && tokenPool(inputs);
  if (shareTooSmall(share)) {
    const tokensShort = (share?.tokens ?? 0) < MIN_SHARE.maxTotalTokens;
    const cover =
      tokensShort && pool && pool.coverTokens > pool.limitTokens ? pool.coverTokens : null;
    const summary = `The shared budget is exhausted: ${feature.id} would start with ${share?.tokens ?? 0} tokens, ${share?.calls ?? 0} calls and ${share?.activeMs ?? 0} ms.${cover ? ` A pool of ${tokenText(cover)} tokens covers the high estimates of the waiting features.` : ""}`;
    return extendAdvice(id, summary, summary, { tokens: cover });
  }
  const available = growthLimit(view, feature.id);
  if (feature.need && available !== null && available < feature.need.low) {
    const base = `The shared budget is short: ${feature.id} has ${available} tokens available after reserving the other waiting features' low estimates, below its estimate of ${feature.need.low}-${feature.need.high}.`;
    const detail =
      pool && inputs
        ? ` ${poolShortText(pool, { id: feature.id, ...feature.need }, available, inputs.waiting, cost)}`
        : "";
    return extendAdvice(id, `${base}${detail}`, `${base}${detail}`, {
      tokens: pool ? pool.coverTokens : null,
    });
  }
  return null;
}

/**
 * Why the dollars a starting feature may grow into (`costGrowthLimit`) do not cover its priced
 * low estimate, as the token gate asks of tokens; null when they do or it is unpriced. Bench
 * round 59 (wheeltags) started pick-command with $2.87 to grow into and it stopped one corrective
 * short with 46% of its token share used; priced at the initiative's own stage mix, the two
 * features after it were short (#1890). The `initiative-dollar-share` stop reason decides whether
 * it parks the feature. Before any feature is measured the waiting features' lows are the plan's
 * guess and nothing else: R62 stepvet recorded two would-stops at the first starts, both false
 * (lines and stepexpr started anyway, finished and left $3.67 of $30 unspent), so the check waits
 * for the first measured feature (#1714). Until `MIN_CALIBRATION_FEATURES` features are measured
 * the dollars per token are too (`shareSpareUsd`).
 */
export function dollarShortfall(
  view: ShareGateView,
  feature: Pick<FeatureView, "id"> & Partial<Pick<FeatureView, "needUsd">>,
): string | null {
  const cost = view.budget.cost;
  if (cost.measuredFeatures === 0) return null;
  const spare = shareSpareUsd(view, feature.id);
  const needUsd = feature.needUsd;
  if (!needUsd || spare === null || cost.ceilingUsd === null || spare >= needUsd.low) return null;
  const ceiling =
    cost.capUsd !== null && cost.ceilingUsd > cost.capUsd
      ? `${usd(cost.ceilingUsd)} ceiling`
      : `${usd(cost.capUsd ?? cost.ceilingUsd)} cap`;
  const within = uncalibratedSlack(cost) > 0 ? " within the ceiling" : "";
  const raise = dollarRaise(view, feature) ?? 0;
  return `The shared dollar budget is short: ${feature.id} has ${usd(spare)} to grow into${within} after reserving the other waiting features' low estimates, below its estimate of ${usd(needUsd.low)}-${usd(needUsd.high)} (${usd(cost.spentUsd)} of the ${ceiling} spent); the dollar budget needs at least ${usd(raise)} more.`;
}

/**
 * The tolerance band the dollar share counts as remaining while the dollars per token are measured
 * on fewer than `MIN_CALIBRATION_FEATURES` features, as the forecast's measured ratio waits for
 * them; 0 from then on. R67 ampwhy (#2099): at 1 measured feature the waiting features' lows were
 * priced at $1.83 and $1.50 per million against the initiative's $1.33, reserved $20.91 of an
 * initiative that cost $16.24 in all, and reader and scanning recorded would-stops for dollars
 * that were never short.
 */
function uncalibratedSlack(cost: ShareGateView["budget"]["cost"]): number {
  if (cost.measuredFeatures >= MIN_CALIBRATION_FEATURES) return 0;
  if (cost.capUsd === null || cost.ceilingUsd === null) return 0;
  return Math.max(0, cost.ceilingUsd - cost.capUsd);
}

/**
 * The spare dollars the `initiative-dollar-share` rule compares with a starting feature's priced
 * low estimate: `costGrowthLimit`, with the remaining dollars counted up to the tolerance ceiling
 * instead of the cap while the dollar rate is uncalibrated (`uncalibratedSlack`). The bound a run's
 * cap grows to stays `costGrowthLimit`.
 */
export function shareSpareUsd(view: ShareGateView, featureId: string): number | null {
  const cost = view.budget.cost;
  const slack = uncalibratedSlack(cost);
  if (!slack || cost.remainingUsd === null) return costGrowthLimit(view, featureId);
  const remainingUsd = cost.remainingUsd + slack;
  return costGrowthLimit(
    { ...view, budget: { ...view.budget, cost: { ...cost, remainingUsd } } },
    featureId,
  );
}

/** How many more dollars start `feature` at its priced low estimate; null when none are missing. */
function dollarRaise(
  view: ShareGateView,
  feature: Pick<FeatureView, "id"> & Partial<Pick<FeatureView, "needUsd">>,
): number | null {
  // Raising the cap by the gap raises the ceiling by at least as much.
  const spare = shareSpareUsd(view, feature.id);
  const needUsd = feature.needUsd;
  if (!needUsd || spare === null || spare >= needUsd.low) return null;
  return Math.ceil((needUsd.low - spare) * 100) / 100;
}

/**
 * Token weights of the features that share the budget: their estimated need (the high end of the
 * estimate), or their size weight when any of them has no estimate. The size words say little
 * about cost: in bench round 32 a small feature used 3.57M tokens and a large one 4.11M (#1311).
 */
function tokenWeights(features: Pick<FeatureView, "size" | "need">[]): number[] {
  return features.every((f) => (f.need?.high ?? 0) > 0)
    ? features.map((f) => f.need?.high ?? 0)
    : features.map((f) => sizeWeight(f));
}

/**
 * The shares of the features waiting for a run: tokens by estimated need, with affordable low
 * estimates protected; dollars by the original token weights, calls and active time by size.
 */
function splitShares(
  features: Pick<FeatureView, "size" | "need">[],
  remaining: UsageView,
  remainingUsd: number | null,
): { share: UsageView; shareUsd: number | null }[] {
  const weights = features.reduce((sum, f) => sum + sizeWeight(f), 0);
  const byNeed = tokenWeights(features);
  const needTotal = byNeed.reduce((sum, w) => sum + w, 0);
  const tokens = splitTokens(
    byNeed,
    features.map((f) => f.need?.low ?? 0),
    remaining.tokens,
  );
  return features.map((feature, index) => ({
    share: {
      ...share(remaining, weights, sizeWeight(feature)),
      tokens: tokens[index] ?? 0,
    },
    shareUsd:
      remainingUsd === null ? null : cents((remainingUsd * (byNeed[index] ?? 0)) / needTotal),
  }));
}

/** The token shares of `splitShares`: by weight, with affordable low estimates protected. */
function splitTokens(byNeed: number[], lows: number[], remaining: number): number[] {
  const needTotal = byNeed.reduce((sum, w) => sum + w, 0);
  const tokens = byNeed.map((weight) => Math.floor((remaining * weight) / needTotal));
  // Keep weighted shares when they cover every low estimate. Otherwise reserve the lows that
  // would be underfunded and split what is left among the others, repeating if needed (#1605).
  if (lows.reduce((sum, low) => sum + low, 0) <= remaining) {
    let pool = remaining;
    let pending = byNeed.map((_, index) => index);
    while (pending.length) {
      const weights = pending.reduce((sum, index) => sum + (byNeed[index] ?? 0), 0);
      const short = pending.filter(
        (index) => (pool * (byNeed[index] ?? 0)) / weights < (lows[index] ?? 0),
      );
      if (!short.length) {
        for (const index of pending)
          tokens[index] = Math.floor((pool * (byNeed[index] ?? 0)) / weights);
        break;
      }
      for (const index of short) {
        tokens[index] = lows[index] ?? 0;
        pool -= tokens[index] ?? 0;
      }
      pending = pending.filter((index) => !short.includes(index));
    }
  }
  return tokens;
}

/**
 * The share gate's view as the plan charge would have it (#2100, #2056): the pool holds each open
 * feature run with a sized plan at its charge instead of its limit, and the waiting features'
 * token shares are split again from what then remains, as `splitShares` splits them. Null when
 * the view records no plan charge or its limits, when the charge is already enforced (the view
 * is this one), or when it changes nothing. A record has no feature sizes: a split without an
 * estimate for every waiting feature weighs by their call shares, which `splitShares` divides
 * by size.
 */
export function planChargedGate(view: ShareGateView): ShareGateView | null {
  const charge = view.budget.planCharge;
  const limit = view.budget.limits?.maxTotalTokens;
  if (!charge || charge.mode === "enforce" || charge.releasedTokens === 0 || limit === undefined)
    return null;
  const tokens = Math.max(0, limit - charge.planCommittedTokens);
  const waiting = view.features.filter((f) => f.share !== null);
  const byNeed = waiting.every((f) => (f.need?.high ?? 0) > 0)
    ? waiting.map((f) => f.need?.high ?? 0)
    : waiting.map((f) => Math.max(1, f.share?.calls ?? 0));
  const split = splitTokens(
    byNeed,
    waiting.map((f) => f.need?.low ?? 0),
    tokens,
  );
  const shares = new Map(waiting.map((f, index) => [f.id, split[index] ?? 0]));
  const pool = view.budget.pool;
  return {
    ...view,
    budget: {
      ...view.budget,
      remaining: { ...view.budget.remaining, tokens },
      ...(pool ? { pool: { ...pool, committedTokens: charge.planCommittedTokens } } : {}),
    },
    features: view.features.map((f) =>
      f.share === null ? f : { ...f, share: { ...f.share, tokens: shares.get(f.id) ?? 0 } },
    ),
  };
}

/**
 * The view a rebased feature's new run is sized from: the feature waits for a run again with
 * `need`, and it and the features that have not started share what remains as at a start. The
 * rebase split by size and passed no growth limits, so its run could grow to the base ceiling
 * and leave a waiting feature below its estimate (#1417).
 */
export function rebaseView(
  view: InitiativeView,
  featureId: string,
  need: TokenRange | null,
  needUsd: TokenRange | null = null,
): InitiativeView {
  const target = view.features.find((f) => f.id === featureId);
  if (!target) return view;
  const waiting = [
    ...view.features.filter((f) => f.share !== null && f.id !== featureId),
    { ...target, need, needUsd },
  ];
  const shares = splitShares(
    waiting,
    view.budget.remaining,
    view.budget.cost?.remainingUsd ?? null,
  );
  const byId = new Map(waiting.map((f, index) => [f.id, { ...f, ...shares[index] }]));
  return { ...view, features: view.features.map((f) => byId.get(f.id) ?? f) };
}

/**
 * How a feature's tokens split across its planned stages: the history's stage ranges scaled by
 * size, or, with `mix`, the tokens the initiative's accepted features took on each stage (#1890).
 * A planned stage the accepted features never ran keeps no weight then.
 */
function stageWeights(
  stages: PreRunEstimate["stages"],
  size: FeatureSize,
  mix?: ReadonlyMap<string, number>,
): { id: string; models: string[]; tokens: number }[] {
  const measured = mix && stages.some((s) => (mix.get(s.stageId) ?? 0) > 0) ? mix : undefined;
  return stages.map((s) => ({
    id: s.stageId,
    models: s.models,
    tokens: measured
      ? (measured.get(s.stageId) ?? 0)
      : ((s.tokens.low + s.tokens.high) / 2) *
        (s.type === "tasks" ? SIZE_TASK_FACTOR[size] : SIZE_STAGE_FACTOR[size]),
  }));
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const cents = (n: number): number => Math.floor(n * 100) / 100;
/** Up to the cent, for an amount a message suggests: it must cover what it names. */
const centsUp = (n: number): number => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;

/** The smallest dollar share a feature run can start with. */
export const MIN_SHARE_USD = 0.01;

/**
 * The `auto` tolerance of an initiative's dollar cap: more features miss their price by more, so
 * the band widens from 10% (up to 3 features) to 30% (more than 12), like a run's by its tasks.
 */
export function initiativeCostTolerance(setting: CostToleranceValue, features: number): number {
  if (setting === "off") return 0;
  return setting === "auto" ? autoCostTolerance(Math.max(1, features) * (8 / 3)) : setting;
}

/** The workflow feature ID of an initiative feature's runs. `_` never occurs in either part. */
export const runFeatureId = (initiativeId: string, featureId: string): string =>
  `${initiativeId}_${featureId}`;
const decomposeFeatureId = (initiativeId: string): string => `${initiativeId}__decompose`;

/**
 * The shared budget when the user sets none: the per-run limits of the policy for every medium
 * feature (half for a small one, double for a large one), plus one more (the decompose run and
 * later re-plans take it).
 */
export function planBudget(settings: InitiativeSettings, plan: InitiativePlan): BudgetLimitsValue {
  if (settings.budget) return settings.budget;
  const factor = plan.features.reduce((sum, f) => sum + sizeWeight(f), 0) / 2 + 1;
  const base = settings.basePolicy;
  return {
    maxTotalTokens: Math.floor(base.maxTotalTokens * factor),
    maxAgentCalls: Math.floor(base.maxAgentCalls * factor),
    maxActiveMs: Math.floor(base.maxActiveMs * factor),
  };
}

/** The smallest share a feature run can start with; below it the shared budget is exhausted. */
export const MIN_SHARE = { maxTotalTokens: 1000, maxAgentCalls: 1, maxActiveMs: 1000 } as const;

export const BUDGET_RULE =
  "Each feature run starts with a share of the remaining shared budget, rounded down: remaining = limit - (usage of finished runs + the limits of open runs, decompose and superseded runs included; with stopModes initiative-plan-charge enforce, an open feature run whose plan is sized counts at the high end of its plan's need at the measured plan-to-actual ratio, never below its usage, instead of its limit), times the feature's weight, divided by the weights of the features of the approved plan without a run. Tokens are weighted by each feature's estimated need (the high end of its estimate), calls and time by size (small 1, medium 2, large 4). When the remaining pool covers the waiting features' low estimates, token shares reserve any lows that the weighted split would underfund and divide the rest by the same weights. A feature starts only if the remaining pool minus the other waiting features' low estimates covers its own low estimate. Otherwise it waits for a budget extension. A feature run grows its own budget only up to what remains after the low ends of the features still waiting. A starting feature's calls and active time are what remains less a floor for each other waiting feature (the base policy's per-run limit scaled by size, at most its share), never below its own share. A rebased run takes one more share of the same split. Agent calls per run are capped at 1000. With a dollar budget (--budget-usd), dollars use the original token weights and each feature run gets its share as its maxCostUsd with the initiative's costTolerance. Its cap may grow independently of tokens, only up to the remaining dollars less the priced low estimates of the other waiting features (their whole shares when unpriced). Split approval warns on dollar shares below their own priced lows; open runs hold their caps. No feature starts on less than $0.01, or once a feature is accepted and the projected total passes the cap and its tolerance.";

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
      // Left out when unset, so splits approved before dollar budgets keep their digest.
      costBudget: settings.costBudget ?? undefined,
      // Only when on, so splits approved before the setting existed keep their digest.
      ...(settings.forecastStop ? { forecastStop: true } : {}),
    },
  });
}

/** `weight` parts of `remaining` split into `parts` parts, rounded down. */
const share = (remaining: UsageView, parts: number, weight = 1): UsageView => ({
  tokens: Math.floor((remaining.tokens * weight) / parts),
  calls: Math.floor((remaining.calls * weight) / parts),
  activeMs: Math.floor((remaining.activeMs * weight) / parts),
});
const zero = (): UsageView => ({ tokens: 0, calls: 0, activeMs: 0 });
const add = (a: UsageView, b: UsageView): UsageView => ({
  tokens: a.tokens + b.tokens,
  calls: a.calls + b.calls,
  activeMs: a.activeMs + b.activeMs,
});

/**
 * The initiative drives running in this process, by workflow service: every `InitiativeService` of
 * one service sees the same drives, so a second instance (the answer of a feature-run decision)
 * neither starts a parallel drive nor reports a driven initiative as idle.
 */
const DRIVES = new WeakMap<NativeWorkflowService, Map<string, AbortController>>();

export class InitiativeService {
  readonly store: InitiativeStore;
  private readonly active: Map<string, AbortController>;
  /**
   * The measured stage usage that prices the features still to run. The replay passes an older
   * pricing here to show a forecast regression on a recorded round (#1707).
   */
  priceSamples: typeof initiativePriceSamples = initiativePriceSamples;
  constructor(readonly workflows: NativeWorkflowService) {
    this.store = new InitiativeStore(workflows.store);
    const drives = DRIVES.get(workflows) ?? new Map<string, AbortController>();
    DRIVES.set(workflows, drives);
    this.active = drives;
  }

  /**
   * Grows a feature run's share to what its initiative can spare now; nothing for a run of no
   * initiative. The workflow service calls it when a run's deadline comes and before it drives
   * (#1958, #2134).
   */
  growRun(runId: string): void {
    const id = this.store.available() ? this.store.initiativeOfRun(runId) : null;
    const featureId = id && this.store.links(id).find((l) => l.run_id === runId)?.feature_id;
    if (id && featureId) this.refreshGrowth(id, featureId, runId);
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
      costBudget: request.costBudget
        ? CostBudgetSchema.parse({ costTolerance: "off", ...request.costBudget })
        : null,
      featureAutoApproval: request.featureAutoApproval ?? null,
      autoApprovalConfirmation: request.autoApprovalConfirmation ?? null,
      model: request.model ?? null,
      ownerLabel: request.ownerLabel,
      featureIssues: request.featureIssues ?? {},
      forecastStop: request.forecastStop ?? false,
      keepFeatures: request.keepFeatures ?? false,
      splitCriticalPath: request.splitCriticalPath ?? false,
      lightContracts: request.lightContracts ?? false,
    };
    this.checkWorkflow(settings);
    // Feature runs in worktrees need Git; refuse now rather than after the decomposer ran.
    if (this.executionMode(settings, settings.workflowId) === "worktree")
      await worktreeBase(this.workflows.workspace);
    const issued = Object.keys(settings.featureIssues);
    if (issued.length && !request.plan)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "Feature issues need the split they belong to; give the plan with them",
      );
    const unknown = issued.filter((key) => !request.plan?.features.some((f) => f.id === key));
    if (unknown.length)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Feature issues name features the split does not have: ${unknown.join(", ")}`,
      );
    if (request.plan) {
      const given = InitiativePlanSchema.parse(request.plan);
      const problems = validateInitiativePlan(given);
      if (problems.length) throw new WorkflowFault("INVALID_DEFINITION", problems.join("\n"));
      const plan = this.fitWorkflows(given, settings, false);
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
      policy: PolicySchema.parse({
        ...settings.basePolicy,
        autoApproval: null,
        ...(settings.splitCriticalPath ? { criticalPath: "split" } : {}),
      }),
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
      const edited = applySplitEdit(latest, parsed);
      // Features the edit left as they were keep their settings, also those of a plan stored
      // before features had workflows, so their runs are not superseded; the others are fitted.
      const before = new Map(latest.features.map((f) => [f.id, featureDigest(f)] as const));
      const keep = new Set(
        edited.features.filter((f) => before.get(f.id) === featureDigest(f)).map((f) => f.id),
      );
      const next = this.fitWorkflows(edited, this.store.settings(row), false, keep);
      this.propose(id, next, "user", parsed);
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
    requested: Partial<BudgetLimitsValue> & { maxCostUsd?: number },
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
      const cost = settings.costBudget;
      const nextCost =
        requested.maxCostUsd === undefined
          ? cost
          : CostBudgetSchema.parse({
              costTolerance: cost?.costTolerance ?? "off",
              maxCostUsd: requested.maxCostUsd,
            });
      if (
        next.maxTotalTokens < current.maxTotalTokens ||
        next.maxAgentCalls < current.maxAgentCalls ||
        next.maxActiveMs < current.maxActiveMs ||
        (cost && nextCost && nextCost.maxCostUsd < cost.maxCostUsd)
      )
        throw new WorkflowFault("INVALID_DEFINITION", "Shared budget limits can only be raised");
      // Raising only the dollars keeps a token budget that is still derived from the split.
      const tokensRaised =
        requested.maxTotalTokens !== undefined ||
        requested.maxAgentCalls !== undefined ||
        requested.maxActiveMs !== undefined;
      this.store.setSettings(id, {
        ...settings,
        budget: tokensRaised || requested.maxCostUsd === undefined ? next : settings.budget,
        costBudget: nextCost,
      });
      this.store.emit(id, "budget.extended", {
        previous: current,
        next,
        ...(requested.maxCostUsd !== undefined
          ? { previousCostUsd: cost?.maxCostUsd ?? null, nextCostUsd: requested.maxCostUsd }
          : {}),
      });
    });
  }

  /**
   * Moves the initiative to another model: feature runs it starts from now on use `model`, and
   * its open runs that are stopped (the decompose run and current feature runs) are rerouted like
   * `baked workflow reroute`, with the same checks and `run.rerouted` events. Every run is checked
   * before any is written, so a refused model changes nothing. With `resume`, rerouted runs that
   * are blocked and a paused initiative continue; the caller then drives the initiative. A split
   * waiting for approval is proposed again, since its approval digest covers the model.
   */
  async reroute(
    id: string,
    command: CommandIdentity,
    request: { model: string; resume?: boolean },
  ): Promise<InitiativeView> {
    SafeId.parse(command.commandId);
    const model = request.model.trim();
    const resume = request.resume === true;
    const body = { action: "reroute", model, resume };
    const full = JSON.parse(JSON.stringify({ initiativeId: id, ...command, ...body })) as unknown;
    const previous = this.store.previousCommand<InitiativeView>(command.commandId, full);
    if (previous) return previous;
    if (!model || model === "none")
      throw new WorkflowFault("INVALID_DEFINITION", "Select a model to switch the initiative to");
    const row = this.store.get(id);
    if (row.status === "completed" || row.status === "refused")
      throw new WorkflowFault(
        "STALE_DECISION",
        `An initiative that is ${row.status} cannot switch models`,
      );
    if (row.revision !== command.expectedRevision)
      throw new WorkflowFault("REVISION_CONFLICT", "Initiative revision changed", {
        expected: command.expectedRevision,
        actual: row.revision,
      });
    if (this.active.has(id))
      throw new WorkflowFault(
        "WORKSPACE_BUSY",
        "The initiative is executing; pause it before switching its model",
      );
    const runs = this.currentRuns(id);
    const busy = runs.filter((r) => this.workflows.store.run(r.runId).status === "running");
    if (busy.length)
      throw new WorkflowFault(
        "WORKSPACE_BUSY",
        `Run ${busy.map((r) => r.runId).join(", ")} is executing; pause the initiative before switching its model`,
      );
    const results: RerouteResult[] = [];
    const planned: { run: (typeof runs)[number]; plan: PlannedReroute }[] = [];
    for (const run of runs) {
      if (!this.workflows.store.latestArtifact(run.runId, ROUTING_ARTIFACT)) {
        results.push({ ...run, result: "skipped", reason: "started before routing was recorded" });
        continue;
      }
      const plan = await this.workflows.planReroute(run.runId, { model });
      if (plan) planned.push({ run, plan });
      else results.push({ ...run, result: "unchanged", reason: "already uses this model" });
    }
    if (!planned.length && this.store.settings(row).model === model)
      throw new WorkflowFault("INVALID_DEFINITION", "The initiative already uses this model");
    const derived = (runId: string, step: string): string =>
      `ir-${hashJson({ commandId: command.commandId, runId, step }).slice(0, 48)}`;
    for (const { run, plan } of planned) {
      const before = this.workflows.store.run(run.runId);
      const after = this.workflows.commitReroute(
        run.runId,
        { commandId: derived(run.runId, "reroute"), expectedRevision: before.revision },
        { model },
        plan,
      );
      const result: RerouteResult = { ...run, result: "rerouted", from: plan.before.runModel };
      // The switch stands even when the run cannot continue yet; its next drive reports why.
      if (resume && after.status === "blocked")
        await this.workflows
          .resume(run.runId, {
            commandId: derived(run.runId, "resume"),
            expectedRevision: after.revision,
          })
          .catch((err: unknown) => {
            result.reason = `not resumed: ${err instanceof Error ? err.message : String(err)}`;
          });
      results.push(result);
    }
    return this.command(id, command, body, () => {
      const current = this.store.get(id);
      const settings = this.store.settings(current);
      this.store.setSettings(id, { ...settings, model });
      this.store.emit(id, "initiative.rerouted", {
        model: { from: settings.model, to: model },
        runs: results,
      });
      // The split approval digest covers the model; a pending approval is asked again.
      const pending = this.store.requests(id).some((r) => r.status === "pending");
      if (pending && current.plan_revision)
        this.propose(
          id,
          this.store.plan(this.store.revision(id, current.plan_revision)),
          "user",
          null,
        );
      if (resume && current.status === "paused")
        this.store.setStatus(
          id,
          current.approved_plan_revision === null ? "decomposing" : "active",
        );
    });
  }

  // --- Execution ---------------------------------------------------------------------------

  /**
   * Advances the initiative until it needs a person, is blocked, is paused or completes. Inline,
   * feature runs execute one at a time in dependency order, so the workspace keeps one writer; in
   * worktrees, features without a dependency path between them execute side by side.
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
      await this.driveSteps(id, controller.signal);
    } finally {
      this.active.delete(id);
      signal.removeEventListener("abort", abort);
    }
    // After the drive let go, so the view it returns no longer reads "driving" (#2024).
    return this.view(id);
  }

  /** The steps of one drive, until the initiative needs a person, finishes or stops moving. */
  private async driveSteps(id: string, signal: AbortSignal): Promise<void> {
    await this.settleSuperseded(id);
    for (let step = 0; step < 500 && !signal.aborted; step++) {
      const view = this.view(id);
      this.noteTokenForecast(view, null);
      this.notePlanCharge(view, null);
      const next = view.next;
      if (view.parallelRuns > 1 && (next.kind === "drive" || next.kind === "start")) {
        if (!(await this.driveFeatures(id, signal))) return;
        continue;
      }
      switch (next.kind) {
        case "decompose":
        case "drive": {
          const runId = next.runId ?? "";
          const feature = view.features.find((f) => f.runId === runId);
          if (next.kind === "drive" && feature) this.refreshGrowth(id, feature.id, runId);
          const before = this.workflows.store.run(runId);
          await this.driveRun(runId, signal);
          const after = this.workflows.store.run(runId);
          // Nothing moved (for example a lost lease): report instead of spinning.
          if (after.revision === before.revision) return;
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
          return;
        default: {
          const parked = view.features.find((f) => f.id === next.featureId);
          if (next.kind === "blocked" && parked?.state === "ready" && shareShortfall(view, parked))
            this.noteShareGate(view, parked, "park");
          return;
        }
      }
    }
  }

  /**
   * One round of an initiative whose features run in worktrees: up to `parallelRuns` feature runs
   * execute at once, and each time one stops the freed slot takes the next ready feature, the one
   * with the longest remaining path first. Each run is driven once per round, so a run that stops
   * without moving is not driven again until the next round. Waiting for every run of a wave before
   * starting the next left slots empty for 8.3 minutes in bench round 44 (cayleykit, #1535). False
   * when nothing started and no run moved.
   */
  private async driveFeatures(id: string, signal: AbortSignal): Promise<boolean> {
    const runnable = (view: InitiativeView): FeatureView[] =>
      view.features.filter((f) => f.state === "in_progress" || f.state === "paused");
    const before = new Map<string, number>();
    const live = new Map<string, Promise<{ runId: string; error?: unknown }>>();
    let started = false;
    let failure: { error: unknown } | null = null;
    const fill = async (): Promise<void> => {
      let view = this.view(id);
      this.noteTokenForecast(view, null);
      this.notePlanCharge(view, null);
      for (;;) {
        const row = this.store.get(id);
        const ready = this.byPath(
          row,
          view.features.filter((f) => f.state === "ready"),
          view.parallelRuns > 1,
        )[0];
        if (!ready || runnable(view).length >= view.parallelRuns) break;
        if (shareShortfall(view, ready)) {
          this.noteShareGate(view, ready, "park");
          break;
        }
        if (this.forecastOver(row, view)) break;
        if (await this.startFeature(id, ready.id)) started = true;
        view = this.view(id);
      }
      for (const feature of runnable(view)) {
        const runId = feature.runId ?? "";
        // A run that started before other features finished grows into what they freed (#1931).
        this.refreshGrowth(id, feature.id, runId);
        if (live.has(runId)) continue;
        if (live.size >= view.parallelRuns) break;
        // A planned-ahead run already driven this round stopped to wait for its upstream; it is
        // released the moment that upstream is accepted, not when the round's last run stops.
        // Bench round 60, wheeltags: names and targets waited 39 minutes with free slots (#1925).
        const released = await this.releasePlanned(id, feature.id, runId);
        if (released) started = true;
        else if (before.has(runId)) continue;
        if (!before.has(runId)) before.set(runId, this.workflows.store.run(runId).revision);
        live.set(
          runId,
          this.driveRun(runId, signal).then(
            () => ({ runId }),
            (error: unknown) => ({ runId, error: error ?? new Error("Feature run failed") }),
          ),
        );
      }
    };
    await fill();
    // Under plan ahead a feature becomes ready when its upstream's spec is approved, in the middle
    // of that upstream's drive, so a free slot is looked at again while runs execute (#1834).
    const row = this.store.get(id);
    const settings = this.store.settings(row);
    const poll = this.planAhead(settings, this.approvedPlan(row), this.workflowFacts(settings));
    while (live.size) {
      const tick = poll ? Bun.sleep(PLAN_AHEAD_POLL_MS).then(() => null) : null;
      const done = await Promise.race(tick ? [...live.values(), tick] : live.values());
      if (done === null) {
        if (!failure && !signal.aborted) await fill();
        continue;
      }
      live.delete(done.runId);
      if ("error" in done && !failure) failure = { error: done.error };
      if (!failure && !signal.aborted) await fill();
    }
    if (failure) throw failure.error;
    return (
      started ||
      [...before].some(([runId, revision]) => this.workflows.store.run(runId).revision !== revision)
    );
  }

  /**
   * Features ordered by remaining critical path, longest first, then in plan order (#1535). One
   * feature at a time keeps plan order: the order does not change the wall time then.
   */
  private byPath<T extends { id: string }>(
    row: InitiativeRow,
    features: T[],
    parallel: boolean,
  ): T[] {
    const plan = parallel && features.length > 1 ? this.approvedPlan(row) : null;
    if (!plan) return features;
    const rank = remainingPath(plan, namedFiles(row.prompt));
    return [...features].sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));
  }

  /**
   * The workspace's parallel run cap when every feature runs in a worktree, or the plan's width up
   * to it with `parallelRunsFromPlan` (#1822); 1 when any feature runs inline, since inline runs
   * share the working copy.
   */
  private parallelRuns(
    settings: InitiativeSettings,
    plan: InitiativePlan | null,
    facts: WorkflowFacts,
  ): number {
    const ids = plan?.features.length
      ? plan.features.map((f) => featureWorkflowId(settings, f))
      : [settings.workflowId];
    if (!ids.every((wf) => this.executionMode(settings, wf, facts) === "worktree")) return 1;
    const cap = parallelRunCap(this.workflows.config);
    return this.workflows.config.workflows?.parallelRunsFromPlan && plan?.features.length
      ? Math.max(1, Math.min(cap, planWidth(plan)))
      : cap;
  }

  /** Plan ahead (#1834) is on and every feature runs in a worktree, more than one at once. */
  private planAhead(
    settings: InitiativeSettings,
    plan: InitiativePlan | null,
    facts: WorkflowFacts,
  ): boolean {
    return (
      this.workflows.config.workflows?.planAhead === true &&
      this.parallelRuns(settings, plan, facts) > 1
    );
  }

  /**
   * Whether a feature may start planning before the features it depends on are finished: it
   * writes a spec (a light feature has no planning to overlap), and every unfinished upstream
   * feature has an open run whose spec is approved, the contract the feature pins (#1834).
   */
  private canPlanAhead(
    settings: InitiativeSettings,
    plan: InitiativePlan,
    feature: InitiativeFeature,
    upstream: FeatureView[],
    facts: WorkflowFacts,
  ): boolean {
    if (facts(featureWorkflowId(settings, feature))?.contract === false) return false;
    if (lightContract(settings, feature, plan)) return false;
    return upstream
      .filter((u) => u.state !== "accepted")
      .every(
        (u) =>
          u.runId !== null &&
          ["in_progress", "paused", "needs_decision", "waiting", "blocked"].includes(u.state) &&
          acceptedContract(this.workflows.store, u.runFeatureId)?.runId === u.runId,
      );
  }

  /** A feature run's execution mode, as `start` resolves it: the definition, then the policy. */
  private executionMode(
    settings: InitiativeSettings,
    workflowId: string,
    facts: WorkflowFacts = this.workflowFacts(settings),
  ): "inline" | "worktree" {
    return facts(workflowId)?.execution ?? executionModeOf(settings.basePolicy);
  }

  /** Facts of the workflows feature runs use, read once per call site. */
  private workflowFacts(settings: InitiativeSettings): WorkflowFacts {
    const known = new Map<string, FeatureWorkflow | null>();
    return (workflowId) => {
      if (!known.has(workflowId))
        known.set(
          workflowId,
          withLightContract(
            featureWorkflow(this.workflows.workspace, settings.basePolicy, workflowId),
            lightContracts(settings),
          ),
        );
      return known.get(workflowId) ?? null;
    };
  }

  /**
   * The plan with a workflow and a size on every feature, refused when a workflow cannot run its
   * feature. A decomposer's split (`replaceInvalid`) has a workflow that cannot run replaced.
   */
  private workflowChoices(settings: InitiativeSettings): FeatureWorkflow[] {
    return featureWorkflowChoices(this.workflows.workspace, settings.basePolicy, {
      tiered: settings.featureAutoApproval !== null,
      lightContracts: lightContracts(settings),
    });
  }

  private fitWorkflows(
    plan: InitiativePlan,
    settings: InitiativeSettings,
    replaceInvalid: boolean,
    keep?: ReadonlySet<string>,
  ): InitiativePlan {
    const choices = this.workflowChoices(settings);
    const fitted = assignFeatureWorkflows(plan, choices, settings.workflowId, {
      replaceInvalid,
      ...(keep ? { keep } : {}),
    });
    const problems = planWorkflowProblems(fitted, choices);
    if (problems.length) throw new WorkflowFault("INVALID_DEFINITION", problems.join("\n"));
    return fitted;
  }

  /**
   * Where a feature's worktree starts: HEAD merged with the accepted result of each upstream
   * feature, so the run sees the code it builds on. Undefined inline (the working copy already
   * holds the upstream results) and for a feature without upstream features.
   */
  private async featureBase(
    id: string,
    feature: InitiativeFeature,
    settings: InitiativeSettings,
    unfinished: readonly string[] = [],
  ): Promise<string | undefined> {
    if (
      this.executionMode(settings, featureWorkflowId(settings, feature)) !== "worktree" ||
      !feature.dependsOn.length
    )
      return undefined;
    const finished = feature.dependsOn.filter((upstream) => !unfinished.includes(upstream));
    const commits = finished.map((upstream) => {
      const link = this.store.current(id, upstream);
      const commit = link ? this.workflows.store.state(link.run_id).worktree?.commit : null;
      if (!commit)
        throw new WorkflowFault(
          "ARTIFACT_MISSING",
          `Feature ${feature.id} builds on ${upstream}, whose run has no committed result`,
        );
      return commit;
    });
    const merged = await mergedBase(
      this.workflows.workspace,
      commits,
      Math.floor(this.store.get(id).created_at / 1000),
    );
    if ("conflicts" in merged) {
      const plan = this.approvedPlan(this.store.get(id));
      const writers = feature.dependsOn.filter((upstream) =>
        plan?.features
          .find((f) => f.id === upstream)
          ?.boundary.paths.some((pattern) =>
            merged.conflicts.some((file) => file === pattern || matchGlob(file, pattern)),
          ),
      );
      const merge = writers.length > 1 ? writers : feature.dependsOn;
      throw new WorkflowFault(
        "INPUT_CHANGED",
        `The results of ${feature.dependsOn.join(", ")}, which ${feature.id} builds on, conflict in ${merged.conflicts.join(", ") || "their files"}. Merge ${merge.join(", ")} into one feature (baked workflow initiative merge --features ${merge.join(",")}), or re-plan one of them so their files do not overlap`,
        { reason: "upstream_conflict", conflicts: merged.conflicts },
      );
    }
    // No upstream branch carries its spec folder (#2017); the accepted specs the prompt points at
    // (specs/<feature>/spec.json) reach the worktree untracked (`baseFiles`), never as a commit
    // the run's own commit deletes (#2046).
    const date = Math.floor(this.store.get(id).created_at / 1000);
    const base = merged.commit;
    if (!unfinished.length) return base;
    // Planning ahead (#1834), the feature sees the stubs the unfinished features it builds on
    // (directly or through others) write, so it plans to modify them as it would on their results.
    const plan = this.approvedPlan(this.store.get(id));
    const accepted = new Set(finished);
    const pending = new Set<string>();
    const visit = (upstream: string): void => {
      if (pending.has(upstream) || accepted.has(upstream)) return;
      pending.add(upstream);
      for (const next of plan?.features.find((f) => f.id === upstream)?.dependsOn ?? []) {
        const link = this.store.current(id, next);
        if (!link || this.workflows.store.state(link.run_id).worktree?.commit == null) visit(next);
      }
    };
    for (const upstream of unfinished) visit(upstream);
    return provisionalBase(
      this.workflows.workspace,
      base,
      [...pending].flatMap(
        (upstream) => plan?.features.find((f) => f.id === upstream)?.skeleton ?? [],
      ),
      date,
    );
  }

  /**
   * The spec documents each accepted feature `feature` builds on (directly or through others)
   * published, byte for byte: what its branch carried before #2017. A feature in `unfinished`,
   * and one whose run published no spec (a definition with `publish: false`), adds none. They go
   * with the feature's base as `baseFiles`, written untracked into its worktree (#2046).
   */
  private upstreamSpecs(
    id: string,
    feature: InitiativeFeature,
    unfinished: readonly string[],
  ): { path: string; content: string }[] {
    const plan = this.approvedPlan(this.store.get(id));
    const seen = new Set<string>();
    const files: { path: string; content: string }[] = [];
    const visit = (upstream: string): void => {
      if (seen.has(upstream) || unfinished.includes(upstream)) return;
      seen.add(upstream);
      const link = this.store.current(id, upstream);
      const state = link ? this.workflows.store.state(link.run_id) : null;
      if (state?.spec && state.plan && state.graph) {
        const documents = specPublication(state.spec, state.plan, state.graph);
        for (const [name, content] of Object.entries(documents)) {
          const path = `specs/${state.spec.featureId}/${name}`;
          if (state.published[path] === hashBytes(content)) files.push({ path, content });
        }
      }
      for (const next of plan?.features.find((f) => f.id === upstream)?.dependsOn ?? [])
        visit(next);
    };
    for (const upstream of feature.dependsOn) visit(upstream);
    return files;
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
    const decomposed = InitiativePlanSchema.parse(JSON.parse(state.initiativePlan));
    const settings = this.store.settings(row);
    // Small siblings share one run's fixed stages (#1352); the decomposer's prompt alone did not.
    // A feature that is only skeleton runs inside a dependent instead of a run of its own (#1662).
    const folded = settings.keepFeatures
      ? { plan: decomposed, merged: [] }
      : foldSkeletonFeatures(decomposed);
    const siblings = settings.keepFeatures
      ? { plan: folded.plan, merged: [] }
      : mergeSmallSiblings(folded.plan, {
          byDependents: settings.splitCriticalPath || settings.basePolicy.criticalPath === "split",
        });
    const floored = { plan: siblings.plan, merged: [...folded.merged, ...siblings.merged] };
    const proposed = floored.plan;
    let plan = proposed;
    let unfit: string | null = null;
    let lightened: { featureId: string; from: string; to: string }[] = [];
    let unavailable: string[] = [];
    try {
      const ownership = testOwnershipProblems(proposed);
      if (ownership.length) throw new WorkflowFault("OUTPUT_INVALID", ownership.join("\n"));
      plan = this.fitWorkflows(proposed, settings, true);
      // A small feature nothing depends on runs the light workflow: nobody pins its spec.
      if (!settings.keepFeatures) {
        const light = lightenSmallLeaves(plan, this.workflowChoices(settings), new Set(), {
          withDependents: lightContracts(settings),
        });
        plan = light.plan;
        lightened = light.lightened;
        unavailable = light.unavailable;
      }
    } catch (error) {
      unfit = error instanceof Error ? error.message : String(error);
    }
    this.store.transaction(() => {
      const size = planSizeProblem(plan) ?? unfit;
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
      if (floored.merged.length)
        this.store.emit(id, "split.merged", {
          planRevision: this.store.get(id).plan_revision,
          merged: floored.merged,
        });
      if (lightened.length || unavailable.length)
        this.store.emit(id, "split.lightened", {
          planRevision: this.store.get(id).plan_revision,
          lightened,
          // Small leaves that keep a spec workflow because quick cannot run a feature here.
          ...(unavailable.length ? { unavailable } : {}),
        });
    });
  }

  /** Starts a feature's run; false when its upstream results conflict and it waits for a person. */
  /**
   * Records the share gate's inputs and verdict for a feature (#1707): every start, and a park
   * once until the feature's verdict changes, so a drive that retries a parked feature does not
   * repeat it.
   */
  private noteShareGate(
    view: InitiativeView,
    feature: FeatureView,
    verdict: "pass" | "park",
  ): void {
    const id = view.initiativeId;
    if (verdict === "park") {
      const last = this.store
        .eventsOfType(id, "feature.share_gate")
        .filter((p) => (p as ShareGateRecord | null)?.featureId === feature.id)
        .at(-1) as ShareGateRecord | undefined;
      if (last?.verdict === "park") return;
    }
    const gateView: ShareGateView = {
      initiativeId: id,
      budget: {
        remaining: view.budget.remaining,
        cost: view.budget.cost,
        limits: view.budget.limits,
        used: view.budget.used,
        pool: view.budget.pool,
        ...(view.budget.planCharge ? { planCharge: view.budget.planCharge } : {}),
      },
      features: view.features.map((f) => ({
        id: f.id,
        state: f.state,
        share: f.share,
        need: f.need,
        shareUsd: f.shareUsd,
        needUsd: f.needUsd ?? null,
      })),
    };
    const mode = this.extendWithinDollars();
    const growth = verdict === "park" && mode !== "off" ? poolGrowthOf(gateView, feature) : null;
    const record: ShareGateRecord = {
      featureId: feature.id,
      verdict,
      ...(growth
        ? {
            poolGrowth: {
              mode,
              wouldExtend: growth.wouldExtend,
              toTokens: growth.toTokens,
              byTokens: growth.byTokens,
            },
          }
        : {}),
      view: {
        initiativeId: id,
        budget: gateView.budget,
        features: view.features.map((f) => ({
          id: f.id,
          state: f.state,
          share: f.share,
          need: f.need,
          shareUsd: f.shareUsd,
          needUsd: f.needUsd ?? null,
        })),
      },
      feature: {
        id: feature.id,
        share: feature.share,
        need: feature.need,
        shareUsd: feature.shareUsd,
        needUsd: feature.needUsd ?? null,
      },
    };
    this.store.emit(id, "feature.share_gate", record);
    if (verdict === "pass") this.noteTokenForecast(view, feature.id);
    if (growth?.wouldExtend) this.noteWouldExtend(gateView, feature.id, growth);
    this.notePlanCharge(view, { view: gateView, feature, verdict });
  }

  /** `workflows.extendWithinDollars`: whether a token park records the host's extension (#2042). */
  private extendWithinDollars(): ExtendWithinDollars {
    return this.workflows.config.workflows?.extendWithinDollars ?? DEFAULT_EXTEND_WITHIN_DOLLARS;
  }

  /**
   * A `budget.forecast_notice` event the first time a drive sees the token forecast above the
   * pool, once per pool size (#2042): at a feature's start (`featureId`) or after a run moved, so
   * `initiative events` and `/v1/initiatives/ID/events` carry the warning before any feature parks.
   */
  private noteTokenForecast(view: InitiativeView, featureId: string | null): void {
    const pool = view.budget.pool;
    if (!pool?.notice) return;
    const noted = this.store
      .eventsOfType(view.initiativeId, "budget.forecast_notice")
      .some((p) => (p as { limitTokens?: number } | null)?.limitTokens === pool.limitTokens);
    if (noted) return;
    this.store.emit(view.initiativeId, "budget.forecast_notice", {
      featureId,
      limitTokens: pool.limitTokens,
      usedTokens: pool.usedTokens,
      forecastTokens: pool.forecastTokens,
      ratio: pool.ratio,
      suggestedTokens: pool.suggestedTokens,
      message: pool.notice,
    });
  }

  /**
   * The host would extend the token pool to start a parked feature inside the dollar cap
   * (`extendWithinDollars: shadow`, #2042): a `decision.would_extend` event with the decision's
   * inputs, once per feature and pool size. Nothing changes: the pool stays as the person set it.
   */
  private noteWouldExtend(view: ShareGateView, featureId: string, growth: PoolExtension): void {
    const id = view.initiativeId;
    const inputs = shareGatePool(view);
    const key = `${growth.reason}-${featureId}-${inputs?.limitTokens ?? 0}`;
    const seen = this.store
      .eventsOfType(id, "decision.would_extend")
      .some((p) => (p as { key?: string } | null)?.key === key);
    if (seen) return;
    this.store.emit(id, "decision.would_extend", {
      reason: growth.reason,
      mode: "shadow",
      featureId,
      key,
      toTokens: growth.toTokens,
      byTokens: growth.byTokens,
      summary: `${growth.why} ${featureId} would start.`,
      inputs,
    });
  }

  /**
   * What the plan charge would change while it is not enforced (#2100, #2056): a
   * `decision.would_release` event once per open run and plan sizing, with the tokens holding it
   * at its plan's need frees (negative: adds), and at a share gate, once per feature, when the
   * charge would turn the verdict: a parked feature that would start (`wouldStart`) or a started
   * one that would park (`wouldPark`). Nothing changes: the pool keeps holding run limits.
   */
  private notePlanCharge(
    view: Pick<InitiativeView, "initiativeId"> & { budget: ShareGateView["budget"] },
    gate: { view: ShareGateView; feature: FeatureView; verdict: "pass" | "park" } | null,
  ): void {
    const charge = view.budget.planCharge;
    if (!charge || charge.mode === "enforce") return;
    const id = view.initiativeId;
    const seen = new Set(
      this.store
        .eventsOfType(id, "decision.would_release")
        .map((p) => (p as { key?: string } | null)?.key),
    );
    const base = {
      reason: "initiative-plan-charge",
      mode: charge.mode,
      ratio: charge.ratio,
      limitCommittedTokens: charge.limitCommittedTokens,
      planCommittedTokens: charge.planCommittedTokens,
      runs: charge.runs.map(({ featureId, runId, usedTokens, limitTokens, chargeTokens }) => ({
        featureId,
        runId,
        usedTokens,
        limitTokens,
        chargeTokens,
      })),
    };
    const amount = (n: number): string =>
      n >= 0 ? `frees ${tokenText(n)} tokens` : `adds ${tokenText(-n)} tokens`;
    for (const run of charge.runs) {
      const key = `run-${run.runId}-${run.plan.high}`;
      if (seen.has(key)) continue;
      const released = Math.max(run.usedTokens, run.limitTokens) - run.chargeTokens;
      if (released === 0) continue;
      this.store.emit(id, "decision.would_release", {
        ...base,
        key,
        featureId: run.featureId,
        releasedTokens: released,
        wouldStart: false,
        wouldPark: false,
        summary: `${run.featureId}'s plan prices its run at ${tokenText(run.chargeTokens)} tokens (${tokenText(run.usedTokens)} used): holding that instead of its ${tokenText(run.limitTokens)} limit ${amount(released)} of the pool.`,
      });
    }
    if (!gate) return;
    const charged = planChargedGate(gate.view);
    if (!charged) return;
    const own = charged.features.find((f) => f.id === gate.feature.id);
    const blocked = shareShortfall(charged, { ...gate.feature, share: own?.share ?? null });
    const wouldStart = gate.verdict === "park" && !blocked;
    const wouldPark = gate.verdict === "pass" && blocked !== null;
    if (!wouldStart && !wouldPark) return;
    const key = `${wouldStart ? "start" : "park"}-${gate.feature.id}`;
    if (seen.has(key)) return;
    const limit = gate.view.budget.limits?.maxTotalTokens ?? 0;
    this.store.emit(id, "decision.would_release", {
      ...base,
      key,
      featureId: gate.feature.id,
      releasedTokens: charge.releasedTokens,
      wouldStart,
      wouldPark,
      summary: `Holding the open runs with a sized plan at their plan's need ${amount(charge.releasedTokens)}: ${tokenText(charged.budget.remaining.tokens)} of the ${tokenText(limit)} pool would remain and ${gate.feature.id} would ${wouldStart ? "start" : "not start"}.`,
    });
  }

  /**
   * Records once for each count of measured features that a feature starts while the forecast
   * is above the ceiling but not yet binding (#1659), so `initiative events` and
   * `/v1/initiatives/ID/events` show the warning a stop used to give.
   */
  private noteAdvisoryForecast(id: string, featureId: string, cost: CostView): void {
    if (cost.forecastNotice === null) return;
    const noted = this.store
      .eventsOfType(id, "cost.forecast_advisory")
      .some(
        (p) =>
          (p as { measuredFeatures?: number } | null)?.measuredFeatures === cost.measuredFeatures,
      );
    if (noted) return;
    this.store.emit(id, "cost.forecast_advisory", {
      featureId,
      forecastUsd: cost.forecastUsd,
      ceilingUsd: cost.ceilingUsd,
      spentUsd: cost.spentUsd,
      measuredFeatures: cost.measuredFeatures,
      message: cost.forecastNotice,
    });
  }

  /**
   * Records, once per key, that a forecast stop in `shadow` or `advisory` mode would have held
   * this start (#1714): the dollar forecast once per count of measured features, the token
   * forecast of `forecastStop` once per plan revision and accepted count.
   */
  private noteForecastWouldStop(row: InitiativeRow, featureId: string, view: InitiativeView): void {
    const cost = view.budget.cost;
    if (cost.forecastMode === "enforce") return;
    const mode = cost.forecastMode;
    const accepted = view.features.filter((f) => f.state === "accepted").length;
    const stops: { key: string; summary: string; inputs: Record<string, unknown> }[] = [];
    if (forecastOverCeiling(cost))
      stops.push({
        key: `usd-m${cost.measuredFeatures}`,
        summary: `The initiative's cost forecast is ${usd(cost.forecastUsd ?? 0)}, above its ${usd(cost.ceilingUsd ?? 0)} ceiling: ${usd(cost.spentUsd)} spent with ${accepted} of ${view.features.length} features accepted. ${featureId} would not start.`,
        inputs: {
          forecastUsd: cost.forecastUsd,
          ceilingUsd: cost.ceilingUsd,
          spentUsd: cost.spentUsd,
          measuredFeatures: cost.measuredFeatures,
        },
      });
    const tokens = this.tokenForecastOver(row, view);
    if (tokens)
      stops.push({
        key: `tokens-r${row.approved_plan_revision}-a${accepted}`,
        summary: `${tokens.summary} ${featureId} would not start.`,
        inputs: tokens.inputs,
      });
    const seen = this.store.eventsOfType(row.id, "decision.would_stop");
    for (const stop of stops) {
      if (
        seen.some(
          (p) =>
            (p as { reason?: string } | null)?.reason === "initiative-forecast" &&
            (p as { key?: string }).key === stop.key,
        )
      )
        continue;
      this.store.emit(row.id, "decision.would_stop", {
        reason: "initiative-forecast",
        mode,
        featureId,
        ...stop,
      });
    }
  }

  /**
   * A feature that starts although its spare dollars are below its priced low estimate, because
   * `initiative-dollar-share` is not enforced: a `decision.would_stop` event, once per feature.
   */
  private noteShareWouldStop(id: string, view: InitiativeView, feature: FeatureView): void {
    const mode = view.budget.cost.shareMode;
    if (!mode || mode === "enforce") return;
    const summary = dollarShortfall(view, feature);
    if (!summary) return;
    const key = `share-${feature.id}`;
    const seen = this.store
      .eventsOfType(id, "decision.would_stop")
      .some(
        (p) =>
          (p as { reason?: string } | null)?.reason === "initiative-dollar-share" &&
          (p as { key?: string }).key === key,
      );
    if (seen) return;
    this.store.emit(id, "decision.would_stop", {
      reason: "initiative-dollar-share",
      mode,
      featureId: feature.id,
      key,
      summary: `${summary} ${feature.id} would not start.`,
      inputs: {
        spareUsd: shareSpareUsd(view, feature.id),
        needUsd: feature.needUsd ?? null,
        remainingUsd: view.budget.cost.remainingUsd,
        remainingTo: uncalibratedSlack(view.budget.cost) > 0 ? "ceiling" : "cap",
        measuredFeatures: view.budget.cost.measuredFeatures,
      },
    });
  }

  private async startFeature(id: string, featureId: string): Promise<boolean> {
    const row = this.store.get(id);
    const plan = this.approvedPlan(row);
    const feature = plan?.features.find((f) => f.id === featureId);
    if (!plan || !feature) throw new WorkflowFault("NOT_FOUND", `Unknown feature ${featureId}`);
    const settings = this.store.settings(row);
    const current = this.view(id);
    const waiting = current.features.find((f) => f.id === featureId);
    const unfinished = waiting?.plannedAhead ?? [];
    const upstream = this.upstreamContracts(id, feature, unfinished);
    const sized = waiting?.share;
    if (!sized) throw stopFault("budget-share", "No budget share is available");
    if (waiting) this.noteShareGate(current, waiting, "pass");
    if (waiting) this.noteShareWouldStop(id, current, waiting);
    this.noteAdvisoryForecast(id, featureId, current.budget.cost);
    this.noteForecastWouldStop(row, featureId, current);
    const share = { ...sized, ...guardGrowth(current, featureId, settings.basePolicy) };
    const previous = this.store.links(id).filter((l) => l.feature_id === featureId).length;
    const runFeature = runFeatureId(id, featureId);
    let baseCommit: string | undefined;
    try {
      baseCommit = await this.featureBase(id, feature, settings, unfinished);
    } catch (error) {
      if (!(error instanceof WorkflowFault) || error.details.reason !== "upstream_conflict")
        throw error;
      // The feature waits for a person instead of failing on every drive (sketchfold: the drive
      // exited every 52 s for 22 minutes with nothing to answer, #1336).
      this.store.emit(id, "feature.upstream_conflict", {
        featureId,
        planRevision: row.approved_plan_revision,
        upstream: feature.dependsOn,
        conflicts: error.details.conflicts ?? [],
        message: error.message,
      });
      return false;
    }
    const policy = featurePolicy(
      settings,
      share,
      feature,
      false,
      growthLimit(current, featureId),
      waiting?.shareUsd ?? null,
      costGrowthLimit(current, featureId),
      current.budget.cost.forecastBinding,
    );
    const declined = featureApprovalDeclined(settings, feature, false, policy);
    // A derived command ID makes a start after a crash return the same run instead of a second one.
    const snapshot = await this.workflows.start({
      commandId: `i-${hashJson({ id, featureId, previous, revision: row.approved_plan_revision }).slice(0, 48)}`,
      workflowId: featureWorkflowId(settings, feature),
      featureId: runFeature,
      prompt: featurePrompt(row, plan, feature, upstream),
      initiativeBounds: {
        featureId,
        features: plan.features.map((f) => ({
          id: f.id,
          ...f.boundary,
          ...(f.testedBy ? { testedBy: f.testedBy } : {}),
          dependsOn: f.dependsOn,
        })),
      },
      policy,
      ...(declined ? { autoApprovalDeclined: declined } : {}),
      ownerLabel: settings.ownerLabel,
      dependencies: upstream.map((u) => ({
        featureId: u.contract.featureId,
        contractHash: u.contract.contractHash,
      })),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.autoApprovalConfirmation
        ? { autoApprovalConfirmation: settings.autoApprovalConfirmation }
        : {}),
      // A shipped light preset approves its plan within the feature's tiered limits (#1374).
      ...(settings.featureAutoApproval ? { boundaryAutoApproval: true } : {}),
      ...(settings.featureIssues[featureId] ? { issue: settings.featureIssues[featureId] } : {}),
      ...(feature.skeleton?.length ? { hostFiles: feature.skeleton } : {}),
      ...(lightContract(settings, feature, plan) ? { contract: feature.contract } : {}),
      ...(baseCommit ? { baseCommit, baseFiles: this.upstreamSpecs(id, feature, unfinished) } : {}),
      ...(baseCommit && unfinished.length ? { planAhead: true } : {}),
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
    return true;
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
    // Under plan ahead the rebased run plans against upstream features still unfinished (#1834).
    const unfinished = this.planAhead(settings, plan, this.workflowFacts(settings))
      ? feature.dependsOn.filter((upstream) => {
          const contract = acceptedContract(this.workflows.store, runFeatureId(id, upstream));
          return contract !== null && !contract.completed;
        })
      : [];
    const upstream = this.upstreamContracts(id, feature, unfinished);
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
    // The rebased run shares what is left with the features that have not started yet, by need,
    // and grows only as far as their estimates leave room, as a starting feature does (#1417).
    const before = this.view(id);
    const accepted = new Set(
      before.features.filter((f) => f.state === "accepted" && f.id !== featureId).map((f) => f.id),
    );
    const estimate = this.estimateOf(row, plan, accepted);
    const need = this.featureNeeds(estimate).get(featureId) ?? null;
    const needUsd = estimate.features.find((f) => f.featureId === featureId)?.costUsd ?? null;
    const current = rebaseView(before, featureId, need, needUsd);
    const rebased = current.features.find((f) => f.id === featureId);
    const rebaseShare = {
      ...(rebased?.share ?? zero()),
      ...guardGrowth(current, featureId, settings.basePolicy),
    };
    const dependencies = upstream.map((u) => ({
      featureId: u.contract.featureId,
      contractHash: u.contract.contractHash,
    }));
    const baseCommit = await this.featureBase(id, feature, settings, unfinished);
    const open = this.workflows.store.run(link.run_id);
    const policy = featurePolicy(
      settings,
      rebaseShare,
      feature,
      true,
      growthLimit(current, featureId),
      rebased?.shareUsd ?? null,
      costGrowthLimit(current, featureId),
      current.budget.cost.forecastBinding,
    );
    const declined = featureApprovalDeclined(settings, feature, true, policy);
    const snapshot = await this.workflows.rebase(
      link.run_id,
      {
        commandId: `r-${hashJson({ runId: link.run_id, dependencies }).slice(0, 48)}`,
        expectedRevision: open.revision,
      },
      {
        dependencies,
        policy,
        ...(baseCommit
          ? { baseCommit, baseFiles: this.upstreamSpecs(id, feature, unfinished) }
          : {}),
        ...(declined ? { autoApprovalDeclined: declined } : {}),
        ...(baseCommit && unfinished.length ? { planAhead: true } : {}),
      },
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

  /**
   * The calls and active time an open feature run may grow into now (`openGuardRoom`): the pool
   * less what the other runs used and the floors of the features still waiting for a run, as
   * `guardGrowth` floors them.
   */
  private guardRoom(
    id: string,
    view: InitiativeView,
    featureId: string,
    runId: string,
    base: RunPolicy,
  ): { calls: number; activeMs: number } {
    const row = this.store.get(id);
    const others = [
      ...(row.decompose_run_id ? [row.decompose_run_id] : []),
      ...this.store.links(id).map((l) => l.run_id),
    ]
      .filter((other) => other !== runId)
      .map((other) => this.usage(other))
      .reduce(add, zero());
    const floor = (
      feature: InitiativeView["features"][number],
      limit: number,
      share: number,
    ): number => Math.min(share, (limit * sizeWeight(feature)) / 2);
    const waiting = view.features
      .filter((f) => f.share !== null && f.id !== featureId)
      .reduce(
        (sum, f) => ({
          calls: sum.calls + floor(f, base.maxAgentCalls, f.share?.calls ?? 0),
          activeMs: sum.activeMs + floor(f, base.maxActiveMs, f.share?.activeMs ?? 0),
        }),
        { calls: 0, activeMs: 0 },
      );
    const limits = this.limits(row);
    return openGuardRoom(
      { calls: limits.maxAgentCalls, activeMs: limits.maxActiveMs },
      this.committed(runId),
      others,
      waiting,
    );
  }

  /**
   * Raises an open feature run's growth bounds to what the initiative can spare now. A run's room
   * to grow was computed once, when it started: a planned-ahead feature starts at planning, long
   * before its tasks run, and dollars the other features freed since stayed out of its reach.
   * R60 wheeltags explain stopped on a $3.41 bound when about $6 was spare, and an owner
   * extension was approved and never used (#1931). Bounds only rise, so nothing stops sooner;
   * the run's own growth still asks for each step. Recorded as a host policy revision.
   */
  private refreshGrowth(id: string, featureId: string, runId: string): void {
    if (!runId) return;
    const run = this.workflows.store.run(runId);
    if (terminalStates.includes(run.status)) return;
    const settings = this.store.settings(this.store.get(id));
    const view = this.view(id);
    const policy = PolicySchema.parse(JSON.parse(run.policy_json));
    const guard = this.guardRoom(id, view, featureId, runId, settings.basePolicy);
    const spareUsd = costGrowthLimit(view, featureId);
    const spareTokens = growthLimit(view, featureId);
    // In enforce the room already counts this run at its plan charge (#2100): it holds that.
    const charged = view.budget.planCharge;
    const own = charged?.mode === "enforce" ? charged.runs.find((r) => r.runId === runId) : null;
    const committed = this.committed(runId);
    const held = {
      ...committed,
      tokens: own ? own.chargeTokens : committed.tokens,
      usd: this.committedUsd(runId),
    };
    const after = refreshedGrowth(policy, settings.basePolicy, held, this.usage(runId), {
      usd: spareUsd,
      tokens: spareTokens,
      calls: guard.calls,
      activeMs: guard.activeMs,
    });
    if (!after) return;
    const store = this.workflows.store;
    const count = store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/initiative-")).length;
    const keys = ["maxAgentCalls", "maxActiveMs", "sizing"] as const;
    store.transaction(() => {
      store.artifact(
        runId,
        "policy-revision",
        `policy-revisions/initiative-${String(count + 1)}.json`,
        canonical({
          kind: "initiative-growth",
          approvedBy: "sizing",
          previousPolicyHash: hashJson(policy),
          policyHash: hashJson(after),
          previous: Object.fromEntries(keys.map((key) => [key, policy[key] ?? null])),
          next: Object.fromEntries(keys.map((key) => [key, after[key] ?? null])),
          inputs: { featureId, held, spareUsd, spareTokens, guard },
        }),
      );
      store.setPolicy(runId, after);
    });
  }

  /**
   * A planned-ahead feature run (#1834) whose upstream features are all accepted moves onto
   * their results, the base it would have started from, and its tasks start. False when the run
   * waits for nothing of the kind.
   */
  private async releasePlanned(id: string, featureId: string, runId: string): Promise<boolean> {
    const state = this.workflows.store.state(runId);
    const run = this.workflows.store.run(runId);
    if (
      run.status !== "waiting" ||
      !state.planAhead ||
      state.planAhead.released ||
      !this.workflows.store.requests(runId).some((r) => r.status === "pending" && isHostRelease(r))
    )
      return false;
    const row = this.store.get(id);
    const feature = this.approvedPlan(row)?.features.find((f) => f.id === featureId);
    if (!feature) return false;
    const baseCommit = await this.featureBase(id, feature, this.store.settings(row));
    if (!baseCommit) return false;
    await this.workflows.releaseBase(
      runId,
      {
        commandId: `p-${hashJson({ runId, baseCommit }).slice(0, 48)}`,
        expectedRevision: run.revision,
      },
      { baseCommit, baseFiles: this.upstreamSpecs(id, feature, []) },
    );
    this.store.emit(id, "feature.released", { featureId, runId, baseCommit });
    await this.checkUpstreamSymbols(runId, feature, this.approvedPlan(row), baseCommit);
    return true;
  }

  /**
   * A released feature's spec was written on a provisional base: each upstream symbol it names is
   * looked up in the accepted upstream files, and a missing one is recorded as a would-stop
   * (`upstream_symbol`, shadow) naming the clause, the symbol and the file (#2135). R68 ewvet
   * scanner made a "public Reader helper" a `must` that the accepted reader did not have, and
   * spent 4.5M tokens before review found it.
   */
  private async checkUpstreamSymbols(
    runId: string,
    feature: InitiativePlan["features"][number],
    plan: InitiativePlan | null,
    baseCommit: string,
  ): Promise<void> {
    const spec = this.workflows.store.state(runId).spec;
    if (!spec || !plan) return;
    const files = upstreamFiles(plan, feature);
    if (!files.length) return;
    const upstream = await Promise.all(
      files.map(async (file) => {
        const shown = await git(this.workflows.workspace, ["show", `${baseCommit}:${file.path}`]);
        return { ...file, text: shown.code === 0 ? shown.stdout : null };
      }),
    );
    const gaps = upstreamSymbolGaps(spec, upstream);
    const policy = PolicySchema.parse(JSON.parse(this.workflows.store.run(runId).policy_json));
    const mode = stopMode(policy, "upstream_symbol");
    // The reason is not enforced yet, so a policy can only choose shadow or advisory.
    if (!gaps.length || mode === "enforce") return;
    recordWouldStop(this.workflows.store, runId, {
      reason: "upstream_symbol",
      mode,
      key: `release-${baseCommit}`,
      summary: `The spec names upstream symbols the accepted code does not have: ${gaps.map((g) => `${g.ref} ${g.symbol} (${g.path}, ${g.featureId})`).join("; ")}`,
      inputs: { baseCommit, gaps },
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

  /**
   * The estimate of the initiative's split (the approved plan, else the latest revision): a level
   * and a token range per feature and in total, from this project's run history. Null before a
   * split exists.
   */
  estimate(id: string): InitiativeEstimate | null {
    const row = this.store.get(id);
    const latest = row.plan_revision ? this.store.revision(id, row.plan_revision) : null;
    const plan = this.approvedPlan(row) ?? (latest ? this.store.plan(latest) : null);
    if (!plan) return null;
    const accepted = this.view(id)
      .features.filter((f) => f.state === "accepted")
      .map((f) => f.id);
    // Asked for rarely and right after runs finish, so it reads the store fresh.
    return this.estimateOf(row, plan, new Set(accepted), 0);
  }

  /**
   * The forecast-stop message when the initiative has `forecastStop` on and the low end of the
   * estimate of its approved split is above the shared budget; null otherwise.
   */
  private forecastOver(
    row: InitiativeRow,
    view: Pick<InitiativeView, "features" | "budget">,
  ): RecoveryAdvice | null {
    if (view.budget.cost.forecastMode !== "enforce") return null;
    const over = this.tokenForecastOver(row, view);
    if (!over) return null;
    return recoveryAdvice(
      `${over.summary} Raise it with baked workflow initiative extend ${row.id} --tokens ${over.withMargin}, or trim the split.`,
      `${over.summary} Raise the budget to ${tokenText(over.withMargin)} tokens, or trim the split.`,
      { action: "extend", initiativeId: row.id, suggestedTokens: over.withMargin },
    );
  }

  /** The token forecast above the shared budget with `forecastStop` on, whatever its mode. */
  private tokenForecastOver(
    row: InitiativeRow,
    view: Pick<InitiativeView, "features">,
  ): { summary: string; inputs: Record<string, unknown>; withMargin: number } | null {
    if (!this.store.settings(row).forecastStop) return null;
    const plan = this.approvedPlan(row);
    if (!plan) return null;
    const accepted = new Set(view.features.filter((f) => f.state === "accepted").map((f) => f.id));
    const estimate = this.estimateOf(row, plan, accepted);
    if (estimate.tokens.low <= estimate.budget.maxTotalTokens) return null;
    return {
      summary: `The forecast is over the shared budget: ${rangeText(estimate.tokens)} tokens against ${tokenText(estimate.budget.maxTotalTokens)}.`,
      inputs: { tokens: estimate.tokens, maxTotalTokens: estimate.budget.maxTotalTokens },
      withMargin: estimate.withMargin,
    };
  }

  /**
   * The estimated tokens of each feature of the approved plan that this project's history prices,
   * or that the initiative's accepted features calibrate. Generic ranges are left out: they say
   * nothing about this project and would hold a feature with a small budget back on numbers no run
   * measured.
   */
  private featureNeeds(estimate: InitiativeEstimate): Map<string, TokenRange> {
    return new Map(
      estimate.features.filter((f) => f.basis !== "defaults").map((f) => [f.featureId, f.tokens]),
    );
  }

  private estimateOf(
    row: InitiativeRow,
    plan: InitiativePlan,
    accepted: ReadonlySet<string>,
    maxAgeMs?: number,
  ): InitiativeEstimate {
    const settings = this.store.settings(row);
    const facts = this.workflowFacts(settings);
    const models = settings.model ? [settings.model] : [];
    const counts = boundaryPathCounts(plan, row.prompt);
    const features = plan.features.map((feature) => {
      const workflowId = featureWorkflowId(settings, feature);
      return {
        id: feature.id,
        title: feature.title,
        workflowId,
        size: feature.size ?? "medium",
        stages: (facts(workflowId)?.stages ?? []).map((stage) => ({ ...stage, models })),
        ...counts.get(feature.id),
        dependsOn: feature.dependsOn,
        ...(feature.testCases ? { testCases: feature.testCases } : {}),
      };
    });
    const history = estimateHistory(
      this.workflows.store,
      this.workflows.workspace,
      settings.basePolicy,
      maxAgeMs,
    );
    // This initiative's own runs are its progress, not feature samples. Stage history still
    // prices the planned workflows; only enough non-skeleton acceptances calibrate their totals.
    const links = this.store.links(row.id);
    const own = new Set(links.map((l) => l.run_id));
    const spent: InitiativeProgress["features"] = {};
    for (const link of links) {
      const entry = spent[link.feature_id] ?? {
        spent: 0,
        accepted: accepted.has(link.feature_id),
      };
      entry.spent += this.usage(link.run_id).tokens;
      // The latest run with a spec says how many criteria the feature has.
      const criteria = this.workflows.store.state(link.run_id).spec?.criteria.length;
      if (criteria) entry.criteria = criteria;
      // And the latest run with a sized plan, what the whole run should use.
      const planned = plannedRunTokens(this.workflows.store, link.run_id);
      if (planned) entry.planned = planned;
      spent[link.feature_id] = entry;
    }
    const estimate = estimateInitiative({
      features,
      history,
      samples: [
        ...featureRunSamples(this.store, this.workflows.store, history),
        ...sharedFeatureRunSamples(
          historyStorePaths(this.workflows.workspace, settings.basePolicy),
          history,
        ),
      ].filter((s) => !own.has(s.runId)),
      maxTotalTokens: this.limits(row).maxTotalTokens,
      progress: {
        features: spent,
        overhead: row.decompose_run_id ? this.usage(row.decompose_run_id).tokens : 0,
      },
      parallelRuns: this.parallelRuns(settings, plan, facts),
      ...(settings.basePolicy?.sizing?.recencyHalfLife
        ? { recencyHalfLife: settings.basePolicy.sizing.recencyHalfLife }
        : {}),
      // Read only when the request demands a test volume: the sizing history opens every store.
      ...(features.some((f) => f.testCases)
        ? {
            testCaseRate: testCaseRate(
              sizingHistory(this.workflows.workspace, settings.basePolicy),
            ),
          }
        : {}),
    });
    this.priceFeatureNeeds(row, estimate, history, accepted);
    return estimate;
  }

  /**
   * The initiative a feature run belongs to and its next step, for the answer of a decision on
   * that run (#2024); null for a run outside an initiative.
   */
  ofRun(runId: string): InitiativeStep | null {
    const id = this.store.initiativeOfRun(runId);
    if (!id) return null;
    const view = this.view(id);
    return { initiativeId: id, status: view.status, next: view.next, drive: view.drive };
  }

  /** What the initiative is, where every feature stands and why, and what happens next. */
  view(id: string): InitiativeView {
    const row = this.store.get(id);
    const settings = this.store.settings(row);
    const latest = row.plan_revision ? this.store.revision(id, row.plan_revision) : null;
    const latestPlan = latest ? this.store.plan(latest) : null;
    const approved = this.approvedPlan(row);
    const plan = approved ?? latestPlan;
    const facts = this.workflowFacts(settings);
    const features = plan ? this.featureViews(row, plan, approved !== null, facts) : [];
    const decompose = row.decompose_run_id ? this.workflows.store.run(row.decompose_run_id) : null;
    const runIds = [
      ...(decompose ? [decompose.id] : []),
      ...this.store.links(id).map((l) => l.run_id),
    ];
    const used = runIds.map((runId) => this.usage(runId)).reduce(add, zero());
    const byLimits = runIds.map((runId) => this.committed(runId)).reduce(add, zero());
    const limits = this.limits(row);
    // Features without a run share what remains: tokens by estimated need, calls and time by size.
    const waitingForRun = approved ? features.filter((f) => f.runId === null) : [];
    const accepted = new Set(features.filter((f) => f.state === "accepted").map((f) => f.id));
    // Keep the token estimate and dollar stage mix on the same fresh history snapshot. A feature
    // can finish within the cache's five seconds, immediately before the next start gate.
    const estimate =
      approved && features.some((f) => f.state !== "accepted")
        ? this.estimateOf(row, approved, accepted, 0)
        : null;
    const charge = estimate ? this.planChargeOf(id, settings, estimate, byLimits.tokens) : null;
    // Only in enforce does the pool hold open runs with a sized plan at their plan charge (#2100).
    const committed =
      charge?.mode === "enforce" ? { ...byLimits, tokens: charge.planCommittedTokens } : byLimits;
    const remaining = {
      tokens: Math.max(0, limits.maxTotalTokens - committed.tokens),
      calls: Math.max(0, limits.maxAgentCalls - committed.calls),
      activeMs: Math.max(0, limits.maxActiveMs - committed.activeMs),
    };
    const needs = estimate ? this.featureNeeds(estimate) : null;
    for (const feature of waitingForRun) {
      feature.need = needs?.get(feature.id) ?? null;
      feature.needUsd = estimate?.features.find((f) => f.featureId === feature.id)?.costUsd ?? null;
    }
    const cost = this.costView(row, settings, plan, runIds, used, accepted, estimate);
    const shares = splitShares(waitingForRun, remaining, cost.remainingUsd);
    for (const [index, feature] of waitingForRun.entries()) Object.assign(feature, shares[index]);
    const measured = estimate ? this.poolForecastOf(row.id, used.tokens, estimate, features) : null;
    const pool = approved
      ? tokenPool({
          initiativeId: row.id,
          limitTokens: limits.maxTotalTokens,
          usedTokens: used.tokens,
          committedTokens: committed.tokens,
          forecastTokens:
            measured?.forecastTokens ??
            (estimate ? Math.max(estimate.expectedTokens, used.tokens) : null),
          ratio: measured?.ratio ?? null,
          features: features.length,
          waiting: waitingNeeds(waitingForRun),
          cost,
        })
      : null;
    const unstarted = waitingForRun.length;
    // The share of the feature that starts next, by the same order the drive starts them in.
    const nextShare =
      (
        this.byPath(
          row,
          waitingForRun.filter((f) => f.state === "ready"),
          this.parallelRuns(settings, plan, facts) > 1,
        )[0] ?? waitingForRun[0]
      )?.share ?? null;
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
      model: settings.model,
      featureAutoApproval: settings.featureAutoApproval,
      parallelRuns: this.parallelRuns(settings, plan, facts),
      criticalPath: plan
        ? criticalPathSummary(plan, row.prompt, this.parallelRuns(settings, plan, facts))
        : null,
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
        cost,
        pool,
        planCharge: charge,
        forecastNotice: pool?.notice ?? null,
        rule: BUDGET_RULE,
      },
      next: { kind: "done", featureId: null, runId: null, message: "" },
      drive: null,
    };
    view.next = this.nextAction(row, view);
    view.drive = initiativeDriveState(view, this.driven(id, runIds));
    return view;
  }

  /**
   * The token pool's measured forecast (`poolForecast`, #2042): each feature's low estimate at its
   * start from its last passing `feature.share_gate` event, and for a feature without a run its
   * current one, with what its runs used.
   */
  private poolForecastOf(
    id: string,
    usedTokens: number,
    estimate: InitiativeEstimate,
    features: FeatureView[],
  ): ReturnType<typeof poolForecast> {
    const started = new Map<string, number>();
    for (const payload of this.store.eventsOfType(id, "feature.share_gate")) {
      const record = payload as ShareGateRecord | null;
      if (record?.verdict === "pass" && record.feature.need)
        started.set(record.featureId, record.feature.need.low);
    }
    return poolForecast(
      usedTokens,
      features.map((f) => {
        const estimated = estimate.features.find((e) => e.featureId === f.id);
        return {
          id: f.id,
          accepted: f.state === "accepted",
          skeleton: (estimated?.skeleton ?? 0) > 0 || (f.skeleton?.length ?? 0) > 0,
          spent: f.usage.tokens,
          low: f.runId === null ? (f.need?.low ?? null) : (started.get(f.id) ?? null),
          expected: estimated?.expectedTokens ?? 0,
        };
      }),
    );
  }

  /**
   * True while a drive of this process advances the initiative, or a live process holds the
   * execution lease of one of its runs (a drive or a resumed run elsewhere).
   */
  private driven(id: string, runIds: readonly string[]): boolean {
    if (this.active.has(id)) return true;
    return executingLeases(this.workflows.store).some(
      (lease) => lease.run_id !== null && runIds.includes(lease.run_id),
    );
  }

  /** The initiative's dollars: spent, held by open runs, and the cap with its forecast. */
  private costView(
    row: InitiativeRow,
    settings: InitiativeSettings,
    plan: InitiativePlan | null,
    runIds: string[],
    used: UsageView,
    accepted: ReadonlySet<string>,
    estimate: InitiativeEstimate | null,
  ): CostView {
    const spentUsd = runIds.reduce((sum, runId) => sum + this.spentUsd(runId), 0);
    const committedUsd = runIds.reduce((sum, runId) => sum + this.committedUsd(runId), 0);
    const budget = settings.costBudget;
    const capUsd = budget?.maxCostUsd ?? null;
    const tolerance = budget
      ? initiativeCostTolerance(budget.costTolerance, plan?.features.length ?? 0)
      : 0;
    // Point forecasts use the stages and models still to run. Tolerance belongs to the ceiling.
    const forecastable =
      capUsd !== null &&
      estimate !== null &&
      accepted.size > 0 &&
      settings.basePolicy.costForecast !== "off" &&
      spentUsd > 0 &&
      used.tokens > 0;
    const left = forecastable ? this.remainingFeatureCost(row, settings, estimate, accepted) : null;
    const round = (n: number): number => Math.round(n * 100) / 100;
    const ceilingUsd = capUsd === null ? null : round(capUsd * (1 + tolerance));
    const forecastUsd = left === null ? null : round(spentUsd + left);
    const measuredFeatures = estimate
      ? estimate.features.filter((f) => accepted.has(f.featureId) && !f.skeleton).length
      : accepted.size;
    const forecastBinding =
      settings.forecastStop === true || measuredFeatures >= FORECAST_BINDING_FEATURES;
    const forecastMode = stopMode(settings.basePolicy, "initiative-forecast");
    const shareMode = stopMode(settings.basePolicy, "initiative-dollar-share");
    const over = forecastUsd !== null && ceilingUsd !== null && forecastUsd > ceilingUsd;
    return {
      capUsd,
      tolerance,
      ceilingUsd,
      spentUsd: round(spentUsd),
      reservedUsd: round(Math.max(0, committedUsd - spentUsd)),
      remainingUsd: capUsd === null ? null : cents(Math.max(0, capUsd - committedUsd)),
      forecastUsd,
      measuredFeatures,
      forecastBinding,
      forecastMode,
      shareMode,
      forecastNotice:
        over && !forecastBinding
          ? `The cost forecast of ${usd(forecastUsd)} is above the ${usd(ceilingUsd)} ceiling. It is advisory until ${FORECAST_BINDING_FEATURES} features are measured (${measuredFeatures} so far): features keep starting while their spent and reserved dollars fit the budget.`
          : over && forecastMode === "advisory"
            ? `The cost forecast of ${usd(forecastUsd)} is above the ${usd(ceilingUsd)} ceiling. The forecast stop is advisory: features keep starting while their spent and reserved dollars fit the budget.`
            : null,
    };
  }

  /** Warn on the proposed revision before approval, including edits to an approved split. */
  private splitApprovalMessage(row: InitiativeRow, view: InitiativeView): string | RecoveryAdvice {
    const plan = this.store.plan(this.store.revision(row.id, row.plan_revision));
    const accepted = new Set(
      view.features
        .filter((f) => {
          const proposed = plan.features.find((p) => p.id === f.id);
          return (
            f.state === "accepted" &&
            proposed &&
            featureDigest(proposed) === this.store.current(row.id, f.id)?.feature_digest
          );
        })
        .map((f) => f.id),
    );
    const estimate = this.estimateOf(row, plan, accepted);
    const tests = estimate.testVolume
      ? `${testVolumeText(
          estimate.testVolume,
          estimate.features.filter((f) => f.basis !== "measured" && f.testCases),
        )} `
      : "";
    const message = `${tests}Approve the split (plan revision ${row.plan_revision}) or edit it.`;
    const needs = this.featureNeeds(estimate);
    const waiting = plan.features
      .filter((f) => {
        const current = this.store.current(row.id, f.id);
        return !accepted.has(f.id) && (!current || current.feature_digest !== featureDigest(f));
      })
      .map((f) => ({ ...f, size: f.size ?? "medium", need: needs.get(f.id) ?? null }));
    const shares = splitShares(waiting, view.budget.remaining, view.budget.cost.remainingUsd);
    let dollarGap = 0;
    const dollarWarnings = waiting.flatMap((f, index) => {
      const low = estimate.features.find((e) => e.featureId === f.id)?.costUsd?.low;
      const share = shares[index]?.shareUsd;
      if (low !== undefined && share != null && share < low) dollarGap += low - share;
      return low !== undefined && share != null && share < low
        ? [
            `Feature ${f.id}'s dollar share (${usd(share)}) is below its low estimate (${usd(low)}). Its cap can grow only into dollars left after the other waiting features' low estimates. Consider extending the dollar budget or trimming the split before approving, or approve with this risk.`,
          ]
        : [];
    });
    // Worded by the expected value and the measured spread: the high end is a bound, and at about
    // twice the low end it made an operator extend a budget the run used 37% of (#1982).
    const limit = estimate.budget.maxTotalTokens;
    // The arithmetic the share gate uses (#2100): R67 ampwhy extended to 38.6M on this warning
    // and used 12.2M; the extension covered the start shares open runs held, not their use.
    const held =
      stopMode(this.store.settings(row).basePolicy, "initiative-plan-charge") === "enforce"
        ? "until its plan is sized"
        : "until the run ends";
    const reservations = ` The share gate holds a started feature's run limit (its start share) against the pool ${held}, not what it uses: an extension to the high end is for those reservations, the ${tokenText(estimate.expectedTokens)} above is what it expects to be used.`;
    const tokenWarning =
      estimate.tokens.high > limit
        ? `The estimate expects about ${tokenText(estimate.expectedTokens)} tokens${estimate.expectedTokens <= limit ? ", within" : ", above"} the shared budget (${tokenText(limit)}); its high end (${tokenText(estimate.tokens.high)} tokens; ${highCalibrationText(estimate.highCalibration)}) exceeds the shared budget.${calibrationLagText(estimate)}${reservations} Consider extending to ${estimate.withMargin} tokens, including margin, before approving, or approve with this risk.`
        : "";
    const warning = [tokenWarning, ...dollarWarnings].filter(Boolean).join(" ");
    if (!warning) return message;
    // The amounts that answer the warnings (#2042): the token estimate with its margin, and a
    // dollar cap raised by what the warned shares miss of their low estimates.
    const capUsd = view.budget.cost.capUsd;
    const suggestedUsd =
      !tokenWarning && dollarGap > 0 && capUsd !== null ? centsUp(capUsd + dollarGap) : null;
    const amount = tokenWarning
      ? ` --tokens ${estimate.withMargin}`
      : ` --budget-usd ${suggestedUsd ?? "N"}`;
    const extend = `Use baked workflow initiative extend ${row.id}${amount} --expected-revision ${row.revision}.`;
    return recoveryAdvice(`${warning} ${extend} ${message}`, `${warning} ${message}`, {
      action: "extend",
      initiativeId: row.id,
      ...(tokenWarning ? { suggestedTokens: estimate.withMargin } : {}),
      ...(suggestedUsd !== null ? { suggestedUsd } : {}),
    });
  }

  private nextAction(row: InitiativeRow, view: InitiativeView): NextAction {
    const action = (
      kind: NextAction["kind"],
      message: string | RecoveryAdvice,
      feature: FeatureView | null = null,
      runId: string | null = feature?.runId ?? null,
    ): NextAction => ({
      kind,
      featureId: feature?.id ?? null,
      runId,
      message: typeof message === "string" ? message : message.message,
      ...(typeof message === "string" ? {} : { recovery: message }),
    });
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
            ? this.splitApprovalMessage(row, view)
            : row.reason || "Edit the split to propose a new revision.",
        );
      case "decomposing": {
        const run = view.decompose;
        if (!run) return action("blocked", "The initiative has no decompose run");
        if (run.status === "completed")
          return action("finish_decompose", "Read the proposed split", null, run.runId);
        if (view.pendingDecisions.some((d) => d.scope === "decompose"))
          return action("decide", "The decompose run waits for a decision", null, run.runId);
        if (run.status === "blocked") {
          const recorded = stopRecovery(this.workflows.store, run.runId);
          return action(
            "blocked",
            recoveryAdvice(
              `The decompose run is blocked (${run.reason}); resolve it with baked workflow resume ${run.runId}`,
              `The decompose run is blocked (${run.reason}).${recorded ? ` ${recorded.summary}` : ""}`,
              ...(recorded?.remedies ?? [{ action: "resume" as const, runId: run.runId }]),
            ),
            null,
            run.runId,
          );
        }
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
    // Inline, one feature run is open at a time: the runtime guards each run's source snapshot, so
    // a second open run's edits would block the first. An open run that waits for a person stops
    // the drive until the decision is made. In worktrees independent features run side by side, and
    // a run that waits for a person stops the drive only when no other feature can move.
    const open = view.features.filter(
      (f) => f.runStatus !== null && !terminalStates.includes(f.runStatus as RunSnapshot["status"]),
    );
    const parallel = view.parallelRuns > 1;
    const running = open.filter((f) => f.state === "in_progress" || f.state === "paused");
    const waits: NextAction[] = [];
    for (const feature of open) {
      if (feature.state === "waiting") continue;
      if (feature.state === "stale")
        return action("rebase", `Rebase ${feature.id} on the changed upstream contract`, feature);
      const wait =
        feature.state === "needs_decision"
          ? action("decide", `Feature ${feature.id} waits for a decision`, feature)
          : feature.state === "blocked"
            ? action(
                "blocked",
                feature.recovery
                  ? {
                      ...feature.recovery,
                      message: `Feature ${feature.id}: ${feature.blockers.join("; ")}`,
                      summary: `Feature ${feature.id}: ${feature.recovery.summary}`,
                    }
                  : `Feature ${feature.id}: ${feature.blockers.join("; ")}`,
                feature,
              )
            : null;
      if (wait && !parallel) return wait;
      if (wait) {
        waits.push(wait);
        continue;
      }
      return action(
        "drive",
        parallel && running.length > 1
          ? `Continue features ${running.map((f) => f.id).join(", ")}`
          : `Continue feature ${feature.id}`,
        feature,
      );
    }
    for (const feature of view.features) {
      if (feature.state === "stale")
        return action("rebase", `Rebase ${feature.id} on the changed upstream contract`, feature);
      if (feature.state !== "ready") continue;
      // Of the ready features, the one with the longest remaining path starts first (#1535).
      const first =
        this.byPath(
          row,
          view.features.filter((f) => f.state === "ready"),
          parallel,
        )[0] ?? feature;
      const shortfall = shareShortfall(view, first);
      if (shortfall) return action("blocked", shortfall, first);
      const over = this.forecastOver(row, view);
      if (over) return action("blocked", over, first);
      return action("start", `Start feature ${first.id}`, first);
    }
    if (waits[0]) return waits[0];
    const missing = view.features.filter((f) => f.mandatory && f.state !== "accepted");
    if (missing.length === 0)
      return action("complete", "Every mandatory feature has an accepted result.");
    const message = missing.map((f) => `${f.id}: ${f.blockers.join("; ") || f.state}`).join(" | ");
    const recovered = missing.filter((f) => f.recovery);
    return action(
      "blocked",
      recovered.length
        ? recoveryAdvice(
            message,
            missing
              .map((f) => `${f.id}: ${f.recovery?.summary ?? (f.blockers.join("; ") || f.state)}`)
              .join(" | "),
            ...recovered.flatMap((f) => f.recovery?.remedies ?? []),
          )
        : message,
    );
  }

  private featureViews(
    row: InitiativeRow,
    plan: InitiativePlan,
    approved: boolean,
    facts: WorkflowFacts,
  ): FeatureView[] {
    const views = new Map<string, FeatureView>();
    const settings = this.store.settings(row);
    const issues = settings.featureIssues;
    // Features whose upstream results could not be merged when they were to start, under the
    // approved split; a new split approval clears them.
    const conflicts = new Map<string, string>();
    for (const payload of this.store.eventsOfType(row.id, "feature.upstream_conflict")) {
      const event = payload as { featureId: string; planRevision: number | null; message: string };
      if (event.planRevision === row.approved_plan_revision)
        conflicts.set(event.featureId, event.message);
    }
    const planAhead = this.planAhead(settings, plan, facts);
    const mergedFrom = new Map<string, string[]>();
    for (const payload of this.store.eventsOfType(row.id, "split.merged"))
      for (const entry of (payload as { merged: { featureId: string; from: string[] }[] }).merged)
        mergedFrom.set(entry.featureId, entry.from);
    for (const feature of topologicalOrder(plan)) {
      const workflowId = featureWorkflowId(settings, feature);
      const runFeature = runFeatureId(row.id, feature.id);
      const runs = this.store.links(row.id).filter((l) => l.feature_id === feature.id);
      const view: FeatureView = {
        id: feature.id,
        title: feature.title,
        mandatory: feature.mandatory,
        dependsOn: feature.dependsOn,
        boundary: feature.boundary,
        skeleton: feature.skeleton ?? [],
        contract: feature.contract,
        workflowId,
        size: feature.size ?? "medium",
        share: null,
        need: null,
        shareUsd: null,
        runFeatureId: runFeature,
        issue: issues[feature.id] ?? null,
        state: "proposed",
        runId: null,
        runStatus: null,
        runReason: null,
        pinned: [],
        contractHash: null,
        blockers: [],
        pendingRequests: [],
        usage: runs.map((l) => this.usage(l.run_id)).reduce(add, zero()),
        spentUsd: Math.round(runs.reduce((sum, l) => sum + this.spentUsd(l.run_id), 0) * 100) / 100,
        runIds: runs.map((l) => l.run_id),
        mergedFrom: mergedFrom.get(feature.id) ?? [],
        ...(feature.serial ? { serial: feature.serial } : {}),
      };
      views.set(feature.id, view);
      if (!approved) continue;
      const upstream = feature.dependsOn.map((d) => views.get(d)).filter((u) => u !== undefined);
      const waiting = upstream
        .filter((u) => u.state !== "accepted")
        .map((u) => `waits for ${u.id}'s contract (${u.id} is ${describe(u)})`);
      const link = this.store.current(row.id, feature.id);
      if (!link) {
        const ahead =
          waiting.length > 0 &&
          planAhead &&
          this.canPlanAhead(settings, plan, feature, upstream, facts);
        view.state = waiting.length && !ahead ? "waiting" : "ready";
        view.blockers = ahead ? [] : waiting;
        if (ahead)
          view.plannedAhead = upstream.filter((u) => u.state !== "accepted").map((u) => u.id);
        const conflict = conflicts.get(feature.id);
        if (view.state === "ready" && conflict) {
          view.state = "blocked";
          view.blockers = [conflict];
        }
        continue;
      }
      const run = this.workflows.store.snapshot(link.run_id);
      const state = this.workflows.store.state(link.run_id);
      view.runId = link.run_id;
      view.runStatus = run.status;
      view.runReason = run.reason;
      view.pinned = state.hostDependencies ?? [];
      // A planned-ahead run waits at its tasks on requests the initiative decides (#1834).
      const ahead = state.planAhead !== null && !state.planAhead.released;
      const held = new Set(
        this.workflows.store
          .requests(link.run_id)
          .filter((r) => r.status === "pending" && isHostRelease(r))
          .map((r) => r.id),
      );
      view.pendingRequests = this.runRequests(link.run_id, "feature", feature.id).filter(
        (r) => !held.has(r.requestId),
      );
      if (ahead)
        view.plannedAhead = upstream.filter((u) => u.state !== "accepted").map((u) => u.id);
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
      // A workflow without a spec gives no contract; nothing depends on such a feature, so its
      // verified result is its acceptance. So does a light run that recorded no contract (#1750).
      const specless =
        (facts(workflowId)?.contract === false && !lightContract(settings, feature, plan)) ||
        !providesContract(this.workflows.store, link.run_id);
      if (run.status === "completed") {
        const accepted = specless ? null : acceptedContract(this.workflows.store, runFeature);
        if (waiting.length) {
          view.state = "waiting";
          view.blockers = [
            ...waiting,
            "the finished result is checked again once the upstream is accepted",
          ];
        } else if (changed.length) {
          view.state = "stale";
          view.blockers = changed;
        } else if (specless) {
          view.state = run.verificationState === "current" ? "accepted" : "stale";
          if (view.state === "stale")
            view.blockers = [`the result's verification is ${run.verificationState}`];
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
      } else if (held.size) {
        // Planned and approved; the drive releases it onto its upstream results once they are all
        // accepted, and its tasks start then.
        view.state = waiting.length ? "waiting" : "in_progress";
        view.blockers = waiting.length
          ? [
              `planned ahead; its tasks start once ${upstream
                .filter((u) => u.state !== "accepted")
                .map((u) => u.id)
                .join(", ")} ${waiting.length > 1 ? "are" : "is"} accepted`,
            ]
          : [];
      } else if (waiting.length && !ahead) {
        view.state = "waiting";
        view.blockers = waiting;
      } else if (run.status === "blocked") {
        if (canRepairRun(run)) view.repairRun = run;
        view.state = "blocked";
        // A provider refusal names its own remedy (credits, a usage limit's reset, a reroute), which
        // a bare reason hides from whoever reads the initiative (#1395).
        const refusal =
          run.reason === "provider_account" || run.reason === "provider_policy"
            ? stopDetail(this.workflows.store, link.run_id)
            : null;
        view.blockers = [
          `run ${link.run_id} is blocked (${run.reason})${refusal ? `: ${refusal.split("\n")[0]?.slice(0, 600)}` : ""}; resolve it with baked workflow ${canRepairRun(run) ? "repair" : "resume"} ${link.run_id}`,
        ];
        const recorded = stopRecovery(this.workflows.store, link.run_id);
        view.recovery = recoveryAdvice(
          view.blockers[0] ?? "",
          `Run ${link.run_id} is blocked (${run.reason}).${recorded ? ` ${recorded.summary}` : ""}`,
          ...(recorded?.remedies ?? [{ action: "resume" as const, runId: link.run_id }]),
        );
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

  /** Resolve the same routed stages for dollar reserves and the point forecast. */
  private plannedFeatureStages(settings: InitiativeSettings, workflowId: string): PlannedStage[] {
    const workspace = this.workflows.workspace;
    const policy = settings.basePolicy;
    const model = settings.model ?? this.workflows.config.defaultModel;
    if (!model) return [];
    const config = explicitModelConfig(this.workflows.config, model);
    const loaded = loadDefinition(workspace, workflowId, policy);
    const registry = routedProfiles(workspace, config, model);
    const gates = loadGateLibrary(workspace, policy).gates;
    const routing = reviewIndependence(
      config,
      routingRecord(
        config,
        registry,
        model,
        workflowId,
        loaded.definition.stages.map((s) => s.id),
        undefined,
      ),
      loaded.definition,
      policy,
      gates,
      registry.list().map((p) => p.profile),
      availableVendorModels(
        (getCachedProviderStatuses() ?? []).filter((p) => p.available).map((p) => p.id),
      ),
    );
    if (routing.refuse) return [];
    return plannedStages({ loaded, policy, routing: routing.record, gates: [...gates.values()] });
  }

  /**
   * Dollar ranges use routed model prices, never the dollars allocated per token. Each stage is
   * priced at its own rate and weighted by the tokens it takes: once a feature on the same workflow
   * is accepted, by the stage mix its runs measured, else by the history's. Bench round 59
   * (wheeltags) priced its features at $0.97 per million tokens at the split, from the history's
   * long cache-heavy task loops. Its accepted features paid $1.95, with short task loops and
   * uncached planning calls; their own stage rates at the history's weights then said $2.67, so
   * the waiting features reserved too much and pick-command started with $2.87 to grow into, one
   * corrective short. Their own mix says $1.97, and pick-command $4.51 (#1890).
   */
  private priceFeatureNeeds(
    row: InitiativeRow,
    estimate: InitiativeEstimate,
    history: PastRun[],
    accepted: ReadonlySet<string>,
  ): void {
    const settings = this.store.settings(row);
    if (!settings.costBudget) return;
    const mixes = this.measuredStageMix(row, estimate, accepted);
    const samples = this.priceSamples(
      this.workflows.store,
      this.store.links(row.id).map((l) => l.run_id),
      history,
      historyStorePaths(this.workflows.workspace, settings.basePolicy),
    );
    const planned = new Map<string, PlannedStage[]>();
    for (const feature of estimate.features) {
      if (!planned.has(feature.workflowId))
        planned.set(feature.workflowId, this.plannedFeatureStages(settings, feature.workflowId));
      const stages = planned.get(feature.workflowId) ?? [];
      if (!stages.length) continue;
      const priced = estimatePreRun({
        history,
        workflowId: feature.workflowId,
        stages,
        maxTotalTokens: 0,
        price: () => null,
      });
      const weights = stageWeights(priced.stages, feature.size, mixes.get(feature.workflowId));
      const total = weights.reduce((sum, s) => sum + s.tokens, 0);
      const rate =
        total > 0
          ? forecastStageCost(
              samples,
              weights.map((s) => ({ ...s, tokens: s.tokens / total })),
            )
          : null;
      feature.costUsd =
        rate === null ? null : { low: feature.tokens.low * rate, high: feature.tokens.high * rate };
    }
  }

  /**
   * The tokens each stage took in the accepted features' runs, by workflow: their finished
   * attempts, superseded runs included. Skeleton features are left out, since the host wrote their
   * tasks. A workflow without such a feature has no entry.
   */
  private measuredStageMix(
    row: InitiativeRow,
    estimate: InitiativeEstimate,
    accepted: ReadonlySet<string>,
  ): Map<string, Map<string, number>> {
    const measured = new Map(
      estimate.features
        .filter((f) => accepted.has(f.featureId) && !f.skeleton)
        .map((f) => [f.featureId, f.workflowId]),
    );
    const mixes = new Map<string, Map<string, number>>();
    for (const link of this.store.links(row.id)) {
      const workflowId = measured.get(link.feature_id);
      if (workflowId === undefined) continue;
      const mix = mixes.get(workflowId) ?? new Map<string, number>();
      for (const a of forecastSamples(this.workflows.store, [link.run_id])) {
        if (a.status === "running" || !a.usedTokens) continue;
        mix.set(a.stage, (mix.get(a.stage) ?? 0) + a.usedTokens);
      }
      mixes.set(workflowId, mix);
    }
    return mixes;
  }

  /** Price unaccepted features' remaining point tokens with their remaining workflow stages. */
  private remainingFeatureCost(
    row: InitiativeRow,
    settings: InitiativeSettings,
    estimate: InitiativeEstimate,
    accepted: ReadonlySet<string>,
  ): number | null {
    const store = this.workflows.store;
    const links = this.store.links(row.id);
    const history = estimateHistory(store, this.workflows.workspace, settings.basePolicy);
    const samples = this.priceSamples(
      store,
      links.map((l) => l.run_id),
      history,
      historyStorePaths(this.workflows.workspace, settings.basePolicy),
    );
    const planned = new Map<string, PlannedStage[]>();
    // The stage mix the accepted features measured, as the waiting features' dollars use (#1890).
    const mixes = this.measuredStageMix(row, estimate, accepted);
    let usd = 0;
    for (const feature of estimate.features) {
      if (accepted.has(feature.featureId)) continue;
      const left = Math.max(0, feature.expectedTokens - feature.spent);
      if (!left) continue;
      const runId = links.filter((l) => l.feature_id === feature.featureId).at(-1)?.run_id;
      let stages: PlannedStage[];
      if (runId) {
        const policy = PolicySchema.parse(JSON.parse(store.run(runId).policy_json));
        stages = runForecastStages(store, runId, policy);
      } else {
        if (!planned.has(feature.workflowId)) {
          planned.set(feature.workflowId, this.plannedFeatureStages(settings, feature.workflowId));
        }
        stages = planned.get(feature.workflowId) ?? [];
      }
      if (!stages.length) return null;
      const priced = estimatePreRun({
        history,
        workflowId: feature.workflowId,
        stages,
        maxTotalTokens: 0,
        price: () => null,
      });
      const weights = stageWeights(priced.stages, feature.size, mixes.get(feature.workflowId));
      const total = weights.reduce((sum, s) => sum + s.tokens, 0);
      const own = runId ? forecastSamples(store, [runId]) : [];
      const latest = new Map(
        (runId ? store.steps(runId) : [])
          .filter((s) => !s.parent_step_id)
          .map((s) => [s.stage_id, s.status]),
      );
      for (const stage of weights) {
        const spent = own
          .filter((a) => a.stage === stage.id)
          .reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
        stage.tokens =
          latest.get(stage.id) === "completed" || latest.get(stage.id) === "skipped"
            ? 0
            : Math.max(
                0,
                (total > 0 ? (stage.tokens / total) * feature.expectedTokens : 0) - spent,
              );
      }
      const remaining = weights.reduce((sum, s) => sum + s.tokens, 0);
      if (remaining === 0) continue;
      const cost = forecastStageCost(
        samples,
        weights.map((s) => ({
          ...s,
          tokens: (s.tokens / remaining) * left,
        })),
      );
      if (cost === null) return null;
      usd += cost;
    }
    return usd;
  }

  /** The dollars a run spent. */
  private spentUsd(runId: string): number {
    return this.workflows.store.costUsage(runId).spentUsd;
  }

  /** The dollars a run takes from the dollar budget: its spending, or its cap while open. */
  private committedUsd(runId: string): number {
    const run = this.workflows.store.run(runId);
    const { spentUsd, reservedUsd } = this.workflows.store.costUsage(runId);
    if (terminalStates.includes(run.status)) return spentUsd;
    const cap = PolicySchema.parse(JSON.parse(run.policy_json)).maxCostUsd ?? 0;
    return Math.max(spentUsd + reservedUsd, cap);
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

  /**
   * The plan charge of the initiative's open feature runs whose latest plan sizing priced them
   * (#2100, #2056), at the plan-to-actual ratio the estimate measured; null without one.
   * `limitCommitted` is the pool's committed tokens with every open run at its limit.
   */
  private planChargeOf(
    id: string,
    settings: InitiativeSettings,
    estimate: InitiativeEstimate,
    limitCommitted: number,
  ): PlanChargeView | null {
    const runs = this.store.links(id).flatMap((link) => {
      const run = this.workflows.store.run(link.run_id);
      if (terminalStates.includes(run.status)) return [];
      const plan = plannedRunTokens(this.workflows.store, link.run_id);
      if (!plan) return [];
      const limit = limitsOf(PolicySchema.parse(JSON.parse(run.policy_json))).maxTotalTokens;
      return [
        {
          featureId: link.feature_id,
          runId: link.run_id,
          usedTokens: this.usage(link.run_id).tokens,
          limitTokens: limit,
          plan,
        },
      ];
    });
    return planCharge(
      stopMode(settings.basePolicy, "initiative-plan-charge"),
      estimate.planCalibration.ratio,
      limitCommitted,
      runs,
    );
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

  /**
   * The contracts a feature run pins: each upstream feature's accepted contract, or, for the
   * `unfinished` upstream features of a feature that plans ahead (#1834), their approved spec.
   */
  private upstreamContracts(
    id: string,
    feature: InitiativeFeature,
    unfinished: readonly string[] = [],
  ): { feature: { id: string }; contract: AcceptedContract }[] {
    return feature.dependsOn.map((dependency) => {
      const contract = acceptedContract(this.workflows.store, runFeatureId(id, dependency));
      if (!contract || (!contract.completed && !unfinished.includes(dependency)))
        throw new WorkflowFault("INVALID_REFERENCE", `No accepted contract of ${dependency} yet`);
      return { feature: { id: dependency }, contract };
    });
  }

  /** Open runs a reroute moves: the decompose run and current feature runs, superseded excluded. */
  private currentRuns(id: string): { featureId: string | null; runId: string }[] {
    const row = this.store.get(id);
    return [
      ...(row.decompose_run_id ? [{ featureId: null, runId: row.decompose_run_id }] : []),
      ...this.store
        .links(id)
        .filter((l) => l.superseded_at === null)
        .map((l) => ({ featureId: l.feature_id, runId: l.run_id })),
    ].filter((r) => !terminalStates.includes(this.workflows.store.run(r.runId).status));
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
    proposed: InitiativePlan,
    source: "decomposer" | "user",
    edit: SplitEdit | null,
  ): void {
    const row = this.store.get(id);
    const settings = this.store.settings(row);
    // Features that may write a common file run one after the other (#1336).
    const withRuns = new Set(
      proposed.features.filter((f) => this.store.current(id, f.id)).map((f) => f.id),
    );
    const choices = this.workflowChoices(settings);
    const noContract = new Set(
      proposed.features
        .filter((f) => !choices.find((c) => c.id === featureWorkflowId(settings, f))?.contract)
        .map((f) => f.id),
    );
    // Documentation follows the code it describes (#1751).
    const documented = sequenceDocumentation(proposed, withRuns);
    const sequenced = sequenceSharedPaths(documented.plan, withRuns, noContract);
    // A light feature that still gained a dependent writes a spec after all (#1406).
    const repaired = restoreContractWorkflows(sequenced.plan, choices, settings.workflowId);
    const plan = repaired.plan;
    const budget = planBudget(settings, plan);
    const revision = row.plan_revision + 1;
    const digest = splitDigest(id, revision, plan, budget, settings);
    for (const request of this.store.requests(id).filter((r) => r.status === "pending"))
      this.store.decide(id, request.id, "superseded", { planRevision: revision });
    this.store.addRevision(id, plan, budget, digest, source, edit);
    if (sequenced.added.length || documented.added.length || repaired.restored.length)
      this.store.emit(id, "split.sequenced", {
        planRevision: revision,
        added: sequenced.added,
        ...(documented.added.length ? { documented: documented.added } : {}),
        ...(repaired.restored.length ? { restored: repaired.restored } : {}),
      });
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

type WorkflowFacts = (workflowId: string) => FeatureWorkflow | null;

/** Finished feature runs of every initiative in a store, with the size their plan gave them. */
function featureRunSamples(
  initiatives: InitiativeStore,
  runStore: WorkflowStore,
  history: PastRun[],
  source: "project" | "shared" = "project",
  /** Names the store, so initiative ids of two stores stay apart. */
  scope = "",
): FeatureRunSample[] {
  const runs = new Map(history.map((run) => [run.runId, run]));
  return initiatives.list().flatMap((row) => {
    const settings = initiatives.settings(row);
    const plans = new Map<
      number,
      { plan: InitiativePlan; counts: ReturnType<typeof boundaryPathCounts> }
    >();
    return initiatives.links(row.id).flatMap((link) => {
      const run = runs.get(link.run_id);
      if (run?.status !== "completed") return [];
      if (!plans.has(link.plan_revision)) {
        const plan = initiatives.plan(initiatives.revision(row.id, link.plan_revision));
        plans.set(link.plan_revision, { plan, counts: boundaryPathCounts(plan, row.prompt) });
      }
      const revision = plans.get(link.plan_revision);
      const feature = revision?.plan.features.find((f) => f.id === link.feature_id);
      if (!feature) return [];
      return [
        {
          runId: run.runId,
          // Measures how far a feature lands above the floor the other initiatives set (#1982).
          initiativeId: `${scope}#${row.id}`,
          workflowId: featureWorkflowId(settings, feature),
          size: feature.size ?? "medium",
          tokens: run.tokens,
          taskCount: run.taskCount,
          activeMs: run.activeMs,
          criteria: runStore.state(run.runId).spec?.criteria.length,
          // A stub it created for a later feature counts at its share, not as a path (#1464).
          ...revision?.counts.get(feature.id),
          ...(source === "shared" ? { source } : {}),
          startedAt: link.created_at,
        },
      ];
    });
  });
}

/** Samples read from each shared store, until the store's files change. */
const sharedSamples = new Map<string, { stamp: string; samples: FeatureRunSample[] }>();

/**
 * Finished feature runs of the initiatives in the stores of `sizing.historyStores`, read only. A
 * project's first initiative has no finished features of its own, so without these the path rate
 * of #1354 could not floor the estimate shown at the split approval (bench round 37, #1376). A
 * store that is missing, unreadable or of another schema gives none.
 */
function sharedFeatureRunSamples(paths: string[], history: PastRun[]): FeatureRunSample[] {
  return paths.flatMap((path) => {
    const parent = dirname(path);
    if (basename(path) !== "workflows.sqlite" || basename(parent) !== ".baked") return [];
    // A WAL database changes its -wal file first.
    const stamp = [path, `${path}-wal`]
      .map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0))
      .join("/");
    const cached = sharedSamples.get(path);
    if (cached?.stamp === stamp) return cached.samples;
    let store: WorkflowStore | null = null;
    let samples: FeatureRunSample[] = [];
    try {
      if (existsSync(path)) {
        store = new WorkflowStore(dirname(parent), true);
        samples = featureRunSamples(new InitiativeStore(store), store, history, "shared", path);
      }
    } catch {
      samples = [];
    } finally {
      store?.close();
    }
    sharedSamples.set(path, { stamp, samples });
    return samples;
  });
}

/** The workflow a feature's runs use: its own, or the initiative's default. */
const featureWorkflowId = (settings: InitiativeSettings, feature: InitiativeFeature): string =>
  feature.workflow ?? settings.workflowId;

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
 * whose allowed paths are the feature's approved boundary, including an edit of a package
 * manifest the boundary names, and limits at least as large as the boundary's files
 * (`boundaryLimits`). A feature without boundary paths and every rebased run (`humanOnly`) go to a
 * person.
 */
export function featurePolicy(
  settings: InitiativeSettings,
  share: UsageView | typeof MIN_SHARE,
  feature: InitiativeFeature,
  humanOnly: boolean,
  growTo: number | null = null,
  shareUsd: number | null = null,
  growUsd: number | null = null,
  forecastBinding = false,
): RunPolicy {
  const tokens = "tokens" in share ? share.tokens : share.maxTotalTokens;
  const calls = "calls" in share ? share.calls : share.maxAgentCalls;
  const ms = "activeMs" in share ? share.activeMs : share.maxActiveMs;
  const base = settings.basePolicy;
  const maxTotalTokens = Math.max(MIN_SHARE.maxTotalTokens, tokens);
  const auto = settings.featureAutoApproval;
  const limits =
    auto && !humanOnly
      ? HostAutoApprovalSchema.safeParse({
          enabled: true,
          ...boundaryLimits(auto, feature.boundary.paths),
          allowedPaths: feature.boundary.paths,
          allowDelete: false,
          allowNewDependencies: false,
          maxTotalTokens,
        })
      : null;
  const cost = costPolicy(settings, shareUsd, forecastBinding);
  const grown = growTo !== null ? grownSizing(base, maxTotalTokens, growTo) : base.sizing;
  // The dollar cap grows for tokens, forecasts or calls, up to what the initiative can spare. The
  // base policy's own cap does not bound it: the initiative's dollar budget does (#1503).
  const costTo =
    cost.maxCostUsd !== undefined && cost.maxCostUsd !== null && growUsd !== null
      ? cents(growUsd)
      : null;
  // Set without a token ceiling too: the cost forecast grows the cap toward it (#1503).
  const sizing =
    costTo !== null ? { ...grown, maxRunCostUsd: Math.max(cost.maxCostUsd ?? 0, costTo) } : grown;
  return PolicySchema.parse({
    ...base,
    maxTotalTokens,
    ...(sizing !== base.sizing ? { sizing } : {}),
    maxAgentCalls: Math.min(1000, Math.max(MIN_SHARE.maxAgentCalls, calls)),
    maxActiveMs: Math.max(MIN_SHARE.maxActiveMs, ms),
    // A manifest the boundary names was approved with the split, and the feature request lists
    // the boundary's paths, so editing it is a requested manifest edit (#1328).
    autoApproval: limits?.success
      ? { ...autoApprovalPolicy(limits.data), requestedManifestEdits: true }
      : null,
    ...cost,
  });
}

/**
 * Why a feature run under tiered approval got no auto approval, or null when it has one or the
 * initiative has tiered approval off. The approval request shows it, so a person who is asked
 * knows why the initiative did not approve on its own (#1467).
 */
export function featureApprovalDeclined(
  settings: InitiativeSettings,
  feature: InitiativeFeature,
  humanOnly: boolean,
  policy: RunPolicy,
): string | null {
  if (!settings.featureAutoApproval || policy.autoApproval) return null;
  if (humanOnly)
    return `Feature ${feature.id} was rebased onto new upstream results, so a person approves its plan again; tiered approval covers only the feature's first run.`;
  if (!feature.boundary.paths.length)
    return `The approved split names no boundary paths for feature ${feature.id}, so tiered approval has no paths to allow and a person approves its plan.`;
  return `Feature ${feature.id}'s boundary (${feature.boundary.paths.length} paths) is outside what tiered approval accepts, so a person approves its plan.`;
}

/**
 * The tiered limits of a feature run: the initiative's limits, raised to the files the approved
 * boundary names, with one task per file and two spare. The person approved those paths with the
 * split, so a plan that writes them is not larger than what was approved; a boundary of 11 files
 * could never pass a 10-file limit (narrowfit language and cli, #1349). A glob names any number of
 * files the person approved with it, so a boundary with a glob takes the host's ceiling: the
 * allowed paths still keep every write inside the boundary. fecsmith front (`commands/*Command.java`
 * and three files) planned 19 files against a 14-file limit and waited for a person (#1504).
 */
export function boundaryLimits(
  auto: { maxTasks: number; maxFiles: number },
  paths: readonly string[],
): { maxTasks: number; maxFiles: number } {
  if (paths.some(isGlobPath)) return { ...HOST_AUTO_APPROVAL_CEILING };
  const files = paths.length;
  if (!files) return { maxTasks: auto.maxTasks, maxFiles: auto.maxFiles };
  return {
    maxTasks: Math.max(auto.maxTasks, Math.min(HOST_AUTO_APPROVAL_CEILING.maxTasks, files + 2)),
    maxFiles: Math.max(auto.maxFiles, Math.min(HOST_AUTO_APPROVAL_CEILING.maxFiles, files)),
  };
}

/**
 * The dollar cap of a feature run under a dollar budget: its share, with the initiative's
 * tolerance. The base policy's own cap is the cap of a run outside a dollar budget; under one, a
 * feature's tokens come from the shared pool, and so do its dollars. Clipped to the base cap, a
 * feature with a $9.80 share and $19 to grow into had $8 whatever it needed: bench round 42
 * (fecsmith front) stopped on its forecast with $21 of the initiative's $30 unspent (#1503).
 * Without a budget the base policy stays as it is.
 */
function costPolicy(
  settings: InitiativeSettings,
  shareUsd: number | null,
  forecastBinding: boolean,
): Pick<RunPolicy, "maxCostUsd" | "costTolerance" | "costForecast"> | Record<string, never> {
  const budget = settings.costBudget;
  if (!budget || shareUsd === null) return {};
  return {
    maxCostUsd: Math.max(MIN_SHARE_USD, cents(shareUsd)),
    costTolerance: budget.costTolerance,
    // The feature's cap and the initiative's spare dollars bound its money; until the
    // initiative's forecast is binding, the run's own forecast only advises (#1659).
    ...(forecastBinding || settings.basePolicy.costForecast === "off"
      ? {}
      : { costForecast: "advise" as const }),
  };
}

/**
 * The host's pool extension for a feature the share gate parks (#2042), or null when the park is
 * not on tokens (a dollar block, or calls or time exhausted) or the view has no pool. A token
 * block is one whose `extend` remedy suggests tokens.
 */
export function poolGrowthOf(
  view: ShareGateView,
  feature: Pick<FeatureView, "id" | "share" | "need" | "shareUsd"> &
    Partial<Pick<FeatureView, "needUsd">>,
  limitTokens?: number,
): PoolExtension | null {
  const inputs = shareGatePool(view, limitTokens);
  if (!inputs) return null;
  const pooled: ShareGateView = {
    ...view,
    budget: { ...view.budget, limits: { ...ZERO_LIMITS, maxTotalTokens: inputs.limitTokens } },
  };
  const advice = shareShortfall(pooled, feature);
  if (!advice?.remedies.some((r) => r.suggestedTokens !== undefined)) return null;
  return poolExtensionDecision(inputs);
}
const ZERO_LIMITS = { maxTotalTokens: 0, maxAgentCalls: 0, maxActiveMs: 0 };

/**
 * What a starting feature may grow its run budget to: the shared budget that remains less the low
 * end of the estimate of every other feature still waiting for a run. Without it a run grew from
 * its share to its own planning floor and sizing ceiling and held that, so the features after it
 * started on what was left (#1311). Null when no feature has an estimate.
 */
export function growthLimit(
  view: Pick<ShareGateView, "budget" | "features">,
  featureId: string,
): number | null {
  const waiting = view.features.filter((f) => f.share !== null);
  if (!waiting.some((f) => f.need)) return null;
  const reserve = waiting
    .filter((f) => f.id !== featureId)
    .reduce((sum, f) => sum + (f.need?.low ?? 0), 0);
  return Math.max(0, view.budget.remaining.tokens - reserve);
}

/**
 * The base policy's sizing with its ceiling and hard ceiling held to `growTo` (never below the
 * share). A base policy without a ceiling never grows, so it is left as it is.
 */
function grownSizing(base: RunPolicy, share: number, growTo: number): RunPolicy["sizing"] {
  const ceiling = base.sizing?.maxRunTokens;
  if (ceiling === undefined || ceiling === null) return base.sizing;
  const limit = Math.max(MIN_GROWTH_TOKENS, share, growTo);
  const hard = extendToOf(base);
  return {
    ...base.sizing,
    maxRunTokens: Math.min(ceiling, limit),
    ...(hard !== null ? { extendToTokens: Math.min(hard, limit) } : {}),
  };
}
/** The smallest sizing ceiling a policy accepts. */
const MIN_GROWTH_TOKENS = 10_000;

const lightContracts = (settings: InitiativeSettings): boolean =>
  settings.lightContracts || settings.basePolicy.lightContracts === "on";

/**
 * A feature on the light workflow while `lightContracts` is on: its run records its host-made spec
 * as the contract (#1664). Every such feature records one, dependents or not, because the setting
 * counts the light workflow as one that provides a contract, so status reads one for each, and a
 * replan or an extension can give it a dependent after it ran (#1750). With the setting off, a
 * light feature whose every dependent is a documentation feature records one as well (#1768).
 */
function lightContract(
  settings: InitiativeSettings,
  feature: InitiativeFeature,
  plan: InitiativePlan,
): boolean {
  if (featureWorkflowId(settings, feature) !== LIGHT_LEAF_WORKFLOW) return false;
  // A light feature only documentation depends on records one too, with the setting off (#1768).
  return lightContracts(settings) || documentedLightLeaf(plan, feature);
}

/**
 * What a feature's run does with its skeleton, from the plan it starts on: the content of every
 * stub, quoted, since the spec author was told the split fixes it but not what it is and wrote
 * another wording into a criterion (bench round 57, modeplan foundation: 407k tokens and 8.8
 * minutes of a second planning round; R56 hdrlens base the same, #1847); the stubs the feature
 * implements; and the stubs later features fill, named with them (#1829). A stub another feature's
 * glob covers counts as filled by it, and the feature may still write a stub its own scope needs.
 */
function skeletonLines(plan: InitiativePlan, feature: InitiativeFeature): string[] {
  const fates = stubFates(plan, feature);
  const own = fates.filter((f) => f.own);
  const later = fates.filter((f) => f.fillers.length);
  return [
    "The split fixes the whole content of these files: one task writes them as host-written files with exactly that content (extra.hostFiles; whitespace may follow the project's formatter). Quote the content exactly wherever a requirement, criterion, plan or test names it; never reword it or ask what it is:",
    ...fates.map((f) => `- ${f.path}: ${JSON.stringify(f.content)}`),
    ...(own.length ? [`This feature implements ${own.map((f) => f.path).join(", ")}.`] : []),
    ...(later.length
      ? [
          `Later features write ${later.map((f) => `${f.path} (${f.fillers.join(", ")})`).join(", ")}: leave those stubs as written${own.length ? ", except the ones this feature implements" : ""}.`,
        ]
      : []),
  ];
}

/** The request a feature run starts from: its place in the initiative and the contracts around it. */
export function featurePrompt(
  row: InitiativeRow,
  plan: InitiativePlan,
  feature: InitiativeFeature,
  upstream: { feature: { id: string }; contract: AcceptedContract }[],
): string {
  const others = plan.features.filter((f) => f.id !== feature.id);
  // A goal that counts spec criteria is a rule for writing specs, which no feature run can
  // enforce across the initiative; as a goal it became a criterion of every feature (#1310).
  const rules = plan.goals.filter(specWritingRule);
  const goals = plan.goals.filter((g) => !specWritingRule(g));
  const lines = [
    `This run implements feature ${feature.id} ("${feature.title}") of the initiative ${row.id} ("${plan.title}").`,
    "",
    "Initiative goals:",
    ...goals.map((g) => `- ${g}`),
    ...(rules.length
      ? [
          "",
          "Rules for writing this feature's specification. They are not product goals: follow them while writing the spec, never turn them into a requirement or acceptance criterion, and never change another feature's accepted specification to meet them:",
          ...rules.map((g) => `- ${g}`),
        ]
      : []),
    "",
    `Boundary of this feature: ${feature.boundary.scope}`,
    feature.boundary.paths.length
      ? `Paths this feature may write: ${feature.boundary.paths.join(", ")}`
      : "The split names no paths for this feature; stay within the boundary above.",
    `Contract this feature provides to the features that depend on it: ${feature.contract}`,
    ...(feature.skeleton?.length ? skeletonLines(plan, feature) : []),
  ];
  for (const { feature: dependency, contract } of upstream) {
    const definition = plan.features.find((f) => f.id === dependency.id);
    lines.push(
      definition?.workflow === LIGHT_LEAF_WORKFLOW
        ? `Upstream feature ${dependency.id} provides: ${definition.contract} It ran the light workflow, so this contract is its whole accepted specification (contract hash ${contract.contractHash}); read its code for the details.`
        : `Upstream feature ${dependency.id} provides: ${definition?.contract ?? ""} Its accepted specification is specs/${contract.featureId}/spec.json (contract hash ${contract.contractHash}).`,
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

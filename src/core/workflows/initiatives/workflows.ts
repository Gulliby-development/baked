/**
 * Which workflow each feature of an initiative runs. A feature names its own workflow, chosen by
 * the decomposer or by a person on the split, and otherwise gets the one `proposeWorkflow`
 * proposes for its text. Only workflows that write files can run a feature, and a feature other
 * features depend on needs one that produces a spec: its accepted spec is the contract they pin.
 */
import { assessRequest, proposeWorkflow } from "../preset-router.js";
import { executionModeOf, type RunPolicy } from "../schemas.js";
import { asV2, listDefinitions, loadDefinition } from "../v2/definitions.js";
import {
  type InitiativeFeature,
  type InitiativePlan,
  isDocumentationFeature,
  literalPathCount,
  MIN_FEATURE_PATHS,
} from "./plan.js";

/** What the initiative needs to know about a workflow to run a feature with it. */
export interface FeatureWorkflow {
  id: string;
  description: string;
  schemaVersion: 1 | 2;
  /** It produces a spec, so features may depend on its result. */
  contract: boolean;
  execution: "inline" | "worktree";
  /** Its stages, for estimates. */
  stages: { id: string; type: string }[];
}

/** Facts of one workflow, or null when it is unknown or does not parse. */
export function featureWorkflow(
  workspace: string,
  policy: RunPolicy,
  id: string,
): FeatureWorkflow | null {
  try {
    const loaded = loadDefinition(workspace, id, policy);
    const v2 = asV2(loaded, policy);
    return {
      id,
      description: v2.description,
      schemaVersion: loaded.schemaVersion,
      contract: v2.stages.some((s) => s.produces === "spec"),
      execution:
        (loaded.schemaVersion === 2 ? loaded.definition.execution : undefined) ??
        executionModeOf(policy),
      stages: v2.stages.map((s) => ({ id: s.id, type: s.type })),
    };
  } catch {
    return null;
  }
}

/**
 * The workflows a feature can run: they start without problems and write files. With tiered
 * approval only schema 1 workflows qualify, since a v2 definition owns its own auto approval,
 * and the shipped light preset, whose plan approval the run binds to the feature's boundary
 * limits (`boundaryAutoApproval`, #1374).
 */
export function featureWorkflowChoices(
  workspace: string,
  policy: RunPolicy,
  options: { tiered: boolean; lightContracts?: boolean },
): FeatureWorkflow[] {
  return listDefinitions(workspace, policy)
    .filter((d) => !d.problems.length && d.writes)
    .filter((d) => !options.tiered || d.schemaVersion === 1 || tieredPreset(d))
    .map((d) =>
      withLightContract(featureWorkflow(workspace, policy, d.id), options.lightContracts === true),
    )
    .filter((w): w is FeatureWorkflow => w !== null);
}

/**
 * The light workflow counted as one that provides a contract when the initiative lets it (#1664):
 * its run records a host-made spec that states the feature's contract, and dependents pin that.
 */
export function withLightContract(
  workflow: FeatureWorkflow | null,
  lightContracts: boolean,
): FeatureWorkflow | null {
  return workflow && lightContracts && workflow.id === LIGHT_LEAF_WORKFLOW && !workflow.contract
    ? { ...workflow, contract: true }
    : workflow;
}

const tieredPreset = (d: { id: string; source: "builtin" | "project"; schemaVersion: 1 | 2 }) =>
  d.schemaVersion === 2 && d.source === "builtin" && d.id === LIGHT_LEAF_WORKFLOW;

const hasDependents = (plan: InitiativePlan, feature: InitiativeFeature): boolean =>
  plan.features.some((f) => f.dependsOn.includes(feature.id));

/**
 * A light feature whose every dependent is a documentation feature (#1768): the host orders docs
 * after the last code feature of each chain (#1751), and a docs feature reads code, not a spec. So
 * the feature keeps `LIGHT_LEAF_WORKFLOW` and its run records its host-made spec as the contract
 * the docs feature pins, as under `lightContracts` (#1664), instead of moving to a spec workflow.
 */
export function documentedLightLeaf(plan: InitiativePlan, feature: InitiativeFeature): boolean {
  const dependents = plan.features.filter((f) => f.dependsOn.includes(feature.id));
  return (
    (feature.workflow ?? null) === LIGHT_LEAF_WORKFLOW &&
    dependents.length > 0 &&
    dependents.every(isDocumentationFeature)
  );
}

/** Why `workflowId` cannot run `feature` of `plan`, or null when it can. */
export function featureWorkflowProblem(
  plan: InitiativePlan,
  feature: InitiativeFeature,
  workflowId: string,
  choices: readonly FeatureWorkflow[],
): string | null {
  const choice = choices.find((c) => c.id === workflowId);
  if (!choice)
    return `${feature.id}: workflow ${workflowId} cannot run a feature here; use one of ${choices.map((c) => c.id).join(", ") || "none"}`;
  if (
    !choice.contract &&
    hasDependents(plan, feature) &&
    !documentedLightLeaf(plan, { ...feature, workflow: workflowId })
  )
    return `${feature.id}: other features depend on it, so it needs a workflow that writes a spec (${
      choices
        .filter((c) => c.contract)
        .map((c) => c.id)
        .join(", ") || "none"
    }), not ${workflowId}`;
  return null;
}

/** Problems of the workflows a plan names; features without one are not checked. */
export function planWorkflowProblems(
  plan: InitiativePlan,
  choices: readonly FeatureWorkflow[],
): string[] {
  return plan.features.flatMap((f) => {
    const problem = f.workflow ? featureWorkflowProblem(plan, f, f.workflow, choices) : null;
    return problem ? [problem] : [];
  });
}

const featureText = (f: InitiativeFeature): string =>
  `${f.title}. ${f.boundary.scope} ${f.contract}`;

/**
 * The plan with a workflow and a size on every feature. A feature without a workflow, or (with
 * `replaceInvalid`, for a decomposer's split) with one that cannot run it, gets the proposal for
 * its text among the workflows that can; a feature other features depend on only gets one that
 * writes a spec, and a risky one keeps `defaultWorkflow`. When no proposal fits, `defaultWorkflow`.
 * A feature without a size gets the size `assessRequest` gives its text. Features in `keep` are
 * left as they are.
 */
export function assignFeatureWorkflows(
  plan: InitiativePlan,
  choices: readonly FeatureWorkflow[],
  defaultWorkflow: string,
  options: { replaceInvalid: boolean; keep?: ReadonlySet<string> },
): InitiativePlan {
  const features = plan.features.map((feature) => {
    // A feature of an earlier revision keeps what it had, so its run is not superseded.
    if (options.keep?.has(feature.id)) return feature;
    const named = feature.workflow;
    const keep =
      named && (!options.replaceInvalid || !featureWorkflowProblem(plan, feature, named, choices));
    const fitting = choices
      .filter((c) => c.contract || !hasDependents(plan, feature))
      .map((c) => c.id);
    const text = featureText(feature);
    const proposal = proposeWorkflow(text, fitting, defaultWorkflow);
    const assessment = assessRequest(text, proposal);
    // A risky change keeps the thorough default even when its text reads small.
    const light = !choices.find((c) => c.id === proposal.workflowId)?.contract;
    const proposed =
      assessment.risk === "high" && light && fitting.includes(defaultWorkflow)
        ? defaultWorkflow
        : proposal.workflowId;
    return {
      ...feature,
      workflow: keep ? named : proposed,
      size: feature.size ?? assessment.size,
    };
  });
  return { ...plan, features };
}

/**
 * A path whose change stays on a thorough workflow even in a small leaf: migrations, auth,
 * secrets, CI and deployment, data schemas, payments. Judged by the files a leaf writes, not its
 * words: ranktally's `release` leaf (README, LICENSE, a test) reads as risky by its name alone
 * (bench round 37, #1374).
 */
const RISKY_PATH =
  /(^|[/._-])(migrations?|auth\w*|security|secrets?|credentials?|\.github|deploy\w*|dockerfile|schema\w*|database|db|payments?|billing|permissions?)([/._-]|$)/i;

/** The light workflow a small leaf feature of a decomposer's split runs (#1352). */
export const LIGHT_LEAF_WORKFLOW = "quick";

/**
 * The plan with small leaf features moved to the light workflow: a feature nothing depends on,
 * with one or two literal boundary paths or size small (never large, never a glob boundary), that
 * runs a workflow writing a spec, runs `LIGHT_LEAF_WORKFLOW` when it can run here and none of its
 * paths is risky (`RISKY_PATH`). Its spec would be a contract nobody pins, and a spec workflow's fixed stages cost the most on the
 * smallest features: seqmill's documentation leaf cost $1.42 under sdd against about $0.5 for a
 * quick run (bench round 36). Features in `keep` are left as they are.
 */
export function lightenSmallLeaves(
  plan: InitiativePlan,
  choices: readonly FeatureWorkflow[],
  keep: ReadonlySet<string> = new Set(),
  /** Also move small features that others depend on (`lightContracts`, #1664). */
  options: { withDependents?: boolean } = {},
): {
  plan: InitiativePlan;
  lightened: { featureId: string; from: string; to: string }[];
  /** Leaves the rule fits that keep their workflow because the light one cannot run here. */
  unavailable: string[];
} {
  const light = choices.find(
    (c) => c.id === LIGHT_LEAF_WORKFLOW && (options.withDependents || !c.contract),
  );
  const lightened: { featureId: string; from: string; to: string }[] = [];
  const unavailable: string[] = [];
  const features = plan.features.map((feature) => {
    const from = feature.workflow;
    // A glob boundary is any number of files: its size is unknown, so it is left alone (#1405).
    const paths = literalPathCount(feature);
    const glob = paths === 0 && feature.boundary.paths.length > 0;
    const small =
      !glob &&
      feature.size !== "large" &&
      (feature.size === "small" || (paths > 0 && paths < MIN_FEATURE_PATHS));
    if (
      keep.has(feature.id) ||
      !from ||
      !small ||
      from === LIGHT_LEAF_WORKFLOW ||
      (!options.withDependents && hasDependents(plan, feature)) ||
      !choices.find((c) => c.id === from)?.contract
    )
      return feature;
    if (feature.boundary.paths.some((p) => RISKY_PATH.test(p))) return feature;
    if (!light) {
      unavailable.push(feature.id);
      return feature;
    }
    lightened.push({ featureId: feature.id, from, to: light.id });
    return { ...feature, workflow: light.id };
  });
  return {
    plan: lightened.length ? { ...plan, features } : plan,
    lightened,
    unavailable,
  };
}

/**
 * The plan with every feature that other features depend on running a workflow that writes a
 * spec: a feature on a light workflow that gained a dependent (shared-path sequencing runs after
 * the workflows are chosen) gets `fallback`, the initiative's default when it writes a spec, else
 * the first choice that does. Without it the dependent stops at ARTIFACT_MISSING on every drive,
 * since there is no accepted spec to pin (#1406). A light feature only documentation depends on
 * keeps its workflow and records a contract instead (`documentedLightLeaf`, #1768).
 */
export function restoreContractWorkflows(
  plan: InitiativePlan,
  choices: readonly FeatureWorkflow[],
  defaultWorkflow: string,
): { plan: InitiativePlan; restored: { featureId: string; from: string; to: string }[] } {
  const contract = (id: string) => choices.find((c) => c.id === id)?.contract === true;
  const fallback = contract(defaultWorkflow)
    ? defaultWorkflow
    : choices.find((c) => c.contract)?.id;
  const restored: { featureId: string; from: string; to: string }[] = [];
  if (!fallback) return { plan, restored };
  const features = plan.features.map((feature) => {
    const from = feature.workflow ?? defaultWorkflow;
    if (contract(from) || !hasDependents(plan, feature) || documentedLightLeaf(plan, feature))
      return feature;
    restored.push({ featureId: feature.id, from, to: fallback });
    return { ...feature, workflow: fallback };
  });
  return restored.length ? { plan: { ...plan, features }, restored } : { plan, restored };
}

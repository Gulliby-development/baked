/**
 * Which workflow each feature of an initiative runs. A feature names its own workflow, chosen by
 * the decomposer or by a person on the split, and otherwise gets the one `proposeWorkflow`
 * proposes for its text. Only workflows that write files can run a feature, and a feature other
 * features depend on needs one that produces a spec: its accepted spec is the contract they pin.
 */
import { assessRequest, proposeWorkflow } from "../preset-router.js";
import { executionModeOf, type RunPolicy } from "../schemas.js";
import { asV2, listDefinitions, loadDefinition } from "../v2/definitions.js";
import type { InitiativeFeature, InitiativePlan } from "./plan.js";

/** What the initiative needs to know about a workflow to run a feature with it. */
export interface FeatureWorkflow {
  id: string;
  description: string;
  schemaVersion: 1 | 2;
  /** It produces a spec, so features may depend on its result. */
  contract: boolean;
  execution: "inline" | "worktree";
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
    };
  } catch {
    return null;
  }
}

/**
 * The workflows a feature can run: they start without problems and write files. With tiered
 * approval only schema 1 workflows qualify, since a v2 definition owns its own auto approval.
 */
export function featureWorkflowChoices(
  workspace: string,
  policy: RunPolicy,
  options: { tiered: boolean },
): FeatureWorkflow[] {
  return listDefinitions(workspace, policy)
    .filter((d) => !d.problems.length && d.writes)
    .filter((d) => !options.tiered || d.schemaVersion === 1)
    .map((d) => featureWorkflow(workspace, policy, d.id))
    .filter((w): w is FeatureWorkflow => w !== null);
}

const hasDependents = (plan: InitiativePlan, feature: InitiativeFeature): boolean =>
  plan.features.some((f) => f.dependsOn.includes(feature.id));

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
  if (!choice.contract && hasDependents(plan, feature))
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

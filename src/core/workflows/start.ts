import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../types/index.js";
import type { ProfileRegistry } from "../agents/profiles/registry.js";
import type { RoutingRecord } from "../llm/model-routing.js";
import { hashBytes, hashJson } from "../specs/hash.js";
import { validateChecks } from "./check-policy.js";
import { frozenInstructions } from "./context.js";
import { WorkflowFault } from "./errors.js";
import {
  independenceWarnings,
  independentReviewMode,
  routedProfiles,
  routingRecord,
} from "./routing.js";
import { GATES_ARTIFACT } from "./scheduler.js";
import {
  type ExecutionMode,
  executionModeOf,
  PolicySchema,
  type RunPolicy,
  type StartRequest,
  validateWorkflow,
  type WorkflowDefinition,
  writerPolicyProblem,
} from "./schemas.js";
import {
  type Gate,
  validateWorkflowV2,
  type WorkflowV2,
  worktreeRefusal,
} from "./v2/definition.js";
import { type LoadedDefinition, loadDefinition } from "./v2/definitions.js";
import { describeGate, loadGateLibrary, unconfirmedGates } from "./v2/library.js";
import {
  autoApprovalHash,
  autoApprovalOf,
  checksOf,
  describeAutoApproval,
  frozenGates,
  KIND_OUTPUT,
  reviewersOf,
  stageKind,
  stageProfileId,
} from "./v2/runtime.js";
import { worktreeBase } from "./worktree.js";

/** Everything a run start validates and resolves before it writes the run. */
export interface PreparedStart {
  model: string;
  /** The request policy bound to the definition: gates, execution mode and writer count applied. */
  policy: RunPolicy;
  mode: ExecutionMode;
  registry: ProfileRegistry;
  loaded: LoadedDefinition;
  routing: RoutingRecord;
  profiles: ReturnType<ProfileRegistry["list"]>[number]["profile"][];
  workflow: WorkflowDefinition | WorkflowV2;
  gates: Gate[];
  instructions: ReturnType<typeof frozenInstructions>;
  skillHashes: Record<string, string>;
  instructionHashes: ReturnType<typeof frozenInstructions>["hashes"];
}

/**
 * The validation half of a run start. It reads the workspace but writes nothing, so `workflow
 * doctor` runs it to report exactly the refusals a start would make.
 */
export async function prepareStart(
  workspace: string,
  config: AppConfig,
  request: Pick<
    StartRequest,
    | "model"
    | "policy"
    | "workflowId"
    | "routes"
    | "autoApprovalConfirmation"
    | "executionMode"
    | "maxConcurrentWriters"
  >,
): Promise<PreparedStart> {
  const model = request.model ?? config.defaultModel;
  if (!model?.trim() || model.trim() === "none")
    throw new WorkflowFault("INVALID_DEFINITION", "Select a model before starting a workflow");
  let policy = PolicySchema.parse(request.policy);
  validateChecks(workspace, policy);
  if (policy.maxCostUsd !== null)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "A dollar cap requires verified model pricing; use the token/time limits with maxCostUsd=null",
    );
  const registry = routedProfiles(workspace, config, model);
  let loaded: LoadedDefinition;
  try {
    loaded = loadDefinition(workspace, request.workflowId, policy);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown workflow"))
      throw new WorkflowFault("NOT_FOUND", error.message);
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      error instanceof Error ? error.message : String(error),
    );
  }
  const routing = routingRecord(
    config,
    registry,
    model,
    request.workflowId,
    loaded.definition.stages.map((stage) => stage.id),
    request.routes,
  );
  const profiles = registry.list().map((p) => p.profile);
  const outputs: Record<string, string> = {
    research: "research",
    specify: "spec",
    plan: "plan",
    analyze: "analysis",
    review: "review",
    converge: "convergence",
  };
  const workflow: WorkflowDefinition | WorkflowV2 = loaded.definition;
  let gates: Gate[] = [];
  const gateFiles: Record<string, string> = {};
  if (loaded.schemaVersion === 1) {
    const validation = validateWorkflow(loaded.definition);
    if (validation.length) throw new WorkflowFault("INVALID_DEFINITION", validation.join("\n"));
    for (const stage of loaded.definition.stages)
      if (stage.profileId && registry.get(stage.profileId).output !== outputs[stage.kind])
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Profile output does not match stage ${stage.id}`,
        );
  } else {
    const bound = bindDefinition(
      workspace,
      loaded.definition,
      policy,
      (id) => registry.get(id).output,
      request.autoApprovalConfirmation,
    );
    gates = bound.gates;
    Object.assign(gateFiles, bound.gateFiles);
    policy = bound.policy;
  }
  // The CLI flag overrides the definition, which overrides the policy. Inline leaves the field
  // out, so the policy hash of an inline run is what it was before execution modes existed.
  const mode =
    request.executionMode ??
    (loaded.schemaVersion === 2 ? loaded.definition.execution : undefined) ??
    executionModeOf(policy);
  const { executionMode: _previous, allowOverlappingWrites, ...rest } = policy;
  // Overlapping writes are kept only when permitted, so a policy that leaves them off keeps the
  // hash it had before the field existed; the requested writer count overrides the policy.
  policy = PolicySchema.parse({
    ...rest,
    ...(mode === "worktree" ? { executionMode: mode } : {}),
    ...(allowOverlappingWrites ? { allowOverlappingWrites } : {}),
    ...(request.maxConcurrentWriters !== undefined
      ? { maxConcurrentWriters: request.maxConcurrentWriters }
      : {}),
  });
  const writers = writerPolicyProblem(policy);
  if (writers) throw new WorkflowFault("INVALID_DEFINITION", writers);
  if (mode === "worktree") {
    const refusal = loaded.schemaVersion === 2 ? worktreeRefusal(loaded.definition) : null;
    if (refusal) throw new WorkflowFault("INVALID_DEFINITION", refusal);
    await worktreeBase(workspace);
  }
  for (const id of Object.values(policy.reviewProfiles))
    if (id && registry.get(id).output !== "review")
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Review profile ${id} has an incompatible output`,
      );
  if (registry.get(policy.skepticProfileId).output !== "refutation")
    throw new WorkflowFault("INVALID_DEFINITION", "Skeptic must return RefutationSchema");
  const independence = independentReviewMode(config);
  if (independence !== "off") {
    const warnings = independenceWarnings(
      routing,
      loaded.definition,
      policy,
      loadGateLibrary(workspace, policy).gates,
      profiles,
    );
    if (warnings.length && independence === "require")
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `${warnings.join("\n")}\nmodelRouting.independentReview is "require"; route the reviewers to another model`,
      );
    if (warnings.length) routing.warnings = warnings;
  }
  const instructions = frozenInstructions(workspace, config.instructionFiles);
  const skillHashes: Record<string, string> = {};
  for (const profile of profiles)
    for (const skill of profile.skills) {
      const path = join(workspace, "baked", "skills", skill.id, "SKILL.md");
      if (!existsSync(path) || hashBytes(readFileSync(path)) !== skill.hash)
        throw new WorkflowFault("INPUT_CHANGED", `Missing or changed skill ${skill.id}`);
      skillHashes[skill.id] = skill.hash;
      instructions.files[path] = skill.hash;
    }
  if (loaded.path) instructions.files[loaded.path] = hashBytes(readFileSync(loaded.path));
  Object.assign(instructions.files, gateFiles);
  const instructionHashes = gates.length
    ? [...instructions.hashes, { source: GATES_ARTIFACT, hash: hashJson(gates) }]
    : [...instructions.hashes];
  return {
    model,
    policy,
    mode,
    registry,
    loaded,
    routing,
    profiles,
    workflow,
    gates,
    instructions,
    skillHashes,
    instructionHashes,
  };
}

/**
 * Validates a v2 definition against the gate library and the profiles a run can use, and derives
 * the run policy from it: the command gates it binds become the checks, with their effective
 * modes, and auto approval comes from the definition only. Shared by run start and by a revision
 * of a started run's definition.
 */
export function bindDefinition(
  workspace: string,
  definition: WorkflowV2,
  basePolicy: RunPolicy,
  outputOf: (profileId: string) => string,
  autoApprovalConfirmation: string | undefined,
): { gates: Gate[]; gateFiles: Record<string, string>; policy: RunPolicy } {
  let policy = basePolicy;
  const gateFiles: Record<string, string> = {};
  const library = loadGateLibrary(workspace, policy);
  const validation = validateWorkflowV2(definition, library.gates);
  if (validation.length) throw new WorkflowFault("INVALID_DEFINITION", validation.join("\n"));
  const gates = frozenGates(definition, library.gates);
  const unconfirmed = unconfirmedGates(
    workspace,
    library,
    gates.map((g) => g.id),
  );
  if (unconfirmed.length)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `Review the project gates this workflow uses before they run:\n${unconfirmed.map(describeGate).join("\n")}\nConfirm them with: baked workflow gates confirm ${unconfirmed.map((e) => e.gate.id).join(" ")}`,
      { unconfirmedGates: unconfirmed.map((e) => e.gate.id) },
    );
  for (const gate of gates) {
    const entry = library.entries.get(gate.id);
    if (entry?.path) gateFiles[entry.path] = hashBytes(readFileSync(entry.path));
  }
  const autoApproval = autoApprovalOf(definition);
  if (definition.autoApproval && autoApproval) {
    const expected = autoApprovalHash(definition.autoApproval);
    if (autoApprovalConfirmation !== expected)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Workflow ${definition.id} approves plans automatically within: ${describeAutoApproval(definition.autoApproval)}. Confirm these limits to start it (CLI: --confirm-auto-approval ${expected}).`,
        { autoApprovalHash: expected },
      );
  }
  // The command gates the definition binds are the run's checks, with their effective modes;
  // auto approval comes from the definition only.
  const acceptanceWrites = [
    ...new Set(
      gates.flatMap((g) =>
        g.type === "ai-acceptance" ? g.acceptance.capabilities.writePaths : [],
      ),
    ),
  ];
  policy = PolicySchema.parse({
    ...policy,
    checks: checksOf(definition, gates),
    autoApproval,
    ...(acceptanceWrites.length ? { acceptanceWrites } : {}),
  });
  validateChecks(workspace, policy);
  for (const stage of definition.stages) {
    const kind = stageKind(stage);
    if (!kind)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Stage ${stage.id} produces ${stage.produces}, which no agent stage can submit`,
      );
    const profileId = stageProfileId(stage);
    if (profileId && outputOf(profileId) !== KIND_OUTPUT[kind])
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Profile output does not match stage ${stage.id}`,
      );
    for (const reviewer of reviewersOf(stage, gates)) {
      if (outputOf(reviewer.profileId) !== "review")
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Review gate ${reviewer.key} needs a profile that returns ReviewSchema`,
        );
      if (reviewer.skepticProfileId && outputOf(reviewer.skepticProfileId) !== "refutation")
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Skeptic of ${reviewer.key} must return RefutationSchema`,
        );
    }
  }
  return { gates, gateFiles, policy };
}

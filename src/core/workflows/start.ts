import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../types/index.js";
import type { ProfileRegistry } from "../agents/profiles/registry.js";
import { parseModelRouting, type RoutingRecord } from "../llm/model-routing.js";
import { checkProviders, getCachedProviderStatuses } from "../llm/provider.js";
import { availableVendorModels } from "../llm/vendor-models.js";
import { detectSandbox } from "../platform/sandbox.js";
import {
  SandboxUnavailableError,
  sandboxSettings,
  stricterSandboxMode,
} from "../security/sandbox.js";
import { hashBytes, hashJson } from "../specs/hash.js";
import { assertCostCapPriced } from "./budget.js";
import { validateChecks } from "./check-policy.js";
import { frozenInstructions } from "./context.js";
import { WorkflowFault } from "./errors.js";
import { languageReviewProfile } from "./language.js";
import { DEFAULT_DUPLICATION } from "./quality/duplication.js";
import { presetMutation, presetOf } from "./quality/mutation.js";
import { presetPropertyTests } from "./quality/properties.js";
import { configuredRules } from "./quality/rules.js";
import { DEFAULT_SAST_CONFIG } from "./quality/sast.js";
import {
  independentReviewMode,
  reviewIndependence,
  routedProfiles,
  routingRecord,
  shadowedModelWarnings,
  strictRoutingConfig,
} from "./routing.js";
import { GATES_ARTIFACT } from "./scheduler.js";
import {
  clarificationOf,
  type ExecutionMode,
  executionModeOf,
  PolicySchema,
  type RunPolicy,
  type StartRequest,
  validateWorkflow,
  type WorkflowDefinition,
  writerPolicyProblem,
} from "./schemas.js";
import { testIntegrityOf } from "./test-integrity.js";
import {
  type Gate,
  validateWorkflowV2,
  type WorkflowV2,
  worktreeRefusal,
} from "./v2/definition.js";
import { type LoadedDefinition, loadDefinition } from "./v2/definitions.js";
import { describeGate, gateToCheck, loadGateLibrary, unconfirmedGates } from "./v2/library.js";
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

export interface StartDeps {
  /** Models of available providers a cross-provider review may move to; tests replace it. */
  availableModels?: () => Promise<string[]>;
}

/** Models of the providers that are signed in, from the last provider check or a new one. */
async function availableModels(): Promise<string[]> {
  const statuses = getCachedProviderStatuses() ?? (await checkProviders());
  return availableVendorModels(statuses.filter((s) => s.available).map((s) => s.id));
}

/** Why a shipped preset with a check stage cannot start in a project without feature checks. */
export const missingFeatureChecks = (workflowId: string): string =>
  `Workflow ${workflowId} needs at least one feature check in the workflow policy (workflows.policy.checks); /workflow gates adds them`;

/**
 * The validation half of a run start. It reads the workspace but writes nothing, so `workflow
 * doctor` runs it to report exactly the refusals a start would make.
 */
export async function prepareStart(
  workspace: string,
  configured: AppConfig,
  request: Pick<
    StartRequest,
    | "model"
    | "policy"
    | "workflowId"
    | "routes"
    | "autoApprovalConfirmation"
    | "executionMode"
    | "sandbox"
    | "maxConcurrentWriters"
    | "candidates"
    | "clarification"
    | "testIntegrity"
    | "duplication"
    | "sast"
    | "mutation"
    | "propertyTests"
    | "modelStrict"
  >,
  deps: StartDeps = {},
): Promise<PreparedStart> {
  const config = request.modelStrict ? strictRoutingConfig(configured) : configured;
  const model = request.model ?? config.defaultModel;
  if (!model?.trim() || model.trim() === "none")
    throw new WorkflowFault("INVALID_DEFINITION", "Select a model before starting a workflow");
  let policy = PolicySchema.parse(request.policy);
  // A Go, .NET, Rust or Java project gets the language reviewer unless the policy names one.
  const languageProfile = policy.reviewProfiles.language ? null : languageReviewProfile(workspace);
  if (languageProfile)
    policy = PolicySchema.parse({
      ...policy,
      reviewProfiles: { ...policy.reviewProfiles, language: languageProfile },
    });
  validateChecks(workspace, policy);
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
  let routing = routingRecord(
    config,
    registry,
    model,
    request.workflowId,
    loaded.definition.stages.map((stage) => stage.id),
    request.routes,
  );
  const profiles = registry.list().map((p) => p.profile);
  if (request.modelStrict) routing.strict = true;
  else if (request.model?.trim() && request.model.trim() !== "none") {
    const shadowed = shadowedModelWarnings(routing, profiles);
    if (shadowed.length) routing.warnings = shadowed;
  }
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
    // A shipped preset bound to a project without feature checks has a check stage with no gates;
    // refuse here so every front end reports it instead of a run that blocks at once.
    if (!loaded.path && loaded.definition.stages.some((s) => s.type === "check" && !s.gates.length))
      throw new WorkflowFault("INVALID_DEFINITION", missingFeatureChecks(request.workflowId), {
        missingFeatureChecks: true,
      });
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
  const {
    executionMode: _previous,
    sandbox: policySandbox,
    clarification: _clarification,
    testIntegrity: _testIntegrity,
    testsFirst: _testsFirst,
    duplication: _duplication,
    qualityRules: requestRules,
    sast: policySast,
    sastConfig: policySastConfig,
    registryLookups: policyLookups,
    mutation: policyMutation,
    mutationThresholds: policyThresholds,
    mutationBudgetMs: policyMutationBudget,
    mutationEngine: policyMutationEngine,
    propertyTests: policyPropertyTests,
    allowOverlappingWrites,
    editDiagnostics: _editDiagnostics,
    candidates: policyCandidates,
    libraryDocs: policyLibraryDocs,
    ...rest
  } = policy;
  // The policy's own source wins over the configured one; without either the field stays out.
  const libraryDocs = policyLibraryDocs ?? config.libraryDocs;
  // The project's chat setting is the default; `feedback` leaves the field out of the hash.
  const editDiagnostics = policy.editDiagnostics ?? config.editDiagnostics ?? "feedback";
  // `ask` leaves the field out, so the policy hash of an asking run is what it was before.
  const clarification = request.clarification ?? clarificationOf(policy);
  // `block` is the default and is left out, so the policy hash of a guarded run is what it was.
  const testIntegrity = request.testIntegrity ?? testIntegrityOf(policy);
  // The definition (the tdd preset) overrides the policy; `off` is left out of the policy.
  const testsFirst =
    (loaded.schemaVersion === 2 ? loaded.definition.testsFirst : undefined) ??
    policy.testsFirst ??
    "off";
  // The run flag overrides the policy, which overrides the configured default; `warn` is the
  // default and leaves the field out, so the policy hash stays what it was before the ratchet.
  const duplication =
    request.duplication ?? policy.duplication ?? config.quality?.duplication ?? DEFAULT_DUPLICATION;
  // The policy's own rule choices win over the configured ones; the built-in pack as shipped
  // leaves the field out.
  const qualityRules = requestRules ?? configuredRules(config.quality);
  // Defaults (`auto`, `p/default`, lookups on) leave the fields out, so the hash stays.
  const sast = request.sast ?? policySast ?? config.quality?.sast ?? "auto";
  const sastConfig = policySastConfig ?? config.quality?.sastConfig ?? DEFAULT_SAST_CONFIG;
  const registryLookups = policyLookups ?? config.quality?.registryLookups ?? true;
  // The preset's mutation default leaves the field out; a project or run choice is frozen.
  const preset = presetOf(loaded);
  const mutation =
    request.mutation ??
    policyMutation ??
    (config.quality?.mutation === "preset" ? undefined : config.quality?.mutation) ??
    presetMutation(preset);
  const mutationThresholds = policyThresholds ?? config.quality?.mutationThresholds;
  const mutationBudgetMs = policyMutationBudget ?? config.quality?.mutationBudgetMs;
  const mutationEngine = policyMutationEngine ?? config.quality?.mutationEngine ?? "auto";
  const propertyTests =
    request.propertyTests ??
    policyPropertyTests ??
    (config.quality?.propertyTests === "preset" ? undefined : config.quality?.propertyTests) ??
    presetPropertyTests(preset);
  // Best-of-N: the run flag, then the definition's tasks stage, then the policy; 1 leaves the
  // field out, so the policy hash stays what it was before candidates existed.
  const stageCandidates =
    loaded.schemaVersion === 2
      ? Math.max(
          1,
          ...loaded.definition.stages.map((s) => (s.type === "tasks" ? (s.candidates ?? 1) : 1)),
        )
      : 1;
  const candidates =
    request.candidates ??
    (stageCandidates > 1 ? stageCandidates : undefined) ??
    policyCandidates ??
    1;
  // Overlapping writes are kept only when permitted, so a policy that leaves them off keeps the
  // hash it had before the field existed; the requested writer count overrides the policy.
  // The requested mode wins; otherwise the policy and the configuration can each only raise it.
  // Off leaves the field out, so the policy hash of an unsandboxed run is what it was before.
  const sandbox =
    request.sandbox ?? stricterSandboxMode(policySandbox, sandboxSettings(workspace).effective);
  if (sandbox === "required") {
    const detection = detectSandbox();
    if (!detection.available)
      throw new WorkflowFault("INVALID_DEFINITION", new SandboxUnavailableError(detection).message);
  }
  policy = PolicySchema.parse({
    ...rest,
    ...(mode === "worktree" ? { executionMode: mode } : {}),
    ...(sandbox !== "off" ? { sandbox } : {}),
    ...(allowOverlappingWrites ? { allowOverlappingWrites } : {}),
    ...(clarification === "assume" ? { clarification } : {}),
    ...(testIntegrity === "warn" ? { testIntegrity } : {}),
    ...(testsFirst !== "off" ? { testsFirst } : {}),
    ...(editDiagnostics === "reject" ? { editDiagnostics } : {}),
    ...(libraryDocs ? { libraryDocs } : {}),
    ...(duplication !== DEFAULT_DUPLICATION ? { duplication } : {}),
    ...(qualityRules ? { qualityRules } : {}),
    ...(sast === "off" ? { sast } : {}),
    ...(sastConfig !== DEFAULT_SAST_CONFIG ? { sastConfig } : {}),
    ...(registryLookups === false ? { registryLookups } : {}),
    ...(mutation !== presetMutation(preset) ? { mutation } : {}),
    ...(mutationThresholds && Object.keys(mutationThresholds).length ? { mutationThresholds } : {}),
    ...(mutationBudgetMs !== undefined ? { mutationBudgetMs } : {}),
    ...(mutationEngine === "built-in" ? { mutationEngine } : {}),
    ...(propertyTests !== presetPropertyTests(preset) ? { propertyTests } : {}),
    ...(request.maxConcurrentWriters !== undefined
      ? { maxConcurrentWriters: request.maxConcurrentWriters }
      : {}),
    ...(candidates > 1 ? { candidates } : {}),
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
  const independence = reviewIndependence(
    config,
    routing,
    loaded.definition,
    policy,
    loadGateLibrary(workspace, policy).gates,
    profiles,
    independentReviewMode(config) === "provider"
      ? await (deps.availableModels ?? availableModels)()
      : [],
  );
  if (independence.refuse)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `${independence.warnings.join("\n")}\nmodelRouting.independentReview is "require"; route the reviewers to another model`,
    );
  routing = independence.record;
  assertCostCapPriced(policy, routing);
  const notes = [...independence.moved, ...independence.warnings];
  if (notes.length) routing.warnings = [...(routing.warnings ?? []), ...notes];
  // Review settings of modelRouting join the policy, so the approval digest covers them; a
  // policy that sets one itself keeps it.
  const reviewSettings = parseModelRouting(config.modelRouting);
  if (reviewSettings?.reviewMinConfidence !== undefined && policy.reviewMinConfidence === undefined)
    policy = PolicySchema.parse({
      ...policy,
      reviewMinConfidence: reviewSettings.reviewMinConfidence,
    });
  if (reviewSettings?.critic && policy.critic === undefined)
    policy = PolicySchema.parse({ ...policy, critic: reviewSettings.critic });
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
  // The gates a wait stage polls are not run checks, but their processes pass the same rules.
  const polled = definition.stages.flatMap((stage) =>
    stage.type === "wait"
      ? stage.gates.flatMap((binding) => {
          const gate = gates.find((g) => g.id === binding.gateId);
          return gate?.type === "command" && !policy.checks.some((c) => c.id === gate.id)
            ? [gateToCheck(gate, binding)]
            : [];
        })
      : [],
  );
  if (polled.length)
    validateChecks(workspace, {
      ...policy,
      checks: [...new Map(polled.map((c) => [c.id, c])).values()],
    });
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

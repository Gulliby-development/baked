import { canonical, hashJson } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import { hostGrowth, withoutHostGrowth } from "./host-growth.js";
import { isManifestPath } from "./quality/manifests.js";
import { unmappedDeliverables } from "./request-coverage.js";
import {
  type ApprovalReview,
  clarificationOf,
  type InputManifest,
  type RunPolicy,
  type Spec,
  type TaskGraph,
} from "./schemas.js";
import type { ArtifactRow, RequestRow } from "./store.js";
import { isAcceptanceRequest } from "./v2/acceptance.js";

/** The built-in profile that decides packages `autoApproval.modelReview` sends to it. */
export const APPROVAL_REVIEWER = "approval-reviewer";

export interface AutoApproval {
  mode: "renewal" | "limits" | "model-review";
  /** Hash of the policy bounds the decision was taken under. */
  limitsHash: string;
  /** The reviewer's verdict, for `model-review`. */
  review?: ApprovalReview;
}
export interface AutoApprovalResult {
  approval: AutoApproval | null;
  /** Why the package needs a person; empty when auto approval is approved or disabled. */
  reasons: string[];
  /**
   * The package left the limits only by its task count, file count or paths, and the policy
   * turns on `modelReview`: the approval reviewer may decide it. Never set for always-human
   * writes, deletes, the token budget or renewal problems.
   */
  reviewable?: boolean;
  /** The policy bounds hash a `model-review` approval records, set with `reviewable`. */
  limitsHash?: string;
}
/**
 * A policy the operator set with an explicit workflow command (`extend`, or `revise` of a staged
 * candidate). Only the command service writes these records; nothing here comes from model output.
 */
export interface PolicyDecision {
  policyHash: string;
}
type Write = TaskGraph["tasks"][number]["writes"][number];

/** Paths that always need a person, whatever the limits (design section 5.2). */
const alwaysHuman =
  /^(?:\.git|\.baked|baked|specs|\.github|\.gitlab|\.circleci|\.husky)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|constitution\.md|package\.json|bunfig\.toml|Cargo\.toml|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|Gemfile|[^/]*\.(?:csproj|fsproj|vbproj)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Directory\.(?:Packages|Build)\.props|[^/]*[.-]lock(?:b|\.[^/]*)?|tsconfig[^/]*|biome[^/]*|\.env(?:\.[^/]*)?|\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|[^/]*\.(?:pem|key|crt|cer|p12|pfx|jks|keystore))$/i;

/** Whether writing `path` always needs a person: secrets, CI and deployment config, manifests. */
export function alwaysNeedsPerson(path: string): boolean {
  return alwaysHuman.test(path);
}

/**
 * Project manifests and tool configs. Creating one that does not exist yet is how a scaffold
 * starts and changes nothing a person has reviewed; modifying one stays with a person.
 */
const manifestFile =
  /(?:^|\/)(?:package\.json|bunfig\.toml|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Gemfile|[^/]*\.(?:csproj|fsproj|vbproj)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Directory\.(?:Packages|Build)\.props|tsconfig[^/]*|biome[^/]*)$/i;

/**
 * Whether a write needs a person whatever the limits; `exists` tells which files are already there.
 * On a scaffold baseline (no source files) a manifest is edited too: the scaffold holds nothing a
 * person has reviewed yet, and the next task needs its scripts and dev dependencies.
 */
function needsPerson(write: Write, exists?: (path: string) => boolean, scaffold = false): boolean {
  if (!alwaysHuman.test(write.path)) return false;
  if (scaffold && manifestFile.test(write.path) && write.action !== "delete") return false;
  return !(
    write.action === "create" &&
    exists !== undefined &&
    manifestFile.test(write.path) &&
    !exists(write.path)
  );
}

/** What the host knows about the run's package that the graph does not say. */
export interface ApprovalContext {
  /** Whether a path exists in the workspace the tasks will write to. */
  exists?: (path: string) => boolean;
  /** Tasks the host added by splitting a planned task; the person approved the plan, not these. */
  hostSplitTasks?: number;
  /** The run's baseline holds no source files (empty or scaffold only). */
  scaffold?: boolean;
  /** The user's request; a spec that leaves one of its deliverables unmapped needs a person. */
  request?: string;
  /**
   * The run's own request text, which `requestedManifestEdits` matches manifest writes against
   * (defaults to `request`). A feature run of an initiative checks deliverables against nothing,
   * since its boundary was approved with the split, but its request still names the manifest its
   * boundary lists (#1394, dieodds cli).
   */
  manifestRequest?: string;
  /**
   * Tokens the host added to the run budget on its own (planning floor, sizing, growth), recorded
   * as policy revisions with `approvedBy: "sizing"`; see `hostBudgetGrowth`.
   */
  hostGrowthTokens?: number;
  /**
   * The run's policy revisions, so a renewal can tell the host's own budget growth from a change a
   * person has to approve (`hostGrowth`).
   */
  policyRevisions?: { artifacts: ArtifactRow[]; read: (artifact: ArtifactRow) => string };
}

/** Budget limits a renewal may keep or lower, never raise, unless the operator raised them. */
const budgetKeys = [
  "maxConcurrentReadAgents",
  "maxAgentSteps",
  "maxAgentCalls",
  "maxTotalTokens",
  "maxActiveMs",
  "maxRepairRounds",
  "maxConvergenceRounds",
  "maxCorrectiveTasks",
] as const;

/** Policy fields that grant capabilities or set review strength; only a person may widen them. */
const capabilityKeys = [
  "allowedTools",
  "network",
  "reviewProfiles",
  "skepticProfileId",
  "forceSecurityReview",
  "sandbox",
] as const;
const networkRank = { deny: 0, ask: 1, allow: 2 } as const;
/** A weaker OS sandbox widens what run processes may touch. */
const sandboxRank = { off: 0, auto: 1, required: 2 } as const;

/**
 * Decides on the host whether a package may be approved without a person. Any doubt returns
 * reasons and no approval, so the run falls back to a human request.
 */
export function evaluateAutoApproval(
  policy: RunPolicy,
  manifest: InputManifest,
  spec: Spec,
  graph: TaskGraph,
  requests: RequestRow[],
  decisions: PolicyDecision[] = [],
  context: ApprovalContext = {},
): AutoApprovalResult {
  const config = policy.autoApproval;
  if (!config) return { approval: null, reasons: [] };
  const writes = graph.tasks.flatMap((task) => task.writes);
  const common: string[] = [];
  for (const write of writes)
    if (
      needsPerson(write, context.exists, context.scaffold) &&
      !(
        config.requestedManifestEdits &&
        requestedManifestEdit(write, context.manifestRequest ?? context.request ?? "")
      )
    )
      common.push(`${write.path} always needs a person`);
  // Under `clarification: assume` the run already decides what it may on its own; the deferral is
  // recorded in the approval body and the run report, so it is visible without a person.
  if (
    clarificationOf(policy) !== "assume" &&
    spec.criteria.some((criterion) => criterion.method === "post-release")
  )
    common.push("Deferring post-release criteria needs a person");
  for (const deliverable of unmappedDeliverables(spec, context.request ?? ""))
    common.push(`Request deliverable not covered by the spec: ${deliverable}`);
  const limitsHash = hashJson({ policy: policyBounds(policy) });
  const reasons: string[] = [...common];
  if (config.renewal) {
    const renewal = renewalProblems(
      policy,
      manifest,
      graph,
      requests,
      decisions,
      context.policyRevisions,
    );
    if (!common.length && !renewal.length)
      return { approval: { mode: "renewal", limitsHash }, reasons: [] };
    reasons.push(...renewal.map((reason) => `Renewal: ${reason}`));
  }
  let reviewable = false;
  if (config.limits) {
    const limits = config.limits;
    const scope = scopeProblems(limits, graph, context.hostSplitTasks ?? 0);
    const problems = scope.map((p) => p.text);
    // Growth the host made itself, up to the policy's own sizing ceiling, is not a budget a person
    // has to approve; only the budget the run started with counts against the limit (#1309).
    const grown = Math.max(0, context.hostGrowthTokens ?? 0);
    const ceiling = Math.max(limits.maxTotalTokens, policy.sizing?.maxRunTokens ?? 0);
    const started = policy.maxTotalTokens - grown;
    if (started > limits.maxTotalTokens)
      problems.push(`the token budget ${policy.maxTotalTokens} exceeds ${limits.maxTotalTokens}`);
    else if (policy.maxTotalTokens > ceiling)
      problems.push(
        `the token budget ${policy.maxTotalTokens} exceeds the sizing ceiling ${ceiling}`,
      );
    if (!common.length && !problems.length)
      return { approval: { mode: "limits", limitsHash }, reasons: [] };
    reasons.push(...problems.map((reason) => `Limits: ${reason}`));
    reviewable =
      config.modelReview === true &&
      !common.length &&
      problems.length > 0 &&
      problems.length === scope.length &&
      scope.every((p) => p.reviewable);
  }
  return {
    approval: null,
    reasons: [...new Set(reasons)],
    ...(reviewable ? { reviewable, limitsHash } : {}),
  };
}

type Limits = NonNullable<NonNullable<RunPolicy["autoApproval"]>["limits"]>;

/**
 * Where a task graph leaves the limits' scope: task and file counts, paths and deletions. A
 * deletion is never left to the approval reviewer.
 */
function scopeProblems(
  limits: Limits,
  graph: TaskGraph,
  hostSplitTasks = 0,
  required: (write: Write) => boolean = () => false,
): { text: string; reviewable: boolean }[] {
  const writes = graph.tasks.flatMap((task) => task.writes);
  const problems: { text: string; reviewable: boolean }[] = [];
  const planned = graph.tasks.length - hostSplitTasks;
  if (planned > limits.maxTasks)
    problems.push({ text: `${planned} tasks exceed ${limits.maxTasks}`, reviewable: true });
  const files = new Set(writes.map((write) => write.path.toLowerCase()));
  if (files.size > limits.maxFiles)
    problems.push({ text: `${files.size} files exceed ${limits.maxFiles}`, reviewable: true });
  const globs = limits.allowedPaths.map((pattern) => new Bun.Glob(pattern.toLowerCase()));
  for (const write of writes) {
    if (required(write)) continue;
    if (!globs.some((glob) => glob.match(write.path.toLowerCase())))
      problems.push({ text: `${write.path} is outside the allowed paths`, reviewable: true });
    if (write.action === "delete" && !limits.allowDelete)
      problems.push({ text: `${write.path} would be deleted`, reviewable: false });
  }
  return problems;
}

/**
 * The scope the host approves without a person, for the planner: without it the planner picks
 * its writes blind to the limits, and an optional extra file sends the plan to a person.
 */
export function plannerApprovalLimits(policy: RunPolicy): {
  maxTasks: number;
  maxFiles: number;
  allowedPaths: string[];
  allowDelete: boolean;
  alwaysHuman: string;
} | null {
  const limits = policy.autoApproval?.limits;
  if (!limits) return null;
  return {
    maxTasks: limits.maxTasks,
    maxFiles: limits.maxFiles,
    allowedPaths: limits.allowedPaths,
    allowDelete: limits.allowDelete,
    alwaysHuman: `repository metadata (.git, .github and other CI folders, .baked, specs), agent instructions, package manifests that already exist (creating one is allowed, and editing one on a workspace without source files${policy.autoApproval?.requestedManifestEdits ? " or one the request names" : ""}), lockfiles, tool configs (tsconfig, biome), .env files and keys`,
  };
}

/** Test files that .NET project templates create and a plan replaces with real tests. */
const templatePlaceholder = /(?:^|\/)(?:UnitTest1|Class1)\.(?:cs|fs|vb)$/i;

/**
 * A write the planner cannot drop: the request names its file, or it deletes a project template's
 * placeholder. Advising against it only makes the planner submit the same plan again (#1111).
 */
function requiredByRequest(write: Write, request: string): boolean {
  if (write.action === "delete" && templatePlaceholder.test(write.path)) return true;
  const text = request.toLowerCase();
  const path = write.path.toLowerCase();
  const name = path.split("/").at(-1) ?? path;
  return text.includes(path) || (name.includes(".") && text.includes(name));
}

/**
 * An edit of an existing package manifest that the request names, under
 * `autoApproval.requestedManifestEdits` (#1229). A multi-project .NET, JVM or Rust workspace plan
 * must reference its new project from the scaffold's manifests. Only manifests the dependency
 * check reads qualify: with `allowNewDependencies` false a package the edit adds still blocks the
 * run unless the request or spec names it (#802). Deletes, lockfiles, tool configs and
 * `Directory.Packages.props` keep needing a person.
 */
function requestedManifestEdit(write: Write, request: string): boolean {
  return (
    write.action !== "delete" && isManifestPath(write.path) && requiredByRequest(write, request)
  );
}

/**
 * Why a submitted plan would not be approved within the limits. The planner gets these once per
 * run as advice: a plan that still needs such a write is accepted and goes to a person at
 * approval. Writes the request requires are left out, since dropping them is not an option.
 */
export function planScopeAdvice(
  policy: RunPolicy,
  graph: TaskGraph,
  exists?: (path: string) => boolean,
  scaffold = false,
  request = "",
): string[] {
  const limits = policy.autoApproval?.limits;
  if (!limits) return [];
  const required = (write: Write) => requiredByRequest(write, request);
  const always = graph.tasks
    .flatMap((task) => task.writes)
    .filter((write) => !required(write) && needsPerson(write, exists, scaffold))
    .map((write) => `${write.path} always needs a person`);
  const problems = [
    ...new Set([...always, ...scopeProblems(limits, graph, 0, required).map((p) => p.text)]),
  ];
  if (!problems.length) return [];
  return [
    `This plan needs a person at approval: ${problems.join("; ")}. Automatic approval covers at most ${limits.maxTasks} tasks and ${limits.maxFiles} files under ${limits.allowedPaths.join(", ")}${limits.allowDelete ? "" : " without deletions"}. Drop writes the requirements do not need (an optional refactor, a type or helper that can live in a file already written) and merge small tasks. If every listed write is needed, submit the plan again unchanged: it is accepted and a person approves it once at approval, which authorizes every write it lists. Do not mention approval in task descriptions or rationales; the tasks run only after the person approved.`,
  ];
}

const APPROVAL = /\bapprov/i;
const GATE =
  /\b(human|person|people|manual(ly)?|requires?|required|needs?|needed|waits?|pending|until|before|without|not (been )?(given|provided|granted))\b/i;

/** A text without the sentences that make a step wait for an approval (#797). */
function withoutApproval(text: string, fallback: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !(APPROVAL.test(sentence) && GATE.test(sentence)))
    .join(" ")
    .trim();
  return kept || fallback;
}

/**
 * Task descriptions and rationales without approval remarks. A planner told that a write needs a
 * person copied that into the task ("this workflow path requires human approval"), and the
 * implementer then refused the write after the person had approved the plan (R12 url-shortener
 * c86f72da). A task only runs after its plan was approved, so such a remark is never true there.
 */
export function withoutApprovalRemarks(graph: TaskGraph): TaskGraph {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => ({
      ...task,
      description: withoutApproval(task.description, task.title),
      rationale: withoutApproval(task.rationale, "Required by the approved plan"),
    })),
  };
}

/**
 * A renewal stays within the latest human approval: the same or fewer writes, the same task
 * profiles and frozen inputs, and no wider capabilities. The remaining policy settings (checks,
 * budgets, auto approval) must match that approval, or match the policy the operator set later
 * with an explicit command, because that command is itself a human decision. Budget growth the
 * host made on its own after either (`hostGrowth`) is not a change: the renewal compares the limits
 * as they were before it. A renewal refused "maxTotalTokens grew" after the host grew the budget
 * past a revise, and since the cost cap grows too, "checks or other policy settings changed"
 * (#1430).
 */
function renewalProblems(
  policy: RunPolicy,
  manifest: InputManifest,
  graph: TaskGraph,
  requests: RequestRow[],
  decisions: PolicyDecision[],
  revisions?: ApprovalContext["policyRevisions"],
): string[] {
  const previous = requests.filter(
    (request) =>
      request.kind === "approval" &&
      request.status === "accepted" &&
      request.actor === "user" &&
      !isAcceptanceRequest(request),
  );
  const last = previous.at(-1);
  if (!last) return ["no earlier human approval in this run"];
  const body = JSON.parse(last.body_json) as {
    manifest?: InputManifest;
    writes?: Write[];
    policy?: RunPolicy;
    profiles?: string[];
  };
  if (!body.manifest || !body.writes || !body.policy)
    return ["the earlier approval does not record its scope"];
  const approved = body.policy;
  const problems = capabilityProblems(policy, approved);
  // A run's policy changes only through operator commands, and each records a decision. A policy
  // in force that a decision names is therefore the operator's latest choice; an approval taken
  // after that decision was taken under the same policy, so their order does not matter.
  const current = hashJson(policy);
  const growth = revisions
    ? hostGrowth(
        revisions.artifacts,
        revisions.read,
        current,
        new Set([hashJson(approved), ...decisions.map((decision) => decision.policyHash)]),
      )
    : null;
  const set = growth ? withoutHostGrowth(policy, growth) : policy;
  const operatorSet = decisions.some(
    (decision) => decision.policyHash === current || decision.policyHash === growth?.baseHash,
  );
  if (!operatorSet) {
    if (canonical(settings(set)) !== canonical(settings(approved)))
      problems.push("checks or other policy settings changed without an operator decision");
    for (const key of budgetKeys)
      if (set[key] > approved[key])
        problems.push(`${key} grew from ${approved[key]} to ${set[key]}`);
  }
  for (const key of ["workflowHash", "profileHashes", "skillHashes"] as const)
    if (canonical(manifest[key]) !== canonical(body.manifest[key])) problems.push(`${key} changed`);
  if (!body.profiles) problems.push("the earlier approval does not record its task profiles");
  else
    for (const profile of new Set(graph.tasks.map((task) => task.profileId)))
      if (!body.profiles.includes(profile))
        problems.push(`task profile ${profile} was not approved`);
  for (const write of graph.tasks.flatMap((task) => task.writes)) {
    const path = write.path.toLowerCase();
    const covered = body.writes.some(
      (w) =>
        w.path.toLowerCase() === path &&
        (write.action === "delete" ? w.action === "delete" : w.action !== "delete"),
    );
    if (!covered) problems.push(`${write.action} ${write.path} was not approved`);
  }
  return problems;
}

/** Capabilities may stay or shrink after a human approval, whoever changed them. */
function capabilityProblems(policy: RunPolicy, approved: RunPolicy): string[] {
  const problems: string[] = [];
  for (const tool of policy.allowedTools)
    if (!approved.allowedTools.includes(tool)) problems.push(`tool ${tool} was added`);
  if (networkRank[policy.network] > networkRank[approved.network])
    problems.push(`network widened from ${approved.network} to ${policy.network}`);
  if (
    canonical(policy.reviewProfiles) !== canonical(approved.reviewProfiles) ||
    policy.skepticProfileId !== approved.skepticProfileId
  )
    problems.push("review profiles changed");
  if (approved.forceSecurityReview && !policy.forceSecurityReview)
    problems.push("forced security review was turned off");
  const sandbox = policy.sandbox ?? "off";
  const approvedSandbox = approved.sandbox ?? "off";
  if (sandboxRank[sandbox] < sandboxRank[approvedSandbox])
    problems.push(`sandbox weakened from ${approvedSandbox} to ${sandbox}`);
  return problems;
}

/** Policy settings other than budgets and capabilities. */
function settings(policy: RunPolicy): Record<string, unknown> {
  const copy = policyBounds(policy, false);
  for (const key of capabilityKeys) delete copy[key];
  return copy;
}

/** Policy without its budget numbers, or all of it. */
function policyBounds(policy: RunPolicy, withBudget = true): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...policy };
  if (!withBudget) for (const key of budgetKeys) delete copy[key];
  return copy;
}

/**
 * The operator's policy decisions of a run: the `policy-revision` artifacts the
 * command service writes for `extend` and `revise`. A record that does not name the user as its
 * approver is ignored.
 */
export function policyDecisions(
  artifacts: ArtifactRow[],
  read: (artifact: ArtifactRow) => string,
): PolicyDecision[] {
  const decisions: PolicyDecision[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "policy-revision") continue;
    const body = JSON.parse(read(artifact)) as { approvedBy?: unknown; policyHash?: unknown };
    if (body.approvedBy === "user" && typeof body.policyHash === "string")
      decisions.push({ policyHash: body.policyHash });
  }
  return decisions;
}

/**
 * Tokens the host added to the run budget without a person: the sum of the `maxTotalTokens`
 * increases of policy revisions with `approvedBy: "sizing"` (planning floor, sizing, growth).
 */
export function hostBudgetGrowth(
  artifacts: ArtifactRow[],
  read: (artifact: ArtifactRow) => string,
): number {
  let grown = 0;
  for (const artifact of artifacts) {
    if (artifact.kind !== "policy-revision") continue;
    const body = JSON.parse(read(artifact)) as {
      approvedBy?: unknown;
      previous?: { maxTotalTokens?: unknown };
      next?: { maxTotalTokens?: unknown };
    };
    const before = body.previous?.maxTotalTokens;
    const after = body.next?.maxTotalTokens;
    if (body.approvedBy === "sizing" && typeof before === "number" && typeof after === "number")
      grown += Math.max(0, after - before);
  }
  return grown;
}

/** What an approval request's `autoApproval` says about the approval reviewer, in one line. */
export function approvalReviewText(autoApproval: {
  review?: ApprovalReview;
  reviewError?: string;
}): string | null {
  if (autoApproval.reviewError)
    return `The approval reviewer could not decide (${autoApproval.reviewError}), so it waits for you.`;
  const review = autoApproval.review;
  if (!review) return null;
  return `The approval reviewer ${review.verdict === "approve" ? "would approve" : "escalated"} at ${review.risk} risk: ${review.reasons.join(" ")}`;
}

/** The policy with the approval reviewer turned on (`--approval-review`); it needs limits. */
export function withModelReview(policy: RunPolicy): RunPolicy {
  const config = policy.autoApproval;
  if (!config?.limits)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "--approval-review needs auto approval limits (workflows.policy.autoApproval.limits)",
    );
  return { ...policy, autoApproval: { ...config, modelReview: true } };
}

/**
 * Why a v2 approval stage marked human waits for a person, and how to approve automatically: the
 * project policy's `autoApproval` applies only to schema 1 workflows, so an operator who set it
 * for `sdd` would otherwise not know why a `quick` run waits.
 */
export function humanApprovalReason(workflowId: string, stageId: string): string {
  return `Stage ${stageId} of workflow ${workflowId} asks a person; the project policy's autoApproval applies only to schema 1 workflows such as sdd. To approve automatically, copy it (baked workflow define ID --from ${workflowId}), set the stage to auto, start the copy with --confirm-auto-approval HASH, and for baked quick set workflows.quickWorkflow to ID.`;
}

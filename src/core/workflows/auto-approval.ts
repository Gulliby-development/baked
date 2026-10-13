import { canonical, hashJson } from "../specs/hash.js";
import {
  clarificationOf,
  type InputManifest,
  type RunPolicy,
  type Spec,
  type TaskGraph,
} from "./schemas.js";
import type { ArtifactRow, RequestRow } from "./store.js";
import { isAcceptanceRequest } from "./v2/acceptance.js";

export interface AutoApproval {
  mode: "renewal" | "limits";
  /** Hash of the policy bounds the decision was taken under. */
  limitsHash: string;
}
export interface AutoApprovalResult {
  approval: AutoApproval | null;
  /** Why the package needs a person; empty when auto approval is approved or disabled. */
  reasons: string[];
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
  /^(?:\.git|\.baked|baked|specs|\.github|\.gitlab|\.circleci|\.husky)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|constitution\.md|package\.json|bunfig\.toml|Cargo\.toml|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|Gemfile|[^/]*[.-]lock(?:b|\.[^/]*)?|tsconfig[^/]*|biome[^/]*|\.env(?:\.[^/]*)?|\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|[^/]*\.(?:pem|key|crt|cer|p12|pfx|jks|keystore))$/i;

/**
 * Project manifests and tool configs. Creating one that does not exist yet is how a scaffold
 * starts and changes nothing a person has reviewed; modifying one stays with a person.
 */
const manifestFile =
  /(?:^|\/)(?:package\.json|bunfig\.toml|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Gemfile|tsconfig[^/]*|biome[^/]*)$/i;

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
] as const;
const networkRank = { deny: 0, ask: 1, allow: 2 } as const;

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
    if (needsPerson(write, context.exists, context.scaffold))
      common.push(`${write.path} always needs a person`);
  // Under assume the operator let the run settle what a person would be asked; the approval body
  // lists the deferred criteria, and the run report shows them as deferred (endfix 2295dbbd).
  if (
    clarificationOf(policy) !== "assume" &&
    spec.criteria.some((criterion) => criterion.method === "post-release")
  )
    common.push("Deferring post-release criteria needs a person");
  const limitsHash = hashJson({ policy: policyBounds(policy) });
  const reasons: string[] = [...common];
  if (config.renewal) {
    const renewal = renewalProblems(policy, manifest, graph, requests, decisions);
    if (!common.length && !renewal.length)
      return { approval: { mode: "renewal", limitsHash }, reasons: [] };
    reasons.push(...renewal.map((reason) => `Renewal: ${reason}`));
  }
  if (config.limits) {
    const limits = config.limits;
    const problems = scopeProblems(limits, graph, context.hostSplitTasks ?? 0);
    if (policy.maxTotalTokens > limits.maxTotalTokens)
      problems.push(`the token budget ${policy.maxTotalTokens} exceeds ${limits.maxTotalTokens}`);
    if (!common.length && !problems.length)
      return { approval: { mode: "limits", limitsHash }, reasons: [] };
    reasons.push(...problems.map((reason) => `Limits: ${reason}`));
  }
  return { approval: null, reasons: [...new Set(reasons)] };
}

type Limits = NonNullable<NonNullable<RunPolicy["autoApproval"]>["limits"]>;

/** Where a task graph leaves the limits' scope: task and file counts, paths and deletions. */
function scopeProblems(limits: Limits, graph: TaskGraph, hostSplitTasks = 0): string[] {
  const writes = graph.tasks.flatMap((task) => task.writes);
  const problems: string[] = [];
  const planned = graph.tasks.length - hostSplitTasks;
  if (planned > limits.maxTasks) problems.push(`${planned} tasks exceed ${limits.maxTasks}`);
  const files = new Set(writes.map((write) => write.path.toLowerCase()));
  if (files.size > limits.maxFiles) problems.push(`${files.size} files exceed ${limits.maxFiles}`);
  const globs = limits.allowedPaths.map((pattern) => new Bun.Glob(pattern.toLowerCase()));
  for (const write of writes) {
    if (!globs.some((glob) => glob.match(write.path.toLowerCase())))
      problems.push(`${write.path} is outside the allowed paths`);
    if (write.action === "delete" && !limits.allowDelete)
      problems.push(`${write.path} would be deleted`);
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
    alwaysHuman:
      "repository metadata (.git, .github and other CI folders, .baked, specs), agent instructions, package manifests that already exist (creating one is allowed, and editing one on a workspace without source files), lockfiles, tool configs (tsconfig, biome), .env files and keys",
  };
}

/**
 * Why a submitted plan would not be approved within the limits. The planner gets these once as
 * advice: a plan that still needs such a write is accepted and goes to a person at approval.
 */
export function planScopeAdvice(
  policy: RunPolicy,
  graph: TaskGraph,
  exists?: (path: string) => boolean,
  scaffold = false,
): string[] {
  const limits = policy.autoApproval?.limits;
  if (!limits) return [];
  const always = graph.tasks
    .flatMap((task) => task.writes)
    .filter((write) => needsPerson(write, exists, scaffold))
    .map((write) => `${write.path} always needs a person`);
  const problems = [...new Set([...always, ...scopeProblems(limits, graph)])];
  if (!problems.length) return [];
  return [
    `This plan needs a person at approval: ${problems.join("; ")}. Automatic approval covers at most ${limits.maxTasks} tasks and ${limits.maxFiles} files under ${limits.allowedPaths.join(", ")}${limits.allowDelete ? "" : " without deletions"}. Drop writes the requirements do not need (an optional refactor, a type or helper that can live in a file already written) and merge small tasks; if every listed write is needed, submit the same plan again and a person approves it.`,
  ];
}

/**
 * A renewal stays within the latest human approval: the same or fewer writes, the same task
 * profiles and frozen inputs, and no wider capabilities. The remaining policy settings (checks,
 * budgets, auto approval) must match that approval, or match the policy the operator set later
 * with an explicit command, because that command is itself a human decision.
 */
function renewalProblems(
  policy: RunPolicy,
  manifest: InputManifest,
  graph: TaskGraph,
  requests: RequestRow[],
  decisions: PolicyDecision[],
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
  const operatorSet = decisions.some((decision) => decision.policyHash === current);
  if (!operatorSet) {
    if (canonical(settings(policy)) !== canonical(settings(approved)))
      problems.push("checks or other policy settings changed without an operator decision");
    for (const key of budgetKeys)
      if (policy[key] > approved[key])
        problems.push(`${key} grew from ${approved[key]} to ${policy[key]}`);
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

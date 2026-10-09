import { canonical, hashJson } from "../specs/hash.js";
import type { InputManifest, RunPolicy, Spec, TaskGraph } from "./schemas.js";
import type { RequestRow } from "./store.js";

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
type Write = TaskGraph["tasks"][number]["writes"][number];

/** Paths that always need a person, whatever the limits (design section 5.2). */
const alwaysHuman =
  /^(?:\.git|\.baked|baked|specs|\.github|\.gitlab|\.circleci|\.husky)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|constitution\.md|package\.json|bunfig\.toml|Cargo\.toml|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|Gemfile|[^/]*[.-]lock(?:b|\.[^/]*)?|tsconfig[^/]*|biome[^/]*|\.env(?:\.[^/]*)?|\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|[^/]*\.(?:pem|key|crt|cer|p12|pfx|jks|keystore))$/i;

/** Budget limits a renewal may keep or lower, never raise. */
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
): AutoApprovalResult {
  const config = policy.autoApproval;
  if (!config) return { approval: null, reasons: [] };
  const writes = graph.tasks.flatMap((task) => task.writes);
  const common: string[] = [];
  for (const write of writes)
    if (alwaysHuman.test(write.path)) common.push(`${write.path} always needs a person`);
  if (spec.criteria.some((criterion) => criterion.method === "post-release"))
    common.push("Deferring post-release criteria needs a person");
  const limitsHash = hashJson({ policy: policyBounds(policy) });
  const reasons: string[] = [...common];
  if (config.renewal) {
    const renewal = renewalProblems(policy, manifest, writes, requests);
    if (!common.length && !renewal.length)
      return { approval: { mode: "renewal", limitsHash }, reasons: [] };
    reasons.push(...renewal.map((reason) => `Renewal: ${reason}`));
  }
  if (config.limits) {
    const limits = config.limits;
    const problems: string[] = [];
    if (graph.tasks.length > limits.maxTasks)
      problems.push(`${graph.tasks.length} tasks exceed ${limits.maxTasks}`);
    const files = new Set(writes.map((write) => write.path.toLowerCase()));
    if (files.size > limits.maxFiles)
      problems.push(`${files.size} files exceed ${limits.maxFiles}`);
    const globs = limits.allowedPaths.map((pattern) => new Bun.Glob(pattern.toLowerCase()));
    for (const write of writes) {
      if (!globs.some((glob) => glob.match(write.path.toLowerCase())))
        problems.push(`${write.path} is outside the allowed paths`);
      if (write.action === "delete" && !limits.allowDelete)
        problems.push(`${write.path} would be deleted`);
    }
    if (policy.maxTotalTokens > limits.maxTotalTokens)
      problems.push(`the token budget ${policy.maxTotalTokens} exceeds ${limits.maxTotalTokens}`);
    if (!common.length && !problems.length)
      return { approval: { mode: "limits", limitsHash }, reasons: [] };
    reasons.push(...problems.map((reason) => `Limits: ${reason}`));
  }
  return { approval: null, reasons: [...new Set(reasons)] };
}

/** A renewal stays within the latest human approval: same or fewer files, same checks, no larger budget. */
function renewalProblems(
  policy: RunPolicy,
  manifest: InputManifest,
  writes: Write[],
  requests: RequestRow[],
): string[] {
  const previous = requests.filter(
    (request) =>
      request.kind === "approval" && request.status === "accepted" && request.actor === "user",
  );
  const last = previous.at(-1);
  if (!last) return ["no earlier human approval in this run"];
  const body = JSON.parse(last.body_json) as {
    manifest?: InputManifest;
    writes?: Write[];
    policy?: RunPolicy;
  };
  if (!body.manifest || !body.writes || !body.policy)
    return ["the earlier approval does not record its scope"];
  const problems: string[] = [];
  const approved = body.policy;
  if (canonical(policyBounds(policy, false)) !== canonical(policyBounds(approved, false)))
    problems.push("checks, tools or other policy settings changed");
  for (const key of budgetKeys)
    if (policy[key] > approved[key])
      problems.push(`${key} grew from ${approved[key]} to ${policy[key]}`);
  for (const key of ["workflowHash", "profileHashes", "skillHashes"] as const)
    if (canonical(manifest[key]) !== canonical(body.manifest[key])) problems.push(`${key} changed`);
  for (const write of writes) {
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

/** Policy without its budget numbers, or all of it; this is what a renewal must keep equal. */
function policyBounds(policy: RunPolicy, withBudget = true): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...policy };
  if (!withBudget) for (const key of budgetKeys) delete copy[key];
  return copy;
}

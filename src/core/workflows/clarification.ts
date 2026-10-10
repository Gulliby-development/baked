import type { AgentProfile, RunPolicy } from "./schemas.js";

/**
 * Research, specification and analysis run before any code changes, so they cannot know check
 * outcomes: the checks stage produces them after implementation. A question about outcomes
 * that were "not run" is therefore never one only the user can answer.
 */
const CHECK_TERMS =
  /\b(lint(?:er|ing)?|typecheck(?:s|ing)?|type[- ]checks?|tests?|test suite|checks?|builds?|validate-locales)\b/i;
const NOT_RUN =
  /\b(no|not|never|without|unrun)\b[^.;:]{0,60}\b(run|ran|executed|performed)\b|\b(outcomes?|results?|status|state)\b[^.;:]{0,40}\b(unknown|unverified|not known|undetermined)\b/i;

export function deferredToChecks(text: string): boolean {
  return CHECK_TERMS.test(text) && NOT_RUN.test(text);
}

/**
 * The policy's checks are the verification the operator chose for the run. A finding that the
 * checks are narrower than the project's usual verification (one test file instead of the whole
 * suite, no build) restates that choice; only the operator could answer it, and they already did.
 */
const WIDER_VERIFICATION =
  /\b(full|whole|entire|complete)\b[^.;:]{0,20}\b(test[- ]?)?suite\b|\bbun (run )?(test|build)\b(?![\w./-]*\.(test|spec)\.)|\bbuild\b[^.;:]{0,40}\b(check|step|command)\b/i;
const POLICY_SCOPE =
  /\b(polic(y|ies)|executionContract|verification|checks?|AGENTS\.md|CONTRIBUTING|project instructions)\b/i;
const NARROWER =
  /\b(missing|lacks?|lacking|omits?|omitted|absent|narrow(er|ed|s)?|only|not (include|includ(ed|ing)|run|cover(ed)?|require[ds]?)|does(n't| not)|without|instead of|excludes?|scoped)\b/i;

export function narrowsVerification(text: string): boolean {
  return WIDER_VERIFICATION.test(text) && POLICY_SCOPE.test(text) && NARROWER.test(text);
}

const resolvedLater = (text: string): boolean =>
  deferredToChecks(text) || narrowsVerification(text);

const DEFERRED_PROBLEM =
  "is blocking, but check outcomes are produced by the checks stage after implementation and this stage cannot run commands. Set blocking to false (or move the check to constraints) and submit again.";

const NARROWED_PROBLEM =
  "is blocking, but the policy checks are the verification the operator chose for this run; narrower checks than the project's usual verification are deliberate. Set blocking to false and submit again.";

/** Submission errors for blocking items that later stages resolve; returned to the agent. */
export function deferredBlockingProblems(
  items: readonly { blocking: boolean }[],
  text: (item: { blocking: boolean }, index: number) => string,
): string[] {
  return items.flatMap((item, index) => {
    if (!item.blocking) return [];
    const body = text(item, index);
    const problem = narrowsVerification(body)
      ? NARROWED_PROBLEM
      : deferredToChecks(body)
        ? DEFERRED_PROBLEM
        : null;
    return problem ? [`Item ${String(index + 1)} ("${body.slice(0, 120)}") ${problem}`] : [];
  });
}

/** Keep deferred items as notes, never as a reason to stop the run for the user. */
export function demoteDeferred<T extends { blocking: boolean }>(
  items: readonly T[],
  text: (item: T) => string,
): T[] {
  return items.map((item) =>
    item.blocking && resolvedLater(text(item)) ? { ...item, blocking: false } : item,
  );
}

/**
 * With `clarification: "assume"`, a blocking question goes back to the agent that raised it. Every
 * answer people gave in benchmark runs was the conventional default (0% shares for a zero total,
 * the feed title from the site name), and each cost a specify, plan and analyze cycle.
 */
export const ASSUME_NOTE =
  'Settle it yourself: choose the most conventional default a user of this feature would expect, apply it, record it in assumptions as "<question> Assumed: <default>, because <reason>.", and mark the question non-blocking. Keep it blocking only when every reasonable default risks data loss, security, money or an irreversible public interface, and say which in the question.';

/** Submission errors for blocking questions when the policy assumes defaults. */
export function assumeProblems(
  policy: Pick<RunPolicy, "clarification">,
  items: readonly { blocking: boolean }[],
  text: (item: { blocking: boolean }, index: number) => string,
): string[] {
  if (policy.clarification !== "assume") return [];
  return items.flatMap((item, index) =>
    item.blocking && !resolvedLater(text(item, index))
      ? [
          `Question ${String(index + 1)} ("${text(item, index).slice(0, 120)}") is blocking. ${ASSUME_NOTE}`,
        ]
      : [],
  );
}

const SPEC_REF = /(^|[^a-z])spec(\.json|\.md)?\b|^(FR|NFR|AC)-\d+/i;

const PLAN_REF = /(^|[^a-z])(plan\.md|tasks\.(json|md))\b|^T\d+\b/i;

/**
 * Blocking analysis findings the planner can fix alone: a coverage gap in the plan (it names the
 * criteria the tasks miss, so spec references are expected), or an inconsistency that refers only
 * to the plan (plan.md, tasks.json). Runs 2fa658c0 and b0d7484c asked a person about tasks that
 * did not cover some criteria.
 */
export function planOnlyFindings<T extends { kind: string; refs: string[]; blocking: boolean }>(
  findings: readonly T[],
): T[] {
  const blocking = findings.filter((f) => f.blocking);
  const refs = (f: T, pattern: RegExp) => f.refs.some((ref) => pattern.test(ref.trim()));
  return blocking.length > 0 &&
    blocking.every(
      (f) =>
        (f.kind === "coverage" && refs(f, PLAN_REF)) ||
        (f.kind === "inconsistency" && !refs(f, SPEC_REF)),
    )
    ? blocking
    : [];
}

/**
 * The stage to continue from after the user answers a clarification raised at `askingIndex`.
 * The answer is appended to the request, so completed outputs stay valid unless they are the
 * ones the questions were about:
 * - research questions do not invalidate the research report; continue with the next stage;
 * - spec questions require a new spec; repeat specify;
 * - analysis findings repeat specify when a finding refers to the spec, otherwise plan.
 */
export function clarificationResumeIndex(
  stages: readonly { kind: string }[],
  askingIndex: number,
  body: unknown,
): number {
  const index = (kind: string): number => {
    const found = stages.findIndex((stage) => stage.kind === kind);
    return found < 0 ? askingIndex : found;
  };
  switch (stages[askingIndex]?.kind) {
    case "research":
      return askingIndex + 1;
    case "specify":
      return askingIndex;
    case "analyze": {
      const findings =
        body && typeof body === "object" && "findings" in body && Array.isArray(body.findings)
          ? (body.findings as { refs?: unknown; blocking?: unknown }[])
          : [];
      const relevant = findings.some((f) => f.blocking === true)
        ? findings.filter((f) => f.blocking === true)
        : findings;
      const touchesSpec = relevant.some(
        (finding) =>
          Array.isArray(finding.refs) &&
          finding.refs.some((ref) => typeof ref === "string" && SPEC_REF.test(ref.trim())),
      );
      return touchesSpec || relevant.length === 0 ? index("specify") : index("plan");
    }
    default:
      return askingIndex;
  }
}

/** Steps a research attempt gets per path the request names, on top of the base. */
export const RESEARCH_STEPS_PER_PATH = 2;
export const RESEARCH_BASE_STEPS = 4;
/** Planner profiles that do their own research when a definition has no research stage. */
export const SCOPING_PLANNERS: ReadonlySet<string> = new Set(["quick-planner"]);
/** Steps a scoping planner gets on top of the research steps to write and submit the plan. */
export const PLAN_SUBMIT_STEPS = 2;
/**
 * Tokens allowed per scoping-planner step. Its prompt also carries the spec and the profiles, and
 * its answer is the whole plan and task graph, so a step costs more than a research step.
 */
export const PLAN_STEP_TOKENS = 20_000;
/** Tokens allowed per research step: one replayed history (~12k) plus the answer. */
export const RESEARCH_STEP_TOKENS = 14_000;
const SOURCE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|rb|php|cs|c|h|cpp|hpp|swift|sql|toml|ya?ml|css|scss|html|sh|txt)$/i;

/** Distinct file paths a request names; their number is the research scope. */
export function namedPaths(prompt: string): string[] {
  const found = new Set<string>();
  for (const match of prompt.matchAll(/[\w@.-]*(?:\/[\w@.-]+)*\.[A-Za-z]{1,5}\b/g)) {
    const path = match[0].replace(/^\.\//, "");
    if (SOURCE_EXTENSIONS.test(path) && /[\w-]/.test(path.split(".")[0] ?? "")) found.add(path);
  }
  return [...found];
}

/**
 * A research budget proportional to the request: a request that names its files needs targeted
 * reads of those files and their direct dependencies, not a survey of the repository. A request
 * that names no file keeps the profile limit.
 */
export function researchBudget(
  prompt: string,
  profile: Pick<AgentProfile, "maxSteps">,
  policy: Pick<RunPolicy, "maxAgentSteps" | "maxAttemptTokens">,
): { maxSteps: number; maxTokens: number | undefined; namedPaths: string[] } {
  const paths = namedPaths(prompt);
  const ceiling = Math.min(profile.maxSteps, policy.maxAgentSteps);
  const maxSteps = paths.length
    ? Math.min(ceiling, RESEARCH_BASE_STEPS + RESEARCH_STEPS_PER_PATH * paths.length)
    : ceiling;
  const scaled = maxSteps * RESEARCH_STEP_TOKENS;
  return {
    maxSteps,
    maxTokens: paths.length ? Math.min(scaled, policy.maxAttemptTokens ?? scaled) : undefined,
    namedPaths: paths,
  };
}

/**
 * The budget of a planner that finds the files itself because the definition has no research
 * stage: the research steps for the request plus the steps to write the plan. A request that
 * names no file keeps the profile limit.
 */
export function scopedPlanBudget(
  prompt: string,
  profile: Pick<AgentProfile, "maxSteps">,
  policy: Pick<RunPolicy, "maxAgentSteps" | "maxAttemptTokens">,
): { maxSteps: number; maxTokens: number | undefined; namedPaths: string[] } {
  const paths = namedPaths(prompt);
  const ceiling = Math.min(profile.maxSteps, policy.maxAgentSteps);
  const maxSteps = paths.length
    ? Math.min(
        ceiling,
        RESEARCH_BASE_STEPS + RESEARCH_STEPS_PER_PATH * paths.length + PLAN_SUBMIT_STEPS,
      )
    : ceiling;
  const scaled = maxSteps * PLAN_STEP_TOKENS;
  return {
    maxSteps,
    maxTokens: paths.length ? Math.min(scaled, policy.maxAttemptTokens ?? scaled) : undefined,
    namedPaths: paths,
  };
}

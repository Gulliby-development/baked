/**
 * Following a delivered pull request: host code reads the checks GitHub reports on the delivered
 * commit, with no model calls, and turns failed checks into the request of a `fix-ci` run whose
 * result goes back to the same pull request as a follow-up delivery (#330).
 */
import type { AppConfig } from "../../types/index.js";
import { configuredPullRequests, latestPushedDelivery } from "./delivery.js";
import type { CommitCheck, PullRequestProvider } from "./delivery-provider.js";
import { WorkflowFault } from "./errors.js";
import { uniqueFeatureId } from "./feature-id.js";
import type { WorkflowStore } from "./store.js";

export interface PullRequestChecks {
  runId: string;
  repository: string;
  branch: string;
  commit: string;
  pullRequest: { number: number; url: string } | null;
  /** `none` until the host reports a check; `failed` as soon as one failed. */
  state: "none" | "pending" | "passed" | "failed";
  checks: CommitCheck[];
  checkedAt: string;
}
export interface FollowOptions {
  /** Seconds between reads, 5 to 3600. */
  intervalSeconds?: number;
  /** How long to wait for every check to finish, 1 to 1440 minutes. */
  timeoutMinutes?: number;
  signal?: AbortSignal;
  provider?: PullRequestProvider | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
export type FollowOutcome = PullRequestChecks & { outcome: "passed" | "failed" | "timeout" };

const refuse = (code: "NOT_FOUND" | "CAPABILITY_DENIED", reason: string, message: string) =>
  new WorkflowFault(code, message, { reason });

/** One read of the checks on the commit the run's latest delivery pushed. */
export async function pullRequestChecks(
  store: WorkflowStore,
  config: AppConfig,
  runId: string,
  provider: PullRequestProvider | null = configuredPullRequests(config),
): Promise<PullRequestChecks> {
  store.run(runId);
  const delivered = latestPushedDelivery(store, runId);
  if (!delivered?.result.commit)
    throw refuse(
      "NOT_FOUND",
      "not_delivered",
      `Run ${runId} has no pushed delivery to follow. Deliver it first with \`baked workflow deliver ${runId}\`.`,
    );
  const { result } = delivered;
  const repository = provider?.repository(result.remote.url) ?? null;
  if (!provider?.checks || !repository)
    throw refuse(
      "CAPABILITY_DENIED",
      "unsupported_remote",
      `The checks of ${result.remote.url} cannot be read; following needs a GitHub remote.`,
    );
  const unavailable = provider.unavailable();
  if (unavailable) throw refuse("CAPABILITY_DENIED", "missing_auth", unavailable);
  const checks = await provider.checks(repository, result.commit as string);
  return {
    runId,
    repository,
    branch: result.branch,
    commit: result.commit as string,
    pullRequest: result.pullRequest
      ? { number: result.pullRequest.number, url: result.pullRequest.url }
      : null,
    state: checksState(checks),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

export function checksState(checks: readonly CommitCheck[]): PullRequestChecks["state"] {
  if (!checks.length) return "none";
  if (checks.some((c) => c.state === "failed")) return "failed";
  return checks.some((c) => c.state === "pending") ? "pending" : "passed";
}

const sleeping = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });

/**
 * Reads the checks until one fails or all pass, or until the timeout. A failure answers at once,
 * so a fix can start while slower checks still run. No model is called while it waits.
 */
export async function followPullRequest(
  store: WorkflowStore,
  config: AppConfig,
  runId: string,
  options: FollowOptions = {},
): Promise<FollowOutcome> {
  const interval = Math.min(3600, Math.max(5, options.intervalSeconds ?? 60)) * 1000;
  const timeout = Math.min(1440, Math.max(1, options.timeoutMinutes ?? 60)) * 60_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleeping;
  const provider =
    options.provider === undefined ? configuredPullRequests(config) : options.provider;
  const deadline = now() + timeout;
  for (;;) {
    const read = await pullRequestChecks(store, config, runId, provider);
    if (read.state === "passed" || read.state === "failed") return { ...read, outcome: read.state };
    if (now() + interval > deadline) return { ...read, outcome: "timeout" };
    await sleep(interval, options.signal);
  }
}

/** The request and feature ID of a `fix-ci` run for the failed checks of a followed run. */
export function fixChecksRequest(
  store: WorkflowStore,
  checks: PullRequestChecks,
): { workflowId: "fix-ci"; featureId: string; prompt: string; followUp: string } {
  const failed = checks.checks.filter((c) => c.state === "failed");
  if (!failed.length)
    throw new WorkflowFault("STALE_DECISION", "No check failed on the delivered commit", {
      reason: "no_failed_checks",
    });
  const feature = store.run(checks.runId).feature_id;
  const where = checks.pullRequest
    ? `pull request ${checks.pullRequest.url}`
    : `branch ${checks.branch}`;
  const prompt = [
    `Checks failed on ${where} (branch ${checks.branch}, commit ${checks.commit}):`,
    "",
    ...failed.map(
      (c) =>
        `- ${c.name}${c.detail ? `: ${c.detail.replace(/\s+/g, " ").trim()}` : ""}${c.url ? ` (${c.url})` : ""}`,
    ),
    "",
    "Reproduce these failures in this workspace, find their cause and fix it without weakening the checks.",
  ].join("\n");
  return {
    workflowId: "fix-ci",
    featureId: uniqueFeatureId(`${feature}-ci`, (id) => store.list(1, id).items.length > 0),
    prompt,
    followUp: checks.runId,
  };
}

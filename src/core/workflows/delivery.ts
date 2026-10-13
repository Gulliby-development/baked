/**
 * Git delivery of a completed run: a plan the user approves by its digest, then commit, push and
 * pull request as journaled external effects. The user's checkout, index, HEAD and files are never
 * changed; the commit is built from the run's files in a temporary index. No force push, no merge.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../types/index.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { workspacePath } from "../specs/validate.js";
import { changedPaths } from "../verification/snapshot.js";
import {
  classifyRemoteFailure,
  git,
  gitMode,
  internalPath,
  looksSecret,
  type RemoteFailure,
  statusPaths,
} from "./delivery-git.js";
import {
  githubPullRequests,
  type PullRequest,
  PullRequestError,
  type PullRequestProvider,
  type ReviewThread,
} from "./delivery-provider.js";
import { fileHash } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { closingReference, type IssueSource } from "./issue-source.js";
import { mutationLeaseFor, WorkspaceLeases } from "./leases.js";
import { PULL_REQUEST_BODY_LIMIT, runReport } from "./run-report.js";
import {
  type Decision,
  DeliveryConfigSchema,
  type WorkflowErrorCode,
  workflowsEnabled,
} from "./schemas.js";
import { type EffectRow, newId, type RequestRow, type WorkflowStore } from "./store.js";
import { removeRunWorktree } from "./worktree.js";

export type DeliveryOperation = "commit" | "push" | "pull_request" | "review_replies";
export interface DeliveryFile {
  path: string;
  action: "add" | "modify" | "delete";
  /** SHA-256 of the content to commit; null for a deletion. */
  hash: string | null;
  mode: "100644" | "100755" | null;
}
export interface DeliveryExclusion {
  path: string;
  reason: "secret" | "internal" | "ignored" | "symlink" | "unchanged" | "specs";
}
export interface DeliveryPlan {
  schemaVersion: 1;
  planId: string;
  runId: string;
  featureId: string;
  runRevision: number;
  snapshotId: string;
  workspaceHash: string | null;
  approvalRoot: string | null;
  /** Seconds since the epoch; also the author and committer date, so the commit is reproducible. */
  createdAt: number;
  operations: DeliveryOperation[];
  remote: { name: string; url: string };
  branch: string;
  base: { commit: string; branch: string };
  baselineHead: string | null;
  headMoved: boolean;
  author: { name: string; email: string };
  files: DeliveryFile[];
  excluded: DeliveryExclusion[];
  /** Uncommitted changes in the workspace that are not part of the delivery; left untouched. */
  userChanges: string[];
  /**
   * The run branch a worktree run's files are delivered from: the content is read in its worktree,
   * which holds the branch's accepted commit. Absent for a run executed in the working copy.
   */
  worktree?: { path: string; branch: string; commit: string };
  /**
   * A follow-up delivery: the commit goes onto the branch an earlier run delivered, on top of its
   * remote tip (`base.commit`), and the pull request that run opened stays the one under review.
   * `base.branch` stays the pull request's base branch. Absent for a delivery to a new branch.
   */
  followUp?: FollowUp;
  /**
   * Review threads of the followed pull request that get a reply after the follow-up push, and
   * are resolved when `resolve` is set. `{commit}` in the body is the pushed commit.
   */
  reviewReplies?: ReviewReplies;
  diff: { artifactId: string; hash: string; lines: number; truncated: boolean };
  commitMessage: string;
  pullRequest: {
    provider: string;
    repository: string;
    title: string;
    body: string;
    base: string;
    draft: boolean;
  } | null;
  evidence: {
    checks: { id: string; status: string; validity: string }[];
    review: string | null;
    criteria: { id: string; verdict: string }[];
    openFindings: number;
  };
}
export interface FollowUp {
  /** The run whose delivered branch receives the commit. */
  runId: string;
  planId: string;
  pullRequest: (PullRequest & { recordedBy: "provider" | "user" }) | null;
}
export interface ReviewReplies {
  provider: string;
  repository: string;
  pullRequest: number;
  threads: { id: string; path: string; url: string }[];
  resolve: boolean;
  body: string;
}
export interface PreparedDelivery {
  planId: string;
  requestId: string;
  digest: string;
  revision: number;
  plan: DeliveryPlan;
  diff: string;
}
export interface DeliveryResult {
  schemaVersion: 1;
  planId: string;
  runId: string;
  digest: string;
  runRevision: number;
  snapshotId: string;
  approvalRoot: string | null;
  remote: { name: string; url: string };
  branch: string;
  commit: string | null;
  pullRequest: (PullRequest & { recordedBy: "provider" | "user" }) | null;
  operations: { operation: DeliveryOperation; effectId: string; status: EffectRow["status"] }[];
  deliveredAt: string;
}

const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const DELIVERY_STAGE = "delivery";

function refuse(
  code: WorkflowErrorCode,
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): WorkflowFault {
  return new WorkflowFault(code, message, { reason, ...details });
}

function deliveryConfig(config: AppConfig) {
  if (!workflowsEnabled(config))
    throw new WorkflowFault(
      "CAPABILITY_DENIED",
      "Workflows are turned off by workflows.enabled: false in the configuration.",
    );
  return DeliveryConfigSchema.parse(config.workflows?.delivery ?? {});
}

/** The pull request provider the configuration names, with its token read from the environment. */
export function configuredPullRequests(config: AppConfig): PullRequestProvider {
  const settings = deliveryConfig(config);
  return githubPullRequests({
    token: process.env[settings.tokenEnv] || undefined,
    tokenEnv: settings.tokenEnv,
    apiUrl: settings.apiUrl,
  });
}

async function assertRepository(workspace: string): Promise<void> {
  const inside = await git(workspace, ["rev-parse", "--show-toplevel"]);
  if (inside.code !== 0)
    throw refuse(
      "CAPABILITY_DENIED",
      "git_required",
      "Git delivery requires a Git repository. This workspace is a plain directory: run `git init`, commit a baseline and add a remote, or copy the changed files by hand.",
    );
  const top = inside.stdout.trim();
  const prefix = (await git(workspace, ["rev-parse", "--show-prefix"])).stdout.trim();
  if (prefix !== "")
    throw refuse(
      "CAPABILITY_DENIED",
      "git_required",
      `Git delivery requires the workspace to be the root of its repository (${top}).`,
    );
}

async function remoteUrl(workspace: string, name: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name))
    throw refuse("INVALID_DEFINITION", "invalid_remote", `Invalid remote name ${name}`);
  const result = await git(workspace, ["remote", "get-url", "--push", name]);
  if (result.code !== 0 || !result.stdout.trim())
    throw refuse(
      "NOT_FOUND",
      "missing_remote",
      `Git remote ${name} is not configured. Add it with \`git remote add ${name} URL\` or pass --remote.`,
    );
  return result.stdout.trim();
}

/** Content hash of a path in a commit, in its working tree form (filters applied), or null. */
async function contentAt(workspace: string, commit: string, path: string): Promise<string | null> {
  const result = await git(workspace, ["cat-file", "--filters", `${commit}:${path}`]);
  return result.code === 0 ? hashBytes(result.bytes) : null;
}

async function modeAt(
  workspace: string,
  commit: string,
  path: string,
): Promise<"100644" | "100755"> {
  const entry = (await git(workspace, ["ls-tree", commit, "--", path])).stdout;
  return entry.startsWith("100755") ? "100755" : "100644";
}

function baselineOf(
  store: WorkflowStore,
  runId: string,
  snapshotId: string | null,
): { head: string | null; userChanges: Set<string> } {
  for (const artifact of store.artifacts(runId).filter((a) => a.kind === "baseline")) {
    const body = JSON.parse(store.readArtifact(runId, artifact.id)) as {
      snapshotId?: string;
      repository?: { head?: string | null; userChanges?: string[] } | null;
    };
    if (body.snapshotId !== snapshotId) continue;
    return {
      head: body.repository?.head ?? null,
      userChanges: new Set(statusPaths((body.repository?.userChanges ?? []).join("\0"))),
    };
  }
  return { head: null, userChanges: new Set() };
}

/** First known content before the run wrote a path, and the last content it wrote, by path. */
function journaledPaths(
  store: WorkflowStore,
  runId: string,
): Map<string, { before: string | null; after: string | null }> {
  const paths = new Map<string, { before: string | null; after: string | null }>();
  for (const effect of store.effects(runId)) {
    if (effect.kind !== "file_patch" && effect.kind !== "artifact_write") continue;
    if (effect.status !== "applied" && effect.status !== "reconciled") continue;
    const { path } = JSON.parse(effect.intent_json) as { path?: string };
    if (!path) continue;
    const known = paths.get(path);
    paths.set(path, {
      before: known ? known.before : effect.before_hash,
      after: effect.after_hash,
    });
  }
  return paths;
}

function evidenceOf(store: WorkflowStore, runId: string): DeliveryPlan["evidence"] {
  const state = store.state(runId);
  const latest = new Map<string, { id: string; status: string; validity: string }>();
  for (const row of store.checkDetails(runId))
    latest.set(row.check_id, { id: row.check_id, status: row.status, validity: row.validity });
  return {
    checks: [...latest.values()],
    review: state.convergence?.verdict ?? null,
    criteria:
      state.convergence?.coverage.map((c) => ({ id: c.criterionId, verdict: c.verdict })) ?? [],
    openFindings: store
      .findings(runId)
      .filter((f) => f.status === "open" || f.status === "confirmed").length,
  };
}

async function reviewableDiff(
  workspace: string,
  base: string,
  files: DeliveryFile[],
): Promise<{ text: string; truncated: boolean }> {
  // A temporary index of the base commit, so a file the base tracks is compared with the working
  // file even when the checkout does not track it (a follow-up built on another branch).
  const directory = mkdtempSync(join(tmpdir(), "baked-delivery-diff-"));
  const env = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    await git(workspace, ["read-tree", base], { env });
    const parts: string[] = [];
    let bytes = 0;
    for (const file of files) {
      const result =
        file.action === "add"
          ? await git(workspace, [
              "diff",
              "--no-color",
              "--no-ext-diff",
              "--no-index",
              "--",
              "/dev/null",
              file.path,
            ])
          : await git(workspace, ["diff", "--no-color", "--no-ext-diff", base, "--", file.path], {
              env,
            });
      bytes += result.bytes.length;
      if (bytes > MAX_DIFF_BYTES) return { text: parts.join(""), truncated: true };
      parts.push(result.stdout);
    }
    return { text: parts.join(""), truncated: false };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function message(
  plan: Pick<DeliveryPlan, "runId" | "featureId" | "planId" | "evidence">,
  title: string,
  outcome: string | null,
): string {
  const checks = plan.evidence.checks.map((c) => `${c.id} ${c.status}`).join(", ");
  return [
    title,
    "",
    ...(outcome ? [outcome, ""] : []),
    `Delivered by BAKED workflow run ${plan.runId} (feature ${plan.featureId}).`,
    ...(checks ? [`Checks: ${checks}.`] : []),
    ...(plan.evidence.review ? [`Review: ${plan.evidence.review}.`] : []),
    "",
    `Baked-Run: ${plan.runId}`,
    `Baked-Delivery: ${plan.planId}`,
    "",
  ].join("\n");
}

/** The run report with what this delivery commits; the plan digest covers the exact text. */
function pullRequestBody(
  store: WorkflowStore,
  plan: Omit<DeliveryPlan, "pullRequest" | "commitMessage" | "diff">,
): string {
  const appendix = [
    "## Delivery",
    "",
    ...plan.files.map((f) => `- ${f.action} \`${f.path}\``),
    ...(plan.excluded.length
      ? ["", "Not delivered:", "", ...plan.excluded.map((e) => `- \`${e.path}\` (${e.reason})`)]
      : []),
    "",
    `Run \`${plan.runId}\`, snapshot \`${plan.snapshotId}\`, base \`${plan.base.commit}\`.`,
  ].join("\n");
  return runReport(store, plan.runId, { maxChars: PULL_REQUEST_BODY_LIMIT, appendix });
}

/** The body of a run started from an issue opens with the line that closes it on merge. */
function closingIssue(issue: IssueSource | null, repository: string, body: string): string {
  return issue ? `${closingReference(issue, repository)}\n\n${body}` : body;
}

export interface PrepareDeliveryOptions {
  remote?: string;
  branch?: string;
  draft?: boolean;
  /** False plans commit and push only. */
  pullRequest?: boolean;
  /**
   * Whether the run's published `specs/FEATURE/` documents go into the commit. By default they do
   * only when the base commit already tracks a `specs/` directory: in a repository that does not
   * keep specs, they are noise in the reviewer's diff and stay in the run's artifacts.
   */
  specs?: boolean;
  provider?: PullRequestProvider | null;
  /**
   * A run whose delivered branch receives this run's commit instead of a new branch: a fix for a
   * failed check or a review of that pull request. No pull request is opened; the earlier one
   * shows the new commit.
   */
  followUp?: string;
  /**
   * Review threads of the followed pull request to answer once the follow-up commit is pushed;
   * `resolve` also resolves them. Needs `followUp`.
   */
  answer?: { threads: string[]; resolve?: boolean };
  /** Seconds since the epoch for the plan and commit dates; defaults to now. */
  now?: number;
}

/**
 * Prepares the delivery of a completed, currently verified run: which of the run's files go into
 * one commit on a new branch, the reviewable diff, the message and the pull request. The plan is
 * stored as an immutable artifact and a pending `delivery` request names its digest.
 */
export async function prepareDelivery(
  store: WorkflowStore,
  config: AppConfig,
  runId: string,
  options: PrepareDeliveryOptions = {},
): Promise<PreparedDelivery> {
  deliveryConfig(config);
  const workspace = store.workspace;
  const run = store.run(runId);
  if (run.status !== "completed")
    throw refuse(
      "STALE_DECISION",
      "run_not_completed",
      `Only a completed run can be delivered; run ${runId} is ${run.status}.`,
    );
  const state = store.state(runId);
  if (state.verificationState !== "current" || !state.snapshotId)
    throw refuse(
      "INPUT_CHANGED",
      "verification_not_current",
      `The run's verification is ${state.verificationState}; deliver only a currently verified result.`,
    );
  await assertRepository(workspace);
  const source = await worktreeSource(store, runId);
  const contentRoot = source ? join(workspace, source.path) : workspace;
  const head = (await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
  if (!head)
    throw refuse(
      "INPUT_CHANGED",
      "no_commits",
      "Git delivery needs a repository with at least one commit.",
    );
  const currentBranch = await git(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (currentBranch.code !== 0)
    throw refuse(
      "INPUT_CHANGED",
      "detached_head",
      "HEAD is detached. Check out the branch the delivery should be based on.",
    );
  const earlier = options.followUp ? followedDelivery(store, runId, options.followUp) : null;
  if (options.answer?.threads.length && !earlier) throw answerWithoutFollowUp();
  const remoteName = options.remote ?? earlier?.result.remote.name ?? "origin";
  const url = await remoteUrl(workspace, remoteName);
  if (earlier && url !== earlier.result.remote.url)
    throw refuse(
      "INPUT_CHANGED",
      "remote_changed",
      `Run ${earlier.result.runId} was delivered to ${earlier.result.remote.url}, but ${remoteName} is ${url}.`,
    );
  const follow = earlier ? await followedTip(workspace, remoteName, earlier.result.branch) : null;
  // The commit is built on the followed branch's tip; otherwise on HEAD.
  const base = follow ?? head;
  const name = (await git(workspace, ["config", "user.name"])).stdout.trim();
  const email = (await git(workspace, ["config", "user.email"])).stdout.trim();
  if (!name || !email)
    throw refuse(
      "INVALID_DEFINITION",
      "missing_identity",
      "Git user.name and user.email must be configured to author the delivery commit.",
    );

  const finalFiles = store.snapshotFiles(runId, state.snapshotId) ?? state.expectedFiles ?? {};
  const baselineId = state.manifest.baselineSnapshotId;
  const baselineFiles = (baselineId && store.snapshotFiles(runId, baselineId)) || {};
  const baseline = baselineOf(store, runId, baselineId);
  const journal = journaledPaths(store, runId);
  const declared = new Set(state.graph?.tasks.flatMap((t) => t.writes.map((w) => w.path)) ?? []);
  const candidates = [
    ...new Set([
      ...journal.keys(),
      ...changedPaths(baselineFiles, finalFiles).filter((p) => declared.has(p)),
    ]),
  ].sort();

  const specsDir = `specs/${run.feature_id}/`;
  const withSpecs =
    options.specs ??
    (await git(workspace, ["ls-tree", "--name-only", base, "--", "specs"])).stdout.trim() !== "";
  const files: DeliveryFile[] = [];
  const excluded: DeliveryExclusion[] = [];
  const dirty: string[] = [];
  const mismatched: { path: string; cause: string }[] = [];
  for (const path of candidates) {
    if (internalPath(path)) {
      excluded.push({ path, reason: "internal" });
      continue;
    }
    if (!withSpecs && path.startsWith(specsDir)) {
      excluded.push({ path, reason: "specs" });
      continue;
    }
    if (looksSecret(path)) {
      excluded.push({ path, reason: "secret" });
      continue;
    }
    const absolute = workspacePath(contentRoot, path);
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(absolute);
    } catch {
      stat = null;
    }
    if (stat?.isSymbolicLink()) {
      excluded.push({ path, reason: "symlink" });
      continue;
    }
    const current = stat ? fileHash(absolute) : null;
    const expected =
      path in finalFiles ? (finalFiles[path] ?? null) : (journal.get(path)?.after ?? null);
    if (current !== expected) {
      dirty.push(path);
      continue;
    }
    const atBase = await contentAt(workspace, base, path);
    if (current === atBase) {
      excluded.push({ path, reason: "unchanged" });
      continue;
    }
    if (atBase === null && current !== null) {
      const ignored = await git(workspace, ["check-ignore", "-q", "--", path]);
      if (ignored.code === 0) {
        excluded.push({ path, reason: "ignored" });
        continue;
      }
    }
    const original = journal.has(path)
      ? (journal.get(path)?.before ?? null)
      : (baselineFiles[path] ?? null);
    if (original !== atBase) {
      mismatched.push({
        path,
        cause: earlier
          ? `differs on ${earlier.result.branch} from what the run started with`
          : baseline.userChanges.has(path)
            ? "had uncommitted changes before the run started"
            : "changed at HEAD after the run started",
      });
      continue;
    }
    if (current !== null && looksSecret(path, readFileSync(absolute))) {
      excluded.push({ path, reason: "secret" });
      continue;
    }
    files.push({
      path,
      action: atBase === null ? "add" : current === null ? "delete" : "modify",
      hash: current,
      // A modified file keeps its committed mode, so a platform without executable bits
      // (Windows) cannot silently drop one; a new file takes the bit from the working tree.
      mode: !stat
        ? null
        : atBase === null
          ? gitMode(stat.mode)
          : await modeAt(workspace, base, path),
    });
  }
  if (dirty.length)
    throw refuse(
      "INPUT_CHANGED",
      "dirty_files",
      `Files changed since the run's verified snapshot: ${dirty.join(", ")}. Re-run verification or restore them before delivery.`,
      { files: dirty },
    );
  if (mismatched.length)
    throw refuse(
      "INPUT_CHANGED",
      "base_mismatch",
      `The run's changes cannot be separated from other changes: ${mismatched.map((m) => `${m.path} ${m.cause}`).join("; ")}. Commit or revert those changes by hand.`,
      { files: mismatched },
    );
  if (!files.length)
    throw refuse(
      "INPUT_CHANGED",
      "nothing_to_deliver",
      "The run changed no file that can be delivered.",
      {
        excluded,
      },
    );

  const branch =
    earlier?.result.branch ?? options.branch ?? `baked/${run.feature_id}-${runId.slice(0, 8)}`;
  if (!earlier) await assertNewBranch(workspace, remoteName, branch);

  let pullRequestTarget: { provider: PullRequestProvider; repository: string } | null = null;
  if (!earlier && options.pullRequest !== false) {
    const provider =
      options.provider === undefined ? configuredPullRequests(config) : options.provider;
    if (!provider)
      throw refuse(
        "CAPABILITY_DENIED",
        "no_provider",
        "No pull request provider is configured; pass --no-pr.",
      );
    const repository = provider.repository(url);
    if (!repository)
      throw refuse(
        "CAPABILITY_DENIED",
        "unsupported_remote",
        `Remote ${remoteName} (${url}) is not served by ${provider.name}. Pass --no-pr to deliver commit and push only.`,
      );
    const unavailable = provider.unavailable();
    if (unavailable) throw refuse("CAPABILITY_DENIED", "missing_auth", unavailable);
    pullRequestTarget = { provider, repository };
  }

  const reviewReplies = options.answer?.threads.length
    ? await plannedReplies(config, earlier, url, options.answer, options.provider)
    : null;

  const planId = newId();
  const userChanges = statusPaths(
    (await git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout,
  ).filter(
    (p) =>
      !internalPath(p) &&
      !files.some((f) => f.path === p) &&
      !excluded.some((e) => e.path === p && e.reason === "specs"),
  );
  const evidence = evidenceOf(store, runId);
  const title = (state.spec?.title ?? `Deliver ${run.feature_id}`).slice(0, 72);
  const outcome = state.spec?.outcome ?? null;
  const diff = await reviewableDiff(contentRoot, base, files);
  const core = {
    schemaVersion: 1 as const,
    planId,
    runId,
    featureId: run.feature_id,
    runRevision: run.revision,
    snapshotId: state.snapshotId,
    workspaceHash: state.workspaceHash,
    approvalRoot: state.approvalRoot,
    createdAt: options.now ?? Math.floor(Date.now() / 1000),
    operations: [
      "commit",
      "push",
      ...(pullRequestTarget ? (["pull_request"] as const) : []),
      ...(reviewReplies ? (["review_replies"] as const) : []),
    ] as DeliveryOperation[],
    remote: { name: remoteName, url },
    branch,
    base: earlier
      ? { commit: base, branch: earlier.plan.base.branch }
      : { commit: head, branch: currentBranch.stdout.trim() },
    baselineHead: baseline.head,
    headMoved: baseline.head !== null && baseline.head !== head,
    author: { name, email },
    files,
    excluded,
    userChanges,
    ...(source ? { worktree: source } : {}),
    ...(earlier
      ? {
          followUp: {
            runId: earlier.result.runId,
            planId: earlier.result.planId,
            pullRequest: earlier.result.pullRequest,
          },
        }
      : {}),
    ...(reviewReplies ? { reviewReplies } : {}),
    evidence,
  };
  const body = pullRequestTarget ? pullRequestBody(store, core) : "";
  return store.transaction(() => {
    if (store.run(runId).revision !== run.revision)
      throw new WorkflowFault("REVISION_CONFLICT", "Run changed while the delivery was prepared");
    for (const pending of store
      .requests(runId)
      .filter((r) => r.kind === "delivery" && r.status === "pending"))
      store.decideRequest(runId, pending.id, "superseded", { planId });
    const diffArtifact = store.artifact(
      runId,
      "delivery-diff",
      `delivery/${planId}/diff.patch`,
      diff.text,
    );
    const plan: DeliveryPlan = {
      ...core,
      diff: {
        artifactId: diffArtifact.id,
        hash: diffArtifact.content_hash,
        lines: diff.text ? diff.text.split("\n").length : 0,
        truncated: diff.truncated,
      },
      commitMessage: message(core, title, outcome),
      pullRequest: pullRequestTarget
        ? {
            provider: pullRequestTarget.provider.name,
            repository: pullRequestTarget.repository,
            title,
            body: closingIssue(state.issue, pullRequestTarget.repository, body),
            base: core.base.branch,
            draft: options.draft === true,
          }
        : null,
    };
    const artifact = store.artifact(
      runId,
      "delivery-plan",
      `delivery/${planId}/plan.json`,
      canonical(plan),
    );
    const digest = artifact.content_hash;
    const requestId = store.request(runId, "delivery", digest, {
      planId,
      planArtifactId: artifact.id,
      operations: plan.operations,
      remote: plan.remote,
      branch: plan.branch,
      base: plan.base,
      files: plan.files.map((f) => `${f.action} ${f.path}`),
      excluded: plan.excluded,
      userChanges: plan.userChanges,
      commitMessage: plan.commitMessage,
      ...(plan.followUp
        ? {
            followUp: {
              runId: plan.followUp.runId,
              pullRequest: plan.followUp.pullRequest
                ? { number: plan.followUp.pullRequest.number, url: plan.followUp.pullRequest.url }
                : null,
            },
          }
        : {}),
      ...(plan.reviewReplies
        ? {
            reviewReplies: {
              threads: plan.reviewReplies.threads,
              resolve: plan.reviewReplies.resolve,
              body: plan.reviewReplies.body,
            },
          }
        : {}),
      pullRequest: plan.pullRequest
        ? {
            repository: plan.pullRequest.repository,
            title: plan.pullRequest.title,
            base: plan.pullRequest.base,
            draft: plan.pullRequest.draft,
          }
        : null,
    });
    store.bump(runId, run.revision);
    return {
      planId,
      requestId,
      digest,
      revision: store.run(runId).revision,
      plan,
      diff: diff.text,
    };
  });
}

const REPLY_BODY = "Addressed in {commit}.";
const answerWithoutFollowUp = () =>
  refuse(
    "INVALID_DEFINITION",
    "answer_without_follow_up",
    "Review threads are answered only by a follow-up delivery to their pull request; add --follow-up.",
  );
/** The marker in a reply that shows which delivery plan wrote it, so a retry never replies twice. */
export const replyMarker = (planId: string) => `<!-- baked-delivery:${planId} -->`;

/**
 * The review threads a follow-up delivery answers: each must be an unresolved thread of the
 * followed run's pull request, read now from the host.
 */
async function plannedReplies(
  config: AppConfig,
  earlier: { result: DeliveryResult } | null,
  url: string,
  answer: NonNullable<PrepareDeliveryOptions["answer"]>,
  configured: PullRequestProvider | null | undefined,
): Promise<ReviewReplies> {
  if (!earlier) throw answerWithoutFollowUp();
  const pull = earlier.result.pullRequest;
  if (!pull?.number)
    throw refuse(
      "NOT_FOUND",
      "no_pull_request",
      `Run ${earlier.result.runId} opened no pull request, so there are no review threads to answer.`,
    );
  const provider = configured === undefined ? configuredPullRequests(config) : configured;
  const repository = provider?.repository(url) ?? null;
  if (!provider?.reviews || !provider.answerThread || !repository)
    throw refuse(
      "CAPABILITY_DENIED",
      "unsupported_remote",
      `Review threads on ${url} cannot be answered; that needs a GitHub remote.`,
    );
  const unavailable = provider.unavailable();
  if (unavailable) throw refuse("CAPABILITY_DENIED", "missing_auth", unavailable);
  const threads = (await provider.reviews(repository, pull.number)).threads;
  const wanted = [...new Set(answer.threads)];
  const missing = wanted.filter((id) => !threads.some((t) => t.id === id && !t.resolved));
  if (missing.length)
    throw refuse(
      "INPUT_CHANGED",
      "thread_not_open",
      `No unresolved review thread ${missing.join(", ")} on ${pull.url}.`,
      { threads: missing },
    );
  return {
    provider: provider.name,
    repository,
    pullRequest: pull.number,
    threads: wanted.map((id) => {
      const thread = threads.find((t) => t.id === id) as ReviewThread;
      return { id, path: thread.path, url: thread.comments[0]?.url ?? pull.url };
    }),
    resolve: answer.resolve === true,
    body: REPLY_BODY,
  };
}

/** A run's latest delivery that pushed a commit, with its plan; null when it has none. */
export function latestPushedDelivery(
  store: WorkflowStore,
  runId: string,
): { result: DeliveryResult; plan: DeliveryPlan } | null {
  const delivered = store
    .artifacts(runId)
    .filter((a) => a.kind === "delivery" && /^delivery\/[^/]+\/result\.json$/.test(a.logical_path))
    .map((a) => JSON.parse(store.readArtifact(runId, a.id)) as DeliveryResult)
    .filter((r) => r.commit && r.operations.some((o) => o.operation === "push"))
    .at(-1);
  const plan = delivered && store.latestArtifact(runId, `delivery/${delivered.planId}/plan.json`);
  if (!delivered || !plan) return null;
  return {
    result: delivered,
    plan: JSON.parse(store.readArtifact(runId, plan.id)) as DeliveryPlan,
  };
}

/** The latest pushed delivery of the run a follow-up delivery continues, and its plan. */
function followedDelivery(
  store: WorkflowStore,
  runId: string,
  followed: string,
): { result: DeliveryResult; plan: DeliveryPlan } {
  if (followed === runId)
    throw refuse(
      "INVALID_DEFINITION",
      "invalid_follow_up",
      "A follow-up delivery continues another run's branch; this run is the one being delivered.",
    );
  store.run(followed);
  const delivered = latestPushedDelivery(store, followed);
  if (!delivered)
    throw refuse(
      "INPUT_CHANGED",
      "not_delivered",
      `Run ${followed} has no pushed delivery to follow up. Deliver it first with \`baked workflow deliver ${followed}\`.`,
    );
  return delivered;
}

/**
 * The remote tip of a followed branch, which the follow-up commit is built on. The local branch,
 * when there is one, must point at the same commit and not be checked out anywhere, so that
 * fast-forwarding it changes no checkout.
 */
async function followedTip(workspace: string, remoteName: string, branch: string): Promise<string> {
  const remote = await git(workspace, ["ls-remote", "--heads", remoteName, `refs/heads/${branch}`]);
  if (remote.code !== 0) {
    const failure = classifyRemoteFailure(remote.stderr);
    throw refuse(
      failure === "auth" ? "CAPABILITY_DENIED" : "NOT_FOUND",
      failure === "auth" ? "missing_auth" : "remote_unreachable",
      `Cannot read remote ${remoteName}: ${remote.stderr.trim()}`,
    );
  }
  const tip = remote.stdout.trim().split(/\s+/)[0] ?? "";
  if (!tip)
    throw refuse(
      "INPUT_CHANGED",
      "branch_missing",
      `Branch ${branch} is no longer on ${remoteName}; a follow-up delivery adds to a branch that exists.`,
    );
  if ((await git(workspace, ["cat-file", "-e", `${tip}^{commit}`])).code !== 0)
    throw refuse(
      "INPUT_CHANGED",
      "fetch_required",
      `The tip ${tip} of ${remoteName}/${branch} is not in this repository. Run \`git fetch ${remoteName} ${branch}\` first.`,
    );
  await assertFollowedLocal(workspace, branch, tip);
  return tip;
}

/** The local copy of a followed branch, if any, is at `tip` and checked out in no worktree. */
async function assertFollowedLocal(workspace: string, branch: string, tip: string): Promise<void> {
  const local = (
    await git(workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  ).stdout.trim();
  if (local && local !== tip)
    throw refuse(
      "INPUT_CHANGED",
      "branch_moved",
      `Local branch ${branch} is at ${local} but the remote is at ${tip}. Bring them to the same commit first; delivery never overwrites a branch.`,
    );
  const worktrees = (await git(workspace, ["worktree", "list", "--porcelain"])).stdout;
  if (worktrees.split("\n").includes(`branch refs/heads/${branch}`))
    throw refuse(
      "INPUT_CHANGED",
      "branch_checked_out",
      `Branch ${branch} is checked out. Switch to another branch first; a follow-up delivery never changes a checkout.`,
    );
}

/** A new branch name is valid and exists neither locally nor on the remote. */
async function assertNewBranch(
  workspace: string,
  remoteName: string,
  branch: string,
): Promise<void> {
  if (
    (await git(workspace, ["check-ref-format", "--branch", branch])).code !== 0 ||
    branch.startsWith("-")
  )
    throw refuse("INVALID_DEFINITION", "invalid_branch", `Invalid branch name ${branch}`);
  if (
    (await git(workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0
  )
    throw refuse(
      "INPUT_CHANGED",
      "branch_exists",
      `Branch ${branch} already exists locally. Choose another name with --branch; delivery never overwrites a branch.`,
    );
  const remote = await git(workspace, ["ls-remote", "--heads", remoteName, `refs/heads/${branch}`]);
  if (remote.code !== 0) {
    const failure = classifyRemoteFailure(remote.stderr);
    throw refuse(
      failure === "auth" ? "CAPABILITY_DENIED" : "NOT_FOUND",
      failure === "auth" ? "missing_auth" : "remote_unreachable",
      `Cannot read remote ${remoteName}: ${remote.stderr.trim()}`,
    );
  }
  if (remote.stdout.trim())
    throw refuse(
      "INPUT_CHANGED",
      "branch_exists",
      `Branch ${branch} already exists on ${remoteName}. Choose another name with --branch; delivery never overwrites a branch.`,
    );
}

/**
 * Where a worktree run is delivered from: its worktree, which must still exist and hold the run
 * branch at the accepted commit. Null for a run executed in the working copy.
 */
async function worktreeSource(
  store: WorkflowStore,
  runId: string,
): Promise<DeliveryPlan["worktree"] | null> {
  const worktree = store.state(runId).worktree;
  if (!worktree) return null;
  const root = join(store.workspace, worktree.path);
  if (!existsSync(root))
    throw refuse(
      "NOT_FOUND",
      "worktree_missing",
      `The run worktree ${worktree.path} was removed; its branch ${worktree.branch} keeps the accepted commit ${worktree.commit ?? "(none)"}.`,
    );
  if (!worktree.commit)
    throw refuse(
      "INPUT_CHANGED",
      "nothing_to_deliver",
      "The run committed no change on its branch.",
    );
  const tip = (
    await git(store.workspace, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${worktree.branch}`,
    ])
  ).stdout.trim();
  const checkedOut = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
  if (tip !== worktree.commit || checkedOut !== worktree.commit)
    throw refuse(
      "INPUT_CHANGED",
      "branch_moved",
      `Branch ${worktree.branch} no longer points at the accepted commit ${worktree.commit}.`,
    );
  return { path: worktree.path, branch: worktree.branch, commit: worktree.commit };
}

/** A delivery approval or a recovery of a delivery effect; both are allowed on a completed run. */
export function isDeliveryRequest(request: RequestRow): boolean {
  if (request.kind === "delivery") return true;
  if (request.kind !== "recovery") return false;
  return (JSON.parse(request.body_json) as { delivery?: boolean }).delivery === true;
}

/**
 * Records the user's decision on a delivery request inside the caller's command transaction. An
 * approval must name the digest of the stored plan; it is never automatic.
 */
export function decideDelivery(
  store: WorkflowStore,
  runId: string,
  request: RequestRow,
  decision: Decision,
): void {
  const body = JSON.parse(request.body_json) as {
    planArtifactId?: string;
    planId?: string;
    effectId?: string;
  };
  if (request.kind === "delivery") {
    if (decision.kind === "reject") {
      store.decideRequest(runId, request.id, "rejected", decision);
      return;
    }
    if (decision.kind !== "approve")
      throw new WorkflowFault("STALE_DECISION", "A delivery plan is approved or rejected");
    const artifact = store.artifacts(runId).find((a) => a.id === body.planArtifactId);
    if (decision.digest !== request.digest || !artifact || artifact.content_hash !== request.digest)
      throw new WorkflowFault("STALE_DECISION", "Approval digest does not match the delivery plan");
    store.decideRequest(runId, request.id, "accepted", decision);
    return;
  }
  if (
    decision.kind !== "recovery" ||
    body.effectId !== decision.effectId ||
    !decision.evidence.trim()
  )
    throw new WorkflowFault(
      "STALE_DECISION",
      "Recovery evidence required for the requested effect",
    );
  const effect = store.effects(runId).find((e) => e.id === decision.effectId);
  if (effect?.kind !== "delivery" || !["prepared", "unknown"].includes(effect.status))
    throw new WorkflowFault("STALE_DECISION", "The delivery effect is no longer uncertain");
  if (decision.resolution === "cancel")
    store.artifact(
      runId,
      "delivery-abandoned",
      `delivery/${body.planId}/abandoned.json`,
      canonical({
        effect,
        decision,
        outcome: "unknown; delivery abandoned by trusted recovery decision; never replay",
      }),
    );
  else
    store.effectStatus(
      runId,
      effect.id,
      decision.resolution === "record-applied" ? "reconciled" : "failed",
    );
  store.decideRequest(runId, request.id, "accepted", decision);
}

type Probe =
  | { outcome: "present"; pullRequest?: PullRequest }
  | { outcome: "absent" }
  | { outcome: "conflict"; actual: string }
  | { outcome: "error"; message: string };

interface DeliveryIntent {
  planId: string;
  operation: DeliveryOperation;
  branch: string;
  commit?: string;
  tree?: string;
  remote?: string;
  url?: string;
  repository?: string;
  base?: string;
}

export interface ExecuteDeliveryOptions {
  expectedRevision: number;
  /** The approved delivery request; defaults to the latest approved one of the run. */
  requestId?: string;
  provider?: PullRequestProvider | null;
}

/**
 * Performs the operations of an approved plan. Each is a `delivery` effect in the run's journal;
 * one of unknown outcome is probed (local branch, remote branch, pull request by head branch) and
 * never repeated blindly: what cannot be settled becomes a recovery request.
 */
export async function executeDelivery(
  store: WorkflowStore,
  config: AppConfig,
  runId: string,
  options: ExecuteDeliveryOptions,
): Promise<DeliveryResult> {
  deliveryConfig(config);
  const workspace = store.workspace;
  const requests = store.requests(runId).filter((r) => r.kind === "delivery");
  const request = options.requestId
    ? requests.find((r) => r.id === options.requestId)
    : requests.filter((r) => r.status === "accepted").at(-1);
  if (!request)
    throw refuse(
      "STALE_DECISION",
      "not_approved",
      "No approved delivery plan. Run `baked workflow deliver RUN_ID`, then approve its request.",
    );
  const answer = request.answer_json
    ? (JSON.parse(request.answer_json) as Partial<Decision>)
    : null;
  if (
    request.status !== "accepted" ||
    request.actor !== "user" ||
    answer?.kind !== "approve" ||
    (answer as { digest?: string }).digest !== request.digest
  )
    throw refuse(
      "STALE_DECISION",
      "not_approved",
      `Delivery request ${request.id} is ${request.status}; only a plan a person approved by digest is executed.`,
    );
  const body = JSON.parse(request.body_json) as { planId: string; planArtifactId: string };
  const planArtifact = store.artifacts(runId).find((a) => a.id === body.planArtifactId);
  if (!planArtifact || planArtifact.content_hash !== request.digest)
    throw new WorkflowFault("ARTIFACT_MISSING", "The approved delivery plan is missing or changed");
  const plan = JSON.parse(store.readArtifact(runId, planArtifact.id)) as DeliveryPlan;
  if (hashJson(plan) !== request.digest)
    throw new WorkflowFault(
      "ARTIFACT_MISSING",
      "The approved delivery plan does not match its digest",
    );
  const done = store.latestArtifact(runId, `delivery/${plan.planId}/result.json`);
  if (done) return JSON.parse(store.readArtifact(runId, done.id)) as DeliveryResult;
  if (store.latestArtifact(runId, `delivery/${plan.planId}/abandoned.json`))
    throw refuse(
      "STALE_DECISION",
      "abandoned",
      "This delivery was abandoned by a recovery decision.",
    );
  const provider =
    plan.pullRequest || plan.reviewReplies
      ? options.provider === undefined
        ? configuredPullRequests(config)
        : options.provider
      : null;
  if (plan.pullRequest || plan.reviewReplies) {
    const unavailable = provider
      ? provider.unavailable()
      : "No pull request provider is configured";
    if (unavailable) throw refuse("CAPABILITY_DENIED", "missing_auth", unavailable);
  }
  await assertRepository(workspace);
  if ((await remoteUrl(workspace, plan.remote.name)) !== plan.remote.url)
    throw refuse(
      "INPUT_CHANGED",
      "remote_changed",
      `Remote ${plan.remote.name} no longer points at ${plan.remote.url}. Prepare and approve a new plan.`,
    );

  store.transaction(() => store.bump(runId, options.expectedRevision));
  const leases = new WorkspaceLeases(store);
  const contentRoot = plan.worktree ? join(workspace, plan.worktree.path) : workspace;
  leases.acquire(mutationLeaseFor(workspace, contentRoot), runId);
  const { stepId, attemptId } = store.transaction(() =>
    store.beginExternalAttempt(runId, DELIVERY_STAGE),
  );
  let finished: "completed" | "failed" = "failed";
  try {
    const result = await new DeliveryExecution(
      store,
      plan,
      request.digest,
      attemptId,
      provider,
    ).run();
    finished = "completed";
    const worktree = store.state(runId).worktree;
    // A delivered worktree run's worktree is no longer needed; its branch stays as the record.
    if (plan.worktree && worktree && existsSync(contentRoot)) {
      try {
        await removeRunWorktree(store, runId, worktree, { deleteBranch: false });
        store.transaction(() =>
          store.artifact(
            runId,
            "worktree",
            `worktree/removed-after-${plan.planId}.json`,
            canonical({
              ...worktree,
              deliveredBy: plan.planId,
              removedAt: new Date().toISOString(),
            }),
          ),
        );
      } catch {
        // The delivery is done; a worktree that could not be removed is left for discard-worktree.
      }
    }
    return result;
  } finally {
    store.transaction(() => {
      store.finishAttempt(runId, attemptId, finished, 0);
      store.finishStep(runId, stepId, finished);
    });
    leases.release();
  }
}

class DeliveryExecution {
  private readonly workspace: string;
  /** Where the delivered files are read: the working copy, or a worktree run's worktree. */
  private readonly contentRoot: string;
  private readonly runId: string;
  private commit: string | null = null;
  private pullRequest: DeliveryResult["pullRequest"] = null;
  constructor(
    private store: WorkflowStore,
    private plan: DeliveryPlan,
    private digest: string,
    private attemptId: string,
    private provider: PullRequestProvider | null,
  ) {
    this.workspace = store.workspace;
    this.contentRoot = plan.worktree ? join(store.workspace, plan.worktree.path) : store.workspace;
    this.runId = plan.runId;
  }
  private effects(): (EffectRow & { intent: DeliveryIntent })[] {
    return this.store
      .effects(this.runId)
      .filter((e) => e.kind === "delivery")
      .map((e) => ({ ...e, intent: JSON.parse(e.intent_json) as DeliveryIntent }))
      .filter((e) => e.intent.planId === this.plan.planId);
  }
  private latest(operation: DeliveryOperation) {
    return this.effects()
      .filter((e) => e.intent.operation === operation)
      .at(-1);
  }
  async run(): Promise<DeliveryResult> {
    // A follow-up adds to the pull request the followed run opened.
    if (this.plan.followUp) this.pullRequest = this.plan.followUp.pullRequest;
    for (const operation of this.plan.operations) {
      const previous = this.latest(operation);
      if (previous && ["prepared", "unknown"].includes(previous.status))
        await this.settle(previous);
      const settled = this.latest(operation);
      if (settled && ["applied", "reconciled"].includes(settled.status)) {
        await this.adopt(settled);
        continue;
      }
      if (operation === "commit") await this.doCommit();
      else if (operation === "push") await this.doPush();
      else if (operation === "review_replies") await this.doReviewReplies();
      else await this.doPullRequest();
    }
    const result: DeliveryResult = {
      schemaVersion: 1,
      planId: this.plan.planId,
      runId: this.runId,
      digest: this.digest,
      runRevision: this.plan.runRevision,
      snapshotId: this.plan.snapshotId,
      approvalRoot: this.plan.approvalRoot,
      remote: this.plan.remote,
      branch: this.plan.branch,
      commit: this.commit,
      pullRequest: this.pullRequest,
      operations: this.plan.operations.map((operation) => {
        const effect = this.latest(operation);
        return { operation, effectId: effect?.id ?? "", status: effect?.status ?? "failed" };
      }),
      deliveredAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      if (!this.store.latestArtifact(this.runId, `delivery/${this.plan.planId}/result.json`))
        this.store.artifact(
          this.runId,
          "delivery",
          `delivery/${this.plan.planId}/result.json`,
          canonical(result),
        );
    });
    return result;
  }
  /** Outputs of an operation that already took effect. */
  private async adopt(effect: EffectRow & { intent: DeliveryIntent }): Promise<void> {
    if (effect.intent.operation === "commit") this.commit = effect.intent.commit ?? null;
    if (effect.intent.operation === "pull_request") {
      const recorded = this.store.latestArtifact(
        this.runId,
        `delivery/${this.plan.planId}/pull-request.json`,
      );
      this.pullRequest = recorded
        ? (JSON.parse(
            this.store.readArtifact(this.runId, recorded.id),
          ) as DeliveryResult["pullRequest"])
        : { number: 0, url: "", recordedBy: "user" };
    }
  }
  private async probe(intent: DeliveryIntent): Promise<Probe> {
    if (intent.operation === "commit") {
      const local = await git(this.workspace, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${intent.branch}`,
      ]);
      const actual = local.stdout.trim();
      if (local.code !== 0 || !actual || this.untouchedTip(actual)) return { outcome: "absent" };
      return actual === intent.commit ? { outcome: "present" } : { outcome: "conflict", actual };
    }
    if (intent.operation === "push") {
      const remote = await git(this.workspace, [
        "ls-remote",
        "--heads",
        intent.remote ?? this.plan.remote.name,
        `refs/heads/${intent.branch}`,
      ]);
      if (remote.code !== 0) return { outcome: "error", message: remote.stderr.trim() };
      const actual = remote.stdout.trim().split(/\s+/)[0] ?? "";
      if (!actual || this.untouchedTip(actual)) return { outcome: "absent" };
      return actual === intent.commit ? { outcome: "present" } : { outcome: "conflict", actual };
    }
    if (!this.provider || !intent.repository)
      return { outcome: "error", message: "No pull request provider to check with" };
    if (intent.operation === "review_replies") {
      try {
        return (await this.unanswered()).length ? { outcome: "absent" } : { outcome: "present" };
      } catch (error) {
        return {
          outcome: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    try {
      const found = await this.provider.findByHead(intent.repository, intent.branch);
      return found ? { outcome: "present", pullRequest: found } : { outcome: "absent" };
    } catch (error) {
      return { outcome: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  /** Settles an effect of unknown outcome by observation, or leaves it to a person. */
  private async settle(effect: EffectRow & { intent: DeliveryIntent }): Promise<void> {
    const probe = await this.probe(effect.intent);
    if (probe.outcome === "error") {
      this.store.transaction(() => {
        if (effect.status !== "unknown") this.store.effectStatus(this.runId, effect.id, "unknown");
        this.requestRecovery(effect);
      });
      throw refuse(
        "RECOVERY_REQUIRED",
        "unknown_outcome",
        `The outcome of ${effect.intent.operation} is unknown and could not be checked (${probe.message}). Resolve recovery request for effect ${effect.id} with \`baked workflow recover\`, or retry when the remote answers.`,
        { effectId: effect.id },
      );
    }
    this.store.transaction(() => {
      if (probe.outcome === "present") {
        this.store.effectStatus(this.runId, effect.id, "reconciled");
        if (probe.pullRequest) this.recordPullRequest(probe.pullRequest);
      } else this.store.effectStatus(this.runId, effect.id, "failed");
      for (const pending of this.store
        .requests(this.runId)
        .filter(
          (r) =>
            r.kind === "recovery" &&
            r.status === "pending" &&
            (JSON.parse(r.body_json) as { effectId?: string }).effectId === effect.id,
        ))
        this.store.decideRequest(this.runId, pending.id, "superseded", { probe: probe.outcome });
    });
    if (probe.outcome === "conflict") throw this.conflict(effect.intent, probe.actual);
  }
  private requestRecovery(effect: EffectRow & { intent: DeliveryIntent }): void {
    const open = this.store
      .requests(this.runId)
      .some(
        (r) =>
          r.kind === "recovery" &&
          r.status === "pending" &&
          (JSON.parse(r.body_json) as { effectId?: string }).effectId === effect.id,
      );
    if (!open)
      this.store.request(this.runId, "recovery", this.digest, {
        effectId: effect.id,
        intent: effect.intent,
        delivery: true,
        planId: this.plan.planId,
      });
  }
  /** A followed branch still at the tip the follow-up commit is built on: nothing happened yet. */
  private untouchedTip(actual: string): boolean {
    return this.plan.followUp !== undefined && actual === this.plan.base.commit;
  }
  private conflict(intent: DeliveryIntent, actual: string): WorkflowFault {
    if (this.plan.followUp)
      return refuse(
        "INPUT_CHANGED",
        "branch_moved",
        `Branch ${intent.branch} ${intent.operation === "push" ? `on ${this.plan.remote.name} ` : ""}moved to ${actual} after the follow-up plan was made. Prepare and approve a new plan.`,
      );
    return refuse(
      "INPUT_CHANGED",
      "branch_exists",
      `Branch ${intent.branch} ${intent.operation === "push" ? `on ${this.plan.remote.name} ` : ""}points at ${actual}, not at the delivered commit ${intent.commit}. Delivery never overwrites a branch; prepare a plan with another --branch.`,
    );
  }
  private prepareEffect(intent: DeliveryIntent): string {
    return this.store.transaction(() =>
      this.store.prepareEffect(this.runId, this.attemptId, "delivery", intent, null, null),
    );
  }
  private mark(effectId: string, status: "applied" | "failed" | "unknown" | "reconciled"): void {
    this.store.transaction(() => this.store.effectStatus(this.runId, effectId, status));
  }
  /** Runs an effect whose outcome can be probed; a crash or an unclear failure is probed, not repeated. */
  private async attempt(
    intent: DeliveryIntent,
    action: () => Promise<{ ok: true } | { ok: false; definite: boolean; fault: WorkflowFault }>,
  ): Promise<void> {
    const effectId = this.prepareEffect(intent);
    let outcome: Awaited<ReturnType<typeof action>>;
    try {
      outcome = await action();
    } catch (error) {
      outcome = {
        ok: false,
        definite: false,
        fault: refuse(
          "CAPABILITY_DENIED",
          `${intent.operation}_failed`,
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    if (outcome.ok) {
      this.mark(effectId, "applied");
      return;
    }
    if (outcome.definite) {
      this.mark(effectId, "failed");
      throw outcome.fault;
    }
    this.mark(effectId, "unknown");
    const effect = this.effects().find((e) => e.id === effectId);
    if (effect) await this.settle(effect);
    const settled = this.effects().find((e) => e.id === effectId);
    if (settled?.status === "failed") throw outcome.fault;
  }
  private async doCommit(): Promise<void> {
    const head = (
      await git(this.workspace, ["rev-parse", "--verify", "--quiet", "HEAD"])
    ).stdout.trim();
    // A follow-up is built on the followed branch, not on HEAD; that branch must be where it was.
    if (this.plan.followUp)
      await assertFollowedLocal(this.workspace, this.plan.branch, this.plan.base.commit);
    else if (head !== this.plan.base.commit)
      throw refuse(
        "INPUT_CHANGED",
        "head_moved",
        `HEAD moved from ${this.plan.base.commit} to ${head || "nothing"} after the plan was approved. Prepare and approve a new plan.`,
      );
    const contents = new Map<string, Uint8Array>();
    const dirty: string[] = [];
    for (const file of this.plan.files) {
      const absolute = workspacePath(this.contentRoot, file.path);
      let bytes: Uint8Array | null = null;
      let mode: string | null = null;
      try {
        const stat = lstatSync(absolute);
        if (!stat.isSymbolicLink()) {
          bytes = readFileSync(absolute);
          mode = gitMode(stat.mode);
        } else mode = "symlink";
      } catch {
        bytes = null;
      }
      if (
        (bytes ? hashBytes(bytes) : null) !== file.hash ||
        (bytes && file.action === "add" && mode !== file.mode)
      )
        dirty.push(file.path);
      else if (bytes) contents.set(file.path, bytes);
    }
    if (dirty.length)
      throw refuse(
        "INPUT_CHANGED",
        "dirty_files",
        `Files changed after the plan was approved: ${dirty.join(", ")}. Prepare and approve a new plan.`,
        { files: dirty },
      );
    const { commit, tree } = await this.buildCommit(contents);
    this.commit = commit;
    // Creates the branch, or fast-forwards a followed one from the tip the commit is built on.
    const previous =
      this.plan.followUp &&
      (
        await git(this.workspace, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${this.plan.branch}`,
        ])
      ).code === 0
        ? this.plan.base.commit
        : "";
    await this.attempt(
      {
        planId: this.plan.planId,
        operation: "commit",
        branch: this.plan.branch,
        commit,
        tree,
        base: this.plan.base.commit,
      },
      async () => {
        const update = await git(this.workspace, [
          "update-ref",
          "-m",
          `baked delivery ${this.plan.planId}`,
          `refs/heads/${this.plan.branch}`,
          commit,
          previous,
        ]);
        if (update.code === 0) return { ok: true };
        return {
          ok: false,
          definite: false,
          fault: refuse(
            "INPUT_CHANGED",
            "branch_exists",
            `Cannot create branch ${this.plan.branch}: ${update.stderr.trim()}`,
          ),
        };
      },
    );
  }
  /**
   * Builds the commit in a temporary index from the approved content. The author and committer
   * dates are the plan's, so the same plan always yields the same commit ID and a retry can check
   * for it. Commit hooks do not run: the checkout is not used, and hooks could rewrite user files.
   */
  private async buildCommit(
    contents: Map<string, Uint8Array>,
  ): Promise<{ commit: string; tree: string }> {
    const directory = mkdtempSync(join(tmpdir(), "baked-delivery-"));
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    try {
      const step = async (
        args: string[],
        input?: Uint8Array | string,
        extra: Record<string, string> = {},
      ) => {
        const result = await git(this.workspace, args, {
          env: { ...env, ...extra },
          ...(input === undefined ? {} : { input }),
        });
        if (result.code !== 0)
          throw refuse(
            "CAPABILITY_DENIED",
            "commit_failed",
            `git ${args[0]} failed: ${result.stderr.trim()}`,
          );
        return result.stdout.trim();
      };
      await step(["read-tree", this.plan.base.commit]);
      for (const file of this.plan.files) {
        if (file.action === "delete") {
          await step(["update-index", "--force-remove", "--", file.path]);
          continue;
        }
        const bytes = contents.get(file.path);
        if (!bytes)
          throw refuse("INPUT_CHANGED", "dirty_files", `Missing content for ${file.path}`);
        const blob = await step(["hash-object", "-w", "--stdin", `--path=${file.path}`], bytes);
        await step([
          "update-index",
          "--add",
          "--cacheinfo",
          `${file.mode ?? "100644"},${blob},${file.path}`,
        ]);
      }
      const tree = await step(["write-tree"]);
      const date = `${this.plan.createdAt} +0000`;
      const commit = await step(
        ["commit-tree", tree, "-p", this.plan.base.commit, "--no-gpg-sign", "-F", "-"],
        this.plan.commitMessage,
        {
          GIT_AUTHOR_NAME: this.plan.author.name,
          GIT_AUTHOR_EMAIL: this.plan.author.email,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: this.plan.author.name,
          GIT_COMMITTER_EMAIL: this.plan.author.email,
          GIT_COMMITTER_DATE: date,
        },
      );
      return { commit, tree };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  private async doPush(): Promise<void> {
    const commit = this.commit ?? this.latest("commit")?.intent.commit;
    if (!commit) throw refuse("STALE_DECISION", "commit_missing", "The delivery commit is missing");
    await this.attempt(
      {
        planId: this.plan.planId,
        operation: "push",
        branch: this.plan.branch,
        commit,
        remote: this.plan.remote.name,
        url: this.plan.remote.url,
      },
      async () => {
        // No leading "+": Git refuses anything but creating or fast-forwarding the branch.
        const push = await git(
          this.workspace,
          [
            "push",
            "--porcelain",
            this.plan.remote.name,
            `${commit}:refs/heads/${this.plan.branch}`,
          ],
          { timeoutMs: 300000 },
        );
        if (push.code === 0) return { ok: true };
        const failure: RemoteFailure = classifyRemoteFailure(`${push.stderr}\n${push.stdout}`);
        const detail = `${push.stderr}\n${push.stdout}`.trim();
        const reasons: Record<RemoteFailure, [WorkflowErrorCode, string]> = {
          non_fast_forward: [
            "INPUT_CHANGED",
            "Push rejected as non-fast-forward; delivery never force-pushes. Prepare a plan with another --branch.",
          ],
          hook_rejected: ["CAPABILITY_DENIED", "Push rejected by a hook."],
          auth: [
            "CAPABILITY_DENIED",
            "Push failed: missing or invalid credentials for the remote.",
          ],
          remote_unreachable: ["NOT_FOUND", "Push failed: the remote cannot be reached."],
          failed: ["CAPABILITY_DENIED", "Push failed."],
        };
        const [code, text] = reasons[failure];
        return {
          ok: false,
          // Only a failure Git reports before the remote could update the ref is definite.
          definite: failure !== "failed",
          fault: refuse(code, failure === "failed" ? "push_failed" : failure, `${text} ${detail}`),
        };
      },
    );
  }
  private recordPullRequest(pullRequest: PullRequest): void {
    this.pullRequest = { ...pullRequest, recordedBy: "provider" };
    this.store.artifact(
      this.runId,
      "delivery-pull-request",
      `delivery/${this.plan.planId}/pull-request.json`,
      canonical(this.pullRequest),
    );
  }
  private async doPullRequest(): Promise<void> {
    const target = this.plan.pullRequest;
    const provider = this.provider;
    if (!target || !provider)
      throw refuse("CAPABILITY_DENIED", "missing_auth", "No pull request provider");
    await this.attempt(
      {
        planId: this.plan.planId,
        operation: "pull_request",
        branch: this.plan.branch,
        repository: target.repository,
        base: target.base,
        commit: this.commit ?? this.latest("commit")?.intent.commit ?? "",
      },
      async () => {
        try {
          const created = await provider.create(target.repository, {
            base: target.base,
            head: this.plan.branch,
            title: target.title,
            body: target.body,
            draft: target.draft,
          });
          this.store.transaction(() => this.recordPullRequest(created));
          return { ok: true };
        } catch (error) {
          const failure = error instanceof PullRequestError ? error.failure : "unknown";
          const text = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            // A refused request may still mean the pull request exists (422); check before failing.
            definite: failure === "auth",
            fault: refuse(
              "CAPABILITY_DENIED",
              failure === "auth"
                ? "missing_auth"
                : failure === "rejected"
                  ? "pull_request_rejected"
                  : "pull_request_failed",
              `Pull request was not created: ${text}`,
            ),
          };
        }
      },
    );
  }
  /**
   * The approved threads that still need this plan's reply or resolution. A reply carries the
   * plan's marker, so what an earlier attempt already posted is seen and not posted again.
   */
  private async unanswered(): Promise<{ id: string; reply: boolean; resolve: boolean }[]> {
    const replies = this.plan.reviewReplies;
    const provider = this.provider;
    if (!replies || !provider?.reviews) throw new Error("No provider can read the review threads");
    const marker = replyMarker(this.plan.planId);
    const current = (await provider.reviews(replies.repository, replies.pullRequest)).threads;
    return replies.threads
      .map(({ id }) => {
        const thread = current.find((t) => t.id === id);
        const replied = thread?.comments.some((c) => c.body.includes(marker)) ?? false;
        return {
          id,
          reply: !replied,
          resolve: replies.resolve && thread !== undefined && !thread.resolved,
        };
      })
      .filter((t) => t.reply || t.resolve);
  }
  private async doReviewReplies(): Promise<void> {
    const replies = this.plan.reviewReplies;
    const provider = this.provider;
    if (!replies || !provider?.answerThread)
      throw refuse("CAPABILITY_DENIED", "missing_auth", "No provider can answer review threads");
    const commit = this.commit ?? this.latest("commit")?.intent.commit ?? "";
    const body = `${replies.body.replaceAll("{commit}", commit)}\n\n${replyMarker(this.plan.planId)}`;
    await this.attempt(
      {
        planId: this.plan.planId,
        operation: "review_replies",
        branch: this.plan.branch,
        repository: replies.repository,
        commit,
      },
      async () => {
        try {
          for (const thread of await this.unanswered()) {
            await provider.answerThread?.(thread.id, thread.reply ? body : null, thread.resolve);
          }
          return { ok: true };
        } catch (error) {
          const failure = error instanceof PullRequestError ? error.failure : "unknown";
          return {
            ok: false,
            definite: failure === "auth",
            fault: refuse(
              "CAPABILITY_DENIED",
              failure === "auth" ? "missing_auth" : "review_replies_failed",
              `Review threads were not all answered: ${error instanceof Error ? error.message : String(error)}`,
            ),
          };
        }
      },
    );
  }
}

/**
 * A run started from a GitHub issue (`workflow run --issue REF`): the issue's title and body
 * become the request, its number names the feature, and the delivery pull request closes it.
 */
import type { AppConfig } from "../../types/index.js";
import { git } from "./delivery-git.js";
import { repositoryOnHost } from "./delivery-provider.js";
import { WorkflowFault } from "./errors.js";
import { featureSlug } from "./feature-id.js";
import { DeliveryConfigSchema } from "./schemas.js";
import type { IssueSource } from "./types.js";

export type { IssueSource } from "./types.js";

export interface FetchedIssue extends IssueSource {
  body: string;
  state: string;
}

/** Longest issue body taken into the prompt; the rest is left to the link. */
const MAX_BODY_CHARS = 20000;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

const invalid = (message: string): WorkflowFault =>
  new WorkflowFault("INVALID_DEFINITION", message, { reason: "invalid_issue" });

function settings(config: AppConfig) {
  const delivery = DeliveryConfigSchema.parse(config.workflows?.delivery ?? {});
  const api = delivery.apiUrl.replace(/\/+$/, "");
  const apiHost = new URL(api).hostname;
  return {
    api,
    host: apiHost === "api.github.com" ? "github.com" : apiHost,
    tokenEnv: delivery.tokenEnv,
  };
}

/**
 * The repository and number an issue reference names: an issue URL on the configured host,
 * `owner/name#N`, or `#N` / `N` for the repository of `defaultRepository`.
 */
export function parseIssueReference(
  reference: string,
  host: string,
  defaultRepository: string | null,
): { repository: string; number: number } {
  const ref = reference.trim();
  const url = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)\/?(?:[?#]\S*)?$/.exec(ref);
  if (url) {
    if (url[1]?.toLowerCase() !== host.toLowerCase())
      throw invalid(
        `Issue ${ref} is not on ${host}; set workflows.delivery.apiUrl for another GitHub host`,
      );
    return { repository: url[2] ?? "", number: Number(url[3]) };
  }
  const slug = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  if (slug) return { repository: slug[1] ?? "", number: Number(slug[2]) };
  const bare = /^#?(\d+)$/.exec(ref);
  if (bare) {
    if (!defaultRepository)
      throw invalid(
        `Issue ${ref} needs a repository: the origin remote is not on ${host}. Pass the issue URL or owner/name#N`,
      );
    return { repository: defaultRepository, number: Number(bare[1]) };
  }
  throw invalid(`Not an issue reference: ${ref}. Pass an issue URL, owner/name#N or #N`);
}

/** `owner/name` of the workspace's origin remote on the given host, or null. */
async function originRepository(workspace: string, host: string): Promise<string | null> {
  const result = await git(workspace, ["remote", "get-url", "origin"]).catch(() => null);
  if (result?.code !== 0) return null;
  const repository = repositoryOnHost(result.stdout.trim(), host);
  return repository && REPOSITORY.test(repository) ? repository : null;
}

/**
 * Reads an issue through the GitHub REST API. The token from `workflows.delivery.tokenEnv` is
 * sent when set, so private repositories work; public issues are read without one.
 */
export async function fetchIssue(
  workspace: string,
  config: AppConfig,
  reference: string,
  options: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<FetchedIssue> {
  const { api, host, tokenEnv } = settings(config);
  const bareNumber = /^#?\d+$/.test(reference.trim());
  const { repository, number } = parseIssueReference(
    reference,
    host,
    bareNumber ? await originRepository(workspace, host) : null,
  );
  const token = (options.env ?? process.env)[tokenEnv] || undefined;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${api}/repos/${repository}/issues/${number}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new WorkflowFault(
      "NOT_FOUND",
      `Cannot read issue ${repository}#${number}: ${error instanceof Error ? error.message : String(error)}`,
      { reason: "issue_unreachable" },
    );
  }
  if (!response.ok) {
    const hint =
      response.status === 404 || response.status === 401 || response.status === 403
        ? token
          ? ` Check that ${tokenEnv} can read ${repository}.`
          : ` Set ${tokenEnv} to a GitHub token for a private repository.`
        : "";
    throw new WorkflowFault(
      response.status === 404 ? "NOT_FOUND" : "CAPABILITY_DENIED",
      `GitHub answered ${response.status} for issue ${repository}#${number}.${hint}`,
      { reason: "issue_unreachable" },
    );
  }
  const issue = (await response.json().catch(() => null)) as {
    number?: unknown;
    html_url?: unknown;
    title?: unknown;
    body?: unknown;
    state?: unknown;
    pull_request?: unknown;
  } | null;
  if (!issue || typeof issue.number !== "number" || typeof issue.title !== "string")
    throw new WorkflowFault("NOT_FOUND", `GitHub returned no issue for ${repository}#${number}`, {
      reason: "issue_unreachable",
    });
  if (issue.pull_request) throw invalid(`${repository}#${number} is a pull request, not an issue`);
  return {
    repository,
    number: issue.number,
    url:
      typeof issue.html_url === "string"
        ? issue.html_url
        : `https://${host}/${repository}/issues/${issue.number}`,
    title: issue.title,
    body: typeof issue.body === "string" ? issue.body : "",
    state: typeof issue.state === "string" ? issue.state : "open",
  };
}

/** The run request an issue stands for, with optional extra instructions from the person. */
export function issuePrompt(issue: FetchedIssue, extra?: string): string {
  // Issue templates leave HTML comments that only guide the author.
  const body = issue.body.replace(/<!--[\s\S]*?-->/g, "").trim();
  const clipped =
    body.length > MAX_BODY_CHARS
      ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[The issue continues at ${issue.url}]`
      : body;
  return [
    `${issue.title} (GitHub issue ${issue.repository}#${issue.number})`,
    ...(clipped ? ["", clipped] : []),
    ...(extra?.trim() ? ["", "Additional instructions:", extra.trim()] : []),
    "",
    `Source: ${issue.url}`,
  ].join("\n");
}

/** `issue-N-title-words`: stable for the same issue, so reruns are listed under one feature. */
export function issueFeatureId(issue: Pick<IssueSource, "number" | "title">): string {
  return `issue-${issue.number}-${featureSlug(issue.title)}`.slice(0, 64).replace(/-+$/, "");
}

/**
 * The line that makes GitHub close the issue when the pull request merges: `Closes #N` in the
 * same repository, `Closes owner/name#N` across repositories.
 */
export function closingReference(issue: IssueSource, pullRequestRepository: string): string {
  const same = issue.repository.toLowerCase() === pullRequestRepository.toLowerCase();
  return `Closes ${same ? "" : issue.repository}#${issue.number}`;
}

export const issueSource = (issue: FetchedIssue): IssueSource => ({
  repository: issue.repository,
  number: issue.number,
  url: issue.url,
  title: issue.title,
});

/**
 * What a run start takes from an issue: the request (with the person's extra instructions), the
 * feature ID unless one is given, and the issue to close on delivery.
 */
export async function issueStart(
  workspace: string,
  config: AppConfig,
  input: { reference: string; prompt?: string; featureId?: string },
  options: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<{ prompt: string; featureId: string; issue: IssueSource }> {
  const issue = await fetchIssue(workspace, config, input.reference, options);
  return {
    prompt: issuePrompt(issue, input.prompt),
    featureId: input.featureId?.trim() || issueFeatureId(issue),
    issue: issueSource(issue),
  };
}

/** The repository new issues go to and the token to create them, or null without either. */
export async function issueTarget(
  workspace: string,
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<{ repository: string; token: string } | null> {
  const { host, tokenEnv } = settings(config);
  const token = env[tokenEnv];
  if (!token) return null;
  const repository = await originRepository(workspace, host);
  return repository ? { repository, token } : null;
}

/**
 * Creates an issue in the workspace's origin repository, as a sub-issue of `parent` when one is
 * given. A parent that cannot take the sub-issue leaves the issue standing, with a warning.
 */
export async function createIssue(
  workspace: string,
  config: AppConfig,
  input: { title: string; body: string; parent?: string },
  options: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<{ issue: FetchedIssue; warning?: string }> {
  const { api, host, tokenEnv } = settings(config);
  const target = await issueTarget(workspace, config, options.env);
  if (!target)
    throw new WorkflowFault(
      "CAPABILITY_DENIED",
      `Creating an issue needs ${tokenEnv} and an origin remote on ${host}`,
      { reason: "issue_unreachable" },
    );
  const post = async (path: string, body: unknown): Promise<Response> =>
    (options.fetch ?? fetch)(`${api}${path}`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  const response = await post(`/repos/${target.repository}/issues`, {
    title: input.title,
    body: input.body,
  }).catch((error: unknown) => {
    throw new WorkflowFault(
      "CAPABILITY_DENIED",
      `Cannot create an issue in ${target.repository}: ${error instanceof Error ? error.message : String(error)}`,
      { reason: "issue_unreachable" },
    );
  });
  const created = (await response.json().catch(() => null)) as {
    id?: unknown;
    number?: unknown;
    html_url?: unknown;
  } | null;
  if (!response.ok || typeof created?.number !== "number")
    throw new WorkflowFault(
      "CAPABILITY_DENIED",
      `GitHub answered ${response.status} creating an issue in ${target.repository}. Check that ${tokenEnv} can write issues there.`,
      { reason: "issue_unreachable" },
    );
  const issue: FetchedIssue = {
    repository: target.repository,
    number: created.number,
    url:
      typeof created.html_url === "string"
        ? created.html_url
        : `https://${host}/${target.repository}/issues/${created.number}`,
    title: input.title,
    body: input.body,
    state: "open",
  };
  if (!input.parent) return { issue };
  const parent = parseIssueReference(input.parent, host, target.repository);
  const linked = await post(`/repos/${parent.repository}/issues/${parent.number}/sub_issues`, {
    sub_issue_id: created.id,
  }).catch(() => null);
  return linked?.ok
    ? { issue }
    : {
        issue,
        warning: `${target.repository}#${issue.number} is not a sub-issue of ${parent.repository}#${parent.number} (GitHub answered ${linked?.status ?? "nothing"})`,
      };
}

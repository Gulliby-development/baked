/** Pull request hosting behind a small interface, so delivery is testable without a network. */

export interface PullRequest {
  number: number;
  url: string;
}
export interface PullRequestDraft {
  /** Branch the pull request merges into. */
  base: string;
  /** Branch that holds the delivered commit, in the same repository. */
  head: string;
  title: string;
  body: string;
  draft: boolean;
}
/**
 * Why a provider call failed. `auth` and `rejected` are definite answers from the host; `unknown`
 * covers a lost response or a network failure, where the request may or may not have taken effect.
 */
export type ProviderFailure = "auth" | "rejected" | "unknown";
export class PullRequestError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    message: string,
  ) {
    super(message);
    this.name = "PullRequestError";
  }
}
/** One check the host reports on a commit: a check run or a commit status. */
export interface CommitCheck {
  name: string;
  state: "pending" | "passed" | "failed";
  /** The host's own words on the result (a check run's title and summary, a status's description). */
  detail: string;
  url: string | null;
}
/** A review thread on a pull request: its comments, oldest first, and whether it is resolved. */
export interface ReviewThread {
  /** The host's ID of the thread, used to answer and resolve it. */
  id: string;
  resolved: boolean;
  /** The commented code changed after the comment was made. */
  outdated: boolean;
  path: string;
  line: number | null;
  comments: { author: string; body: string; url: string }[];
}
/** What reviewers said on a pull request: its review threads and the latest review of each reviewer. */
export interface PullRequestReviews {
  threads: ReviewThread[];
  reviews: { author: string; state: string; body: string; url: string }[];
}
export interface PullRequestProvider {
  readonly name: string;
  /** The `owner/name` repository a remote URL points at, or null when this host does not serve it. */
  repository(remoteUrl: string): string | null;
  /** Null when the provider can make calls; otherwise why not (for example a missing token). */
  unavailable(): string | null;
  /** The pull request whose head is this branch of the repository, in any state, or null. */
  findByHead(repository: string, branch: string): Promise<PullRequest | null>;
  create(repository: string, draft: PullRequestDraft): Promise<PullRequest>;
  /** The checks reported on a commit. Absent for a provider that cannot read them. */
  checks?(repository: string, commit: string): Promise<CommitCheck[]>;
  /** The review threads and reviews of a pull request. Absent for a provider that cannot read them. */
  reviews?(repository: string, pullRequest: number): Promise<PullRequestReviews>;
  /** Adds a reply to a review thread unless `body` is null, then resolves it when `resolve` is set. */
  answerThread?(threadId: string, body: string | null, resolve: boolean): Promise<void>;
}

const PASSED_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
/** A GitHub check run as a check: only a completed run passes or fails. */
export function checkRunState(status: string, conclusion: string | null): CommitCheck["state"] {
  if (status !== "completed") return "pending";
  return conclusion && PASSED_CONCLUSIONS.has(conclusion) ? "passed" : "failed";
}

/** Repository slug from an HTTPS, SSH or scp-style remote URL on the given host. */
export function repositoryOnHost(remoteUrl: string, host: string): string | null {
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(remoteUrl.trim());
    if (match && match[1]?.toLowerCase() === host.toLowerCase()) return `${match[2]}/${match[3]}`;
  }
  return null;
}

/**
 * GitHub REST pull requests. The token is read once from the configured environment variable and
 * sent only to the configured API URL. github.com remotes map to api.github.com; any other API URL
 * (GitHub Enterprise) serves remotes on its own host.
 */
export function githubPullRequests(options: {
  token: string | undefined;
  tokenEnv: string;
  apiUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): PullRequestProvider {
  const api = options.apiUrl.replace(/\/+$/, "");
  const apiHost = new URL(api).hostname;
  const host = apiHost === "api.github.com" ? "github.com" : apiHost;
  const call = options.fetch ?? fetch;
  async function request(
    path: string,
    init: { method: string; body?: unknown },
    url = `${api}${path}`,
  ): Promise<unknown> {
    if (!options.token)
      throw new PullRequestError("auth", `Missing auth: set ${options.tokenEnv} to a GitHub token`);
    let response: Response;
    try {
      response = await call(url, {
        method: init.method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "x-github-api-version": "2022-11-28",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
    } catch (error) {
      throw new PullRequestError(
        "unknown",
        `GitHub request failed without a response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text().catch(() => "");
    if (response.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new PullRequestError("unknown", "GitHub returned an unreadable response");
      }
    }
    let message = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
      message = [parsed.message, ...(parsed.errors ?? []).map((e) => e.message)]
        .filter(Boolean)
        .join("; ");
    } catch {
      // Keep the raw text.
    }
    const failure: ProviderFailure =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status >= 400 && response.status < 500
          ? "rejected"
          : "unknown";
    throw new PullRequestError(failure, `GitHub answered ${response.status}: ${message}`);
  }
  // GitHub serves GraphQL at /graphql of api.github.com, and at /api/graphql on an Enterprise host.
  const graphqlUrl = api.endsWith("/api/v3") ? `${api.slice(0, -2)}graphql` : `${api}/graphql`;
  async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const answer = (await request(
      "",
      { method: "POST", body: { query, variables } },
      graphqlUrl,
    )) as {
      data?: unknown;
      errors?: { message?: string; type?: string }[];
    };
    if (answer.errors?.length) {
      const message = answer.errors.map((e) => e.message).join("; ");
      const failure = answer.errors.some((e) => e.type === "FORBIDDEN") ? "auth" : "rejected";
      throw new PullRequestError(failure, `GitHub answered: ${message}`);
    }
    return answer.data;
  }
  const toPullRequest = (value: unknown): PullRequest => {
    const pr = value as { number?: unknown; html_url?: unknown };
    if (typeof pr.number !== "number" || typeof pr.html_url !== "string")
      throw new PullRequestError(
        "unknown",
        "GitHub returned a pull request without a number or URL",
      );
    return { number: pr.number, url: pr.html_url };
  };
  return {
    name: "github",
    repository: (remoteUrl) => repositoryOnHost(remoteUrl, host),
    unavailable: () =>
      options.token ? null : `Missing auth: set ${options.tokenEnv} to a GitHub token`,
    async findByHead(repository, branch) {
      const owner = repository.split("/")[0] ?? "";
      const list = await request(
        `/repos/${repository}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`,
        { method: "GET" },
      );
      if (!Array.isArray(list))
        throw new PullRequestError("unknown", "GitHub returned an unexpected pull request list");
      return list.length ? toPullRequest(list[0]) : null;
    },
    async create(repository, draft) {
      return toPullRequest(
        await request(`/repos/${repository}/pulls`, {
          method: "POST",
          body: {
            title: draft.title,
            body: draft.body,
            head: draft.head,
            base: draft.base,
            draft: draft.draft,
            maintainer_can_modify: false,
          },
        }),
      );
    },
    async checks(repository, commit) {
      const runs = (await request(
        `/repos/${repository}/commits/${commit}/check-runs?per_page=100`,
        {
          method: "GET",
        },
      )) as {
        check_runs?: {
          name?: string;
          status?: string;
          conclusion?: string | null;
          html_url?: string | null;
          output?: { title?: string | null; summary?: string | null };
        }[];
      };
      const statuses = (await request(`/repos/${repository}/commits/${commit}/status`, {
        method: "GET",
      })) as {
        statuses?: {
          context?: string;
          state?: string;
          description?: string | null;
          target_url?: string | null;
        }[];
      };
      if (!Array.isArray(runs.check_runs) || !Array.isArray(statuses.statuses))
        throw new PullRequestError("unknown", "GitHub returned unexpected checks");
      return [
        ...runs.check_runs.map((run) => ({
          name: run.name ?? "check",
          state: checkRunState(run.status ?? "", run.conclusion ?? null),
          detail: [run.output?.title, run.output?.summary]
            .filter(Boolean)
            .join(": ")
            .slice(0, 2000),
          url: run.html_url ?? null,
        })),
        ...statuses.statuses.map((status) => ({
          name: status.context ?? "status",
          state:
            status.state === "success"
              ? ("passed" as const)
              : status.state === "pending"
                ? ("pending" as const)
                : ("failed" as const),
          detail: (status.description ?? "").slice(0, 2000),
          url: status.target_url ?? null,
        })),
      ];
    },
    async reviews(repository, pullRequest) {
      const [owner, name] = repository.split("/");
      const data = (await graphql(REVIEWS_QUERY, { owner, name, number: pullRequest })) as {
        repository?: {
          pullRequest?: {
            reviewThreads?: { nodes?: GraphThread[] };
            latestReviews?: { nodes?: GraphReview[] };
          } | null;
        };
      } | null;
      const pull = data?.repository?.pullRequest;
      if (!pull?.reviewThreads?.nodes || !pull.latestReviews?.nodes)
        throw new PullRequestError("unknown", "GitHub returned unexpected reviews");
      return {
        threads: pull.reviewThreads.nodes.map((thread) => ({
          id: thread.id,
          resolved: thread.isResolved === true,
          outdated: thread.isOutdated === true,
          path: thread.path ?? "",
          line: thread.line ?? null,
          comments: (thread.comments?.nodes ?? []).map((c) => ({
            author: c.author?.login ?? "ghost",
            body: (c.body ?? "").slice(0, 4000),
            url: c.url ?? "",
          })),
        })),
        reviews: pull.latestReviews.nodes.map((review) => ({
          author: review.author?.login ?? "ghost",
          state: review.state ?? "",
          body: (review.body ?? "").slice(0, 4000),
          url: review.url ?? "",
        })),
      };
    },
    async answerThread(threadId, body, resolve) {
      if (body !== null) await graphql(REPLY_MUTATION, { thread: threadId, body });
      if (resolve) await graphql(RESOLVE_MUTATION, { thread: threadId });
    },
  };
}

interface GraphThread {
  id: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: { nodes?: { author?: { login?: string } | null; body?: string; url?: string }[] };
}
interface GraphReview {
  author?: { login?: string } | null;
  state?: string;
  body?: string;
  url?: string;
}
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved isOutdated path line comments(first: 30) { nodes { author { login } body url } } }
      }
      latestReviews(first: 50) { nodes { author { login } state body url } }
    }
  }
}`;
const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
}`;
const RESOLVE_MUTATION = `mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { id } }
}`;

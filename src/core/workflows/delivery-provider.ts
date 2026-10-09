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
export interface PullRequestProvider {
  readonly name: string;
  /** The `owner/name` repository a remote URL points at, or null when this host does not serve it. */
  repository(remoteUrl: string): string | null;
  /** Null when the provider can make calls; otherwise why not (for example a missing token). */
  unavailable(): string | null;
  /** The pull request whose head is this branch of the repository, in any state, or null. */
  findByHead(repository: string, branch: string): Promise<PullRequest | null>;
  create(repository: string, draft: PullRequestDraft): Promise<PullRequest>;
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
  async function request(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    if (!options.token)
      throw new PullRequestError("auth", `Missing auth: set ${options.tokenEnv} to a GitHub token`);
    let response: Response;
    try {
      response = await call(`${api}${path}`, {
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
  };
}

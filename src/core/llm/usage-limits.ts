import { getProviderApiKey } from "../secrets.js";
import { CURRENT_VERSION } from "../version.js";
import { copilotIdeLogin } from "./detected-logins.js";
import { getClaudeCodeLoginStatus } from "./providers/claude-code/cli.js";
import { getCodexLoginStatus, startCodexAppServerSession } from "./providers/codex/client.js";
import {
  ageWindows,
  type LimitProvider,
  loadLimits,
  type ProviderLimits,
  parseCodexRateLimits,
  parseCopilotUser,
  saveLimits,
} from "./usage-limits-record.js";

export * from "./usage-limits-record.js";

/**
 * Reads how much of each subscription's usage limit is left (#2300): Codex through its
 * app-server, Claude Code from the last report its turns recorded, Copilot from GitHub.
 */

export interface LimitReader {
  provider: LimitProvider;
  name: string;
  read(options: ReadOptions): Promise<ProviderLimits>;
}

export interface ReadOptions {
  /** The store of last-seen reports; the data directory's `usage-limits.json` by default. */
  file?: string;
  now?: Date;
  fetch?: typeof fetch;
}

const COPILOT_USER = "https://api.github.com/copilot_internal/user";

const codexReader: LimitReader = {
  provider: "codex",
  name: "Codex",
  async read({ file, now = new Date() }) {
    const base = emptyLimits("codex", "Codex");
    const login = getCodexLoginStatus();
    if (!login.installed || !login.loggedIn)
      return { ...base, state: "not-signed-in", message: login.message };
    if (login.authMode === "api-key")
      return {
        ...base,
        state: "no-data",
        message: "Codex uses an API key: billed per token, with no subscription limit.",
      };
    try {
      const session = await startCodexAppServerSession();
      try {
        const parsed = parseCodexRateLimits(
          await session.request("account/rateLimits/read", {}, 15_000),
          now,
        );
        if (parsed) {
          if (parsed.windows.length) saveLimits({ ...parsed, source: "last-seen" }, file);
          return parsed;
        }
      } finally {
        session.close();
      }
      return lastSeen("codex", file, now, "Codex did not report its limits");
    } catch (error) {
      return lastSeen("codex", file, now, `Codex did not answer (${errorText(error)})`);
    }
  },
};

const claudeReader: LimitReader = {
  provider: "claude-code",
  name: "Claude Code",
  async read({ file, now = new Date() }) {
    const base = emptyLimits("claude-code", "Claude Code");
    const login = getClaudeCodeLoginStatus();
    if (!login.installed || !login.loggedIn)
      return { ...base, state: "not-signed-in", message: login.message };
    if (login.authMethod && /key/i.test(login.authMethod))
      return {
        ...base,
        state: "no-data",
        message: "Claude Code uses an API key: billed per token, with no subscription limit.",
      };
    const seen = loadLimits("claude-code", file);
    if (seen) return ageWindows(seen, now);
    return {
      ...base,
      state: "no-data",
      message:
        "Claude Code reports its limits only while it works. They show here after BAKED's next turn on Claude Code.",
    };
  },
};

const copilotReader: LimitReader = {
  provider: "copilot",
  name: "GitHub Copilot",
  async read({ file, now = new Date(), fetch: get = fetch }) {
    const base = emptyLimits("copilot", "GitHub Copilot");
    const token = getProviderApiKey("COPILOT_API_KEY") ?? copilotIdeLogin()?.token;
    if (!token)
      return {
        ...base,
        state: "not-signed-in",
        message: "Sign in to Copilot in VS Code or JetBrains, or save a token with /keys.",
      };
    try {
      const res = await get(COPILOT_USER, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "User-Agent": `baked/${CURRENT_VERSION}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return lastSeen("copilot", file, now, `GitHub answered ${String(res.status)}`);
      const parsed = parseCopilotUser(await res.json(), now);
      if (!parsed) return lastSeen("copilot", file, now, "GitHub sent no quota");
      if (parsed.windows.length) saveLimits({ ...parsed, source: "last-seen" }, file);
      return parsed;
    } catch (error) {
      return lastSeen("copilot", file, now, `GitHub did not answer (${errorText(error)})`);
    }
  },
};

// ── All providers ────────────────────────────────────────────────────────────

/**
 * Every provider with a subscription limit. A provider that gains one adds its reader here and a
 * parse case in `tests/usage-limits.test.ts`; the API, CLI, TUI and desktop render this list.
 */
export const LIMIT_READERS: readonly LimitReader[] = [codexReader, claudeReader, copilotReader];

export async function readUsageLimits(options: ReadOptions = {}): Promise<ProviderLimits[]> {
  return Promise.all(
    LIMIT_READERS.map((reader) =>
      reader.read(options).catch(
        (error: unknown): ProviderLimits => ({
          ...emptyLimits(reader.provider, reader.name),
          state: "error",
          message: errorText(error),
        }),
      ),
    ),
  );
}

function emptyLimits(provider: LimitProvider, name: string): ProviderLimits {
  return {
    provider,
    name,
    state: "no-data",
    source: null,
    observedAt: null,
    plan: null,
    windows: [],
    credits: null,
    message: "",
  };
}

/** The last recorded report after a failed live read, or the failure itself. */
function lastSeen(
  provider: LimitProvider,
  file: string | undefined,
  now: Date,
  why: string,
): ProviderLimits {
  const seen = loadLimits(provider, file);
  if (seen)
    return {
      ...ageWindows(seen, now),
      source: "last-seen",
      message: `${why}; showing the last report.`,
    };
  const name = LIMIT_READERS.find((r) => r.provider === provider)?.name ?? provider;
  return { ...emptyLimits(provider, name), state: "error", message: `${why}.` };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

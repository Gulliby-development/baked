import { existsSync } from "node:fs";
import { getProviderApiKey } from "../secrets.js";
import { CURRENT_VERSION } from "../version.js";
import { copilotIdeLogin } from "./detected-logins.js";
import {
  type AccountProvider,
  type AccountStoreOptions,
  isAccountProvider,
  readProviderAccounts,
} from "./provider-accounts.js";
import { providerAccountEnv, providerAccountHome } from "./providers/account-env.js";
import { getClaudeCodeLoginStatus } from "./providers/claude-code/cli.js";
import { getCodexLoginStatus, startCodexAppServerSession } from "./providers/codex/client.js";
import {
  ageWindows,
  type LimitAccount,
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
 * app-server, Claude Code from the last report its turns recorded, Copilot from GitHub. A
 * provider with labelled accounts (#2303) is read once for the CLI's own sign-in and once per
 * account, each in that account's credential home.
 */

export interface LimitReader {
  provider: LimitProvider;
  name: string;
  read(options: ReadOptions): Promise<ProviderLimits>;
}

export interface ReadOptions extends AccountStoreOptions {
  /** The store of last-seen reports; the data directory's `usage-limits.json` by default. */
  file?: string;
  now?: Date;
  fetch?: typeof fetch;
  /** The labelled account to read; null or absent for the CLI's own sign-in. */
  account?: LimitAccount | null;
}

/**
 * The environment of a CLI process for the account being read, or undefined for the CLI's own
 * sign-in. `null` means the account has no credential home yet, so it never signed in.
 */
function accountEnv(
  provider: AccountProvider,
  account: LimitAccount | null | undefined,
): NodeJS.ProcessEnv | undefined | null {
  if (!account) return undefined;
  if (!existsSync(providerAccountHome(provider, account.id))) return null;
  return providerAccountEnv(provider, account);
}

const NEVER_SIGNED_IN = "This account has not signed in yet; sign it in under Providers.";

const COPILOT_USER = "https://api.github.com/copilot_internal/user";

const codexReader: LimitReader = {
  provider: "codex",
  name: "Codex",
  async read({ file, now = new Date(), account }) {
    const base = emptyLimits("codex", "Codex", account);
    const env = accountEnv("codex", account);
    if (env === null) return { ...base, state: "not-signed-in", message: NEVER_SIGNED_IN };
    const login = getCodexLoginStatus(env);
    if (!login.installed || !login.loggedIn)
      return { ...base, state: "not-signed-in", message: login.message };
    if (login.authMode === "api-key")
      return {
        ...base,
        state: "no-data",
        message: "Codex uses an API key: billed per token, with no subscription limit.",
      };
    try {
      const session = await startCodexAppServerSession(env ? { env } : {});
      try {
        const parsed = parseCodexRateLimits(
          await session.request("account/rateLimits/read", {}, 15_000),
          now,
        );
        if (parsed) {
          const own = { ...parsed, name: base.name, account: base.account };
          if (own.windows.length) saveLimits({ ...own, source: "last-seen" }, file);
          return own;
        }
      } finally {
        session.close();
      }
      return lastSeen(base, file, now, "Codex did not report its limits");
    } catch (error) {
      return lastSeen(base, file, now, `Codex did not answer (${errorText(error)})`);
    }
  },
};

const claudeReader: LimitReader = {
  provider: "claude-code",
  name: "Claude Code",
  async read({ file, now = new Date(), account }) {
    const base = emptyLimits("claude-code", "Claude Code", account);
    const env = accountEnv("claude-code", account);
    if (env === null) return { ...base, state: "not-signed-in", message: NEVER_SIGNED_IN };
    const login = getClaudeCodeLoginStatus(env ? { env } : {});
    if (!login.installed || !login.loggedIn)
      return { ...base, state: "not-signed-in", message: login.message };
    if (login.authMethod && /key/i.test(login.authMethod))
      return {
        ...base,
        state: "no-data",
        message: "Claude Code uses an API key: billed per token, with no subscription limit.",
      };
    const seen = loadLimits("claude-code", file, account?.id ?? null);
    if (seen) return { ...ageWindows(seen, now), name: base.name, account: base.account };
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
      if (!res.ok) return lastSeen(base, file, now, `GitHub answered ${String(res.status)}`);
      const parsed = parseCopilotUser(await res.json(), now);
      if (!parsed) return lastSeen(base, file, now, "GitHub sent no quota");
      if (parsed.windows.length) saveLimits({ ...parsed, source: "last-seen" }, file);
      return parsed;
    } catch (error) {
      return lastSeen(base, file, now, `GitHub did not answer (${errorText(error)})`);
    }
  },
};

// ── All providers ────────────────────────────────────────────────────────────

/**
 * Every provider with a subscription limit. A provider that gains one adds its reader here and a
 * parse case in `tests/usage-limits.test.ts`; the API, CLI, TUI and desktop render this list.
 */
export const LIMIT_READERS: readonly LimitReader[] = [codexReader, claudeReader, copilotReader];

/**
 * Every provider's limits: the CLI's own sign-in first, then each labelled account of a provider
 * that has them, in the order the person added them.
 */
export async function readUsageLimits(options: ReadOptions = {}): Promise<ProviderLimits[]> {
  return Promise.all(
    limitReads(options).map(({ reader, account }) =>
      reader.read({ ...options, account }).catch(
        (error: unknown): ProviderLimits => ({
          ...emptyLimits(reader.provider, reader.name, account),
          state: "error",
          message: errorText(error),
        }),
      ),
    ),
  );
}

/** Which reader runs for which account, in the order `readUsageLimits` lists them. */
export function limitReads(
  options: AccountStoreOptions = {},
): { reader: LimitReader; account: LimitAccount | null }[] {
  const reads: { reader: LimitReader; account: LimitAccount | null }[] = [];
  for (const reader of LIMIT_READERS) {
    reads.push({ reader, account: null });
    if (!isAccountProvider(reader.provider)) continue;
    const { accounts } = readProviderAccounts(reader.provider, options);
    for (const { id, label } of accounts) reads.push({ reader, account: { id, label } });
  }
  return reads;
}

function emptyLimits(
  provider: LimitProvider,
  name: string,
  account?: LimitAccount | null,
): ProviderLimits {
  return {
    provider,
    name: account ? `${name} · ${account.label}` : name,
    account: account ?? null,
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
  base: ProviderLimits,
  file: string | undefined,
  now: Date,
  why: string,
): ProviderLimits {
  const seen = loadLimits(base.provider, file, base.account?.id ?? null);
  if (seen)
    return {
      ...ageWindows(seen, now),
      name: base.name,
      account: base.account,
      source: "last-seen",
      message: `${why}; showing the last report.`,
    };
  return { ...base, state: "error", message: `${why}.` };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

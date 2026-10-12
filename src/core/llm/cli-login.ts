/**
 * Sign-in for providers that run through a local CLI on the user's subscription (Claude Code,
 * Codex). The CLI keeps its own credentials; BAKED only starts its login, relays the progress
 * lines and sign-in URL it prints, and never reads or stores the tokens. Front ends without a
 * terminal (the desktop app over `baked serve`) start a login here and poll its state.
 */
import { invalidateProviderModelCache } from "./models.js";
import { checkProviders } from "./provider.js";
import {
  getClaudeCodeLoginStatus,
  logoutClaudeCode,
  runClaudeCodeLogin,
} from "./providers/claude-code/cli.js";
import { getCodexLoginStatus, logoutCodex } from "./providers/codex/client.js";
import { runCodexBrowserLogin } from "./providers/codex/login.js";

export const CLI_LOGIN_PROVIDERS = ["claude-code", "codex"] as const;
export type CliLoginProvider = (typeof CLI_LOGIN_PROVIDERS)[number];

export function isCliLoginProvider(id: string): id is CliLoginProvider {
  return (CLI_LOGIN_PROVIDERS as readonly string[]).includes(id);
}

/** Whether the CLI is installed and signed in, as the CLI itself reports it. */
export interface CliSignInStatus {
  installed: boolean;
  loggedIn: boolean;
  /** The CLI's own summary, such as the account type or why it is not usable. */
  message: string;
  /** The command a user can run in a terminal instead. */
  command: string;
}

export type CliLoginState = "running" | "succeeded" | "failed" | "cancelled";

export interface CliLogin {
  provider: CliLoginProvider;
  state: CliLoginState;
  /** Progress lines the CLI printed, oldest first, capped at {@link MAX_LINES}. */
  lines: string[];
  /** The sign-in page to open, once the CLI has printed or returned one. */
  url?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

/** A started CLI login: `onLine` gets progress, `onUrl` the sign-in page. */
export type CliLoginRunner = (
  onLine: (line: string) => void,
  onUrl: (url: string) => void,
) => { promise: Promise<void>; abort: () => void };

export interface CliLoginBackend {
  status(): CliSignInStatus;
  run: CliLoginRunner;
  logout(): { ok: boolean; message: string };
}

const MAX_LINES = 200;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;

const backends: Record<CliLoginProvider, CliLoginBackend> = {
  "claude-code": {
    status: () => {
      const s = getClaudeCodeLoginStatus({ refresh: true });
      return {
        installed: s.installed,
        loggedIn: s.loggedIn,
        message: s.message,
        command: "claude auth login",
      };
    },
    run: (onLine, onUrl) =>
      runClaudeCodeLogin((line) => {
        const url = URL_PATTERN.exec(line)?.[0];
        if (url) onUrl(url);
        onLine(line);
      }),
    logout: () => logoutClaudeCode(),
  },
  codex: {
    status: () => {
      const s = getCodexLoginStatus();
      return {
        installed: s.installed,
        loggedIn: s.loggedIn,
        message: s.message,
        command: "codex login",
      };
    },
    run: (onLine, onUrl) => runCodexBrowserLogin(onLine, onUrl),
    logout: () => logoutCodex(),
  },
};

interface Active {
  login: CliLogin;
  abort: () => void;
  done: Promise<void>;
}

const logins = new Map<CliLoginProvider, Active>();

/** Replaces a provider's backend; tests use it so no real CLI runs. Returns the restore function. */
export function setCliLoginBackend(
  provider: CliLoginProvider,
  backend: CliLoginBackend,
): () => void {
  const previous = backends[provider];
  backends[provider] = backend;
  logins.delete(provider);
  return () => {
    backends[provider] = previous;
    logins.delete(provider);
  };
}

export function cliSignInStatus(provider: CliLoginProvider): CliSignInStatus {
  return backends[provider].status();
}

/** The current or last login of this process for `provider`, if one was started. */
export function getCliLogin(provider: CliLoginProvider): CliLogin | null {
  const active = logins.get(provider);
  return active ? snapshot(active.login) : null;
}

/** Resolves when the current login of `provider` ends; tests and callers that must wait use it. */
export async function cliLoginSettled(provider: CliLoginProvider): Promise<CliLogin | null> {
  await logins.get(provider)?.done;
  return getCliLogin(provider);
}

/**
 * Starts the CLI login of `provider`, or returns the one already running. A login of an already
 * signed-in CLI succeeds at once without opening a browser.
 */
export function startCliLogin(provider: CliLoginProvider): CliLogin {
  const current = logins.get(provider);
  if (current?.login.state === "running") return snapshot(current.login);

  const login: CliLogin = {
    provider,
    state: "running",
    lines: [],
    startedAt: new Date().toISOString(),
  };
  const finish = (state: CliLoginState, error?: string) => {
    if (login.state !== "running") return;
    login.state = state;
    login.endedAt = new Date().toISOString();
    if (error) login.error = error;
  };
  const backend = backends[provider];
  const status = backend.status();
  if (!status.installed) {
    finish("failed", status.message);
    logins.set(provider, { login, abort: () => {}, done: Promise.resolve() });
    return snapshot(login);
  }
  if (status.loggedIn) {
    login.lines.push(`Already signed in. ${status.message}`.trim());
    finish("succeeded");
    logins.set(provider, { login, abort: () => {}, done: Promise.resolve() });
    return snapshot(login);
  }

  let cancelled = false;
  const handle = backend.run(
    (line) => {
      if (login.lines.length >= MAX_LINES) login.lines.shift();
      login.lines.push(line);
    },
    (url) => {
      login.url ??= url;
    },
  );
  const done = handle.promise.then(
    async () => {
      await refreshProvider(provider);
      finish("succeeded");
    },
    (error: unknown) => {
      if (cancelled) finish("cancelled");
      else finish("failed", error instanceof Error ? error.message : String(error));
    },
  );
  logins.set(provider, {
    login,
    abort: () => {
      cancelled = true;
      handle.abort();
    },
    done,
  });
  return snapshot(login);
}

/** Stops a running login. Returns the login's state, or null when none was started. */
export async function cancelCliLogin(provider: CliLoginProvider): Promise<CliLogin | null> {
  const active = logins.get(provider);
  if (!active) return null;
  if (active.login.state === "running") {
    active.abort();
    await active.done;
  }
  return snapshot(active.login);
}

/** Signs the CLI out with its own logout command. */
export async function logoutCli(
  provider: CliLoginProvider,
): Promise<{ ok: boolean; message: string }> {
  const result = backends[provider].logout();
  await refreshProvider(provider);
  return result;
}

/** What {@link switchCliAccount} did: the logout's result and the login it started, if any. */
export interface CliAccountSwitch {
  ok: boolean;
  message: string;
  login: CliLogin | null;
}

/**
 * Switches the CLI to another account, as `/codex switch` does: signs the current account out
 * with the CLI's own logout, then starts its login so the user picks an account in the browser.
 * The CLI keeps one account at a time and its own credentials, so there is no account list. When
 * the logout fails and the CLI is still signed in, no login starts.
 */
export async function switchCliAccount(provider: CliLoginProvider): Promise<CliAccountSwitch> {
  const running = logins.get(provider);
  if (running?.login.state === "running") {
    return { ok: true, message: "A sign-in is already running.", login: snapshot(running.login) };
  }
  const logout = await logoutCli(provider);
  if (!logout.ok && backends[provider].status().loggedIn) {
    return { ok: false, message: logout.message, login: null };
  }
  return { ok: true, message: logout.message, login: startCliLogin(provider) };
}

async function refreshProvider(provider: CliLoginProvider): Promise<void> {
  invalidateProviderModelCache(provider);
  await checkProviders().catch(() => {});
}

function snapshot(login: CliLogin): CliLogin {
  return { ...login, lines: [...login.lines] };
}

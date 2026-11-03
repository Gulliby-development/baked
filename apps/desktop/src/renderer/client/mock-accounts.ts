import type { ApiResponse } from "../../shared/api.js";
import { type MockRoute, response } from "./mock-response.js";
import type { CliLogin, ProviderAccount, ProviderAccounts } from "./setup.js";

// Sample accounts of the Codex and Claude Code providers (#2303), one store for every project:
// accounts live in the global config, and each project chooses its own.

interface Stored {
  id: string;
  label: string;
  allowedProjects: string[];
  loggedIn: boolean;
  login: CliLogin | null;
  polls: number;
}

const NAMES: Record<ProviderAccounts["provider"], string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};
const COMMANDS: Record<ProviderAccounts["provider"], string> = {
  codex: "codex login",
  "claude-code": "claude auth login",
};
/** A sample sign-in finishes after a few polls, as if completed in the browser. */
const LOGIN_POLLS = 3;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const store: Record<ProviderAccounts["provider"], Stored[]> = {
  codex: [],
  "claude-code": [
    {
      id: "personal",
      label: "Personal",
      allowedProjects: ["/Users/me/code/baked"],
      loggedIn: true,
      login: null,
      polls: 0,
    },
    {
      id: "client",
      label: "Client seat",
      allowedProjects: ["/Users/me/code/client-portal"],
      loggedIn: false,
      login: null,
      polls: 0,
    },
  ],
};
/** Project folder → provider → the account it uses. */
const chosen = new Map<string, Partial<Record<ProviderAccounts["provider"], string>>>();

const fail = (status: number, code: string, message: string): ApiResponse =>
  response(status, { error: { code, message } });

/** The sample project folder of a backend key. */
const projectOf = (key: string): string => `/Users/me/code/${key}`;

function view(key: string, provider: ProviderAccounts["provider"]): ProviderAccounts {
  const project = projectOf(key);
  const picked = chosen.get(project)?.[provider] ?? null;
  const active = store[provider].some((a) => a.id === picked && a.allowedProjects.includes(project))
    ? picked
    : null;
  return {
    provider,
    name: NAMES[provider],
    project,
    active,
    accounts: store[provider].map(
      (a): ProviderAccount => ({
        id: a.id,
        label: a.label,
        allowedProjects: [...a.allowedProjects],
        allowed: a.allowedProjects.includes(project),
        active: a.id === active,
        home: `~/.baked/${provider === "codex" ? "codex" : "claude"}-accounts/${a.id}`,
        signIn: {
          installed: true,
          loggedIn: a.loggedIn,
          message: a.loggedIn ? "Logged in" : "Not logged in",
          command: COMMANDS[provider],
        },
        login: a.login,
      }),
    ),
  };
}

function isProvider(id: string | undefined): id is ProviderAccounts["provider"] {
  return id === "codex" || id === "claude-code";
}

function signIn(account: Stored, provider: string, method: string): ApiResponse {
  if (method === "POST" && account.login?.state !== "running") {
    account.polls = 0;
    account.login = {
      provider,
      state: "running",
      lines: ["Opening browser to sign in…", "Waiting for the sign-in to finish in the browser."],
      url: "https://example.com/sign-in",
      startedAt: new Date().toISOString(),
    };
    return response(202, { login: account.login });
  }
  if (method === "DELETE" && account.login?.state === "running")
    Object.assign(account.login, { state: "cancelled", endedAt: new Date().toISOString() });
  if (method === "GET" && account.login?.state === "running") {
    account.polls += 1;
    if (account.polls >= LOGIN_POLLS) {
      account.login.lines.push("Signed in.");
      Object.assign(account.login, { state: "succeeded", endedAt: new Date().toISOString() });
      account.loggedIn = true;
    }
  }
  return response(200, { login: account.login });
}

export const accountRoutes: MockRoute = ({ key, method, path, query, body }) => {
  const sign = /^\/v1\/providers\/([a-z0-9-]+)\/(login|logout)$/.exec(path);
  const accountId = query.get("account");
  if (sign && accountId) {
    const provider = sign[1];
    if (!isProvider(provider)) return fail(404, "NOT_FOUND", "No accounts for this provider");
    const account = store[provider].find((a) => a.id === accountId);
    if (!account) return fail(404, "NOT_FOUND", `${provider} has no account ${accountId}`);
    if (sign[2] === "logout") {
      Object.assign(account, { loggedIn: false, login: null });
      return response(200, { ok: true, message: "Logged out." });
    }
    return signIn(account, provider, method);
  }
  const list = /^\/v1\/providers\/([a-z0-9-]+)\/accounts(?:\/([a-z0-9-]+))?$/.exec(path);
  const choice = /^\/v1\/providers\/([a-z0-9-]+)\/account$/.exec(path);
  const provider = list?.[1] ?? choice?.[1];
  if (!list && !choice) return undefined;
  if (!isProvider(provider)) return fail(404, "NOT_FOUND", "This provider keeps no accounts");
  const accounts = store[provider];
  if (choice) {
    const id = (body as { account?: string | null } | undefined)?.account ?? null;
    const project = projectOf(key);
    const picks = chosen.get(project) ?? {};
    if (id === null) delete picks[provider];
    else {
      const account = accounts.find((a) => a.id === id);
      if (!account) return fail(404, "NOT_FOUND", `${provider} has no account ${id}`);
      if (!account.allowedProjects.includes(project)) account.allowedProjects.push(project);
      picks[provider] = id;
    }
    chosen.set(project, picks);
    return response(200, view(key, provider));
  }
  const itemId = list?.[2];
  if (itemId) {
    const at = accounts.findIndex((a) => a.id === itemId);
    if (at < 0) return fail(404, "NOT_FOUND", `${provider} has no account ${itemId}`);
    if (method === "DELETE") accounts.splice(at, 1);
    else if (method === "PATCH") {
      const change = (body ?? {}) as { label?: string; allowedProjects?: string[] };
      const account = accounts[at];
      if (account && change.label?.trim()) account.label = change.label.trim();
      if (account && change.allowedProjects) account.allowedProjects = [...change.allowedProjects];
    }
    return response(200, view(key, provider));
  }
  if (method === "POST") {
    const input = (body ?? {}) as { id?: string; label?: string };
    if (!input.id || !ID.test(input.id))
      return fail(400, "INVALID_REQUEST", "Use lowercase letters, digits and hyphens for the ID");
    if (!input.label?.trim()) return fail(400, "INVALID_REQUEST", "Give the account a label");
    if (accounts.some((a) => a.id === input.id))
      return fail(409, "CONFLICT", `${provider} already has an account ${input.id}`);
    accounts.push({
      id: input.id,
      label: input.label.trim(),
      allowedProjects: [],
      loggedIn: false,
      login: null,
      polls: 0,
    });
    return response(201, view(key, provider));
  }
  return response(200, view(key, provider));
};

/**
 * Several subscriptions of one provider (#2303): a personal plan, an employer's seat, a client's
 * seat. Each is a labelled account with its own credential home (`providerAccountEnv` in
 * `providers/account-env.ts`) and the projects it may serve. A project uses an account only when
 * the person chose it there; with none chosen it uses the CLI's own sign-in, as before accounts
 * existed. BAKED never moves a project to another account by itself.
 *
 * The accounts live only in the global `config.json` under `providers.<id>`:
 *
 * ```json
 * "providers": { "codex": {
 *   "accounts": [{ "id": "work", "label": "Employer", "allowedProjects": ["/abs/project"] }],
 *   "projectAccounts": { "/abs/project": "work" }
 * } }
 * ```
 *
 * A project's own `.baked/config.json` is never read for them: a checkout must not be able to
 * grant itself someone's account.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getCwd } from "../cwd.js";
import { configDir as defaultConfigDir } from "../platform/index.js";
import { realPath } from "../projects/paths.js";
import { writeViaTemp } from "../workflows/atomic-write.js";

/** Providers whose credentials BAKED can keep per account. A new one adds its `ACCOUNT_ENV` row. */
export const ACCOUNT_PROVIDERS = ["codex", "claude-code"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export function isAccountProvider(id: string): id is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly string[]).includes(id);
}

export interface ProviderAccount {
  /** Lowercase letters, digits and hyphens; names the credential home folder. */
  id: string;
  /** What the person calls it: "Personal", "Employer", "Client". */
  label: string;
  /** Real paths of the projects this account may serve. Empty: none yet. */
  allowedProjects: string[];
}

export interface ProviderAccountsSection {
  accounts: ProviderAccount[];
  /** Project real path → the account it uses. */
  projectAccounts: Record<string, string>;
}

export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_LABEL = 60;

/** Why an account change was refused; the API answers it with 400 or 404. */
export class ProviderAccountError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "CONFLICT" = "INVALID_REQUEST",
  ) {
    super(message);
  }
}

export interface AccountStoreOptions {
  /** The folder of the global `config.json`; tests point it at a temporary profile. */
  configDir?: string;
}

function configFile(options: AccountStoreOptions): string {
  return join(options.configDir ?? defaultConfigDir(), "config.json");
}

function readGlobal(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function strictGlobal(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ProviderAccountError(`${file} does not hold a JSON object`, "CONFLICT");
  return parsed as Record<string, unknown>;
}

function section(
  root: Record<string, unknown>,
  provider: AccountProvider,
): ProviderAccountsSection {
  const providers = root.providers;
  const raw =
    providers && typeof providers === "object" && !Array.isArray(providers)
      ? (providers as Record<string, unknown>)[provider]
      : undefined;
  const node = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const list = (node as { accounts?: unknown }).accounts;
  const accounts: ProviderAccount[] = [];
  const seen = new Set<string>();
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const { id, label, allowedProjects } = item as Record<string, unknown>;
      if (typeof id !== "string" || !ACCOUNT_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      accounts.push({
        id,
        label: typeof label === "string" && label.trim() ? label.trim() : id,
        allowedProjects: Array.isArray(allowedProjects)
          ? allowedProjects.filter((p): p is string => typeof p === "string" && isAbsolute(p))
          : [],
      });
    }
  }
  const map = (node as { projectAccounts?: unknown }).projectAccounts;
  const projectAccounts: Record<string, string> = {};
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [project, id] of Object.entries(map as Record<string, unknown>))
      if (typeof id === "string" && seen.has(id)) projectAccounts[project] = id;
  }
  return { accounts, projectAccounts };
}

/** The accounts of `provider` and which project uses which. Unreadable config reads as none. */
export function readProviderAccounts(
  provider: AccountProvider,
  options: AccountStoreOptions = {},
): ProviderAccountsSection {
  return section(readGlobal(configFile(options)), provider);
}

function write(
  provider: AccountProvider,
  options: AccountStoreOptions,
  change: (current: ProviderAccountsSection) => ProviderAccountsSection,
): ProviderAccountsSection {
  const file = configFile(options);
  const root = strictGlobal(file);
  const next = change(section(root, provider));
  const providers =
    root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : {};
  const previous = providers[provider];
  const {
    accounts: _accounts,
    projectAccounts: _projectAccounts,
    ...kept
  } = previous && typeof previous === "object" && !Array.isArray(previous)
    ? (previous as Record<string, unknown>)
    : {};
  const node: Record<string, unknown> = { ...kept };
  if (next.accounts.length) node.accounts = next.accounts;
  if (Object.keys(next.projectAccounts).length) node.projectAccounts = next.projectAccounts;
  const { [provider]: _old, ...others } = providers;
  const nextProviders = Object.keys(node).length ? { ...others, [provider]: node } : others;
  const { providers: _providers, ...rest } = root;
  const out = Object.keys(nextProviders).length ? { ...rest, providers: nextProviders } : rest;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeViaTemp(file, `${JSON.stringify(out, null, 2)}\n`, { flag: "w", flush: true });
  return next;
}

function cleanLabel(label: string): string {
  const clean = label.trim();
  if (!clean) throw new ProviderAccountError("Give the account a label, e.g. Personal or Work.");
  if (clean.length > MAX_LABEL)
    throw new ProviderAccountError(`Keep the label under ${String(MAX_LABEL)} characters.`);
  return clean;
}

function cleanProjects(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!isAbsolute(path))
      throw new ProviderAccountError(`Send absolute project folders, not ${path}.`);
    const real = realPath(path);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** Adds an account; its credential home is made when it first signs in or runs. */
export function addProviderAccount(
  provider: AccountProvider,
  input: { id: string; label: string; allowedProjects?: readonly string[] },
  options: AccountStoreOptions = {},
): ProviderAccountsSection {
  if (!ACCOUNT_ID.test(input.id))
    throw new ProviderAccountError(
      "Use 1 to 40 lowercase letters, digits and hyphens for the account ID, e.g. work.",
    );
  const label = cleanLabel(input.label);
  const allowedProjects = cleanProjects(input.allowedProjects ?? []);
  return write(provider, options, (current) => {
    if (current.accounts.some((a) => a.id === input.id))
      throw new ProviderAccountError(`${provider} already has an account ${input.id}.`, "CONFLICT");
    return {
      ...current,
      accounts: [...current.accounts, { id: input.id, label, allowedProjects }],
    };
  });
}

/** Changes an account's label or the projects it may serve. A project it may no longer serve stops using it. */
export function updateProviderAccount(
  provider: AccountProvider,
  id: string,
  change: { label?: string; allowedProjects?: readonly string[] },
  options: AccountStoreOptions = {},
): ProviderAccountsSection {
  const label = change.label === undefined ? undefined : cleanLabel(change.label);
  const allowed =
    change.allowedProjects === undefined ? undefined : cleanProjects(change.allowedProjects);
  return write(provider, options, (current) => {
    const account = current.accounts.find((a) => a.id === id);
    if (!account) throw new ProviderAccountError(`${provider} has no account ${id}.`, "NOT_FOUND");
    const next: ProviderAccount = {
      ...account,
      ...(label ? { label } : {}),
      ...(allowed ? { allowedProjects: allowed } : {}),
    };
    const projectAccounts = Object.fromEntries(
      Object.entries(current.projectAccounts).filter(
        ([project, used]) => used !== id || next.allowedProjects.includes(project),
      ),
    );
    return {
      accounts: current.accounts.map((a) => (a.id === id ? next : a)),
      projectAccounts,
    };
  });
}

/** Removes an account from the config; every project that used it goes back to the CLI's own sign-in. */
export function removeProviderAccount(
  provider: AccountProvider,
  id: string,
  options: AccountStoreOptions = {},
): ProviderAccountsSection {
  return write(provider, options, (current) => {
    if (!current.accounts.some((a) => a.id === id))
      throw new ProviderAccountError(`${provider} has no account ${id}.`, "NOT_FOUND");
    return {
      accounts: current.accounts.filter((a) => a.id !== id),
      projectAccounts: Object.fromEntries(
        Object.entries(current.projectAccounts).filter(([, used]) => used !== id),
      ),
    };
  });
}

/**
 * Chooses the account `project` uses, or with null goes back to the CLI's own sign-in. Choosing
 * an account the project is not allowed to use is refused unless `allow` adds the project to it,
 * which a person choosing it from inside the project does.
 */
export function setProjectAccount(
  provider: AccountProvider,
  project: string,
  id: string | null,
  options: AccountStoreOptions & { allow?: boolean } = {},
): ProviderAccountsSection {
  const root = projectRootOf(project);
  return write(provider, options, (current) => {
    const projectAccounts = { ...current.projectAccounts };
    if (id === null) {
      delete projectAccounts[root];
      return { ...current, projectAccounts };
    }
    const account = current.accounts.find((a) => a.id === id);
    if (!account) throw new ProviderAccountError(`${provider} has no account ${id}.`, "NOT_FOUND");
    let accounts = current.accounts;
    if (!account.allowedProjects.includes(root)) {
      if (!options.allow)
        throw new ProviderAccountError(
          `Account ${account.label} is not allowed for ${root}; allow it for this project first.`,
          "CONFLICT",
        );
      accounts = current.accounts.map((a) =>
        a.id === id ? { ...a, allowedProjects: [...a.allowedProjects, root] } : a,
      );
    }
    projectAccounts[root] = id;
    return { accounts, projectAccounts };
  });
}

/**
 * The project a folder belongs to: the main checkout of its Git repository, so a workflow
 * worktree or a chat session's worktree uses its project's account. Read from the `.git` file
 * and `commondir` without running Git, since every model turn asks. A folder outside Git is its
 * own project.
 */
export function projectRootOf(folder: string): string {
  let dir = resolve(folder);
  for (;;) {
    const git = join(dir, ".git");
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(git);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return realPath(dir);
    if (stat?.isFile()) return realPath(mainCheckout(git) ?? dir);
    const parent = dirname(dir);
    if (parent === dir) return realPath(folder);
    dir = parent;
  }
}

/** The main checkout a worktree's `.git` file leads to, through its gitdir's `commondir`. */
function mainCheckout(gitFile: string): string | null {
  try {
    const line = readFileSync(gitFile, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/m.exec(line);
    if (!match?.[1]) return null;
    const gitDir = resolve(dirname(gitFile), match[1].trim());
    const commonFile = join(gitDir, "commondir");
    const common = existsSync(commonFile)
      ? resolve(gitDir, readFileSync(commonFile, "utf8").trim())
      : gitDir;
    // The common dir of a normal repository is `<checkout>/.git`.
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

/** An account and how it stands for one project. */
export interface ProjectAccountView extends ProviderAccount {
  /** The project may use this account. */
  allowed: boolean;
  /** The project uses this account. */
  active: boolean;
}

/** The accounts of `provider` as one project sees them, and the one it uses (null: the CLI's own sign-in). */
export function projectAccounts(
  provider: AccountProvider,
  folder: string = getCwd(),
  options: AccountStoreOptions = {},
): { project: string; active: string | null; accounts: ProjectAccountView[] } {
  const project = projectRootOf(folder);
  const { accounts, projectAccounts: chosen } = readProviderAccounts(provider, options);
  const active = activeIn(accounts, chosen, project)?.id ?? null;
  return {
    project,
    active,
    accounts: accounts.map((a) => ({
      ...a,
      allowed: a.allowedProjects.includes(project),
      active: a.id === active,
    })),
  };
}

function activeIn(
  accounts: ProviderAccount[],
  chosen: Record<string, string>,
  project: string,
): ProviderAccount | null {
  const id = chosen[project];
  const account = id ? accounts.find((a) => a.id === id) : undefined;
  // A choice whose account no longer lists the project is void, never a fallback elsewhere.
  return account?.allowedProjects.includes(project) ? account : null;
}

/** The account a run asked for per provider (`--account codex=work`); the rest keep the project's. */
export type AccountChoice = Partial<Record<AccountProvider, string>>;

const runAccounts = new AsyncLocalStorage<AccountChoice>();

/**
 * Runs `fn` with `choice` winning over the project's account for the providers it names: every
 * model turn, login check and app-server it starts uses the chosen account. With no choice, `fn`
 * runs as it is.
 */
export function runWithAccounts<T>(choice: AccountChoice | null | undefined, fn: () => T): T {
  if (!choice || Object.keys(choice).length === 0) return fn();
  return runAccounts.run(choice, fn);
}

/**
 * Parses `codex=work,claude-code=client` (or repeated values) into a choice; refuses a provider
 * that keeps no accounts, a malformed ID and a provider named twice.
 */
export function parseAccountChoice(values: string | readonly string[]): AccountChoice {
  const choice: AccountChoice = {};
  const parts = (typeof values === "string" ? [values] : values).flatMap((v) => v.split(","));
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    const [provider = "", id = "", ...rest] = text.split("=").map((x) => x.trim());
    if (!isAccountProvider(provider) || rest.length)
      throw new ProviderAccountError(
        `Write the account as PROVIDER=ID with a provider of ${ACCOUNT_PROVIDERS.join(", ")}; got ${text}.`,
      );
    if (!ACCOUNT_ID.test(id))
      throw new ProviderAccountError(`${id || "(empty)"} is not an account ID of ${provider}.`);
    if (choice[provider] !== undefined && choice[provider] !== id)
      throw new ProviderAccountError(
        `${provider} is given two accounts: ${choice[provider]} and ${id}.`,
      );
    choice[provider] = id;
  }
  return choice;
}

/**
 * The account `choice` names for `provider`, refused (never replaced by another account) when it
 * does not exist or may not serve `folder`'s project.
 */
function chosenAccount(
  provider: AccountProvider,
  id: string,
  accounts: ProviderAccount[],
  project: string,
): ProviderAccount {
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new ProviderAccountError(`${provider} has no account ${id}.`, "NOT_FOUND");
  if (!account.allowedProjects.includes(project))
    throw new ProviderAccountError(
      `Account ${account.label} of ${provider} is not allowed for ${project}; allow it for this project first.`,
      "CONFLICT",
    );
  return account;
}

/** Checks every account of `choice` before a run starts on it: it exists and may serve the project. */
export function checkAccountChoice(
  choice: AccountChoice,
  folder: string = getCwd(),
  options: AccountStoreOptions = {},
): void {
  const project = projectRootOf(folder);
  for (const [provider, id] of Object.entries(choice) as [AccountProvider, string][])
    chosenAccount(provider, id, readProviderAccounts(provider, options).accounts, project);
}

/**
 * The account model turns of `provider` use in `folder`'s project, or null for the CLI's own
 * sign-in: the one the run chose (`runWithAccounts`), else the project's. Read on every turn so
 * a change in Settings applies to the next one.
 */
export function activeProviderAccount(
  provider: AccountProvider,
  folder: string = getCwd(),
  options: AccountStoreOptions = {},
): ProviderAccount | null {
  const { accounts, projectAccounts: chosen } = readProviderAccounts(provider, options);
  const forced = runAccounts.getStore()?.[provider];
  if (forced !== undefined) return chosenAccount(provider, forced, accounts, projectRootOf(folder));
  if (accounts.length === 0) return null;
  return activeIn(accounts, chosen, projectRootOf(folder));
}

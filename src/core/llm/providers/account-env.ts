/**
 * Per-account credential homes (#2303). Each account of a provider that signs in through its own
 * CLI gets a BAKED-owned folder the CLI keeps that account's sign-in in, and every process BAKED
 * starts for the account (its login, status, logout and model turns) gets the environment that
 * points the CLI there. Workflows and agents never see accounts: they reach a provider, and the
 * provider layer picks the home of the account the project uses.
 *
 * A provider that gains accounts adds its row to `ACCOUNT_ENV` (and to `ACCOUNT_PROVIDERS` in
 * `provider-accounts.ts`); `tests/provider-accounts.test.ts` fails on a provider without one.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../platform/index.js";
import {
  type AccountProvider,
  activeProviderAccount,
  type ProviderAccount,
} from "../provider-accounts.js";

interface AccountHomeSpec {
  /** The folder under `dataDir()` that holds one subfolder per account. */
  folder: string;
  /** The environment variables that point the CLI at an account's home. */
  env: (home: string) => Record<string, string>;
  /** Files a new home starts with, so the CLI keeps the sign-in in it. */
  seed?: Record<string, string>;
}

export const ACCOUNT_ENV: Record<AccountProvider, AccountHomeSpec> = {
  codex: {
    folder: "codex-accounts",
    env: (home) => ({ CODEX_HOME: home }),
    // The keyring would hold one sign-in for every home; a file keeps each account in its own.
    seed: { "config.toml": 'cli_auth_credentials_store = "file"\n' },
  },
  "claude-code": {
    folder: "claude-accounts",
    env: (home) => ({ CLAUDE_CONFIG_DIR: home }),
  },
};

/** The credential home of one account: `dataDir()/<provider folder>/<id>`. */
export function providerAccountHome(provider: AccountProvider, id: string): string {
  return join(dataDir(), ACCOUNT_ENV[provider].folder, id);
}

/** Makes the account's home with its seed files, keeping whatever the CLI already wrote there. */
export function ensureProviderAccountHome(provider: AccountProvider, id: string): string {
  const home = providerAccountHome(provider, id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(ACCOUNT_ENV[provider].seed ?? {})) {
    const file = join(home, name);
    if (!existsSync(file)) writeFileSync(file, text, { mode: 0o600 });
  }
  return home;
}

/** Deletes an account's home and the sign-in the CLI kept in it. */
export function removeProviderAccountHome(provider: AccountProvider, id: string): void {
  rmSync(providerAccountHome(provider, id), { recursive: true, force: true });
}

/**
 * The environment of a process that acts for `account` of `provider`: `env` with the variables
 * that point the CLI at the account's home. With no account, `env` unchanged, so the CLI uses
 * its own sign-in as it did before accounts existed.
 */
export function providerAccountEnv(
  provider: AccountProvider,
  account: Pick<ProviderAccount, "id"> | null,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!account) return env;
  const home = ensureProviderAccountHome(provider, account.id);
  return { ...env, ...ACCOUNT_ENV[provider].env(home) };
}

/**
 * The environment of the account `folder`'s project uses for `provider`, or undefined when it
 * uses the CLI's own sign-in, so a caller that ran the CLI without an environment keeps doing so.
 */
export function activeAccountEnv(
  provider: AccountProvider,
  folder?: string,
): NodeJS.ProcessEnv | undefined {
  const account = activeProviderAccount(provider, folder);
  return account ? providerAccountEnv(provider, account) : undefined;
}

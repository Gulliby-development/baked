/**
 * What every surface shows of a provider's accounts (#2303): `GET /v1/providers/:id/accounts`,
 * `baked accounts`, the TUI's `/accounts` and the desktop's Providers page all render this view,
 * and change accounts only through the functions here.
 */
import {
  type CliLogin,
  type CliLoginProvider,
  type CliSignInStatus,
  cliSignInStatus,
  getCliLogin,
  logoutCli,
} from "./cli-login.js";
import {
  ACCOUNT_PROVIDERS,
  type AccountProvider,
  type AccountStoreOptions,
  type ProjectAccountView,
  projectAccounts,
  removeProviderAccount,
} from "./provider-accounts.js";
import { providerAccountHome, removeProviderAccountHome } from "./providers/account-env.js";

export const ACCOUNT_PROVIDER_NAMES: Record<AccountProvider, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

export interface AccountView extends ProjectAccountView {
  /** The folder the CLI keeps this account's sign-in in. */
  home: string;
  signIn: CliSignInStatus;
  login: CliLogin | null;
}

export interface ProviderAccountsView {
  provider: AccountProvider;
  name: string;
  /** The project the view is for: the main checkout of the workspace. */
  project: string;
  /** The account the project uses; null for the CLI's own sign-in. */
  active: string | null;
  accounts: AccountView[];
}

/**
 * The accounts of `provider` for `folder`'s project, each with its sign-in state as its CLI
 * reports it. `signIn: false` skips asking the CLIs, for a quick listing.
 */
export function providerAccountsView(
  provider: AccountProvider,
  folder?: string,
  options: AccountStoreOptions & { signIn?: boolean } = {},
): ProviderAccountsView {
  const view = projectAccounts(provider, folder, options);
  return {
    provider,
    name: ACCOUNT_PROVIDER_NAMES[provider],
    project: view.project,
    active: view.active,
    accounts: view.accounts.map((account) => ({
      ...account,
      home: providerAccountHome(provider, account.id),
      signIn:
        options.signIn === false
          ? { installed: true, loggedIn: false, message: "not checked", command: "" }
          : cliSignInStatus(provider as CliLoginProvider, account.id),
      login: getCliLogin(provider as CliLoginProvider, account.id),
    })),
  };
}

/** Every provider's accounts for `folder`'s project. */
export function allProviderAccounts(
  folder?: string,
  options: AccountStoreOptions & { signIn?: boolean } = {},
): ProviderAccountsView[] {
  return ACCOUNT_PROVIDERS.map((provider) => providerAccountsView(provider, folder, options));
}

/**
 * Removes an account: signs it out with its CLI's own logout (best effort), deletes its
 * credential home and drops it from the config. Projects that used it go back to the CLI's own
 * sign-in; none is moved to another account.
 */
export async function deleteProviderAccount(
  provider: AccountProvider,
  id: string,
  options: AccountStoreOptions = {},
): Promise<void> {
  await logoutCli(provider as CliLoginProvider, id).catch(() => {});
  removeProviderAccount(provider, id, options);
  removeProviderAccountHome(provider, id);
}

import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import { getCwd } from "../cwd.js";
import { icon } from "../icons.js";
import {
  allProviderAccounts,
  deleteProviderAccount,
  type ProviderAccountsView,
} from "../llm/account-overview.js";
import { cliLoginSettled, getCliLogin, logoutCli, startCliLogin } from "../llm/cli-login.js";
import {
  ACCOUNT_PROVIDERS,
  type AccountProvider,
  addProviderAccount,
  isAccountProvider,
  ProviderAccountError,
  setProjectAccount,
} from "../llm/provider-accounts.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

const TITLE = "Provider accounts";
const USAGE = [
  "/accounts                                 list accounts and the one this project uses",
  "/accounts add <provider> <id> <label>     add an account",
  "/accounts login <provider> <id>           sign it in, in its own credential home",
  "/accounts use <provider> <id|default>     choose it for this project (default: the CLI's own)",
  "/accounts logout <provider> <id>          sign it out",
  "/accounts remove <provider> <id>          sign out, delete its home, drop it",
];

function linesOf(views: ProviderAccountsView[]): InfoPopupLine[] {
  const theme = getThemeTokens();
  const lines: InfoPopupLine[] = [];
  for (const view of views) {
    if (lines.length) lines.push({ type: "spacer" });
    lines.push({ type: "header", label: view.name });
    lines.push({
      type: "text",
      label: view.active
        ? `This project uses ${view.active}.`
        : "This project uses the CLI's own sign-in.",
      color: theme.textSecondary,
    });
    for (const a of view.accounts) {
      const state = !a.signIn.installed
        ? "CLI not installed"
        : a.signIn.loggedIn
          ? "signed in"
          : "signed out";
      lines.push({
        type: "entry",
        label: `${a.active ? "* " : "  "}${a.id}`,
        desc: [a.label, state, a.allowed ? "allowed here" : "not allowed here"].join(" · "),
        descColor: a.signIn.loggedIn ? theme.success : theme.warning,
      });
    }
  }
  lines.push({ type: "spacer" });
  for (const usage of USAGE) lines.push({ type: "text", label: usage, color: theme.textMuted });
  return lines;
}

function show(ctx: CommandContext): void {
  ctx.openInfoPopup({
    title: TITLE,
    icon: icon("key"),
    lines: linesOf(allProviderAccounts(getCwd())),
    labelWidth: 20,
    width: 96,
  });
}

/** The words after the subcommand: `/accounts use codex work` → `["codex", "work"]`. */
function words(input: string): string[] {
  return input.trim().split(/\s+/).slice(2);
}

function providerOf(name: string | undefined): AccountProvider {
  if (!name || !isAccountProvider(name))
    throw new ProviderAccountError(`Name the provider: ${ACCOUNT_PROVIDERS.join(" or ")}.`);
  return name;
}

/** Runs an account change and shows the list, or the reason it was refused. */
function guarded(
  work: (args: string[], ctx: CommandContext) => Promise<void> | void,
): CommandHandler {
  return async (input, ctx) => {
    try {
      await work(words(input), ctx);
      show(ctx);
    } catch (error) {
      if (!(error instanceof ProviderAccountError)) throw error;
      sysMsg(ctx, error.message);
    }
  };
}

const handleAdd = guarded(([name, id, ...label]) => {
  if (!id || label.length === 0)
    throw new ProviderAccountError("Usage: /accounts add <provider> <id> <label>");
  addProviderAccount(providerOf(name), { id, label: label.join(" ") });
});

const handleUse = guarded(([name, id]) => {
  if (!id) throw new ProviderAccountError("Usage: /accounts use <provider> <id|default>");
  const provider = providerOf(name);
  if (id === "default") setProjectAccount(provider, getCwd(), null);
  else setProjectAccount(provider, getCwd(), id, { allow: true });
});

const handleLogout = guarded(async ([name, id], ctx) => {
  if (!id) throw new ProviderAccountError("Usage: /accounts logout <provider> <id>");
  const result = await logoutCli(providerOf(name), id);
  sysMsg(ctx, result.message);
});

const handleRemove = guarded(async ([name, id]) => {
  if (!id) throw new ProviderAccountError("Usage: /accounts remove <provider> <id>");
  await deleteProviderAccount(providerOf(name), id);
});

/** Starts the account's sign-in, which opens the browser, and shows the page to open meanwhile. */
const handleLogin: CommandHandler = async (input, ctx) => {
  const theme = getThemeTokens();
  const [name, id] = words(input);
  try {
    if (!id) throw new ProviderAccountError("Usage: /accounts login <provider> <id>");
    const provider = providerOf(name);
    let login = startCliLogin(provider, id);
    const render = (): void =>
      ctx.openInfoPopup({
        title: `Sign in ${provider} account ${id}`,
        icon: icon("key"),
        width: 96,
        lines: [
          ...(login.url ? [{ type: "text" as const, label: `Open ${login.url}` }] : []),
          ...login.lines.slice(-8).map((label) => ({
            type: "text" as const,
            label,
            color: theme.textSecondary,
          })),
          {
            type: "text",
            label:
              login.state === "running"
                ? "Waiting for the sign-in to finish in the browser..."
                : login.state === "succeeded"
                  ? "Signed in."
                  : (login.error ?? `Sign-in ${login.state}.`),
            color:
              login.state === "succeeded"
                ? theme.success
                : login.state === "running"
                  ? theme.textMuted
                  : theme.warning,
          },
        ],
      });
    render();
    while (login.state === "running") {
      await Promise.race([cliLoginSettled(provider, id), Bun.sleep(500)]);
      login = getCliLogin(provider, id) ?? login;
      render();
    }
  } catch (error) {
    if (!(error instanceof ProviderAccountError)) throw error;
    sysMsg(ctx, error.message);
  }
};

export function register(map: Map<string, CommandHandler>): void {
  map.set("/accounts", async (_input, ctx) => show(ctx));
  map.set("/accounts add", handleAdd);
  map.set("/accounts login", handleLogin);
  map.set("/accounts use", handleUse);
  map.set("/accounts logout", handleLogout);
  map.set("/accounts remove", handleRemove);
}

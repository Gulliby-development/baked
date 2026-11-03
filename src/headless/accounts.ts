import { getCwd } from "../core/cwd.js";
import {
  allProviderAccounts,
  deleteProviderAccount,
  type ProviderAccountsView,
  providerAccountsView,
} from "../core/llm/account-overview.js";
import {
  ACCOUNT_PROVIDERS,
  type AccountProvider,
  addProviderAccount,
  isAccountProvider,
  ProviderAccountError,
  setProjectAccount,
  updateProviderAccount,
} from "../core/llm/provider-accounts.js";
import { BOLD, DIM, GREEN, PURPLE, RST, YELLOW } from "./constants.js";

const help = `Usage: baked accounts [--json]
       baked accounts add <codex|claude-code> <id> --label <label>
       baked accounts use <codex|claude-code> <id>
       baked accounts use <codex|claude-code> --default
       baked accounts allow <codex|claude-code> <id> <project folder>...
       baked accounts remove <codex|claude-code> <id>

Several subscriptions of one provider, such as a personal plan and an employer's seat, each under
its own label and credential home. Without a subcommand it lists every account, whether it is
signed in, whether this project may use it and which one it uses. A project uses an account only
when you choose it with use (which also allows it there); otherwise it uses the CLI's own
sign-in, as before. BAKED never moves a project to another account by itself.

Sign an account in with baked login <provider> --account <id>. allow replaces the folders an
account may serve. remove signs the account out, deletes its credential home and sends the
projects that used it back to the CLI's own sign-in. --json prints the answer of the local
API's GET /v1/providers/:id/accounts for each provider.
`;

function line(view: ProviderAccountsView): string {
  const out = [`${BOLD}${PURPLE()}${view.name}${RST}`];
  if (view.accounts.length === 0) {
    out.push(`  ${DIM}No accounts; this project uses the CLI's own sign-in.${RST}`);
    return out.join("\n");
  }
  out.push(
    view.active
      ? `  this project uses ${BOLD}${view.active}${RST}`
      : `  ${DIM}this project uses the CLI's own sign-in${RST}`,
  );
  for (const a of view.accounts) {
    const state = !a.signIn.installed
      ? `${YELLOW()}CLI not installed${RST}`
      : a.signIn.loggedIn
        ? `${GREEN()}signed in${RST}`
        : `${YELLOW()}signed out${RST}`;
    const marks = [a.active ? "active" : null, a.allowed ? "allowed here" : "not allowed here"]
      .filter(Boolean)
      .join(", ");
    out.push(
      `  ${a.active ? "*" : " "} ${a.id.padEnd(16)} ${a.label.padEnd(20)} ${state}  ${DIM}${marks}${RST}`,
    );
  }
  return out.join("\n");
}

export function formatAccounts(views: ProviderAccountsView[]): string {
  return `${views.map(line).join("\n\n")}\n`;
}

function provider(name: string | undefined): AccountProvider {
  if (!name || !isAccountProvider(name))
    throw new ProviderAccountError(
      `Name the provider: ${ACCOUNT_PROVIDERS.join(" or ")}${name ? `, not ${name}` : ""}.`,
    );
  return name;
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function runAccountsCli(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
    return 0;
  }
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const [command, name, id, ...more] = rest;
  const cwd = getCwd();
  try {
    if (!command) {
      const views = allProviderAccounts(cwd);
      process.stdout.write(
        json ? `${JSON.stringify({ providers: views }, null, 2)}\n` : formatAccounts(views),
      );
      return 0;
    }
    const p = provider(name);
    if (command === "add") {
      const label = flag(more, "--label");
      if (!id || !label) throw new ProviderAccountError("Give the account an ID and --label.");
      addProviderAccount(p, { id, label });
    } else if (command === "use") {
      if (id === "--default") setProjectAccount(p, cwd, null);
      else if (id) setProjectAccount(p, cwd, id, { allow: true });
      else throw new ProviderAccountError("Name the account to use, or --default.");
    } else if (command === "allow") {
      if (!id) throw new ProviderAccountError("Name the account to allow.");
      updateProviderAccount(p, id, { allowedProjects: more });
    } else if (command === "remove") {
      if (!id) throw new ProviderAccountError("Name the account to remove.");
      await deleteProviderAccount(p, id);
    } else {
      process.stderr.write(`Unknown command: ${command}\n\n${help}`);
      return 1;
    }
    const view = providerAccountsView(p, cwd);
    process.stdout.write(json ? `${JSON.stringify(view, null, 2)}\n` : formatAccounts([view]));
    return 0;
  } catch (error) {
    if (!(error instanceof ProviderAccountError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

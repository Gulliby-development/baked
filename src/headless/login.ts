import {
  CLI_LOGIN_PROVIDERS,
  type CliLogin,
  cancelCliLogin,
  cliLoginSettled,
  cliSignInStatus,
  getCliLogin,
  isCliLoginProvider,
  logoutCli,
  startCliLogin,
} from "../core/llm/cli-login.js";

const help = `Usage: baked login [codex|claude-code] [--json]
       baked logout codex|claude-code [--json]

login signs the provider's own CLI in with your subscription, as /codex login and
/claude-code login do in the terminal UI: it prints the CLI's progress and the sign-in page to
open, and waits until the sign-in ends. An already signed-in CLI succeeds at once. Without a
provider it prints whether each CLI is installed and signed in. logout runs the CLI's own logout.
BAKED never reads or stores the CLI's tokens.

Exit codes: 0 signed in or out, 1 failed or not installed, 130 interrupted.
`;

const POLL_MS = 200;

function exitOf(login: CliLogin | null): number {
  if (login?.state === "succeeded") return 0;
  return login?.state === "cancelled" ? 130 : 1;
}

/** Prints the login's new lines and its URL to stderr until it ends. */
async function follow(provider: (typeof CLI_LOGIN_PROVIDERS)[number]): Promise<CliLogin | null> {
  let printed = 0;
  let urlShown = false;
  const flush = (): CliLogin | null => {
    const login = getCliLogin(provider);
    if (!login) return null;
    for (const line of login.lines.slice(printed))
      if (line.trim()) process.stderr.write(`${line}\n`);
    printed = login.lines.length;
    if (login.url && !urlShown) {
      urlShown = true;
      process.stderr.write(`Open ${login.url} to sign in\n`);
    }
    return login;
  };
  let current = flush();
  while (current?.state === "running") {
    await Promise.race([
      cliLoginSettled(provider),
      new Promise((resolve) => setTimeout(resolve, POLL_MS)),
    ]);
    current = flush();
  }
  return current;
}

export async function runLoginCli(command: "login" | "logout", argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help);
    return 0;
  }
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const [name, ...extra] = rest;
  if (extra.length || name?.startsWith("-")) {
    process.stderr.write(`Unknown argument: ${extra[0] ?? name ?? ""}\n\n${help}`);
    return 1;
  }
  if (name !== undefined && !isCliLoginProvider(name)) {
    process.stderr.write(
      `${name} does not sign in through a CLI; use baked --set-key for API keys\n\n${help}`,
    );
    return 1;
  }
  const provider = name;
  if (!provider) {
    if (command === "logout") {
      process.stderr.write(`Name the provider to sign out.\n\n${help}`);
      return 1;
    }
    const statuses = CLI_LOGIN_PROVIDERS.map((id) => ({ provider: id, ...cliSignInStatus(id) }));
    process.stdout.write(
      json
        ? `${JSON.stringify({ providers: statuses }, null, 2)}\n`
        : `${statuses
            .map(
              (s) =>
                `${s.provider.padEnd(12)} ${!s.installed ? "not installed" : s.loggedIn ? "signed in" : "signed out"}  ${s.message}`,
            )
            .join("\n")}\n`,
    );
    return 0;
  }
  if (command === "logout") {
    const result = await logoutCli(provider);
    process.stdout.write(
      json ? `${JSON.stringify({ provider, ...result })}\n` : `${result.message}\n`,
    );
    return result.ok ? 0 : 1;
  }
  const interrupt = (): void => {
    void cancelCliLogin(provider);
  };
  process.on("SIGINT", interrupt);
  try {
    startCliLogin(provider);
    const login = await follow(provider);
    if (json) process.stdout.write(`${JSON.stringify(login, null, 2)}\n`);
    else if (login?.state === "succeeded") process.stdout.write(`Signed in to ${provider}\n`);
    else if (login?.state === "failed")
      process.stderr.write(`Sign-in failed: ${login.error ?? "unknown error"}\n`);
    else process.stderr.write("Sign-in cancelled\n");
    return exitOf(login);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

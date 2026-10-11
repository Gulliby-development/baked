import { providerIcon } from "../icons.js";
import { checkProviders } from "../llm/provider.js";
import { getClaudeCodeLoginStatus, logoutClaudeCode } from "../llm/providers/claude-code.js";
import { getProvider } from "../llm/providers/index.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";

const TITLE = "Claude Code";

async function handleStatus(_input: string, ctx: CommandContext): Promise<void> {
  const theme = getThemeTokens();
  const status = getClaudeCodeLoginStatus({ refresh: true });
  ctx.openInfoPopup({
    title: `${TITLE} Status`,
    icon: providerIcon("claude-code"),
    lines: [
      {
        type: "entry",
        label: "Installed",
        desc: status.installed ? "yes" : "no",
        descColor: status.installed ? theme.success : theme.brandSecondary,
      },
      {
        type: "entry",
        label: "Logged in",
        desc: status.loggedIn ? "yes" : "no",
        descColor: status.loggedIn ? theme.success : theme.warning,
      },
      { type: "entry", label: "Auth method", desc: status.authMethod ?? "unknown" },
      { type: "spacer" },
      {
        type: "text",
        label: status.message,
        color: status.loggedIn ? theme.textPrimary : theme.textSecondary,
      },
    ],
  });
}

async function handleLogin(): Promise<void> {
  const provider = getProvider("claude-code");
  if (!provider?.onRequestAuth) throw new Error("Claude Code login is not available.");
  await provider.onRequestAuth();
}

async function handleLogout(_input: string, ctx: CommandContext): Promise<void> {
  const theme = getThemeTokens();
  const result = logoutClaudeCode();
  await checkProviders().catch(() => {});
  const active = ctx.chat.activeModel.startsWith("claude-code/");
  ctx.openInfoPopup({
    title: `${TITLE} Logout`,
    icon: providerIcon("claude-code"),
    lines: [
      {
        type: "text",
        label: result.message,
        color: result.ok ? theme.success : theme.brandSecondary,
      },
      ...(active
        ? [
            { type: "spacer" as const },
            {
              type: "text" as const,
              label:
                "The active model is still Claude Code. Switch models or log back in before your next prompt.",
              color: theme.textSecondary,
            },
          ]
        : []),
    ],
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/claude-code", handleStatus);
  map.set("/claude-code status", handleStatus);
  map.set("/claude-code login", handleLogin);
  map.set("/claude-code logout", handleLogout);
}

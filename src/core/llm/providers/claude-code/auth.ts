import type { InfoPopupLine } from "../../../../components/modals/InfoPopup.js";
import { useUIStore } from "../../../../stores/ui.js";
import { providerIcon } from "../../../icons.js";
import { getThemeTokens } from "../../../theme/index.js";
import { checkProviders } from "../../provider.js";
import { getClaudeCodeLoginStatus, runClaudeCodeLogin } from "./cli.js";

/** Runs `claude auth login` and shows its progress (and sign-in URL) in a popup. */
export async function requestClaudeCodeAuth(): Promise<void> {
  const theme = getThemeTokens();
  const lines: InfoPopupLine[] = [];
  let handle: ReturnType<typeof runClaudeCodeLogin> | null = null;
  const show = () => {
    useUIStore.getState().openInfoPopup({
      title: "Claude Code Login",
      icon: providerIcon("claude-code"),
      lines: [...lines],
      onClose: () => handle?.abort(),
    });
  };
  const add = (label: string, color: string = theme.textPrimary) => {
    lines.push({ type: "text", label, color });
    show();
  };

  const status = getClaudeCodeLoginStatus({ refresh: true });
  if (!status.installed) {
    add(status.message, theme.brandSecondary);
    return;
  }
  if (status.loggedIn) {
    add(`Claude Code is already logged in. ${status.message}`, theme.success);
    await checkProviders().catch(() => {});
    return;
  }

  add("Starting `claude auth login`; complete the sign-in in your browser.", theme.textSecondary);
  handle = runClaudeCodeLogin((line) => add(line));
  try {
    await handle.promise;
    await checkProviders().catch(() => {});
    add("Select a Claude Code model with Ctrl+L or /models.", theme.success);
    useUIStore.getState().openModal("llmSelector");
  } catch (error) {
    add(
      `Error: ${error instanceof Error ? error.message : String(error)}. You can also run \`claude auth login\` in a terminal.`,
      theme.brandSecondary,
    );
  }
}

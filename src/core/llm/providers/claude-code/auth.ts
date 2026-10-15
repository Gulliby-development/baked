import type { InfoPopupLine } from "../../../../components/modals/InfoPopup.js";
import { useUIStore } from "../../../../stores/ui.js";
import { providerIcon } from "../../../icons.js";
import { getThemeTokens } from "../../../theme/index.js";
import { checkProviders } from "../../provider.js";
import { getClaudeCodeLoginStatus, runClaudeCodeLogin } from "./cli.js";

let running: ReturnType<typeof runClaudeCodeLogin> | null = null;
let addLine: ((label: string, color?: string) => void) | null = null;

/**
 * Sends the code the manual sign-in page shows to the running `/claude-code login`, as pasting it
 * at the CLI's prompt would. Returns false when no login is running.
 */
export function submitClaudeCodeAuthCode(code: string): boolean {
  if (!running) return false;
  running.submitCode(code);
  addLine?.(
    "Code sent; waiting for Claude Code to finish signing in.",
    getThemeTokens().textSecondary,
  );
  return true;
}

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
      // Closing keeps the sign-in running so /claude-code code can finish it; a new
      // /claude-code login replaces it and quitting BAKED stops it.
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

  running?.abort();
  add("Starting `claude auth login`; complete the sign-in in your browser.", theme.textSecondary);
  add(
    "If the page ends on a code, close this and run /claude-code code CODE with it.",
    theme.textSecondary,
  );
  handle = runClaudeCodeLogin((line) => {
    // The CLI's own prompt has nowhere to type into here; /claude-code code takes its role.
    const shown = line.replace(/^Paste code here if prompted\s*>?/i, "").trim();
    if (shown) add(shown);
  });
  running = handle;
  addLine = add;
  try {
    await handle.promise;
    await checkProviders().catch(() => {});
    add("Select a Claude Code model with Ctrl+L or /models.", theme.success);
    useUIStore.getState().openModal("llmSelector");
  } catch (error) {
    // A newer /claude-code login aborted this one and shows its own progress.
    if (running !== handle) return;
    add(
      `Error: ${error instanceof Error ? error.message : String(error)}. You can also run \`claude auth login\` in a terminal.`,
      theme.brandSecondary,
    );
  } finally {
    if (running === handle) {
      running = null;
      addLine = null;
    }
  }
}

import type { InfoPopupLine } from "../../../../components/modals/InfoPopup.js";
import { useUIStore } from "../../../../stores/ui.js";
import { providerIcon } from "../../../icons.js";
import { getThemeTokens } from "../../../theme/index.js";
import { checkProviders } from "../../provider.js";
import { runCodexBrowserLogin } from "./login.js";

export { performCodexBrowserLogin, runCodexBrowserLogin } from "./login.js";

export async function requestCodexAuth(): Promise<void> {
  const theme = getThemeTokens();
  const lines: InfoPopupLine[] = [
    {
      type: "text",
      label: "Starting Codex login...",
      color: theme.textSecondary,
    },
  ];

  let handle: ReturnType<typeof runCodexBrowserLogin> | null = null;
  const updatePopup = () => {
    useUIStore.getState().openInfoPopup({
      title: "Codex Login",
      icon: providerIcon("codex"),
      lines: [...lines],
      onClose: () => handle?.abort(),
    });
  };

  updatePopup();
  handle = runCodexBrowserLogin((message) => {
    lines.push({ type: "text", label: message, color: theme.textPrimary });
    updatePopup();
  });

  try {
    await handle.promise;
    await checkProviders().catch(() => {});
    lines.push({
      type: "text",
      label: "Select a Codex model with Ctrl+L or /models.",
      color: theme.success,
    });
    updatePopup();
    useUIStore.getState().openModal("llmSelector");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push({
      type: "text",
      label: `Error: ${message}`,
      color: theme.brandSecondary,
    });
    updatePopup();
  }
}

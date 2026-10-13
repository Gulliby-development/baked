import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../../config/index.js";
import { getCwd } from "../cwd.js";

/** What an edit that introduces errors does; see `editDiagnostics` in the config. */
export type EditDiagnosticsMode = "feedback" | "reject";

export const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 2500;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30_000;

const modeScope = new AsyncLocalStorage<EditDiagnosticsMode>();

/** Runs `action` with the mode a workflow run froze in its policy, instead of the config's. */
export const withEditDiagnosticsMode = <T>(mode: EditDiagnosticsMode, action: () => T): T =>
  modeScope.run(mode, action);

/** The mode of the current workflow attempt, else the chat setting of the active project. */
export function editDiagnosticsMode(): EditDiagnosticsMode {
  const scoped = modeScope.getStore();
  if (scoped) return scoped;
  try {
    const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(getCwd()));
    return config.editDiagnostics === "reject" ? "reject" : "feedback";
  } catch {
    return "feedback";
  }
}

/** Clamp a configured wait for diagnostics; anything not a finite number gives the default. */
export function diagnosticsTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

/** The configured wait for diagnostics before and after an edit (global `diagnostics.timeoutMs`). */
export function configuredDiagnosticsTimeoutMs(): number {
  try {
    return diagnosticsTimeoutMs(loadConfig().diagnostics?.timeoutMs);
  } catch {
    return DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
  }
}

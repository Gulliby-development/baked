import { applyConfigPatch } from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import type { Preset } from "./loader.js";

/**
 * Translate a preset's free-form keys into an AppConfig patch.
 * Presets may use either AppConfig keys directly (e.g. modelRouting, theme, providers)
 * or grouped sections via `config: { ... }`. Both are merged.
 */
function presetToPatch(preset: Preset): Partial<AppConfig> {
  const patch: Record<string, unknown> = {};

  // Direct AppConfig-shaped fields
  for (const key of [
    "defaultModel",
    "modelRouting",
    "providers",
    "theme",
    "codeIntelligence",
    "thinking",
    "performance",
    "contextManagement",
    "compaction",
    "retry",
    "mcpServers",
    "hooks",
  ]) {
    const v = (preset as Record<string, unknown>)[key];
    if (v !== undefined) patch[key] = v;
  }

  // Nested `config` block — treated as raw AppConfig patch
  if (preset.config && typeof preset.config === "object") {
    Object.assign(patch, preset.config);
  }

  return patch as Partial<AppConfig>;
}

/**
 * Fold presets into a base AppConfig in order. Each preset is a patch layer,
 * later presets win over earlier ones, user config still wins over all of them
 * (apply user config AFTER this).
 */
export function mergePresetsIntoConfig(base: AppConfig, presets: Preset[]): AppConfig {
  let merged = base;
  for (const preset of presets) {
    const patch = presetToPatch(preset);
    merged = applyConfigPatch(merged, patch) as AppConfig;
  }
  return merged;
}

/** Pure helpers of the Chat settings pages, kept apart from React so tests can import them. */
import type {
  SettingDefinition,
  SettingScope,
  SettingSource,
  SettingsView,
  SettingValue,
} from "../../client/settings.js";

export interface SettingSection {
  title: string;
  settings: SettingDefinition[];
}

/** The settings of a page grouped by section, sections in the order they first appear. */
export function pageSections(view: SettingsView, pageId: string): SettingSection[] {
  const sections = new Map<string, SettingSection>();
  for (const setting of view.settings) {
    if (setting.page !== pageId) continue;
    const section = sections.get(setting.section);
    if (section) section.settings.push(setting);
    else sections.set(setting.section, { title: setting.section, settings: [setting] });
  }
  return [...sections.values()];
}

/** Why a setting cannot be changed here, or null when it can. */
export function lockedReason(setting: SettingDefinition, scope: SettingScope): string | null {
  if (setting.scopes.includes(scope)) return null;
  return setting.scopes.includes("global")
    ? "Saved for all projects only"
    : "Saved for a single project only";
}

/** Whether the setting matters with the other values as they are (`enabledWhen`). */
export function isActive(setting: SettingDefinition, values: SettingsView["values"]): boolean {
  const when = setting.enabledWhen;
  if (!when) return true;
  const other = values[when.id]?.value;
  return when.values.some((value) => value === other);
}

/** The label of the setting `enabledWhen` points at, for "needs X" notes. */
export function dependencyNote(setting: SettingDefinition, view: SettingsView): string | null {
  const when = setting.enabledWhen;
  if (!when) return null;
  const other = view.settings.find((s) => s.id === when.id);
  if (!other) return null;
  const shown = when.values.map((value) => {
    if (typeof value === "boolean") return value ? "on" : "off";
    if (other.type === "enum") return other.options.find((o) => o.value === value)?.label ?? value;
    return value;
  });
  return `Used when ${other.label} is ${shown.join(" or ")}`;
}

const SOURCE_LABEL: Record<SettingSource, string> = {
  project: "this project",
  global: "all projects",
  default: "default",
  env: "environment",
  keychain: "keychain",
  file: "secrets file",
};

export function sourceLabel(source: SettingSource): string {
  return SOURCE_LABEL[source];
}

/** Whether the scope being edited holds its own value, which Reset removes. */
export function setInScope(value: SettingValue | undefined, scope: SettingScope): boolean {
  if (!value) return false;
  return scope === "global" ? value.global !== undefined : value.project !== undefined;
}

/** A number setting in its display unit: milliseconds as seconds, a fraction as a percentage. */
export function displayNumber(setting: SettingDefinition, value: unknown): string {
  if (setting.type !== "number") return String(value);
  if (value === null || value === undefined) return "auto";
  const factor = setting.display?.factor ?? 1;
  const shown = Math.round(((value as number) / factor) * 100) / 100;
  const unit = setting.display?.unit;
  if (!unit) return shown.toLocaleString("en-US");
  return unit === "%" ? `${shown}%` : `${shown.toLocaleString("en-US")} ${unit}`;
}

/** Turns what the user typed in display units back into the stored number, or an error. */
export function parseNumber(
  setting: SettingDefinition,
  text: string,
): { value: number | null } | { error: string } {
  if (setting.type !== "number") return { error: "Not a number setting" };
  const trimmed = text.trim().replace(/[,_\s]/g, "");
  if (trimmed === "") return setting.nullable ? { value: null } : { error: "Enter a number" };
  const shown = Number(trimmed);
  if (!Number.isFinite(shown)) return { error: "Enter a number" };
  const factor = setting.display?.factor ?? 1;
  const stored = Math.round(shown * factor * 1e6) / 1e6;
  if (setting.integer && !Number.isInteger(stored)) return { error: "Enter a whole number" };
  if (stored < setting.min || stored > setting.max)
    return {
      error: `Between ${displayNumber(setting, setting.min)} and ${displayNumber(setting, setting.max)}`,
    };
  return { value: stored };
}

/** The number a dialog starts with, in display units. */
export function numberDraft(setting: SettingDefinition, value: unknown): string {
  if (setting.type !== "number" || value === null || value === undefined) return "";
  const factor = setting.display?.factor ?? 1;
  return String(Math.round(((value as number) / factor) * 100) / 100);
}

/** The value a map or list edit starts from: the scope's own, else the one in use. */
export function scopeValue<T>(value: SettingValue | undefined, scope: SettingScope, empty: T): T {
  const own = scope === "global" ? value?.global : value?.project;
  return ((own ?? value?.value ?? empty) as T) ?? empty;
}

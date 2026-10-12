import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AppSettings, DEFAULT_SETTINGS, VOICE_LANGUAGES } from "../shared/api.js";

const THEMES = ["system", "dark", "light"];
const DENSITIES = ["comfortable", "compact"];

/** Keeps known keys with valid values; anything else falls back to the default. */
export function sanitizeSettings(input: unknown): AppSettings {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const bool = (key: keyof AppSettings): boolean =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : (DEFAULT_SETTINGS[key] as boolean);
  return {
    theme: THEMES.includes(raw.theme as string)
      ? (raw.theme as AppSettings["theme"])
      : DEFAULT_SETTINGS.theme,
    density: DENSITIES.includes(raw.density as string)
      ? (raw.density as AppSettings["density"])
      : DEFAULT_SETTINGS.density,
    openLastProjects: bool("openLastProjects"),
    keepRunningInTray: bool("keepRunningInTray"),
    notifyBlocking: bool("notifyBlocking"),
    notifyAdvisory: bool("notifyAdvisory"),
    bakedPath:
      typeof raw.bakedPath === "string" && raw.bakedPath.trim() ? raw.bakedPath.trim() : null,
    openProjects: Array.isArray(raw.openProjects)
      ? raw.openProjects.filter((p): p is string => typeof p === "string")
      : [],
    voiceInput: bool("voiceInput"),
    voiceLanguage:
      raw.voiceLanguage === "auto" || VOICE_LANGUAGES.includes(raw.voiceLanguage as never)
        ? (raw.voiceLanguage as AppSettings["voiceLanguage"])
        : DEFAULT_SETTINGS.voiceLanguage,
  };
}

/** App settings in `<userData>/settings.json`; an unreadable file means defaults. */
export class SettingsStore {
  private value: AppSettings;

  constructor(private readonly file: string) {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // Missing or damaged: start from the defaults.
    }
    this.value = sanitizeSettings(parsed);
  }

  get(): AppSettings {
    return this.value;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.value = sanitizeSettings({ ...this.value, ...patch });
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
    return this.value;
  }
}

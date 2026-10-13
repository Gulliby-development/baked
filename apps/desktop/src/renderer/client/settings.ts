/**
 * Chat settings over `GET|PATCH /v1/settings` (docs/desktop/api.md, "Chat settings"). The backend
 * serves the schema with the values, so the pages render whatever settings it describes.
 */
import type {
  SettingCatalog,
  SettingDefinition,
  SettingPage,
  SettingScope,
} from "../../../../../src/core/settings/schema.js";
import { ApiError, call } from "./api.js";
import { offers, SETTINGS_CAPABILITY } from "./capabilities.js";

export type { SettingDefinition, SettingPage, SettingScope };

export type SettingSource = "project" | "global" | "default" | "env" | "keychain" | "file";

export interface SettingValue {
  id: string;
  value: unknown;
  source: SettingSource;
  global?: unknown;
  project?: unknown;
}

export interface SettingsView {
  pages: SettingPage[];
  settings: SettingDefinition[];
  values: Record<string, SettingValue>;
  /** Catalogs of `string-list` settings; a server older than a catalog leaves it out. */
  catalogs: Partial<Record<SettingCatalog, { name: string; description: string }[]>>;
  /** What the server found when it checked a value in use, by setting ID; older servers omit it. */
  checks?: Record<string, SettingCheck>;
}

export interface SettingCheck {
  status: "ok" | "warn" | "fail" | "skip";
  title: string;
  detail?: string;
  fix?: string;
}

export interface SettingsChange {
  set?: Record<string, unknown>;
  reset?: string[];
}

export const settingsApi = {
  load: async (key: string): Promise<SettingsView> => {
    let capabilities: string[] | null = null;
    try {
      capabilities =
        (await call<{ capabilities?: string[] }>(key, "GET", "/v1/health")).capabilities ?? null;
    } catch {
      // Health could not tell; the request's own 404 says the same.
    }
    if (offers(capabilities, SETTINGS_CAPABILITY) === false)
      throw new ApiError(404, "NOT_FOUND", "This BAKED has no settings endpoints");
    return call<SettingsView>(key, "GET", "/v1/settings");
  },
  /** 400 `INVALID_SETTING` names the setting the backend refused; nothing is written then. */
  change: (key: string, scope: SettingScope, change: SettingsChange) =>
    call<SettingsView>(key, "PATCH", "/v1/settings", { scope, ...change }),
};

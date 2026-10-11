/**
 * Reading and changing the settings of `schema.ts` against the global and project config layers.
 * File access stays with the caller, so the local API and tests share the same rules.
 */
import { z } from "zod";
import { getToolCatalog } from "../tools/constants.js";
import {
  readSettingPath,
  SETTING_PAGES,
  SETTINGS,
  type SettingDefinition,
  type SettingPage,
  type SettingScope,
  settingById,
  writeSettingPath,
} from "./schema.js";

const ModelId = z.string().trim().min(1).max(200);

/** The validator of a setting's value as the API receives it; secrets take the key itself. */
export function settingValueSchema(setting: SettingDefinition): z.ZodType {
  switch (setting.type) {
    case "boolean":
      return z.boolean();
    case "enum": {
      const values = setting.options.map((option) => option.value) as [string, ...string[]];
      return z.enum(values);
    }
    case "number": {
      let number = z.number().min(setting.min).max(setting.max);
      if (setting.integer) number = number.int();
      return setting.nullable ? number.nullable() : number;
    }
    case "model":
      return ModelId.nullable();
    case "string-list":
      return z.array(z.string().min(1).max(200)).max(500);
    case "model-list-map":
      return z
        .record(ModelId, z.array(ModelId).max(10))
        .refine((map) => Object.keys(map).length <= 100);
    case "model-number-map":
      return z
        .record(ModelId, z.number().int().min(setting.min).max(setting.max))
        .refine((map) => Object.keys(map).length <= 100);
    case "secret":
      return z.string().trim().min(1).max(4096);
  }
}

export type SettingSource = "project" | "global" | "default" | "env" | "keychain" | "file";

export interface SettingValue {
  id: string;
  /** The value in use; for a secret, whether one is set. */
  value: unknown;
  /** Where the value in use comes from. */
  source: SettingSource;
  global?: unknown;
  project?: unknown;
}

export interface SettingsView {
  pages: readonly SettingPage[];
  settings: readonly SettingDefinition[];
  values: Record<string, SettingValue>;
  /** Names and descriptions of the `string-list` catalogs. */
  catalogs: { tools: Array<{ name: string; description: string }> };
}

export interface SettingsLayers {
  global: Record<string, unknown>;
  /** `.baked/config.json` of the project. */
  project: Record<string, unknown>;
  /** The merged configuration the server runs with. */
  effective: unknown;
  /** Where a secret setting is stored, if anywhere. */
  secret(id: string): "env" | "keychain" | "file" | "none";
}

/** Values older config files hold for `semanticSummaries`, mapped to the current names. */
const LEGACY_SUMMARIES: Record<string, string> = { true: "synthetic", false: "off", on: "full" };

function normalize(setting: SettingDefinition, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (setting.id === "semanticSummaries") return LEGACY_SUMMARIES[String(value)] ?? value;
  // The config spells "no default model" as "none".
  if (setting.id === "defaultModel" && value === "none") return undefined;
  return value;
}

export function settingsView(layers: SettingsLayers): SettingsView {
  const values: Record<string, SettingValue> = {};
  for (const setting of SETTINGS) {
    if (setting.type === "secret") {
      const stored = layers.secret(setting.id);
      values[setting.id] = {
        id: setting.id,
        value: stored !== "none",
        source: stored === "none" ? "default" : stored,
      };
      continue;
    }
    const global = normalize(setting, readSettingPath(layers.global, setting.id));
    const project = normalize(setting, readSettingPath(layers.project, setting.id));
    const effective = normalize(setting, readSettingPath(layers.effective, setting.id));
    const source: SettingSource =
      project !== undefined ? "project" : global !== undefined ? "global" : "default";
    values[setting.id] = {
      id: setting.id,
      value: effective ?? project ?? global ?? setting.default,
      source,
      ...(global !== undefined ? { global } : {}),
      ...(project !== undefined ? { project } : {}),
    };
  }
  const tools = Object.entries(getToolCatalog()).map(([name, description]) => ({
    name,
    description,
  }));
  return { pages: SETTING_PAGES, settings: SETTINGS, values, catalogs: { tools } };
}

export interface SettingsChange {
  scope: SettingScope;
  /** Setting ID → new value. A secret takes the key itself. */
  set?: Record<string, unknown>;
  /** Setting IDs to remove from the scope; a secret is deleted from the store. */
  reset?: string[];
}

export interface PlannedSettingsChange {
  /** The config layer of `scope` after the change, or null when it does not change. */
  layer: Record<string, unknown> | null;
  secrets: { set: Record<string, string>; remove: string[] };
}

export class SettingsChangeError extends Error {
  constructor(
    message: string,
    readonly settingId: string,
  ) {
    super(message);
  }
}

/** Validates a change against the schema and works out the new layer; writes nothing. */
export function planSettingsChange(
  layer: Record<string, unknown>,
  change: SettingsChange,
): PlannedSettingsChange {
  let next = layer;
  let changed = false;
  const secrets: PlannedSettingsChange["secrets"] = { set: {}, remove: [] };
  const known = (id: string): SettingDefinition => {
    const setting = settingById(id);
    if (!setting) throw new SettingsChangeError(`${id} is not a known setting`, id);
    if (!setting.scopes.includes(change.scope))
      throw new SettingsChangeError(
        `${setting.label} is saved only in the ${setting.scopes.join(" or ")} config`,
        id,
      );
    return setting;
  };
  for (const [id, raw] of Object.entries(change.set ?? {})) {
    const setting = known(id);
    const parsed = settingValueSchema(setting).safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? "invalid value";
      throw new SettingsChangeError(`${setting.label}: ${issue}`, id);
    }
    if (setting.type === "secret") {
      secrets.set[id] = parsed.data as string;
      continue;
    }
    // A null model or number means "unset", which the config spells by leaving the key out.
    next = writeSettingPath(next, id, parsed.data === null ? undefined : parsed.data);
    changed = true;
  }
  for (const id of change.reset ?? []) {
    const setting = known(id);
    if (change.set && id in change.set)
      throw new SettingsChangeError(`${setting.label} is both set and reset`, id);
    if (setting.type === "secret") {
      secrets.remove.push(id);
      continue;
    }
    next = writeSettingPath(next, id, undefined);
    changed = true;
  }
  return { layer: changed ? next : null, secrets };
}

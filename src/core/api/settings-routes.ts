/**
 * Chat settings of the local API: `GET|PATCH /v1/settings`, served from the schema in
 * `src/core/settings/`. The contract is `docs/desktop/api.md`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadEffectiveProjectConfig,
  mergeConfigs,
} from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import { configDir as defaultConfigDir } from "../platform/index.js";
import { deleteSecret, hasSecret, setSecret } from "../secrets.js";
import { planSettingsChange, SettingsChangeError, settingsView } from "../settings/values.js";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import type { RouteContext } from "./route-context.js";
import { readJsonFile, replaceInPlace } from "./setup-routes.js";

/** Where secret settings live; tests pass an in-memory one. */
export interface SettingsSecretStore {
  status(id: string): "env" | "keychain" | "file" | "none";
  set(id: string, value: string): void;
  remove(id: string): void;
}

const systemSecrets: SettingsSecretStore = {
  status: (id) => hasSecret(id).source,
  set: (id, value) => {
    setSecret(id, value);
  },
  remove: (id) => {
    deleteSecret(id);
  },
};

export interface SettingsRouteContext extends RouteContext {
  workspace: string;
  /** The running server's config; updated in place after a change. */
  config: AppConfig;
  configDir?: string;
  secrets?: SettingsSecretStore;
}

const SettingId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const SettingsBody = z
  .strictObject({
    scope: z.enum(["global", "project"]),
    set: z.record(SettingId, z.unknown()).optional(),
    reset: z.array(SettingId).max(100).optional(),
  })
  .refine((body) => Object.keys(body.set ?? {}).length > 0 || (body.reset?.length ?? 0) > 0, {
    message: "Name settings to set or reset",
  });

/** Answers a settings request, or returns null when the path is not a settings endpoint. */
export async function settingsRoute(ctx: SettingsRouteContext): Promise<Response | null> {
  if (ctx.path !== "/v1/settings") return null;
  ctx.only("GET", "PATCH");
  const dir = ctx.configDir ?? defaultConfigDir();
  const globalFile = join(dir, "config.json");
  const projectFile = join(ctx.workspace, ".baked", "config.json");
  const secrets = ctx.secrets ?? systemSecrets;
  const layer = (file: string): Record<string, unknown> => {
    try {
      return readJsonFile(file);
    } catch (error) {
      return ctx.fail(409, "INPUT_CHANGED", error instanceof Error ? error.message : String(error));
    }
  };
  const effective = (): AppConfig => {
    const base = ctx.configDir
      ? ({ ...DEFAULT_CONFIG, ...layer(globalFile) } as AppConfig)
      : loadConfig();
    return mergeConfigs(base, loadEffectiveProjectConfig(ctx.workspace));
  };
  const view = () =>
    settingsView({
      global: layer(globalFile),
      project: layer(projectFile),
      effective: effective(),
      secret: (id) => secrets.status(id),
    });
  if (ctx.method === "GET") return ctx.json(200, view());

  const body = SettingsBody.parse(await ctx.readJson());
  const file = body.scope === "global" ? globalFile : projectFile;
  let plan: ReturnType<typeof planSettingsChange>;
  try {
    plan = planSettingsChange(layer(file), body);
  } catch (error) {
    if (error instanceof SettingsChangeError)
      return ctx.fail(400, "INVALID_SETTING", `${error.message} (${error.settingId})`);
    throw error;
  }
  if (plan.layer) {
    if (body.scope === "global") mkdirSync(dir, { recursive: true, mode: 0o700 });
    else ensurebakedDir(ctx.workspace);
    writeFileSync(file, `${JSON.stringify(plan.layer, null, 2)}\n`);
    replaceInPlace(ctx.config, effective());
  }
  for (const [id, value] of Object.entries(plan.secrets.set)) secrets.set(id, value);
  for (const id of plan.secrets.remove) secrets.remove(id);
  return ctx.json(200, view());
}

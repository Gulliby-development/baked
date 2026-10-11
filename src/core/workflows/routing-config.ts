/**
 * Reads and writes the `modelRouting` section of the global and project config files. The local
 * API's `PATCH /v1/workflow/routing` and `baked workflow routing` change routing through here, so
 * both run the checks of `applyRoutingChange` before anything is written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrateLegacyConfigKeys } from "../../config/index.js";
import type { ModelRouting } from "../llm/model-routing.js";
import { configDir as defaultConfigDir } from "../platform/index.js";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import { WorkflowFault } from "./errors.js";
import {
  applyRoutingChange,
  type RoutingChange,
  type RoutingLayers,
  type RoutingScope,
} from "./routing-edit.js";

export type RoutingConfigFiles = Record<RoutingScope, string>;

export function routingConfigFiles(workspace: string, configDir?: string): RoutingConfigFiles {
  return {
    global: join(configDir ?? defaultConfigDir(), "config.json"),
    project: join(workspace, ".baked", "config.json"),
  };
}

/** Reads a config file, with legacy keys under their current names; a missing file is `{}`. */
export function readConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} does not hold a JSON object`);
  return migrateLegacyConfigKeys(parsed as Record<string, unknown>);
}

export function readRoutingLayers(files: RoutingConfigFiles): RoutingLayers {
  return {
    global: readConfigObject(files.global).modelRouting as ModelRouting | undefined,
    project: readConfigObject(files.project).modelRouting as ModelRouting | undefined,
  };
}

/**
 * Applies a change to one layer and writes only its `modelRouting` section, removing an emptied
 * section. Nothing is written when `problems` is not empty. An unreadable file of that layer is
 * an `INPUT_CHANGED` fault.
 */
export function saveRoutingChange(
  workspace: string,
  files: RoutingConfigFiles,
  scope: RoutingScope,
  change: RoutingChange,
): { problems: string[]; file: string } {
  const file = files[scope];
  let current: Record<string, unknown>;
  try {
    current = readConfigObject(file);
  } catch (error) {
    throw new WorkflowFault(
      "INPUT_CHANGED",
      error instanceof Error ? error.message : String(error),
    );
  }
  const { routing, problems } = applyRoutingChange(readRoutingLayers(files), scope, change);
  if (problems.length) return { problems, file };
  const { modelRouting: _previous, ...rest } = current;
  const next = routing ? { ...current, modelRouting: routing } : rest;
  if (scope === "global") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  else ensurebakedDir(workspace);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { problems: [], file };
}

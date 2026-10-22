/** Sample answers of `GET|PATCH /v1/settings` for the preview, from the real schema. */

import {
  readSettingPath,
  SETTING_PAGES,
  SETTINGS,
  type SettingDefinition,
  writeSettingPath,
} from "../../../../../src/core/settings/schema.js";
import { qualityRuleCatalog } from "../../../../../src/core/workflows/quality/builtin-rules.js";
import { type MockRoute, response } from "./mock-response.js";
import type { SettingsView, SettingValue } from "./settings.js";

type Layer = Record<string, unknown>;

let globalLayer: Layer = {
  defaultModel: "anthropic/claude-sonnet-4-6",
  performance: { effort: "medium" },
  taskRouter: { spark: "anthropic/claude-haiku-4-5" },
  modelFallback: { "anthropic/claude-sonnet-4-6": ["openai/gpt-5.5"] },
  contextWindowOverrides: { "ollama/qwen3-coder": 131072 },
};
const projectLayers = new Map<string, Layer>();
const secrets = new Set<string>(["brave-api-key"]);
const TOOLS = [
  ["read", "Read file contents with optional line range or symbol target"],
  ["edit_file", "Edit, create, or write files with line-anchored matching"],
  ["shell", "Execute shell commands"],
  ["dispatch", "Spawn parallel subagents for multi-file tasks"],
  ["web_search", "Search the web"],
  ["request_tools", "Let the agent load tools on demand"],
  ["release_tools", "Let the agent unload tools it no longer needs"],
  ["skills", "Let the agent search, install, and load skills from skills.sh"],
] as const;

function view(key: string): SettingsView {
  const project = projectLayers.get(key) ?? { compaction: { triggerThreshold: 0.8 } };
  projectLayers.set(key, project);
  const values: Record<string, SettingValue> = {};
  for (const setting of SETTINGS) {
    if (setting.type === "secret") {
      const set = secrets.has(setting.id);
      values[setting.id] = { id: setting.id, value: set, source: set ? "keychain" : "default" };
      continue;
    }
    const g = readSettingPath(globalLayer, setting.id);
    const p = readSettingPath(project, setting.id);
    values[setting.id] = {
      id: setting.id,
      value: p ?? g ?? setting.default,
      source: p !== undefined ? "project" : g !== undefined ? "global" : "default",
      ...(g !== undefined ? { global: g } : {}),
      ...(p !== undefined ? { project: p } : {}),
    };
  }
  return {
    pages: [...SETTING_PAGES],
    settings: [...SETTINGS],
    values,
    catalogs: {
      tools: TOOLS.map(([name, description]) => ({ name, description })),
      "quality-rules": qualityRuleCatalog(),
    },
  };
}

function refuse(setting: SettingDefinition, value: unknown): string | null {
  if (value === null)
    return setting.type === "model" ||
      setting.type === "library-docs" ||
      (setting.type === "number" && setting.nullable)
      ? null
      : "must be set";
  if (
    setting.type === "library-docs" &&
    (typeof value !== "object" || !("dir" in value || "mcp" in value))
  )
    return "must name a directory or an MCP tool";
  if (setting.type === "enum" && !setting.options.some((o) => o.value === value))
    return "not an allowed value";
  if (
    setting.type === "number" &&
    (typeof value !== "number" || value < setting.min || value > setting.max)
  )
    return `must be between ${setting.min} and ${setting.max}`;
  if (setting.type === "boolean" && typeof value !== "boolean") return "must be on or off";
  return null;
}

export const settingsRoutes: MockRoute = ({ key, method, path, body }) => {
  if (path !== "/v1/settings") return undefined;
  if (method === "GET") return response(200, view(key));
  if (method !== "PATCH") return undefined;
  const change = (body ?? {}) as { scope?: "global" | "project"; set?: Layer; reset?: string[] };
  const scope = change.scope === "project" ? "project" : "global";
  let layer = scope === "global" ? globalLayer : (projectLayers.get(key) ?? {});
  for (const [id, value] of Object.entries(change.set ?? {})) {
    const setting = SETTINGS.find((s) => s.id === id);
    if (!setting)
      return response(400, {
        error: { code: "INVALID_SETTING", message: `${id} is not a known setting` },
      });
    if (!setting.scopes.includes(scope))
      return response(400, {
        error: {
          code: "INVALID_SETTING",
          message: `${setting.label} is saved only in the global config`,
        },
      });
    const problem = refuse(setting, value);
    if (problem)
      return response(400, {
        error: { code: "INVALID_SETTING", message: `${setting.label}: ${problem}` },
      });
    if (setting.type === "secret") secrets.add(id);
    else layer = writeSettingPath(layer, id, value === null ? undefined : value);
  }
  for (const id of change.reset ?? []) {
    if (secrets.has(id)) secrets.delete(id);
    else layer = writeSettingPath(layer, id, undefined);
  }
  if (scope === "global") globalLayer = layer;
  else projectLayers.set(key, layer);
  return response(200, view(key));
};

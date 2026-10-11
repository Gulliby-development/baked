import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { SettingsSecretStore } from "../src/core/api/settings-routes.js";
import { mergeConfigs, DEFAULT_CONFIG } from "../src/config/index.js";
import { SETTING_PAGES, SETTINGS, writeSettingPath } from "../src/core/settings/schema.js";
import { planSettingsChange, SettingsChangeError, settingValueSchema, settingsView, type SettingsView } from "../src/core/settings/values.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

describe("settings schema", () => {
  test("every setting has a unique ID, a known page and a default its validator accepts", () => {
    const ids = new Set<string>();
    const pages = new Set(SETTING_PAGES.map((page) => page.id));
    for (const setting of SETTINGS) {
      expect(ids.has(setting.id)).toBe(false);
      ids.add(setting.id);
      expect(pages.has(setting.page)).toBe(true);
      expect(setting.scopes.length).toBeGreaterThan(0);
      if (setting.type !== "secret") expect(settingValueSchema(setting).safeParse(setting.default).success).toBe(true);
      if (setting.enabledWhen) expect(SETTINGS.some((other) => other.id === setting.enabledWhen?.id)).toBe(true);
    }
    for (const page of SETTING_PAGES) expect(SETTINGS.some((setting) => setting.page === page.id)).toBe(true);
  });

  test("writing a path creates parents and removing it drops parents left empty", () => {
    const set = writeSettingPath({ other: 1 }, "performance.effort", "high");
    expect(set).toEqual({ other: 1, performance: { effort: "high" } });
    expect(writeSettingPath(set, "performance.effort", undefined)).toEqual({ other: 1 });
    const two = writeSettingPath(set, "performance.speed", "fast");
    expect(writeSettingPath(two, "performance.effort", undefined)).toEqual({ other: 1, performance: { speed: "fast" } });
  });
});

describe("settings changes", () => {
  test("a change is validated and leaves untouched keys alone", () => {
    const plan = planSettingsChange(
      { defaultModel: "a/b", taskRouter: { spark: "x/y" } },
      { scope: "project", set: { "taskRouter.ember": "c/d", "performance.effort": "high" }, reset: ["defaultModel"] },
    );
    expect(plan.layer).toEqual({ taskRouter: { spark: "x/y", ember: "c/d" }, performance: { effort: "high" } });
  });

  test("bad values, unknown settings and wrong scopes are refused", () => {
    const refuse = (set: Record<string, unknown>, scope: "global" | "project" = "global") =>
      expect(() => planSettingsChange({}, { scope, set })).toThrow(SettingsChangeError);
    refuse({ "performance.effort": "huge" });
    refuse({ "compaction.triggerThreshold": 2 });
    refuse({ "taskRouter.maxConcurrentAgents": 3.5 });
    refuse({ nope: true });
    refuse({ toolTimeout: 5 }, "project");
    refuse({ modelFallback: { "a/b": "c/d" } });
  });

  test("null unsets a model and secrets are kept out of the config layer", () => {
    const plan = planSettingsChange(
      { taskRouter: { spark: "x/y" } },
      { scope: "global", set: { "taskRouter.spark": null, "brave-api-key": "key" }, reset: ["jina-api-key"] },
    );
    expect(plan.layer).toEqual({});
    expect(plan.secrets).toEqual({ set: { "brave-api-key": "key" }, remove: ["jina-api-key"] });
    expect(planSettingsChange({}, { scope: "global", set: { "brave-api-key": "k" } }).layer).toBeNull();
  });

  test("the view reports the value in use and where it comes from", () => {
    const global = { performance: { effort: "low" }, semanticSummaries: true };
    const project = { performance: { effort: "high" } };
    const view = settingsView({
      global,
      project,
      effective: mergeConfigs({ ...DEFAULT_CONFIG, ...global } as typeof DEFAULT_CONFIG, project),
      secret: (id) => (id === "brave-api-key" ? "file" : "none"),
    });
    expect(view.values["performance.effort"]).toMatchObject({ value: "high", source: "project", global: "low", project: "high" });
    expect(view.values["performance.speed"]).toMatchObject({ value: "off", source: "default" });
    expect(view.values.semanticSummaries).toMatchObject({ value: "synthetic", source: "global" });
    expect(view.values["brave-api-key"]).toEqual({ id: "brave-api-key", value: true, source: "file" });
    expect(view.values["jina-api-key"]).toMatchObject({ value: false, source: "default" });
    expect(view.catalogs.tools.some((tool) => tool.name === "shell")).toBe(true);
  });

  test("project fields of the task router and agent features merge over the global ones", () => {
    const merged = mergeConfigs(
      {
        ...DEFAULT_CONFIG,
        taskRouter: { spark: "g/s", ember: "g/e", webSearch: null, desloppify: null, verify: null, compact: null, semantic: null, default: null },
        agentFeatures: { desloppify: true },
      },
      { taskRouter: { spark: "p/s" } as never, agentFeatures: { verifyEdits: true } },
    );
    expect(merged.taskRouter?.spark).toBe("p/s");
    expect(merged.taskRouter?.ember).toBe("g/e");
    expect(merged.agentFeatures).toEqual({ desloppify: true, verifyEdits: true });
  });
});

describe("settings API", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-settings-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-settings-home-"));
    const stored = new Map<string, string>();
    const settingsSecrets: SettingsSecretStore = {
      status: (id) => (stored.has(id) ? "file" : "none"),
      set: (id, value) => void stored.set(id, value),
      remove: (id) => void stored.delete(id),
    };
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, settingsSecrets, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
      });
    const patch = (body: unknown) => call("/v1/settings", { method: "PATCH", body: JSON.stringify(body) });
    return { fixture, configDir, stored, call, patch };
  }

  test("health lists settings, and GET serves pages, schema and values", async () => {
    const { call } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("settings");
    const view = (await (await call("/v1/settings")).json()) as SettingsView;
    expect(view.pages.map((page) => page.id)).toContain("provider-options");
    expect(view.settings.length).toBe(SETTINGS.length);
    expect(view.values.defaultModel).toMatchObject({ value: null, source: "default" });
  });

  test("PATCH writes the scope's file, updates the running config and stores secrets", async () => {
    const { fixture, configDir, stored, patch } = await setup();
    mkdirSync(join(fixture.root, ".baked"), { recursive: true });
    writeFileSync(join(fixture.root, ".baked", "config.json"), JSON.stringify({ keep: 1 }));
    const response = await patch({ scope: "project", set: { "performance.effort": "high", repoMap: false } });
    expect(response.status).toBe(200);
    const view = (await response.json()) as SettingsView;
    expect(view.values["performance.effort"]).toMatchObject({ value: "high", source: "project" });
    expect(JSON.parse(readFileSync(join(fixture.root, ".baked", "config.json"), "utf8"))).toEqual({
      keep: 1,
      performance: { effort: "high" },
      repoMap: false,
    });
    expect(fixture.service.config.performance?.effort).toBe("high");
    expect(fixture.service.config.repoMap).toBe(false);

    const global = await patch({ scope: "global", set: { toolTimeout: 5, "brave-api-key": "secret-value" } });
    const globalView = (await global.json()) as SettingsView;
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))).toEqual({ toolTimeout: 5 });
    expect(stored.get("brave-api-key")).toBe("secret-value");
    expect(globalView.values["brave-api-key"]?.value).toBe(true);
    expect(JSON.stringify(globalView)).not.toContain("secret-value");

    const reset = (await (await patch({ scope: "project", reset: ["performance.effort"] })).json()) as SettingsView;
    expect(reset.values["performance.effort"]).toMatchObject({ value: "off", source: "default" });
  });

  test("PATCH refuses invalid values and settings outside their scope", async () => {
    const { patch } = await setup();
    const bad = await patch({ scope: "global", set: { "performance.effort": "huge" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("INVALID_SETTING");
    expect((await patch({ scope: "project", set: { toolTimeout: 5 } })).status).toBe(400);
    expect((await patch({ scope: "global" })).status).toBe(400);
  });
});

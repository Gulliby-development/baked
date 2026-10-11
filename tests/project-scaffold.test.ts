import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../src/core/projects/manifest.js";
import { clearProjectCache, resolveProject } from "../src/core/projects/resolve.js";
import { scaffoldProject } from "../src/core/projects/scaffold.js";
import { WorkflowConfigSchema, workflowsEnabled } from "../src/core/workflows/schemas.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  clearProjectCache();
});

/** A project folder and a private user profile for the project registry. */
function layout() {
  const base = mkdtempSync(join(tmpdir(), "baked-scaffold-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const folder = join(base, "app");
  const profile = join(base, "profile");
  mkdirSync(folder);
  mkdirSync(profile);
  return { folder, profile };
}

describe("workflows are on by default", () => {
  test("a configuration without a workflows block allows runs", () => {
    expect(workflowsEnabled({})).toBe(true);
    expect(WorkflowConfigSchema.parse({ policy: defaultWorkflowPolicy }).enabled).toBe(true);
  });
  test("an explicit false still turns them off", () => {
    expect(workflowsEnabled({ workflows: { enabled: false } })).toBe(false);
  });
});

describe("setting up an opened folder", () => {
  test("creates the manifest, the .baked directory and the workflow store", () => {
    const { folder, profile } = layout();
    const result = scaffoldProject(folder, { configDir: profile });
    expect(result.created).toEqual(["baked/project.json", ".baked/", ".baked/workflows.sqlite"]);
    expect(readManifest(folder)?.id).toBe("app");
    expect(existsSync(join(folder, ".baked", "workflows.sqlite"))).toBe(true);
    expect(resolveProject(folder, { configDir: profile })?.registered).toBe(true);
  });

  test("keeps existing files and creates nothing the second time", () => {
    const { folder, profile } = layout();
    const own = JSON.stringify({ schemaVersion: 1, id: "mine", name: "Mine" });
    mkdirSync(join(folder, "baked"));
    writeFileSync(join(folder, "baked", "project.json"), own);
    mkdirSync(join(folder, ".baked"));
    writeFileSync(join(folder, ".baked", "config.json"), '{"defaultModel":"p/m"}');
    expect(scaffoldProject(folder, { configDir: profile }).created).toEqual([".baked/workflows.sqlite"]);
    expect(readFileSync(join(folder, "baked", "project.json"), "utf8")).toBe(own);
    expect(readFileSync(join(folder, ".baked", "config.json"), "utf8")).toBe('{"defaultModel":"p/m"}');
    expect(scaffoldProject(folder, { configDir: profile }).created).toEqual([]);
  });

  test("a folder inside a registered project gets no manifest of its own", () => {
    const { folder, profile } = layout();
    scaffoldProject(folder, { configDir: profile });
    const sub = join(folder, "packages", "web");
    mkdirSync(sub, { recursive: true });
    const result = scaffoldProject(sub, { configDir: profile });
    expect(result.created).not.toContain("baked/project.json");
    expect(existsSync(join(sub, "baked"))).toBe(false);
  });

  test("leaves a missing folder alone", () => {
    const { folder, profile } = layout();
    const result = scaffoldProject(join(folder, "missing"), { configDir: profile });
    expect(result.skipped).toBe("not a folder");
    expect(result.created).toEqual([]);
  });
});

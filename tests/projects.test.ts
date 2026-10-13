import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEffectiveProjectConfig, loadProjectConfig } from "../src/config/index.js";
import { loadInstructions } from "../src/core/instructions.js";
import { parseManifest, readManifest } from "../src/core/projects/manifest.js";
import { activeProject, clearProjectCache, resolveProject } from "../src/core/projects/resolve.js";
import { ProjectService } from "../src/core/projects/service.js";
import { renderWorkingSet, resolveWorkingSet, WORKING_SET_ARTIFACT } from "../src/core/projects/working-set.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { migration001 } from "../src/core/workflows/migrations/001.js";
import { migration002 } from "../src/core/workflows/migrations/002.js";
import { migration003 } from "../src/core/workflows/migrations/003.js";
import { migration004 } from "../src/core/workflows/migrations/004.js";
import { migration005 } from "../src/core/workflows/migrations/005.js";
import { migration006 } from "../src/core/workflows/migrations/006.js";
import { newId, WorkflowStore } from "../src/core/workflows/store.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  clearProjectCache();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function manifest(root: string, body: Record<string, unknown>): void {
  write(join(root, "baked", "project.json"), JSON.stringify({ schemaVersion: 1, id: "demo", name: "Demo", ...body }));
}

/** A checkout, a sibling docs root and a private user profile for the registry. */
function layout() {
  const base = temp("baked-project-");
  const app = join(base, "app");
  const docs = join(base, "docs");
  const profile = join(base, "profile");
  mkdirSync(app, { recursive: true });
  mkdirSync(docs, { recursive: true });
  mkdirSync(profile, { recursive: true });
  return { base, app, docs, profile };
}

describe("manifest", () => {
  test("a valid manifest gets defaults for the optional fields", () => {
    const parsed = parseManifest("p.json", JSON.stringify({ schemaVersion: 1, id: "demo", name: "Demo" }));
    expect(parsed).toEqual({ schemaVersion: 1, id: "demo", name: "Demo", roots: [], workingSet: [], defaults: {} });
  });

  test("workflow policy and unknown keys are refused", () => {
    const base = { schemaVersion: 1, id: "demo", name: "Demo" };
    expect(() => parseManifest("p.json", JSON.stringify({ ...base, defaults: { config: { workflows: {} } } }))).toThrow(/defaults.config may only set/);
    expect(() => parseManifest("p.json", JSON.stringify({ ...base, extra: true }))).toThrow(/Invalid project manifest/);
    expect(() => parseManifest("p.json", JSON.stringify({ ...base, id: "Bad Id" }))).toThrow(/id/);
    expect(() => parseManifest("p.json", JSON.stringify({ ...base, schemaVersion: 2 }))).toThrow(/schemaVersion 2 is not supported/);
  });

  test("an invalid manifest means no project and one warning", () => {
    const { app } = layout();
    write(join(app, "baked", "project.json"), "{ not json");
    const warnings: string[] = [];
    expect(activeProject(app, { warn: (m) => warnings.push(m) })).toBeNull();
    expect(activeProject(app, { warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe("trusted roots", () => {
  test("a secondary root is used only after the user registers it", () => {
    const { app, docs, profile } = layout();
    manifest(app, { roots: ["../docs"], workingSet: ["../docs/guide.md"] });
    write(join(docs, "guide.md"), "# Guide\n");
    const before = resolveProject(app, { configDir: profile });
    expect(before?.roots).toHaveLength(1);
    expect(before?.ignoredRoots).toHaveLength(1);
    expect(before && resolveWorkingSet(before).files).toEqual([]);
    expect(before && resolveWorkingSet(before).skipped[0]?.reason).toBe("outside the trusted project roots");

    new ProjectService(app, { configDir: profile }).register();
    const after = resolveProject(app, { configDir: profile });
    expect(after?.roots).toHaveLength(2);
    expect(after && resolveWorkingSet(after).files.map((f) => f.path.endsWith("guide.md"))).toEqual([true]);
    // The docs root resolves to the same project through the registry.
    expect(resolveProject(docs, { configDir: profile })?.id).toBe("demo");
  });

  test("a root added to the manifest after registration stays untrusted", () => {
    const { base, app, docs, profile } = layout();
    manifest(app, { roots: ["../docs"] });
    new ProjectService(app, { configDir: profile }).register();
    mkdirSync(join(base, "other"));
    manifest(app, { roots: ["../docs", "../other"] });
    const project = resolveProject(app, { configDir: profile });
    expect(project?.roots).toEqual([app, docs].map((p) => realpath(p)));
    expect(project?.ignoredRoots).toEqual([realpath(join(base, "other"))]);
  });
});

const realpath = (path: string): string => realpathSync(path);

describe("working set", () => {
  test("globs, directories and files expand inside the roots; secrets, .git and binaries are skipped", () => {
    const { app, profile } = layout();
    write(join(app, "src", "a.ts"), "export const a = 1;\n");
    write(join(app, "src", "nested", "b.ts"), "export const b = 2;\n");
    write(join(app, "notes", "todo.md"), "- one\n");
    write(join(app, ".env"), "SECRET=1\n");
    write(join(app, ".git", "config"), "[remote]\n");
    write(join(app, "src", "image.bin"), "\0\0\0");
    manifest(app, { workingSet: ["src/**/*.ts", "notes", ".env", ".git/config", "src/image.bin", "missing.ts"] });
    const project = resolveProject(app, { configDir: profile });
    if (!project) throw new Error("no project");
    const set = resolveWorkingSet(project);
    expect(set.files.map((f) => f.path.slice(realpath(app).length + 1).replaceAll("\\", "/"))).toEqual(["src/a.ts", "src/nested/b.ts", "notes/todo.md"]);
    const reasons = Object.fromEntries(set.skipped.map((s) => [s.path.split(/[\\/]/).slice(-2).join("/"), s.reason]));
    expect(reasons).toMatchObject({
      "app/.env": "forbidden (.env)",
      ".git/config": "excluded directory",
      "src/image.bin": "binary",
      "missing.ts": "not found",
    });
  });

  test("a symlink that leaves the roots is not read", () => {
    const { base, app, profile } = layout();
    write(join(base, "outside.txt"), "private\n");
    symlinkSync(join(base, "outside.txt"), join(app, "link.txt"));
    manifest(app, { workingSet: ["link.txt"] });
    const project = resolveProject(app, { configDir: profile });
    if (!project) throw new Error("no project");
    const set = resolveWorkingSet(project);
    expect(set.files).toEqual([]);
    expect(set.skipped[0]?.reason).toBe("outside the trusted project roots");
  });

  test("files over the budget are listed, not cut", () => {
    const { app, profile } = layout();
    write(join(app, "small.ts"), "small\n");
    write(join(app, "big.ts"), "x".repeat(3000));
    manifest(app, { workingSet: ["small.ts", "big.ts"] });
    const project = resolveProject(app, { configDir: profile });
    if (!project) throw new Error("no project");
    const rendered = renderWorkingSet(project.id, resolveWorkingSet(project), { cwd: app, fileMaxBytes: 1024, now: new Date(0) });
    expect(rendered?.text).toContain('<file path="small.ts">\nsmall\n</file>');
    expect(rendered?.text).toContain("Listed without contents (over budget): big.ts (3 KB)");
    expect(rendered?.text).not.toContain("xxxx");
    expect(rendered?.included).toEqual([realpath(join(app, "small.ts"))]);
  });

  test("add refuses entries outside the roots and keeps the rest", () => {
    const { app, profile } = layout();
    const service = new ProjectService(app, { configDir: profile });
    service.init({ id: "demo", name: "Demo" });
    expect(() => service.addToWorkingSet(["../elsewhere/*"])).toThrow(/outside the project roots/);
    service.addToWorkingSet(["src/**/*.ts", "README.md"]);
    service.addToWorkingSet(["README.md"]);
    service.removeFromWorkingSet(["src/**/*.ts"]);
    expect(readManifest(app)?.workingSet).toEqual(["README.md"]);
  });
});

describe("defaults", () => {
  test("manifest config sits under .baked/config.json and is never written into it", () => {
    const { app } = layout();
    manifest(app, { defaults: { config: { defaultModel: "manifest/model", modelFallback: { a: ["b"] } } } });
    write(join(app, ".baked", "config.json"), JSON.stringify({ defaultModel: "checkout/model" }));
    expect(loadEffectiveProjectConfig(app)).toMatchObject({ defaultModel: "checkout/model", modelFallback: { a: ["b"] } });
    expect(loadProjectConfig(app)).toEqual({ defaultModel: "checkout/model" });
  });

  test("manifest instructions join the project instructions", () => {
    const { app } = layout();
    write(join(app, "docs", "agent.md"), "Always write tests.\n");
    manifest(app, { defaults: { instructions: ["docs/agent.md", "../outside.md"] } });
    const loaded = loadInstructions(app, ["baked"]);
    expect(loaded).toEqual([{ source: "project", file: "docs/agent.md", content: "Always write tests.", scope: "project" }]);
  });
});

describe("projectId on sessions", () => {
  test("a saved session records its project and the list returns it", async () => {
    const { app } = layout();
    manifest(app, {});
    const manager = new SessionManager(app);
    const tab = {
      id: "t1",
      label: "Tab",
      activeModel: "m",
      sessionId: "s1",
      planMode: false,
      planRequest: null,
      coAuthorCommits: false,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      messageRange: { startLine: 0, endLine: 0 },
    };
    await manager.saveTab("s1", tab, [{ id: "m1", role: "user", content: "hi", timestamp: 1 }], undefined, {
      title: "Hello",
      cwd: app,
      bakeMode: "default",
      activeTabId: "t1",
    });
    expect(JSON.parse(readFileSync(join(app, ".baked", "sessions", "s1", "meta.json"), "utf8")).projectId).toBe("demo");
    expect(manager.listSessions().map((s) => s.projectId)).toEqual(["demo"]);
    expect(new ProjectService(app).summary().sessions.map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("projectId and working set on workflow runs", () => {
  test("a run records its project, captures the working set and gives it to the first agents only", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { root, service, executor } = fixture;
    write(join(root, "focus.md"), "The focus of this project.\n");
    manifest(root, { workingSet: ["focus.md"] });
    const run = await fixture.start();
    expect(run.projectId).toBe("demo");
    expect(service.store.events(run.runId)[0]?.payload).toMatchObject({ projectId: "demo" });
    const state = service.store.state(run.runId);
    expect(state.workingSet?.files).toEqual(["focus.md"]);
    expect(state.manifest.instructionHashes.some((h) => h.source === WORKING_SET_ARTIFACT)).toBe(true);
    expect(service.store.projectRuns("demo").map((r) => r.runId)).toEqual([run.runId]);

    await service.drive(run.runId, new AbortController().signal);
    const research = executor.prompts.research?.[0] ?? "";
    expect(research).toContain("The focus of this project.");
    for (const prompt of executor.prompts.spec ?? []) expect(prompt).not.toContain("The focus of this project.");

    // A revision keeps the captured working set among the inputs.
    const candidate = await new WorkflowArtifacts(service).stageRevision(run.runId, {
      commandId: newId(),
      expectedInputHash: (await service.get(run.runId)).inputHash,
    });
    expect(candidate.candidateHash).toBeTruthy();
    const staged = JSON.parse(service.store.readArtifact(run.runId, candidate.reportArtifactId)) as {
      state: { manifest: { instructionHashes: { source: string; hash: string }[] } };
    };
    expect(staged.state.manifest.instructionHashes.filter((h) => h.source === WORKING_SET_ARTIFACT)).toEqual(
      state.manifest.instructionHashes.filter((h) => h.source === WORKING_SET_ARTIFACT),
    );
  });

  test("migration 007 upgrades a 006 database and earlier runs have no project", () => {
    const root = temp("baked-project-db-");
    mkdirSync(join(root, ".baked"), { recursive: true });
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    db.exec("PRAGMA foreign_keys=ON;");
    for (const [index, sql] of [migration001, migration002, migration003, migration004, migration005, migration006].entries()) {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations VALUES (?,?,?)", [index + 1, hashBytes(sql), Date.now()]);
    }
    db.run("INSERT INTO features VALUES ('legacy','specs/legacy',1)");
    db.run("INSERT INTO runs (id,feature_id,status,definition_json,profiles_json,policy_json,input_manifest_json,input_hash,created_at,updated_at) VALUES ('r1','legacy','paused','{}','[]','{}','{}',?,1,1)", ["a".repeat(64)]);
    db.close();
    const reader = new WorkflowStore(root, true);
    try {
      expect(reader.projectRuns("demo")).toEqual([]);
    } finally {
      reader.close();
    }
    const store = new WorkflowStore(root);
    try {
      expect(store.schemaVersion()).toBe(13);
      expect(store.run("r1").project_id).toBeNull();
      expect(store.projectRuns("demo")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

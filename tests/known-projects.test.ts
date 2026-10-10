import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addKnownProject,
  findKnownProject,
  forgetKnownProject,
  KNOWN_PROJECTS_LIMIT,
  knownProjectsPath,
  listKnownProjects,
  recordProjectOpen,
  renameKnownProject,
  setProjectPinned,
} from "../src/core/projects/known.js";
import { projectOverview } from "../src/core/projects/overview.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A private profile and two project folders inside one temporary directory. */
function layout() {
  const base = temp("baked-known-");
  const profile = join(base, "profile");
  const app = join(base, "app");
  const site = join(base, "site");
  for (const dir of [profile, app, site]) mkdirSync(dir, { recursive: true });
  return { base, profile, app, site, opts: { configDir: profile } };
}

function session(folder: string, id: string, updatedAt: number): void {
  const dir = join(folder, ".baked", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ id, title: id, cwd: folder, startedAt: updatedAt, updatedAt, tabs: [] }),
  );
}

describe("known projects", () => {
  test("opening a folder lists it once, most recent first, with the folder name", () => {
    const { app, site, opts } = layout();
    expect(listKnownProjects(opts)).toEqual([]);
    expect(recordProjectOpen(app, { ...opts, now: 1000 })).toBe(true);
    expect(recordProjectOpen(site, { ...opts, now: 2000 })).toBe(true);
    expect(recordProjectOpen(app, { ...opts, now: 3000 })).toBe(true);
    const list = listKnownProjects(opts);
    expect(list.map((p) => [p.name, p.path, p.addedAt, p.lastOpenedAt])).toEqual([
      ["app", app, 1000, 3000],
      ["site", site, 2000, 2000],
    ]);
    expect(list[0]).toMatchObject({ projectId: null, pinned: false, exists: true });
  });

  test("the home directory, a filesystem root and the config directory are not recorded", () => {
    const { base, profile, opts } = layout();
    const home = process.env.HOME;
    process.env.HOME = base;
    cleanups.push(() => {
      process.env.HOME = home;
    });
    expect(recordProjectOpen(base, opts)).toBe(false);
    expect(recordProjectOpen("/", opts)).toBe(false);
    expect(recordProjectOpen(profile, opts)).toBe(false);
    expect(listKnownProjects(opts)).toEqual([]);
    expect(() => addKnownProject(profile, opts)).toThrow("not a project");
    expect(() => addKnownProject(join(base, "missing"), opts)).toThrow("does not exist");
  });

  test("the manifest names a project, a user name overrides it, and an empty name restores it", () => {
    const { app, opts } = layout();
    mkdirSync(join(app, "baked"), { recursive: true });
    writeFileSync(join(app, "baked", "project.json"), JSON.stringify({ schemaVersion: 1, id: "demo", name: "Demo" }));
    addKnownProject(app, opts);
    expect(findKnownProject(app, opts)).toMatchObject({ name: "Demo", projectId: "demo" });
    expect(renameKnownProject(app, " Main app ", opts).name).toBe("Main app");
    expect(renameKnownProject(app, "", opts).name).toBe("Demo");
    expect(readFileSync(knownProjectsPath(opts.configDir), "utf8")).not.toContain('"name"');
  });

  test("pinned projects come first and survive pruning", () => {
    const { base, app, opts } = layout();
    recordProjectOpen(app, { ...opts, now: 1 });
    setProjectPinned(app, true, opts);
    for (let i = 0; i <= KNOWN_PROJECTS_LIMIT; i++) {
      const dir = join(base, `p${i}`);
      mkdirSync(dir);
      recordProjectOpen(dir, { ...opts, now: 10 + i });
    }
    const list = listKnownProjects(opts);
    expect(list).toHaveLength(KNOWN_PROJECTS_LIMIT + 1);
    expect(list[0]).toMatchObject({ path: app, pinned: true });
    expect(list.some((p) => p.path === join(base, "p0"))).toBe(false);
    expect(setProjectPinned(app, false, opts).pinned).toBe(false);
  });

  test("forgetting removes only the list entry; a moved folder is reported missing", () => {
    const { app, site, opts } = layout();
    recordProjectOpen(app, opts);
    recordProjectOpen(site, opts);
    session(app, "s1", 5);
    expect(forgetKnownProject(app, opts)).toBe(true);
    expect(forgetKnownProject(app, opts)).toBe(false);
    expect(statSync(join(app, ".baked", "sessions", "s1")).isDirectory()).toBe(true);
    rmSync(site, { recursive: true });
    expect(listKnownProjects(opts)).toMatchObject([{ path: site, exists: false }]);
    expect(() => setProjectPinned(app, true, opts)).toThrow("not in the project list");
  });

  test("an unreadable list counts as empty and is replaced on the next open", () => {
    const { app, profile, opts } = layout();
    writeFileSync(knownProjectsPath(profile), "{ not json");
    expect(listKnownProjects(opts)).toEqual([]);
    recordProjectOpen(app, opts);
    expect(listKnownProjects(opts).map((p) => p.path)).toEqual([app]);
  });
});

describe("project overview", () => {
  test("an empty or missing folder has nothing", () => {
    const { app, base } = layout();
    const empty = { sessions: 0, lastSessionAt: null, activeRuns: 0, attention: 0 };
    expect(projectOverview(app)).toEqual(empty);
    expect(projectOverview(join(base, "missing"))).toEqual(empty);
  });

  test("counts sessions, active runs and what waits for a person", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    session(fixture.root, "s1", 100);
    session(fixture.root, "s2", 300);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    expect(fixture.service.store.run(run.runId).status).toBe("waiting");
    expect(projectOverview(fixture.root)).toEqual({ sessions: 2, lastSessionAt: 300, activeRuns: 1, attention: 1 });
  });
});

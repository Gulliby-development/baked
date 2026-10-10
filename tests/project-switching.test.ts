import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  addKnownProject,
  type KnownProject,
  listKnownProjects,
  setProjectPinned,
} from "../src/core/projects/known.js";
import type { ProjectOverview } from "../src/core/projects/overview.js";
import { realPath } from "../src/core/projects/paths.js";
import {
  badgeProjects,
  fitLabel,
  overviewBrief,
  overviewLine,
  projectDetails,
  resolveFolderInput,
  runsExecutingInProcess,
  waitingBadgeText,
  waitingElsewhere,
} from "../src/core/projects/switcher.js";
import { getRestartSpec, projectSwitchArgs } from "../src/core/restart.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";

describe("projectSwitchArgs", () => {
  test("adds --cwd and keeps the other arguments", () => {
    expect(projectSwitchArgs(["--verbose"], "/work/b")).toEqual(["--verbose", "--cwd", "/work/b"]);
  });

  test("replaces --cwd in both forms", () => {
    expect(projectSwitchArgs(["--cwd", "/work/a", "-x"], "/work/b")).toEqual([
      "-x",
      "--cwd",
      "/work/b",
    ]);
    expect(projectSwitchArgs(["--cwd=/work/a"], "/work/b")).toEqual(["--cwd", "/work/b"]);
  });

  test("drops sessions of the old folder and the one-shot wizard", () => {
    for (const args of [
      ["--resume", "abc"],
      ["--session", "abc"],
      ["-s", "abc"],
      ["--resume=abc"],
      ["--session=abc"],
      ["--wizard"],
    ])
      expect(projectSwitchArgs(args, "/work/b")).toEqual(["--cwd", "/work/b"]);
  });

  test("resumes a session of the new folder when one was picked", () => {
    expect(projectSwitchArgs(["-s", "old", "--cwd", "/a"], "/work/b", "new-id")).toEqual([
      "--cwd",
      "/work/b",
      "--resume",
      "new-id",
    ]);
  });

  test("a trailing flag without a value is dropped", () => {
    expect(projectSwitchArgs(["--resume"], "/b")).toEqual(["--cwd", "/b"]);
  });

  test("getRestartSpec uses the replacement arguments", () => {
    const spec = getRestartSpec({
      execPath: "/usr/bin/bun",
      argv: ["/usr/bin/bun", "/app/src/boot.tsx", "--cwd", "/a"],
      moduleUrl: "file:///app/src/core/restart.ts",
      userArgs: ["--cwd", "/b"],
    });
    expect(spec).toEqual({ command: "/usr/bin/bun", args: ["/app/src/boot.tsx", "--cwd", "/b"] });
  });
});

function known(path: string, over: Partial<KnownProject> = {}): KnownProject {
  return {
    path,
    name: path.split("/").pop() ?? path,
    projectId: null,
    pinned: false,
    addedAt: 0,
    lastOpenedAt: 0,
    exists: true,
    ...over,
  };
}

describe("badge aggregation", () => {
  test("reads pinned projects and the most recent others, never the current or missing ones", () => {
    const projects = [
      known("/p/current", { lastOpenedAt: 100 }),
      known("/p/pinned-old", { pinned: true, lastOpenedAt: 1 }),
      known("/p/gone", { exists: false, lastOpenedAt: 99 }),
      ...Array.from({ length: 12 }, (_, i) => known(`/p/r${i}`, { lastOpenedAt: 50 - i })),
    ];
    const picked = badgeProjects(projects, "/p/current", 10).map((p) => p.path);
    expect(picked[0]).toBe("/p/pinned-old");
    expect(picked).toHaveLength(11);
    expect(picked).not.toContain("/p/current");
    expect(picked).not.toContain("/p/gone");
    expect(picked).toContain("/p/r9");
    expect(picked).not.toContain("/p/r10");
  });

  test("badge text", () => {
    expect(waitingBadgeText({ waiting: 0, projects: 0 })).toBeNull();
    expect(waitingBadgeText({ waiting: 1, projects: 1 })).toBe("1 waiting in another project");
    expect(waitingBadgeText({ waiting: 3, projects: 2 })).toBe("3 waiting in other projects");
  });

  test("overview line", () => {
    const o: ProjectOverview = { sessions: 1, lastSessionAt: null, activeRuns: 2, attention: 0 };
    expect(overviewLine(o)).toBe("1 session · 2 active runs");
    expect(overviewLine({ ...o, attention: 4 })).toBe("1 session · 2 active runs · 4 waiting");
    expect(overviewBrief({ ...o, activeRuns: 0 })).toBe("1 session");
    expect(overviewBrief({ ...o, sessions: 3, attention: 4 })).toBe(
      "3 sessions · 2 active · 4 waiting",
    );
  });

  test("picker labels fit their column", () => {
    expect(fitLabel("app", "~/code/app", 32)).toBe("app  ~/code/app");
    const long = fitLabel("app", "/very/long/path/to/some/nested/project/app", 32);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.startsWith("app  …")).toBe(true);
    expect(long.endsWith("project/app")).toBe(true);
    expect(fitLabel("x".repeat(40), "/p", 32)).toHaveLength(32);
  });
});

describe("with a temporary profile", () => {
  let root: string;
  let configDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    root = realPath(mkdtempSync(join(tmpdir(), "baked-switch-")));
    configDir = join(root, "profile");
    mkdirSync(configDir);
    savedHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.HOME);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  function folder(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  test("waitingElsewhere sums other projects and survives a failing one", async () => {
    const a = folder("a");
    const b = folder("b");
    const c = folder("c");
    const broken = folder("broken");
    for (const [i, path] of [a, b, c, broken].entries())
      addKnownProject(path, { configDir, now: 1000 + i });
    setProjectPinned(c, true, { configDir });
    const attention: Record<string, number> = { [a]: 5, [b]: 2, [c]: 1 };
    const result = await waitingElsewhere(a, {
      configDir,
      overview: (path) => {
        if (path === broken) throw new Error("unreadable");
        return { sessions: 0, lastSessionAt: null, activeRuns: 0, attention: attention[path] ?? 0 };
      },
    });
    expect(result).toEqual({ waiting: 3, projects: 2 });
  });

  test("waitingElsewhere reads real empty folders as nothing waiting", async () => {
    addKnownProject(folder("x"), { configDir });
    addKnownProject(folder("y"), { configDir });
    expect(await waitingElsewhere(join(root, "x"), { configDir })).toEqual({
      waiting: 0,
      projects: 0,
    });
  });

  test("resolveFolderInput expands ~, resolves relative paths and rejects files", () => {
    const target = folder("home/code/app");
    expect(resolveFolderInput("~/code/app", "/")).toEqual({ path: target });
    expect(resolveFolderInput("app", join(root, "home/code"))).toEqual({ path: target });
    expect(resolveFolderInput(`"${target}"`, "/")).toEqual({ path: target });
    writeFileSync(join(root, "file.txt"), "x");
    expect(resolveFolderInput(join(root, "file.txt"), "/")).toHaveProperty("error");
    expect(resolveFolderInput(join(root, "missing"), "/")).toHaveProperty("error");
    expect(resolveFolderInput("  ", "/")).toHaveProperty("error");
  });

  test("projectDetails describes a plain folder", () => {
    const path = folder("plain");
    addKnownProject(path, { configDir });
    const details = projectDetails(path, { configDir });
    expect(details.name).toBe("plain");
    expect(details.path).toBe(path);
    expect(details.projectId).toBeNull();
    expect(details.workingSet).toBeNull();
    expect(details.sessions).toEqual([]);
    expect(details.runs).toEqual([]);
    expect(details.attention).toEqual([]);
    expect(listKnownProjects({ configDir })).toHaveLength(1);
  });
});

describe("runsExecutingInProcess", () => {
  test("finds running runs whose lease this process holds", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-switch-runs-"));
    const config = {
      ...DEFAULT_CONFIG,
      defaultModel: "fixture/model",
      workflows: { enabled: true, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy },
    };
    const executor: AgentExecutor = {
      execute: async () => {
        throw new Error("not driven in this test");
      },
    };
    const service = new NativeWorkflowService(root, config, executor);
    try {
      expect(runsExecutingInProcess(root)).toEqual([]);
      const run = await service.start({
        commandId: newId(),
        featureId: "fixture",
        workflowId: "sdd",
        prompt: "Create a value",
        ownerLabel: "test",
        policy: defaultWorkflowPolicy,
      });
      const lease = (pid: number, extra: Record<string, string> = {}) =>
        service.store.putLease({
          resource: "execution",
          owner_id: "owner",
          owner_epoch: 1,
          run_id: run.runId,
          expires_at: 0,
          process_identity_json: JSON.stringify({ pid, ...extra }),
        });
      lease(process.pid);
      // A created run holds no execution yet.
      expect(runsExecutingInProcess(root)).toEqual([]);
      service.store.transition(run.runId, "running");
      expect(runsExecutingInProcess(root)).toEqual([run.runId]);
      lease(2147483647);
      expect(runsExecutingInProcess(root)).toEqual([]);
      lease(process.pid, { exitedWorkerOwner: "owner" });
      expect(runsExecutingInProcess(root)).toEqual([]);
    } finally {
      service.store.releaseLease("execution", "owner", 1);
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHead, readGitBranch } from "../src/main/git-branch.ts";
import {
  manageKnownProject,
  ProjectActionError,
  renameKnownProject,
} from "../src/main/project-actions.ts";
import {
  BADGE_FILL,
  BADGE_TEXT,
  badgeBitmap,
  badgeLabel,
  CloseRequests,
  closeAction,
  closeToTray,
  trayModel,
} from "../src/main/tray-model.ts";
import type { ApiResponse, AttentionItem, DesktopProject } from "../src/shared/api.ts";

describe("git branch", () => {
  test("parses HEAD", () => {
    expect(parseHead("ref: refs/heads/feature/x\n")).toBe("feature/x");
    expect(parseHead("4be1f02c0ffee\n")).toBeNull();
  });

  test("reads a repository and a linked worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-branch-"));
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, "meta"));
    writeFileSync(join(root, "meta", "HEAD"), "ref: refs/heads/topic\n");
    mkdirSync(join(root, "tree"));
    writeFileSync(join(root, "tree", ".git"), "gitdir: ../meta\n");
    expect(readGitBranch(join(root, "repo"))).toBe("main");
    expect(readGitBranch(join(root, "tree"))).toBe("topic");
    expect(readGitBranch(join(root, "meta"))).toBeNull();
  });
});

describe("project actions", () => {
  const reply =
    (status: number, body: unknown = {}) =>
    async (): Promise<ApiResponse> => ({ status, body });

  test("a running backend answers first", async () => {
    const calls: string[][] = [];
    const via = await manageKnownProject(
      "/p",
      "pin",
      [reply(200, { projects: [] })],
      async (args) => {
        calls.push(args);
        return "";
      },
    );
    expect(via).toBe("api");
    expect(calls).toEqual([]);
  });

  test("an older backend or none falls back to the command", async () => {
    const calls: string[][] = [];
    const cli = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };
    const old = reply(404, { error: { code: "NOT_FOUND", message: "No endpoint /v1/projects/pin" } });
    expect(await manageKnownProject("/p", "unpin", [old], cli)).toBe("cli");
    expect(await manageKnownProject("/p", "forget", [], cli)).toBe("cli");
    const failing = async (): Promise<ApiResponse> => {
      throw new Error("PROJECT_CLOSED");
    };
    expect(await manageKnownProject("/p", "pin", [failing], cli)).toBe("cli");
    expect(calls).toEqual([
      ["projects", "unpin", "/p"],
      ["projects", "forget", "/p"],
      ["projects", "pin", "/p"],
    ]);
  });

  test("an unknown folder is refused, not retried", async () => {
    const unknown = reply(404, {
      error: { code: "NOT_FOUND", message: "/p is not a known project" },
    });
    await expect(
      manageKnownProject("/p", "pin", [unknown], async () => {
        throw new Error("should not run");
      }),
    ).rejects.toBeInstanceOf(ProjectActionError);
  });

  test("a rename goes to the backend, or to the command with the name", async () => {
    const posted: unknown[] = [];
    const backend = async (path: string, body: unknown): Promise<ApiResponse> => {
      posted.push([path, body]);
      return { status: 200, body: { projects: [] } };
    };
    const calls: string[][] = [];
    const cli = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };
    expect(await renameKnownProject("/p", "Shop", [backend], cli)).toBe("api");
    expect(posted).toEqual([["/v1/projects/rename", { path: "/p", name: "Shop" }]]);
    const old = reply(404, {
      error: { code: "NOT_FOUND", message: "No endpoint /v1/projects/rename" },
    });
    expect(await renameKnownProject("/p", "", [old], cli)).toBe("cli");
    expect(calls).toEqual([["projects", "rename", "/p", ""]]);
    const refused = reply(400, { error: { code: "INVALID_REQUEST", message: "Too long" } });
    await expect(renameKnownProject("/p", "x", [refused], cli)).rejects.toThrow("Too long");
  });
});

describe("tray", () => {
  const project = (open: boolean, activeRuns: number): DesktopProject => ({
    key: "k",
    name: "n",
    path: "/n",
    projectId: null,
    pinned: false,
    addedAt: 0,
    lastOpenedAt: 0,
    exists: true,
    open,
    backend: { kind: "running", version: "1" },
    overview: { sessions: 0, lastSessionAt: null, activeRuns, attention: 0 },
  });

  test("hides to the tray only while an open project has active runs", () => {
    const on = { quitting: false, keepRunningInTray: true };
    expect(closeAction({ ...on, projects: [project(true, 1)] })).toBe("hide");
    expect(closeAction({ ...on, projects: [project(true, 0), project(false, 2)] })).toBe("close");
    expect(closeAction({ ...on, keepRunningInTray: false, projects: [project(true, 1)] })).toBe(
      "close",
    );
    expect(closeAction({ ...on, quitting: true, projects: [project(true, 1)] })).toBe("close");
  });

  test("hides at once and keeps a window reopened while the list loads (#2391)", async () => {
    const run = async (projects: DesktopProject[], reopen: boolean) => {
      const log: string[] = [];
      let visible = true;
      let release: (list: DesktopProject[]) => void = () => {};
      const pending = closeToTray({
        window: {
          hide: () => {
            visible = false;
            log.push("hide");
          },
          destroy: () => log.push("destroy"),
          isVisible: () => visible,
          isDestroyed: () => false,
        },
        showTray: () => log.push("tray"),
        hideTray: () => log.push("untray"),
        projects: () => new Promise((resolve) => (release = resolve)),
        decide: (list) =>
          closeAction({ quitting: false, keepRunningInTray: true, projects: list }),
        current: () => true,
      });
      // The window is hidden before the slow project list answers.
      expect(log).toEqual(["hide", "tray"]);
      if (reopen) visible = true;
      release(projects);
      return { action: await pending, log };
    };
    expect(await run([project(true, 1)], false)).toEqual({ action: "hide", log: ["hide", "tray"] });
    expect(await run([project(true, 0)], false)).toEqual({
      action: "close",
      log: ["hide", "tray", "untray", "destroy"],
    });
    expect(await run([project(true, 0)], true)).toEqual({
      action: "stale",
      log: ["hide", "tray"],
    });
  });

  test("an older close cannot decide after the window was reopened and closed again", async () => {
    const requests = new CloseRequests();
    const log: string[] = [];
    const window = {
      hide: () => log.push("hide"),
      destroy: () => log.push("destroy"),
      isVisible: () => false,
      isDestroyed: () => false,
    };
    const releases: ((list: DesktopProject[]) => void)[] = [];
    const close = () => {
      const id = requests.next();
      return closeToTray({
        window,
        showTray: () => log.push("tray"),
        hideTray: () => log.push("untray"),
        projects: () => new Promise((resolve) => releases.push(resolve)),
        decide: (list) =>
          closeAction({ quitting: false, keepRunningInTray: true, projects: list }),
        current: () => requests.isCurrent(id),
      });
    };
    const first = close();
    requests.cancel(); // shown again, a run starts
    const second = close();
    releases[0]?.([project(true, 0)]);
    releases[1]?.([project(true, 1)]);
    expect(await first).toBe("stale");
    expect(await second).toBe("hide");
    expect(log).not.toContain("destroy");
  });

  test("counts blocking items for the badge and menu", () => {
    const item = (blocking: boolean) => ({ blocking }) as AttentionItem;
    expect(trayModel([item(true), item(false), item(true)])).toEqual({
      tooltip: "BAKED: 2 need you",
      needYou: "2 need you",
      badge: 2,
    });
    expect(trayModel([item(false)])).toEqual({ tooltip: "BAKED", needYou: null, badge: 0 });
  });
});

describe("windows overlay badge", () => {
  test("labels the count up to 9, then 9+, and clears at 0", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-1)).toBeNull();
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
    expect(badgeLabel(250)).toBe("9+");
  });

  test("draws an orange disc with the label in BGRA", () => {
    const size = 32;
    const pixel = (image: Buffer, x: number, y: number): string => {
      const at = (y * size + x) * 4;
      return [image[at + 2], image[at + 1], image[at], image[at + 3]].join();
    };
    const textPixels = (image: Buffer): number => {
      let count = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) if (pixel(image, x, y) === [...BADGE_TEXT, 255].join()) count++;
      return count;
    };
    const one = badgeBitmap("1", size);
    expect(one.length).toBe(size * size * 4);
    // Corners stay transparent; the disc is the accent orange.
    expect(pixel(one, 0, 0)).toBe("0,0,0,0");
    expect(pixel(one, 4, 16)).toBe([...BADGE_FILL, 255].join());
    expect(textPixels(one)).toBeGreaterThan(0);
    expect(textPixels(badgeBitmap("9+", size))).toBeGreaterThan(0);
    expect(textPixels(badgeBitmap("", size))).toBe(0);
    expect(badgeBitmap("8", size).equals(badgeBitmap("3", size))).toBe(false);
  });
});

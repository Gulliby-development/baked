import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHead, readGitBranch } from "../src/main/git-branch.ts";
import { manageKnownProject, ProjectActionError } from "../src/main/project-actions.ts";
import { closeAction, trayModel } from "../src/main/tray-model.ts";
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

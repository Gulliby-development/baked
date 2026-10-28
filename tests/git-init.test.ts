import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_FILE_MAX,
  BASELINE_MESSAGE,
  DEFAULT_GITIGNORE,
  gitInitSummary,
  initWorkspaceGit,
  workspaceGitState,
} from "../src/core/git/init.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => Promise<void>)[] = [];
// No identity, hooks or signing from the developer's Git configuration (#1345 tests the fallback).
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
let globalDir = "";
beforeAll(() => {
  globalDir = mkdtempSync(join(tmpdir(), "baked-git-init-global-"));
  writeFileSync(join(globalDir, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(globalDir, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(async () => {
  for (const [key, value] of [
    ["GIT_CONFIG_GLOBAL", saved.global],
    ["GIT_CONFIG_NOSYSTEM", saved.nosystem],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTempDir(globalDir);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-git-init-"));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

describe("initializing Git for worktree runs", () => {
  test("a plain folder gets Git, a .gitignore and a baseline without secrets, internal and large files", async () => {
    const dir = folder();
    // A temporary folder inside a repository cannot be initialized; nothing to test there.
    if ((await workspaceGitState(dir)).kind !== "missing") return;
    writeFileSync(join(dir, "main.py"), "print('hi')\n");
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
    writeFileSync(join(dir, "notes.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
    mkdirSync(join(dir, ".baked"), { recursive: true });
    writeFileSync(join(dir, ".baked", "workflows.db"), "db");
    writeFileSync(join(dir, "video[1].bin"), "");
    truncateSync(join(dir, "video[1].bin"), BASELINE_FILE_MAX + 1);

    const result = await initWorkspaceGit(dir);
    expect(result).toMatchObject({ initialized: true, gitignore: true });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(DEFAULT_GITIGNORE);
    const tracked = git(dir, "ls-files").trim().split("\n").sort();
    expect(tracked).toEqual([".gitignore", "main.py"]);
    expect(result.files).toBe(2);
    expect(result.skipped).toEqual([
      { path: "notes.txt", reason: "secret" },
      { path: "video[1].bin", reason: "large" },
    ]);
    // Left-out files stay out of `git status`, so later commits do not pick them up.
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "log", "-1", "--format=%s|%an")).toBe(`${BASELINE_MESSAGE}|BAKED\n`);
    expect(result.commit).toBe(git(dir, "rev-parse", "HEAD").trim());
    expect((await workspaceGitState(dir)).kind).toBe("ready");
    expect(gitInitSummary(result)).toContain("Left out 2 secret or large files: notes.txt, video[1].bin.");
  });

  test("keeps an existing .gitignore and commits the first baseline of a repository without a commit", async () => {
    const dir = folder();
    git(dir, "init", "-q");
    git(dir, "config", "user.name", "Person");
    git(dir, "config", "user.email", "person@example.com");
    writeFileSync(join(dir, ".gitignore"), "tmp/\n");
    writeFileSync(join(dir, "a.txt"), "a\n");
    expect((await workspaceGitState(dir)).kind).toBe("no-commit");
    const result = await initWorkspaceGit(dir);
    expect(result).toMatchObject({ initialized: false, gitignore: false, files: 2, skipped: [] });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("tmp/\n");
    expect(git(dir, "log", "-1", "--format=%an")).toBe("Person\n");
  });

  test("refuses a folder that already has Git and a folder inside another repository", async () => {
    const dir = folder();
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.txt"), "a\n");
    await initWorkspaceGit(dir);
    await expect(initWorkspaceGit(dir)).rejects.toThrow("already has Git");
    const inner = join(dir, "inner");
    mkdirSync(inner);
    expect(await workspaceGitState(inner)).toMatchObject({ kind: "nested" });
    await expect(initWorkspaceGit(inner)).rejects.toThrow("is inside the Git repository");
    expect(existsSync(join(inner, ".git"))).toBe(false);
  });
});

describe("the baseline of a folder with scripts (#2331)", () => {
  test("a new file with a shebang is committed executable even when the folder has no executable bit", async () => {
    const dir = folder();
    if ((await workspaceGitState(dir)).kind !== "missing") return;
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "tool"), "#!/usr/bin/env python3\nprint('hi')\n", { mode: 0o644 });
    writeFileSync(join(dir, "main.py"), "print('hi')\n", { mode: 0o644 });
    await initWorkspaceGit(dir);
    expect(git(dir, "ls-tree", "HEAD", "--", "bin/tool")).toStartWith("100755 ");
    expect(git(dir, "ls-tree", "HEAD", "--", "main.py")).toStartWith("100644 ");
  });
});

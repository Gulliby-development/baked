import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBaseline, sourceManifest } from "../src/core/verification/snapshot.js";
import { gitWorktreePaths } from "../src/core/workflows/delivery-git.js";
import { commitRunBranch, ensureRunWorktree, worktreeBase } from "../src/core/workflows/worktree.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function repository(existing?: string) {
  const root = existing ?? mkdtempSync(join(tmpdir(), "baked-git-cache-"));
  if (!existing) roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "*.log\n.baked/\n");
  writeFileSync(join(root, "value.txt"), "one");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Initial");
  return root;
}

test("repeated source scans use two Git processes total and still hash changed content", async () => {
  const root = repository();
  const spawns = spyOn(Bun, "spawn");
  try {
    const before = await sourceManifest(root);
    writeFileSync(join(root, "value.txt"), "two");
    const after = await sourceManifest(root);
    expect(after["value.txt"]).not.toBe(before["value.txt"]);
    const calls = spawns.mock.calls.filter(([cmd]) => Array.isArray(cmd) && cmd[0] === "git");
    expect(calls.length).toBeLessThanOrEqual(2);
  } finally {
    spawns.mockRestore();
  }
});

test("tracked names refresh after index changes and an unborn index is never cached", async () => {
  const root = repository();
  writeFileSync(join(root, "forced.log"), "tracked despite ignore");
  expect((await sourceManifest(root))["forced.log"]).toBeUndefined();
  git(root, "add", "-f", "forced.log");
  expect((await sourceManifest(root))["forced.log"]).toBeDefined();
  git(root, "rm", "--cached", "-f", "forced.log");
  expect((await sourceManifest(root))["forced.log"]).toBeUndefined();
  rmSync(join(root, ".git", "index"));
  expect((await sourceManifest(root))["forced.log"]).toBeUndefined();
  git(root, "read-tree", "HEAD");
  git(root, "add", "-f", "forced.log");
  expect((await sourceManifest(root))["forced.log"]).toBeDefined();
});

test("HEAD and status remain fresh while worktree locations are cached", async () => {
  const root = repository();
  const before = await worktreeBase(root);
  writeFileSync(join(root, "value.txt"), "two");
  expect((await gitBaseline(root))?.userChanges).toContain(" M value.txt");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Second");
  const after = await worktreeBase(root);
  expect(after).not.toBe(before);
  expect((await gitBaseline(root))?.head).toBe(after);
  expect((await gitBaseline(root))?.userChanges).toEqual([]);
});

test("linked worktrees keep separate indexes and recreated worktrees refresh cached locations", async () => {
  const root = repository();
  const other = join(root, "other");
  git(root, "worktree", "add", "--detach", other, "HEAD");
  const first = await gitWorktreePaths(other);
  writeFileSync(join(other, "forced.log"), "only tracked in the linked worktree");
  git(other, "add", "-f", "forced.log");
  expect((await sourceManifest(other))["forced.log"]).toBeDefined();
  expect((await sourceManifest(root))["forced.log"]).toBeUndefined();
  git(root, "worktree", "remove", "--force", other);
  // Occupy the old administrative name so the same path gets a different index location.
  const occupied = join(root, "occupied", "other");
  git(root, "worktree", "add", "--detach", occupied, "HEAD");
  git(root, "worktree", "add", "--detach", other, "HEAD");
  expect((await gitWorktreePaths(other))?.index).not.toBe(first?.index);
  expect((await sourceManifest(other))["forced.log"]).toBeUndefined();
});

test("an alternate index invalidates both location and tracked-name caches", async () => {
  const root = repository();
  await sourceManifest(root);
  const index = join(root, ".git", "alternate-index");
  writeFileSync(index, readFileSync(join(root, ".git", "index")));
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = index;
    writeFileSync(join(root, "forced.log"), "alternate only");
    git(root, "add", "-f", "forced.log");
    expect((await sourceManifest(root))["forced.log"]).toBeDefined();
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
  expect((await sourceManifest(root))["forced.log"]).toBeUndefined();
});

test("accepted commits batch index updates, preserve modes and exclude secrets", async () => {
  const fx = workflowFixture();
  try {
    const root = repository(fx.root);
    writeFileSync(join(root, "script.sh"), "original\n");
    writeFileSync(join(root, "deleted.txt"), "delete me");
    git(root, "add", ".");
    git(root, "update-index", "--chmod=+x", "script.sh");
    git(root, "commit", "-qm", "Executable and deleted file");
    const run = await fx.start();
    const worktree = await ensureRunWorktree(fx.service.store, run.runId);
    const tree = join(root, worktree.path);
    writeFileSync(join(tree, "script.sh"), "changed\n");
    rmSync(join(tree, "deleted.txt"));
    writeFileSync(join(tree, ".env"), "TOKEN=secret");
    writeFileSync(join(tree, "key.txt"), "-----BEGIN PRIVATE KEY-----");
    mkdirSync(join(tree, "nested"));
    const added = Array.from({ length: 12 }, (_, i) => `nested/file ${i}, value.txt`);
    for (const path of added) writeFileSync(join(tree, path), path);
    const spawns = spyOn(Bun, "spawn");
    let commit: string | null;
    try {
      commit = await commitRunBranch(fx.service.store, run.runId, worktree,
        ["script.sh", "deleted.txt", ".env", "key.txt", ...added], "Accepted files");
      const commands = spawns.mock.calls.flatMap(([cmd]) => Array.isArray(cmd) && cmd[0] === "git" ? [cmd] : []);
      expect(commands.filter((cmd) => cmd.includes("ls-tree"))).toHaveLength(1);
      expect(commands.filter((cmd) => cmd.includes("update-index"))).toHaveLength(1);
    } finally {
      spawns.mockRestore();
    }
    expect(commit).toBeTruthy();
    expect(git(tree, "ls-tree", commit!, "--", "script.sh")).toStartWith("100755");
    expect(git(tree, "show", `${commit}:script.sh`)).toBe("changed");
    const files = git(tree, "ls-tree", "-r", "--name-only", commit!);
    expect(files).not.toContain("deleted.txt");
    expect(files).not.toContain(".env");
    expect(files).not.toContain("key.txt");
    for (const path of added) expect(git(tree, "show", `${commit}:${path}`)).toBe(path);
    expect(git(root, "show", "HEAD:script.sh")).toBe("original");
    expect(await commitRunBranch(fx.service.store, run.runId, worktree,
      ["script.sh", "deleted.txt", ...added], "Accepted files")).toBe(commit);
  } finally {
    await fx.dispose();
  }
});

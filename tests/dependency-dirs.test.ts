import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionWorktree } from "../src/core/chat/session-worktree.js";
import { sourceManifest } from "../src/core/verification/snapshot.js";
import { copyWorkspace } from "../src/core/verification/doc-examples.js";
import {
  ALL_DEPENDENCY_DIRS,
  isLinkedDependency,
  linkDependencies,
} from "../src/core/workflows/dependency-dirs.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import {
  createTaskWorktree,
  runContentCommit,
  worktreePath,
} from "../src/core/workflows/worktree.js";

// #2330 (R74 ladlemath, PHP): a task worktree linked only `node_modules`, so a Composer project
// had to commit vendor/ for its checks to run there. Every worktree and copy now links the
// dependency folders of `DEPENDENCY_DIRS`, and the links stay out of snapshots and commits.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function write(root: string, path: string, content = "") {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A Composer project with an ignored, installed vendor/ and a Bundler path, and a run worktree. */
function composerProject(ignoreRules = ".baked/\nvendor/\nvendor/bundle/\n.bundle/\n") {
  const workspace = mkdtempSync(join(tmpdir(), "baked-dependency-dirs-"));
  roots.push(workspace);
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.name", "t");
  git(workspace, "config", "user.email", "t@example.com");
  write(workspace, ".gitignore", ignoreRules);
  write(workspace, "composer.json", "{}\n");
  write(workspace, "src/Sum.php", "<?php\n");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "base");
  write(workspace, "vendor/bin/phpunit", "#!/usr/bin/env php\n");
  write(workspace, "vendor/autoload.php", "<?php\n");
  const runId = "run-deps";
  const path = worktreePath(runId);
  git(workspace, "worktree", "add", "-q", "-b", "baked/run-deps", join(workspace, path));
  linkDependencies(workspace, join(workspace, path));
  const state = { worktree: { path, branch: "baked/run-deps", baseHead: "", commit: null } };
  const store = {
    workspace,
    run: () => ({ created_at: 1_700_000_000_000 }),
    state: () => state,
  } as unknown as WorkflowStore;
  return { workspace, root: join(workspace, path), store, runId, worktree: state.worktree };
}

describe("dependency folders in worktrees (#2330)", () => {
  test("the run worktree, a task worktree and a chat session worktree get an ignored vendor/", async () => {
    const f = composerProject();
    expect(existsSync(join(f.root, "vendor/bin/phpunit"))).toBe(true);
    const base = await runContentCommit(f.store, f.runId, f.worktree);
    const task = join(f.workspace, await createTaskWorktree(f.store, f.runId, "T001", base));
    expect(existsSync(join(task, "vendor/bin/phpunit"))).toBe(true);
    expect(lstatSync(join(task, "vendor")).isSymbolicLink()).toBe(true);
    const session = await createSessionWorktree(f.workspace, "session-deps");
    if ("unavailable" in session) throw new Error(session.unavailable);
    expect(existsSync(join(session.path, "vendor/autoload.php"))).toBe(true);
  });

  test("the run's content commit and its snapshot leave the link out, whichever way vendor is ignored", async () => {
    for (const rules of [".baked/\nvendor/\n", ".baked/\n/vendor\n"]) {
      const f = composerProject(rules);
      write(f.root, "src/Sum.php", "<?php\n// edited\n");
      const base = await runContentCommit(f.store, f.runId, f.worktree);
      const files = git(f.workspace, "ls-tree", "-r", "--name-only", base).split("\n");
      expect(files).toContain("src/Sum.php");
      expect(files.filter((file) => file.startsWith("vendor"))).toEqual([]);
      const manifest = await sourceManifest(f.root);
      expect(Object.keys(manifest).filter((file) => file.startsWith("vendor"))).toEqual([]);
      expect(Object.keys(manifest)).toContain("src/Sum.php");
    }
  });

  test("a tracked vendor/ (Go vendoring, a committed Composer tree) is checked out and never linked", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "baked-dependency-dirs-"));
    roots.push(workspace);
    git(workspace, "init", "-q", "-b", "main");
    git(workspace, "config", "user.name", "t");
    git(workspace, "config", "user.email", "t@example.com");
    write(workspace, "vendor/modules.txt", "# example.com/lib v1.0.0\n");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "base");
    const copy = join(workspace, ".worktree");
    git(workspace, "worktree", "add", "-q", "--detach", copy);
    expect(linkDependencies(workspace, copy)).toEqual([]);
    expect(lstatSync(join(copy, "vendor")).isSymbolicLink()).toBe(false);
    expect(Object.keys(await sourceManifest(copy))).toContain("vendor/modules.txt");
  });

  test("a nested folder (Bundler's vendor/bundle) is linked below a vendor/ the project tracks", () => {
    const workspace = mkdtempSync(join(tmpdir(), "baked-dependency-dirs-"));
    const copy = mkdtempSync(join(tmpdir(), "baked-dependency-dirs-copy-"));
    roots.push(workspace, copy);
    write(workspace, "vendor/bundle/ruby/3.4.0/gems/rspec/lib/rspec.rb");
    write(workspace, "renv/library/R-4.5/testthat/DESCRIPTION");
    write(copy, "vendor/tracked.rb");
    expect(linkDependencies(workspace, copy).sort()).toEqual(["renv/library", "vendor/bundle"]);
    expect(isLinkedDependency(copy, "vendor/bundle")).toBe(true);
    expect(existsSync(join(copy, "vendor/bundle/ruby/3.4.0/gems/rspec/lib/rspec.rb"))).toBe(true);
  });

  test("the documented-example copy links the same folders", () => {
    const workspace = mkdtempSync(join(tmpdir(), "baked-dependency-dirs-"));
    roots.push(workspace);
    write(workspace, "README.md", "# x\n");
    write(workspace, "vendor/autoload.php", "<?php\n");
    write(workspace, ".venv/bin/python", "");
    const copy = copyWorkspace(workspace, ["README.md"]);
    if (!copy) throw new Error("no copy");
    roots.push(copy);
    expect(existsSync(join(copy, "vendor/autoload.php"))).toBe(true);
    expect(existsSync(join(copy, ".venv/bin/python"))).toBe(true);
  });

  test("every folder of the record is relative and unique", () => {
    expect(new Set(ALL_DEPENDENCY_DIRS).size).toBe(ALL_DEPENDENCY_DIRS.length);
    for (const dir of ALL_DEPENDENCY_DIRS) {
      expect(dir.startsWith("/")).toBe(false);
      expect(dir.split("/")).not.toContain("..");
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { RuntimeState } from "../src/core/workflows/types.js";
import {
  createTaskWorktree,
  ensureRunWorktree,
  removeTaskWorktree,
} from "../src/core/workflows/worktree.js";

// The flaky initiative test "in worktrees, independent features run side by side": the two
// feature runs created their worktrees at the same moment, and `git worktree add` of one failed
// with "failed to read .git/worktrees/main/commondir" while the other was still creating its
// entry. The run blocked (input_changed) and the initiative stopped as active.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-worktree-race-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Race\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  return root;
}

/** A store with one state per run, enough for the worktree helpers. */
function fakeStore(workspace: string): WorkflowStore {
  const states = new Map<string, RuntimeState>();
  const state = (runId: string) => {
    const found = states.get(runId) ?? ({} as RuntimeState);
    states.set(runId, found);
    return found;
  };
  return {
    workspace,
    state,
    saveState: (runId: string, next: RuntimeState) => Object.assign(state(runId), next),
    transaction: <T>(action: () => T): T => action(),
    artifact: () => ({}),
  } as unknown as WorkflowStore;
}

describe("worktrees created at the same time", () => {
  test("run worktrees of parallel runs are all created", async () => {
    const root = repository();
    const store = fakeStore(root);
    // Without serialization some `git worktree add` of a round fails in almost every run.
    for (let round = 0; round < 6; round++) {
      const runIds = Array.from({ length: 12 }, (_, i) => `run-${round}-${i}`);
      const results = await Promise.allSettled(runIds.map((runId) => ensureRunWorktree(store, runId)));
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      for (const runId of runIds)
        expect(existsSync(join(root, store.state(runId).worktree?.path ?? "missing", ".git"))).toBe(true);
    }
  }, 60000);

  test("task worktrees of parallel writers are created and removed side by side", async () => {
    const root = repository();
    const store = fakeStore(root);
    const head = git(root, "rev-parse", "HEAD");
    const tasks = Array.from({ length: 8 }, (_, i) => `T00${i + 1}`);
    const paths = await Promise.all(tasks.map((task) => createTaskWorktree(store, "writers", task, head)));
    for (const path of paths) expect(existsSync(join(root, path, ".git"))).toBe(true);
    const removed = await Promise.all(paths.map((path) => removeTaskWorktree(root, path, { stopHolders: async () => {} })));
    expect(removed.every((r) => r.removed)).toBe(true);
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 60000);
});

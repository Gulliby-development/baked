import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileHash, sameContentIgnoringEol } from "../src/core/workflows/effects.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import {
  alignTaskFiles,
  createTaskWorktree,
  runContentCommit,
  worktreePath,
} from "../src/core/workflows/worktree.js";

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

/** A Windows-style repository: autocrlf on, no .gitattributes, a run worktree with an LF file. */
function fixture(autocrlf: boolean) {
  const workspace = mkdtempSync(join(tmpdir(), "baked-eol-"));
  roots.push(workspace);
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.name", "t");
  git(workspace, "config", "user.email", "t@example.com");
  git(workspace, "config", "core.autocrlf", autocrlf ? "true" : "false");
  writeFileSync(join(workspace, "readme.md"), "base\n");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "base");
  const runId = "run-eol";
  const path = worktreePath(runId);
  git(workspace, "worktree", "add", "-q", "-b", "baked/run-eol", join(workspace, path));
  const lines = "export const a = 1;\nexport const b = 2;\n";
  mkdirSync(join(workspace, path, "test"), { recursive: true });
  writeFileSync(join(workspace, path, "test", "options.test.js"), lines);
  const state = { worktree: { path, branch: "baked/run-eol", baseHead: "", commit: null } };
  const store = {
    workspace,
    run: () => ({ created_at: 1_700_000_000_000 }),
    state: () => state,
  } as unknown as WorkflowStore;
  return { workspace, path, store, runId, lines, worktree: state.worktree };
}

describe("byte-exact task worktrees", () => {
  // #1954: a same-size edit written in the same instant as the run's index ("racily clean") was
  // left out of the run's content: the copied index got a fresh time, so git trusted its stat.
  test("the run's content holds a same-size edit as recent as the run's index", async () => {
    const f = fixture(false);
    const root = join(f.workspace, f.path);
    const file = join(root, "Cargo.lock");
    // Ten seconds back, so `git add` records the entry without smudging it as racy.
    const then = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
    git(f.workspace, "config", "core.trustctime", "false");
    writeFileSync(file, 'version = "1.0.200"\n');
    utimesSync(file, then, then);
    git(root, "add", "Cargo.lock");
    // The edit lands in the same second as the index: same size, same mtime second.
    writeFileSync(file, 'version = "1.0.201"\n');
    utimesSync(file, then, then);
    const index = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index");
    utimesSync(index, then, new Date(then.getTime() + 500));
    expect(statSync(index).mtimeMs).toBeGreaterThan(statSync(file).mtimeMs);
    const base = await runContentCommit(f.store, f.runId, f.worktree as never);
    expect(git(f.workspace, "show", `${base}:Cargo.lock`)).toBe('version = "1.0.201"');
  });

  test("a task worktree holds the run worktree's LF bytes when autocrlf is on", async () => {
    const f = fixture(true);
    const base = await runContentCommit(f.store, f.runId, f.worktree as never);
    const task = await createTaskWorktree(f.store, f.runId, "T006", base, ["test/options.test.js"]);
    const bytes = readFileSync(join(f.workspace, task, "test", "options.test.js"));
    expect(bytes.toString("utf8")).toBe(f.lines);
    expect(bytes.includes(13)).toBe(false);
  });

  test("a file a checkout filter changed is replaced by a byte copy", () => {
    const f = fixture(false);
    const from = join(f.workspace, f.path);
    const to = mkdtempSync(join(tmpdir(), "baked-eol-to-"));
    roots.push(to);
    mkdirSync(join(to, "test"), { recursive: true });
    writeFileSync(join(to, "test", "options.test.js"), f.lines.replaceAll("\n", "\r\n"));
    expect(alignTaskFiles(from, to, ["test/options.test.js", "missing.js"])).toEqual([
      "test/options.test.js",
    ]);
    expect(readFileSync(join(to, "test", "options.test.js"), "utf8")).toBe(f.lines);
  });

  test("the edit check treats a line-ending difference as the same content", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-eol-hash-"));
    roots.push(dir);
    const file = join(dir, "a.txt");
    writeFileSync(file, "one\ntwo\n");
    const recorded = fileHash(file);
    writeFileSync(file, "one\r\ntwo\r\n");
    expect(fileHash(file)).not.toBe(recorded);
    expect(sameContentIgnoringEol(file, recorded)).toBe(true);
    writeFileSync(file, "one\r\nthree\r\n");
    expect(sameContentIgnoringEol(file, recorded)).toBe(false);
    expect(sameContentIgnoringEol(join(dir, "none.txt"), recorded)).toBe(false);
  });
});

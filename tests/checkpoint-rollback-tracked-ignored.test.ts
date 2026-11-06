import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollbackToCheckpoint } from "../src/core/checkpoints/fork.js";
import { snapshotWorkspace } from "../src/core/checkpoints/snapshot.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// #2741: a tracked file that matches .gitignore is in every snapshot, so rollback restores it;
// an untracked ignored file is in none, so rollback leaves it in place.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const msg = (id: string, role: "user" | "assistant", edited: string[] = []): ChatMessage => ({
  id,
  role,
  content: id,
  timestamp: 0,
  ...(edited.length > 0
    ? {
        toolCalls: edited.map((path, i) => ({
          id: `${id}-${String(i)}`,
          name: "edit_file",
          args: { path },
          result: { success: true, output: "ok" },
        })),
      }
    : {}),
});

test("rollback restores a tracked file that matches .gitignore and keeps an untracked one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-ignored-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "*.lock\n");
  writeFileSync(join(dir, "deps.lock"), "v0");
  git(dir, "add", "-A");
  git(dir, "add", "-f", "deps.lock");
  git(dir, "commit", "-q", "-m", "init");
  expect(await snapshotWorkspace(dir, "baked/cp-ign-0", "cp0")).toBe(true);
  writeFileSync(join(dir, "deps.lock"), "v1");
  writeFileSync(join(dir, "local.lock"), "mine");
  expect(await snapshotWorkspace(dir, "baked/cp-ign-1", "cp1")).toBe(true);

  const messages = [msg("u1", "user"), msg("a1", "assistant", ["deps.lock", "local.lock"])];
  const report = await rollbackToCheckpoint({
    cwd: dir,
    messages,
    checkpoint: 0,
    tags: [
      { index: 0, anchorMessageId: "", gitTag: "baked/cp-ign-0" },
      { index: 1, anchorMessageId: "u1", gitTag: "baked/cp-ign-1" },
    ],
    backupTag: "baked/ign-backup",
  });
  expect(report.restored).toEqual([join(dir, "deps.lock")]);
  expect(report.skipped).toEqual([
    { path: join(dir, "local.lock"), reason: "ignored by Git, so no snapshot holds it" },
  ]);
  expect(readFileSync(join(dir, "deps.lock"), "utf-8")).toBe("v0");
  expect(readFileSync(join(dir, "local.lock"), "utf-8")).toBe("mine");
});

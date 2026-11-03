import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollbackToCheckpoint } from "../src/core/checkpoints/fork.js";
import { readFileAt, snapshotWorkspace } from "../src/core/checkpoints/snapshot.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// #2740: snapshot bytes are read with the file's working-tree filters, as a checkout writes them.

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

const tags = [
  { index: 0, anchorMessageId: "", gitTag: "baked/cp-eol-0" },
  { index: 1, anchorMessageId: "u1", gitTag: "baked/cp-eol-1" },
];

async function crlfRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "baked-eol-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitattributes"), "*.txt text eol=crlf\n");
  writeFileSync(join(dir, "a b.txt"), "one\r\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  expect(await snapshotWorkspace(dir, "baked/cp-eol-0", "cp0")).toBe(true);
  writeFileSync(join(dir, "a b.txt"), "two\r\n");
  expect(await snapshotWorkspace(dir, "baked/cp-eol-1", "cp1")).toBe(true);
  return dir;
}

test("a snapshot file reads back as the working tree holds it under eol=crlf", async () => {
  const dir = await crlfRepo();
  expect((await readFileAt(dir, "baked/cp-eol-0", "a b.txt"))?.toString()).toBe("one\r\n");
});

test("rollback restores a CRLF file the agent edited instead of skipping it", async () => {
  const dir = await crlfRepo();
  const messages = [msg("u1", "user"), msg("a1", "assistant", ["a b.txt"])];
  const report = await rollbackToCheckpoint({
    cwd: dir,
    messages,
    checkpoint: 0,
    tags,
    backupTag: "baked/eol-backup",
  });
  expect(report.skipped).toEqual([]);
  expect(report.restored).toEqual([join(dir, "a b.txt")]);
  expect(readFileSync(join(dir, "a b.txt"), "utf-8")).toBe("one\r\n");
});

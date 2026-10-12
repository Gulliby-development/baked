import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileAt, snapshotWorkspace } from "../src/core/checkpoints/snapshot.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// A same-size rewrite within one timestamp tick of the cached stat is only caught because Git
// treats entries as new as the index as "racy". The snapshot's temporary index copy must keep
// that property (#298). The tick is pinned with utimes so the test does not depend on timing.
test("snapshot stores a same-size rewrite made in the same tick as the index", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "baked-racy-"));
  dirs.push(cwd);
  git(cwd, "init", "-q");
  // ctime changes on every write and cannot be pinned; ignoring it isolates the mtime check.
  git(cwd, "config", "core.trustctime", "false");
  const file = join(cwd, "a.txt");
  const tick = new Date(Date.now() - 60_000);

  writeFileSync(file, "v0");
  utimesSync(file, tick, tick);
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "-q", "-m", "init");
  // The real index was written in the same tick as the file, so its entry is racy.
  utimesSync(join(cwd, ".git", "index"), tick, tick);

  for (const [i, content] of ["v1", "v2", "v3"].entries()) {
    writeFileSync(file, content);
    utimesSync(file, tick, tick);
    const tag = `racy-${String(i)}`;
    expect(await snapshotWorkspace(cwd, tag, tag)).toBe(true);
    expect((await readFileAt(cwd, tag, "a.txt"))?.toString()).toBe(content);
  }
});

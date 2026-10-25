import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// #2161: `session.close()` kills the fake Codex app-server without waiting for it, and the
// process runs in the test's temporary directory. On Windows that directory stays locked until
// the process exits, so a bare rmSync in the cleanup failed with EBUSY and ejected a queue run.
describe("tests that start a Codex app-server (#2161)", () => {
  test("remove their directories with removeTempDir, not a bare rmSync", () => {
    const offenders = readdirSync(join(import.meta.dir))
      .filter((name) => /\.test\.tsx?$/.test(name))
      .filter((name) => {
        const text = readFileSync(join(import.meta.dir, name), "utf8");
        return /startCodexAppServerSession\(/.test(text) && /\brmSync\(/.test(text);
      });
    expect(offenders).toEqual([]);
  });
});

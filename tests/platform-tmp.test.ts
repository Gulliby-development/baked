import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { longPath, tmpDir } from "../src/core/platform/index.js";

const SHORT = "C:\\Users\\ILYAMY~1\\AppData\\Local\\Temp";
const LONG = "C:\\Users\\IlyaMyalik\\AppData\\Local\\Temp";

describe("tmpDir is the long temp path on Windows (#1999)", () => {
  test("a short Windows path resolves to its long form", () => {
    const real = (path: string) => (path === SHORT ? LONG : path);
    expect(longPath(SHORT, true, real)).toBe(LONG);
    expect(longPath(SHORT, true, real).split("\\").some((part) => part.includes("~"))).toBe(false);
  });

  test("a path that cannot be resolved is kept, and other platforms keep the path as given", () => {
    const fail = () => {
      throw new Error("ENOENT");
    };
    expect(longPath(SHORT, true, fail)).toBe(SHORT);
    expect(longPath("/tmp", false, () => "/private/tmp")).toBe("/tmp");
  });

  test.skipIf(process.platform !== "win32")("with a short TEMP, tmpDir has no ~ segment", () => {
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    // The 8.3 alias of the current temp directory, as cmd prints it.
    const short = spawnSync("cmd", ["/d", "/c", `for %I in ("${tmpDir()}") do @echo %~sI`], {
      encoding: "utf8",
    }).stdout.trim();
    try {
      process.env.TEMP = short;
      process.env.TMP = short;
      expect(tmpDir().split("\\").some((part) => part.includes("~"))).toBe(false);
    } finally {
      process.env.TEMP = saved.TEMP;
      process.env.TMP = saved.TMP;
    }
  });
});

/**
 * Files that make a scratch directory under os.tmpdir() and never run a program with it as the
 * cwd: a program there only gets files by absolute path, or the directory holds an index or a
 * database the host opens itself.
 */
const ALLOWED: Record<string, string> = {
  "src/core/verification/repro.ts": "input files passed by absolute path; the cwd is the run root",
  "src/core/intelligence/call-context.ts": "copies handed to tree-sitter by path",
  "src/core/workflows/worktree.ts": "a temporary GIT_INDEX_FILE; git runs in the worktree",
  "src/core/workflows/delivery.ts": "a temporary GIT_INDEX_FILE; git runs in the workspace",
  "src/core/workflows/trace.ts": "SQLite copies the host opens itself",
  "src/core/llm/providers/codex/runner.ts": "schema and image files passed by absolute path",
};

describe("scratch directories that become a program's cwd use tmpDir (#1999)", () => {
  test("no file outside the allowlist makes a scratch directory under os.tmpdir()", () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const path of new Bun.Glob("src/core/**/*.ts").scanSync({ cwd: root })) {
      const file = path.replaceAll("\\", "/");
      const text = readFileSync(join(root, path), "utf8");
      if (!/mkdtemp(?:Sync)?\(\s*join\(\s*tmpdir\(\)/.test(text)) continue;
      seen.add(file);
      if (!(file in ALLOWED)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // An allowlisted file that no longer needs its entry is dropped from the list.
    expect(Object.keys(ALLOWED).filter((file) => !seen.has(file))).toEqual([]);
  });
});

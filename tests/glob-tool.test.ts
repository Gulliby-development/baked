import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForbidden } from "../src/core/security/forbidden.js";
import { globMatcher, globTool } from "../src/core/tools/glob.js";

const TMP = join(tmpdir(), `glob-tool-${String(process.pid)}-${String(Date.now())}`);

function touch(rel: string, ageSeconds: number): void {
  const path = join(TMP, rel);
  writeFileSync(path, "x\n");
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(path, t, t);
}

beforeAll(() => {
  mkdirSync(join(TMP, "src", "a"), { recursive: true });
  mkdirSync(join(TMP, "docs"), { recursive: true });
  touch("src/y.ts", 30);
  touch("src/a/x.ts", 20);
  touch("src/a/z.test.ts", 10);
  touch("docs/readme.md", 5);
  touch("docs/secrets.json", 5);
  touch(".hidden.ts", 5);
  touch("src/gen.ts", 5);
  writeFileSync(join(TMP, ".gitignore"), "src/gen.ts\n");
  spawnSync("git", ["init", "-q"], { cwd: TMP });
  initForbidden(TMP);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const list = async (pattern: string) =>
  (await globTool.execute({ pattern, path: TMP })).output
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(TMP.length + 1).replaceAll("\\", "/"));

describe("glob tool", () => {
  // fd --glob and find -name match only the base name: every pattern with a slash, including
  // the documented '**/*.ts', listed nothing.
  it("matches the documented patterns that hold a slash", async () => {
    expect((await list("**/*.ts")).sort()).toEqual(["src/a/x.ts", "src/a/z.test.ts", "src/y.ts"]);
    expect(await list("src/**/*.test.*")).toEqual(["src/a/z.test.ts"]);
    expect((await list("src/a/*.ts")).sort()).toEqual(["src/a/x.ts", "src/a/z.test.ts"]);
  });

  it("matches a slash-free pattern at any depth, newest first", async () => {
    expect(await list("*.ts")).toEqual(["src/a/z.test.ts", "src/a/x.ts", "src/y.ts"]);
  });

  it("skips hidden, gitignored and forbidden files", async () => {
    const all = await list("*.{ts,json,md}");
    expect(all).not.toContain(".hidden.ts");
    expect(all).not.toContain("src/gen.ts");
    expect(await list("docs/*")).toEqual(["docs/readme.md"]);
  });

  it("reports no match plainly", async () => {
    expect((await globTool.execute({ pattern: "**/*.rs", path: TMP })).output).toBe(
      "No files found.",
    );
  });

  it("accepts Windows separators and a leading ./ in the pattern", () => {
    expect(globMatcher("src\\a\\*.ts")("src\\a\\x.ts")).toBe(true);
    expect(globMatcher("./src/**/*.ts")("src/a/x.ts")).toBe(true);
    expect(globMatcher("src/*.ts")("src/a/x.ts")).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoFormatAfterEdit, resetFormatCache } from "../src/core/tools/auto-format.js";
import { formatFile, formatRoot } from "../src/core/tools/project.js";

const root = mkdtempSync(join(tmpdir(), "baked-format-root-"));
const nodeModules = join(import.meta.dir, "..", "node_modules");

// Other test files in the same process turn post-edit formatting off.
beforeAll(() => resetFormatCache());

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A checkout with Biome; `gitFile` makes `.git` a file, as in a linked worktree. */
function checkout(dir: string, gitFile: boolean): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  if (gitFile) writeFileSync(join(dir, ".git"), "gitdir: elsewhere\n");
  else mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".gitignore"), ".baked/\n");
  writeFileSync(join(dir, "bun.lock"), "");
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(
    join(dir, "biome.json"),
    JSON.stringify({ vcs: { enabled: true, clientKind: "git", useIgnoreFile: true } }),
  );
  symlinkSync(nodeModules, join(dir, "node_modules"), "junction");
}

describe("formatting a file in a task worktree", () => {
  const main = join(root, "main");
  const task = join(main, ".baked", "worktrees", "run", "main");
  checkout(main, false);
  checkout(task, true);

  it("finds the checkout that holds the file", () => {
    expect(formatRoot(join(task, "src", "a.ts"))).toBe(task);
    expect(formatRoot(join(main, "src", "a.ts"))).toBe(main);
  });

  // Runs Biome twice. Its first start through `bunx` on a loaded Windows runner took over the
  // 30 s a format gets after an edit (#1177, #2265); this test is about the root it formats from,
  // so the first run gets the room of a cold start, and the second one is warm.
  it("formats from the worktree even when called from the main checkout", async () => {
    const file = join(task, "src", "a.ts");
    writeFileSync(file, "export const a = {b:1}\n");
    expect(await formatFile(file, undefined, 80_000)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("export const a = { b: 1 };\n");

    const edited = join(task, "src", "b.ts");
    writeFileSync(edited, "export const b = {c:2}\n");
    expect(await autoFormatAfterEdit(edited, undefined, null)).toBe(true);
    expect(readFileSync(edited, "utf8")).toBe("export const b = { c: 2 };\n");
  }, 150_000);
});

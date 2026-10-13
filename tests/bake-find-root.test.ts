import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeFindTool } from "../src/core/tools/bake-find";

const dirs: string[] = [];
function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "bake-find-root-"));
  dirs.push(root);
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x");
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bake_find root", () => {
  test("searches the given root, not the project directory", async () => {
    const worktree = tree(["src/shortener.ts"]);
    const result = await bakeFindTool.createExecute(undefined, worktree)({ query: "shortener" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("src/shortener.ts");
    expect(result.output).not.toContain("..");
  });

  test("leaves BAKED's own .baked state out of the results", async () => {
    const root = tree([
      ".baked/workflows.sqlite",
      ".baked/worktrees/run-1/workflows.ts",
      "src/workflows.ts",
    ]);
    const result = await bakeFindTool.createExecute(undefined, root)({ query: "workflows" });
    expect(result.output).toContain("src/workflows.ts");
    expect(result.output).not.toContain(".baked");
  });
});

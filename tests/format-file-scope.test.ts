import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFile } from "../src/core/tools/project.js";

const root = mkdtempSync(join(tmpdir(), "baked-format-scope-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("formatFile", () => {
  it("does not run a directory-wide format script for a single file", async () => {
    // The script would rewrite every file under src/ if a path were appended to it.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "bun.lock"), "");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          format: `bun -e "require('fs').writeFileSync('src/other.ts', 'rewritten')" src/`,
        },
      }),
    );
    writeFileSync(join(root, "src", "edited.ts"), "export const a = 1;\r\n");
    writeFileSync(join(root, "src", "other.ts"), "export const b = 2;\r\n");

    expect(await formatFile(join(root, "src", "edited.ts"), root)).toBe(false);
    expect(readFileSync(join(root, "src", "other.ts"), "utf8")).toBe("export const b = 2;\r\n");
  });
});

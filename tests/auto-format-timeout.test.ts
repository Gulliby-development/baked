import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoFormatAfterEdit, resetFormatCache, setFormatCache } from "../src/core/tools/auto-format.js";

// Sibling-bug audit (#1429): #1238 gave `formatFile` 30 s for a formatter's slow first start on
// Windows, while the format after an edit ran the same command with 5 s and failed silently.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("autoFormatAfterEdit", () => {
  it("waits for a formatter whose first start takes over five seconds", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-auto-format-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "edited.ts");
    writeFileSync(file, "export const a = 1;\n");
    // A formatter that starts slowly, then rewrites the file it is given.
    setFormatCache(`bun -e "await Bun.sleep(5500); require('fs').writeFileSync(process.argv.at(-1), 'formatted')"`);
    cleanups.push(resetFormatCache);
    expect(await autoFormatAfterEdit(file, root, null)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("formatted");
  }, 30_000);
});

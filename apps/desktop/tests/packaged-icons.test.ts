import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("packaged icons", () => {
  test("every icon the main process loads from build/ ships in the app", () => {
    const builder = readFileSync(join(root, "electron-builder.yml"), "utf8").split(/\r?\n/);
    const main = join(root, "src", "main");
    const loaded = new Set<string>();
    for (const file of readdirSync(main).filter((name) => name.endsWith(".ts")))
      for (const match of readFileSync(join(main, file), "utf8").matchAll(/"([\w@-]+\.png)"/g))
        if (match[1]) loaded.add(match[1]);
    expect([...loaded]).toContain("icon.png");
    for (const name of loaded) expect(builder).toContain(`  - build/${name}`);
  });
});

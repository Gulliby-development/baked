import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// #2266: OpenTUI's input parser holds a lone Escape for 20 ms to tell it apart from an escape
// sequence. A test that pressed Escape and only flushed renders saw the popup still open when the
// flushes took under 20 ms; a key pressed right after it reads as Alt+key. Every mock Escape
// waits past the hold (a `Bun.sleep` on its line or the next, or a `press` helper that sleeps).
describe("mock Escape presses in UI tests (#2266)", () => {
  test("wait past the parser's hold before the next render or key", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(import.meta.dir, { recursive: true }) as string[]) {
      if (!/\.(test\.)?tsx?$/.test(name) || name.endsWith("mock-escape-settle.test.ts")) continue;
      const lines = readFileSync(join(import.meta.dir, name), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("pressEscape(")) return;
        const settled = /Bun\.sleep\(/.test(line) || /Bun\.sleep\(/.test(lines[i + 1] ?? "") || /\bpress\(view/.test(line);
        if (!settled) offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

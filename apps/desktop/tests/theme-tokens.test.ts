import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = join(import.meta.dir, "..", "src", "renderer", "styles");
const tokens = readFileSync(join(styles, "tokens.css"), "utf8");
const entry = readFileSync(join(styles, "index.css"), "utf8");

function block(selector: string): string {
  const start = tokens.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  return tokens.slice(start, tokens.indexOf("}", start));
}

function defined(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ""));
}

describe("theme tokens", () => {
  const dark = defined(block(':root[data-theme="dark"]'));
  const light = defined(block(':root[data-theme="light"]'));
  const shared = defined(tokens);

  test("both themes define the same colour tokens", () => {
    expect([...dark].sort()).toEqual([...light].sort());
  });

  test("every token the Tailwind theme maps to is defined", () => {
    const theme = entry.slice(entry.indexOf("@theme inline"));
    const used = [...theme.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1] ?? "");
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(shared.has(name)).toBe(true);
  });
});

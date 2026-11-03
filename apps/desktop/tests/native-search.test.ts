import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = join(import.meta.dir, "..", "src", "renderer", "styles");
const base = readFileSync(join(styles, "base.css"), "utf8");
const tokens = readFileSync(join(styles, "tokens.css"), "utf8");

function rule(selector: string): string {
  const start = base.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return base.slice(start, base.indexOf("}", start));
}

// A search field's clear button drops Chromium's blue cross (#2676).
describe("native search clear button", () => {
  test("base.css replaces it with a cross painted in the text colour", () => {
    const cancel = rule('input[type="search"]::-webkit-search-cancel-button');
    expect(cancel).toContain("appearance: none");
    expect(cancel).toContain("background: currentColor");
    expect(cancel).toContain("var(--cross)");
    expect(base).toContain('input[type="search"]::-webkit-search-cancel-button:hover');
    expect(tokens).toContain("--cross:");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const renderer = join(import.meta.dir, "..", "src", "renderer");
const base = readFileSync(join(renderer, "styles", "base.css"), "utf8");

function rule(selector: string): string {
  const start = base.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return base.slice(start, base.indexOf("}", start));
}

// Radio buttons drop the platform look like checkboxes do (#2675).
describe("native radio buttons", () => {
  test("base.css draws a round ink-outlined radio with an accent fill when chosen", () => {
    const radio = rule('input[type="radio"]');
    expect(radio).toContain("appearance: none");
    expect(radio).toContain("border-radius: 50%");
    expect(radio).toContain("var(--ink)");
    expect(rule('input[type="radio"]:checked')).toContain("var(--fill-accent)");
    expect(base).toContain('input[type="radio"]:focus-visible');
    expect(base).toContain('input[type="radio"]:disabled');
  });
});

import { describe, expect, test } from "bun:test";
import { annotations, ownLimit, slowTests } from "../scripts/slow-tests.js";

// The guard #1589 asked for and #1656 adds to CI: Windows merge-queue runs timed out at 18 to 41 s
// against a 30 s limit, and nothing showed the tests growing into it before they ejected PRs.

const source = [
  'import { test } from "bun:test";',
  'test("fast", () => {});',
  'test("own limit", async () => {',
  '  const text = "a ) in a string";',
  "  // and ) in a comment",
  "}, 120_000);",
  'test.skip("plain", async () => {',
  "  await Promise.all([]);",
  "});",
].join("\n");

const xml = (cases: [string, number, number][]) =>
  `<testsuites>${cases.map(([name, line, seconds]) => `<testcase name="${name}" file="tests/a.test.ts" line="${String(line)}" time="${String(seconds)}" />`).join("")}</testsuites>`;

describe("slow-test report (#1656)", () => {
  test("reads a test's own limit from its call, past strings and comments", () => {
    expect(ownLimit(source, 3)).toBe(120_000);
    expect(ownLimit(source, 2)).toBeNull();
    expect(ownLimit(source, 7)).toBeNull();
  });

  test("lists tests above half of their limit, the default or their own, and marks those above 80 percent", () => {
    const slow = slowTests(xml([["fast", 2, 0.2], ["own limit", 3, 70], ["plain", 7, 25]]), 30_000, () => source);
    expect(slow.map((t) => [t.name, t.limitMs, Math.round(t.share * 100)])).toEqual([
      ["plain", 30_000, 83],
      ["own limit", 120_000, 58],
    ]);
    expect(annotations(slow)).toEqual([
      "::error file=tests/a.test.ts,line=7::plain took 25.0 s of its 30 s limit (83 percent)",
      "::warning file=tests/a.test.ts,line=3::own limit took 70.0 s of its 120 s limit (58 percent)",
    ]);
  });

  test("a test whose file cannot be read is measured against the default limit", () => {
    expect(slowTests(xml([["plain", 7, 16]]), 30_000, () => null).map((t) => t.limitMs)).toEqual([30_000]);
  });
});

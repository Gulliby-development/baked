import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIgnoreMatcher, parseIgnore } from "../src/core/intelligence/ignore.js";
import { collectFiles } from "../src/core/intelligence/repo-map-utils.js";

describe("parseIgnore", () => {
  test("drops comments and blanks, preserves rules incl. negations", () => {
    const rules = parseIgnore("# comment\n\n!keep.ts\nbuild/\n");
    // negations are valid gitignore syntax — the engine honors them, so we keep them
    expect(rules).toEqual(["!keep.ts", "build/"]);
  });
});

describe("IgnoreMatcher", () => {
  test("dir/ matches a directory at any depth", () => {
    const m = buildIgnoreMatcher("build/");
    expect(m.ignores("build", true)).toBe(true);
    expect(m.ignores("packages/x/build", true)).toBe(true);
    // dir-only rule must NOT match a file of the same name
    expect(m.ignores("build", false)).toBe(false);
  });

  test("rooted /foo matches only at repo root", () => {
    const m = buildIgnoreMatcher("/dist");
    expect(m.ignores("dist", true)).toBe(true);
    expect(m.ignores("src/dist", true)).toBe(false);
  });

  test("*.ext glob matches by extension at any depth", () => {
    const m = buildIgnoreMatcher("*.log");
    expect(m.ignores("debug.log", false)).toBe(true);
    expect(m.ignores("logs/server.log", false)).toBe(true);
    expect(m.ignores("server.ts", false)).toBe(false);
  });

  test("exact basename matches at any depth", () => {
    const m = buildIgnoreMatcher("secret.key");
    expect(m.ignores("secret.key", false)).toBe(true);
    expect(m.ignores("config/secret.key", false)).toBe(true);
    expect(m.ignores("secret.key.example", false)).toBe(false);
  });

  test("path with slash anchors to that path", () => {
    const m = buildIgnoreMatcher("src/generated");
    expect(m.ignores("src/generated", true)).toBe(true);
    expect(m.ignores("src/generated/api.ts", false)).toBe(true);
    expect(m.ignores("lib/src/generated", true)).toBe(false);
  });

  test("** double-star matches at any depth (gitignore spec)", () => {
    const m = buildIgnoreMatcher("**/temp");
    expect(m.ignores("temp", true)).toBe(true);
    expect(m.ignores("a/b/temp", true)).toBe(true);
  });

  test("negation re-includes a previously ignored path", () => {
    const m = buildIgnoreMatcher("*.log\n!keep.log\n");
    expect(m.ignores("debug.log", false)).toBe(true);
    expect(m.ignores("keep.log", false)).toBe(false);
  });

  test("empty matcher never ignores", () => {
    const m = buildIgnoreMatcher(null, undefined, "");
    expect(m.size).toBe(0);
    expect(m.ignores("anything", true)).toBe(false);
  });

  test("does not ignore real source files", () => {
    const m = buildIgnoreMatcher("node_modules/\ndist/\n*.log\ncoverage/\n");
    expect(m.ignores("src/core/agents/forge.ts", false)).toBe(false);
    expect(m.ignores("src/components/App.tsx", false)).toBe(false);
  });
});

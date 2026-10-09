import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractContentTrigrams,
  extractPatternTrigrams,
  MIN_TRIGRAM_LEN,
} from "../src/core/intelligence/trigram.js";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

describe("trigram extraction", () => {
  test("extracts distinct trigrams from content", () => {
    const tris = extractContentTrigrams("abcd");
    // "abc" and "bcd"
    expect(tris.size).toBe(2);
  });

  test("returns empty for content shorter than 3 chars", () => {
    expect(extractContentTrigrams("ab").size).toBe(0);
  });

  test("is case-insensitive (lowercases)", () => {
    const a = extractContentTrigrams("ABC");
    const b = extractContentTrigrams("abc");
    expect([...a]).toEqual([...b]);
  });

  test("skips all-whitespace trigrams", () => {
    const tris = extractContentTrigrams("a   b");
    // "a  " has a non-ws char, "   " is skipped, "  b" has a non-ws char
    // so only the all-space window is dropped
    expect(tris.size).toBeGreaterThan(0);
    // the pure "   " (3 spaces) trigram must not be present
    const wsOnly = extractContentTrigrams("   ");
    expect(wsOnly.size).toBe(0);
  });

  test("pattern: returns trigrams for a pure literal", () => {
    const tris = extractPatternTrigrams("handleRequest");
    expect(tris).not.toBeNull();
    expect(tris?.length).toBeGreaterThan(0);
  });

  test("pattern: null when literal run too short", () => {
    expect(extractPatternTrigrams("ab")).toBeNull();
    expect(extractPatternTrigrams("a.b")).toBeNull(); // longest literal run = "a" or "b"
  });

  test("pattern: uses longest literal run in a regex", () => {
    // longest literal run is "Request" (7 chars) — should produce trigrams
    const tris = extractPatternTrigrams("handle.*Request");
    expect(tris).not.toBeNull();
    expect(tris?.length).toBeGreaterThanOrEqual(MIN_TRIGRAM_LEN - 1);
  });
});

describe("RepoMap.searchTrigramCandidates", () => {
  const TMP = join(tmpdir(), `trigram-rm-${Date.now()}`);
  let repoMap: RepoMap;

  beforeAll(async () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(
      join(TMP, "src", "alpha.ts"),
      "export function handleRequest() { return uniqueNeedleXYZ(1); }\n",
    );
    writeFileSync(
      join(TMP, "src", "beta.ts"),
      "export function unrelated() { return somethingElse(2); }\n",
    );
    repoMap = new RepoMap(TMP);
    await repoMap.scan();
  });

  afterAll(async () => { await repoMap.close(); rmSync(TMP, { recursive: true, force: true }); });

  test("returns only files containing the literal", () => {
    const candidates = repoMap.searchTrigramCandidates("uniqueNeedleXYZ");
    expect(candidates).not.toBeNull();
    expect(candidates).toContain("src/alpha.ts");
    expect(candidates).not.toContain("src/beta.ts");
  });

  test("returns empty array for a literal in no file", () => {
    const candidates = repoMap.searchTrigramCandidates("zzzAbsentLiteralQQQ");
    expect(candidates).not.toBeNull();
    expect(candidates?.length).toBe(0);
  });

  test("returns null for an un-narrowable short pattern", () => {
    expect(repoMap.searchTrigramCandidates("ab")).toBeNull();
  });

  test("candidate set is a superset — finds shared substrings", () => {
    // "function" appears in both files
    const candidates = repoMap.searchTrigramCandidates("function");
    expect(candidates).not.toBeNull();
    expect(candidates).toContain("src/alpha.ts");
    expect(candidates).toContain("src/beta.ts");
  });
});

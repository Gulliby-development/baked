import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BEFORE_AFTER_PHRASINGS,
  caseCheck,
  criterionCases,
} from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// Bench round 64, mdtoc-update (#2000): the request supplied tests/version.test.ts verbatim, and
// AC-006 read `Only version "0.1.0" -> "0.2.0" and the appended start entry ... differ`. The walk
// demanded `0.1.0`, the manifest's version before the bump, from the test file; T004 reported
// spec_conflict twice and a third session added the literal (784k of the run's 1.28M tokens). The
// left side of a before/after pair in a Then is the state before the change, not a test value.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A Then for each phrasing in `BEFORE_AFTER_PHRASINGS`, by name. */
const THENS: Record<string, string> = {
  "arrow ->": 'only version "0.1.0" -> "0.2.0" and the appended entry differ',
  "arrow =>": 'only version "0.1.0" => "0.2.0" and the appended entry differ',
  "arrow →": 'only version "0.1.0" → "0.2.0" and the appended entry differ',
  "from ... to": 'the manifest version is bumped from "0.1.0" to "0.2.0"',
  becomes: 'the version "0.1.0" becomes "0.2.0" in the manifest',
};

/** A test file of each language that spells the new version only. */
const LANGUAGES: [string, string, string][] = [
  ["csharp", "tests/App.Tests/VersionTests.cs", '[Fact] public void Bumped() { Assert.Equal("0.2.0", App.Version); }'],
  ["go", "version_test.go", 'func TestBumped(t *testing.T) { if Version != "0.2.0" { t.Fatal(Version) } }'],
  ["java", "src/test/java/app/VersionTest.java", 'class VersionTest { @Test void bumped() { assertEquals("0.2.0", App.VERSION); } }'],
  ["python", "tests/test_version.py", 'def test_bumped():\n    assert app.VERSION == "0.2.0"\n'],
  ["typescript", "tests/version.test.ts", 'test("bumped", () => { expect(version).toBe("0.2.0"); });'],
];

const criterion = (then: string, given = "the project at its released state") => ({
  id: "AC-006",
  requirementIds: ["FR-001"],
  given,
  when: "the change is applied",
  then,
  method: "automated" as const,
});

const walk = async (spec: Pick<Spec, "criteria">, path: string, text: string) => {
  const task = { id: "T004", criterionIds: ["AC-006"], writes: [{ path, action: "create" as const }] };
  const root = mkdtempSync(join(tmpdir(), "baked-case-before-after-"));
  roots.push(root);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  const check = caseCheck(spec, task, { checks: [] });
  if (!check) throw new Error("no case walk");
  return check(root);
};

const literals = (then: string, given?: string) =>
  criterionCases({ criteria: [criterion(then, given)] }, { criterionIds: ["AC-006"] }, { checks: [] }).map(
    (c) => c.literal,
  );

describe("the state before a change in a Then is context, not a case (#2000)", () => {
  test("every phrasing of the list has its case here", () => {
    expect(BEFORE_AFTER_PHRASINGS.map((p) => p.name).sort()).toEqual(Object.keys(THENS).sort());
  });

  for (const phrasing of BEFORE_AFTER_PHRASINGS) {
    const then = THENS[phrasing.name] ?? "";
    test(`${phrasing.name}: only the new value is a case`, () => {
      expect(literals(then)).toEqual(["0.2.0"]);
    });
    for (const [language, path, text] of LANGUAGES)
      test(`${phrasing.name}, ${language}`, async () => {
        expect(await walk({ criteria: [criterion(then)] }, path, text)).toEqual([]);
        // The new value is still demanded.
        const refused = await walk({ criteria: [criterion(then)] }, path, text.replace("0.2.0", "0.3.0"));
        expect(refused).toHaveLength(1);
        expect(refused[0]).toStartWith('AC-006 names "0.2.0"');
      });
  }
});

describe("a quoted value that is an input is still a case (#2000)", () => {
  test("a version the Given quotes as the input", () => {
    expect(literals('it prints "0.2.0"', 'the version "0.1.0"')).toEqual(["0.1.0", "0.2.0"]);
  });

  test("a transformation of an input, a range and a mapping with no change word", () => {
    expect(literals('the input "Hello World 2" becomes "hello-world-2"')).toEqual(["Hello World 2", "hello-world-2"]);
    expect(literals('it lists the entries from "2024-01-01" to "2024-01-31"')).toEqual([
      "2024-01-01",
      "2024-01-31",
    ]);
    expect(literals('"x1" -> "y1" and "x2" -> "y2"')).toEqual(["x1", "y1", "x2", "y2"]);
  });

  test("a before/after pair outside the Then keeps both sides", () => {
    const spec = {
      criteria: [{ ...criterion('it prints "done"'), when: 'the version is bumped from "0.1.0" to "0.2.0"' }],
    };
    expect(criterionCases(spec, { criterionIds: ["AC-006"] }, { checks: [] }).map((c) => c.literal)).toEqual([
      "0.1.0",
      "0.2.0",
      "done",
    ]);
  });

  for (const [language, path, text] of LANGUAGES)
    test(`a Given input is demanded, ${language}`, async () => {
      const refused = await walk({ criteria: [criterion('it prints "0.2.0"', 'the version "0.1.0"')] }, path, text);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toStartWith('AC-006 names "0.1.0"');
    });
});

describe("scenario: the R64 mdtoc-update T004 walk (#2000)", () => {
  // The request's tests/version.test.ts, as supplied: it never spells the old version.
  const SUPPLIED = [
    'import { describe, expect, test } from "bun:test";',
    'import pkg from "../package.json";',
    'describe("version", () => {',
    '  test("package version is 0.2.0", () => { expect(pkg.version).toBe("0.2.0"); });',
    '  test("the start script reports the version", () => { expect(start()).toContain("0.2.0"); });',
    "});",
  ].join("\n");
  const spec = {
    criteria: [
      criterion(
        'Only version "0.1.0" -> "0.2.0" and the appended start entry ... differ from the baseline manifest.',
        "the baseline package.json at version 0.1.0",
      ),
    ],
  };

  test("the supplied test file passes the walk as written", async () => {
    expect(await walk(spec, "tests/version.test.ts", SUPPLIED)).toEqual([]);
  });

  test("a test file without the new version is still refused for it", async () => {
    const refused = await walk(spec, "tests/version.test.ts", SUPPLIED.replaceAll("0.2.0", "0.3.0"));
    expect(refused.map((line) => line.split(",")[0])).toEqual(['AC-006 names "0.2.0"']);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isNoRow,
  type LanguageRecord,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../src/core/intelligence/language-records.js";
import {
  isManifestFile,
  isTestContent,
  isTestFile,
  MANIFEST_NAMES,
  TEST_CONVENTIONS,
  TEST_MARKERS,
} from "../src/core/intelligence/language-traits.js";
import { detectLanguageFromPath } from "../src/core/intelligence/types.js";
import {
  failureSignature,
  TEST_RUNNERS,
  testCount,
} from "../src/core/verification/output-counts.js";
import { ENTRY_POINTS, projectEntryPoints } from "../src/core/verification/entry-points.js";
import { detectGates, GATE_TOOLCHAINS } from "../src/core/workflows/gates.js";
import { PLACEHOLDERS } from "../src/core/workflows/quality/builtin-rules.js";
import { DEPENDENCY_MANIFESTS, manifestDependencies } from "../src/core/workflows/quality/manifests.js";
import { detectMutationTool, MUTATION_TOOLS } from "../src/core/workflows/quality/mutation-tools.js";
import { PROPERTY_LIBRARIES, propertyTestKind } from "../src/core/workflows/quality/properties.js";
import { checkBuiltinRules } from "../src/core/workflows/quality/rules.js";
import { INLINE_HARNESS, inlineRowFile } from "../src/core/workflows/acceptance-rows-inline.js";
import { TEST_GATES, testGateFlags } from "../src/core/workflows/test-gates.js";
import { TaskSchema } from "../src/core/workflows/schemas.js";

// Language parity (#1717): every language-bound record has a row for every supported language,
// and every row is exercised by the language's fixture project in `tests/fixtures/languages/`.
// A fixture's `expected` holds the golden output of each record's function over its files:
// `null` where the record's row is `none(reason)`, a non-empty list where the row has data.

type Files = Record<string, string>;
interface Fixture {
  files: Files;
  /** Check output the language's test runner prints: a failing run, and the same run with one more passing test. */
  outputs?: { tests: string; testsGrown: string };
  expected: Record<string, string[] | null>;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The fixture's files in a temporary directory, for code that reads a workspace. */
function workspace(files: Files): string {
  const root = mkdtempSync(join(tmpdir(), "baked-language-parity-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const ofLanguage = (language: SupportedLanguage, files: Files) =>
  Object.entries(files).filter(([path]) => detectLanguageFromPath(path) === language);

/** The language-bound records and the public function that reads each, over a fixture's files. */
const RECORDS: Record<
  string,
  {
    record: LanguageRecord<unknown>;
    run: (language: SupportedLanguage, fixture: Fixture) => string[];
    /** Outputs a row with data must never give, whatever its golden says. */
    never?: string[];
  }
> = {
  tests: {
    record: TEST_CONVENTIONS,
    run: (language, { files }) =>
      Object.keys(files).filter((path) => detectLanguageFromPath(path) === language && isTestFile(path)),
  },
  // The fixture's test files that hold a test marker, and its source files named like a test that
  // hold none, which are not tests (#1848).
  testMarkers: {
    record: TEST_MARKERS,
    run: (language, { files }) =>
      ofLanguage(language, files)
        .filter(([path]) => isTestFile(path))
        .map(([path, text]) => `${path}: ${isTestContent(path, text) ? "test" : "source"}`),
  },
  manifests: {
    record: MANIFEST_NAMES,
    run: (_, { files }) => Object.keys(files).filter(isManifestFile),
  },
  dependencies: {
    record: DEPENDENCY_MANIFESTS,
    run: (_, { files }) =>
      Object.entries(files).flatMap(([path, text]) =>
        manifestDependencies(path, text).map((d) => `${d.file}: ${d.ecosystem} ${d.name}`),
      ),
  },
  placeholders: {
    record: PLACEHOLDERS,
    run: (language, { files }) =>
      checkBuiltinRules(
        Object.entries(files)
          .filter(([path]) => detectLanguageFromPath(path) === language)
          .map(([path, content]) => ({ path, content, before: null })),
        {},
      )
        .filter((finding) => finding.rule === "placeholder-body")
        .map((finding) => `${finding.file}:${finding.line}`),
  },
  gates: {
    record: GATE_TOOLCHAINS,
    run: (_, { files }) => detectGates(workspace(files)).map((s) => s.check.id),
  },
  entryPoints: {
    record: ENTRY_POINTS,
    run: (_, { files }) =>
      projectEntryPoints(workspace(files)).map((e) => `${e.name}: ${e.launcher.join(" ")}`),
  },
  testRunners: {
    record: TEST_RUNNERS,
    // The runner's count, and whether the failure signature ignores one more passing test (#1425).
    run: (_, { outputs }) => {
      if (!outputs) return [];
      const count = testCount(outputs.tests);
      const stable =
        failureSignature(outputs.tests, "/repo") === failureSignature(outputs.testsGrown, "/repo");
      return [count ? `${count.tool} ${count.count}` : "no count", stable ? "signature stable" : "signature changed"];
    },
    never: ["no count", "signature changed"],
  },
  // The gate flags a gated test file of the language gets in its written-tests check (#1832).
  testGates: {
    record: TEST_GATES,
    run: (language, { files }) =>
      [...testGateFlags(ofLanguage(language, files).map(([path, text]) => ({ path, text })))].map(
        ([program, flags]) => `${program} ${flags.join(" ")}`,
      ),
  },
  mutation: {
    record: MUTATION_TOOLS,
    // Every tool counts as installed, so the record alone decides which one the files get.
    run: (language, { files }) => {
      const found = detectMutationTool(
        ofLanguage(language, files).map(([path, content]) => ({ path, content, before: null })),
        {
          root: "/repo",
          scratch: "/scratch",
          platform: "linux",
          run: async () => ({ exitCode: 0, output: "", timedOut: false }),
          read: (path) => files[path] ?? "pitest-maven info.solidsoft.pitest",
          exists: () => true,
          remove: () => {},
          which: (command) => `/usr/bin/${command}`,
          now: () => 0,
        },
      );
      return found ? [`${found.tool}: ${found.files.map((f) => f.path).join(", ")}`] : [];
    },
  },
  properties: {
    record: PROPERTY_LIBRARIES,
    run: (language, { files }) =>
      ofLanguage(language, files).flatMap(([path, content]) => {
        const kind = propertyTestKind(path, content);
        return kind ? [`${path}: ${kind}`] : [];
      }),
  },
};

const dir = join(import.meta.dir, "fixtures", "languages");
const fixture = (language: string): Fixture =>
  JSON.parse(readFileSync(join(dir, `${language}.json`), "utf8")) as Fixture;

test("every supported language has a fixture project, and every fixture a supported language", () => {
  const fixtures = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  expect(fixtures).toEqual([...SUPPORTED_LANGUAGES].sort());
});

for (const language of SUPPORTED_LANGUAGES)
  describe(`language parity: ${language}`, () => {
    for (const [name, { record, run, never = [] }] of Object.entries(RECORDS))
      test(name, () => {
        const data = fixture(language);
        const golden = data.expected?.[name];
        const actual = run(language, data);
        const row = record[language];
        // A missing golden prints what the record gives, ready to paste into the fixture.
        expect({ [name]: golden === undefined ? "missing" : golden }).toEqual({
          [name]: isNoRow(row) ? null : actual,
        });
        if (isNoRow(row)) return;
        expect(actual.length).toBeGreaterThan(0);
        for (const output of never) expect(actual).not.toContain(output);
      });
  });

// #1763: every acceptance-rows framework has both modes, and the inline block needs no file or
// dependency the brief may forbid: only the language's standard library and its test framework.
describe("acceptance rows: every framework has the file and the inline mode (#1763)", () => {
  const frameworks = TaskSchema.shape.rowTest.unwrap().options[0].shape.framework.options;
  test.each(frameworks.map((framework) => [framework]))("%s", (framework) => {
    expect(INLINE_HARNESS[framework]).toBeTruthy();
    const pkg = framework === "go" ? "calc" : framework === "junit" ? "com.ex.calc" : "Calc.Tests";
    const test = { bun: "tests/a.test.ts", pytest: "tests/test_a.py", go: "calc/a_test.go", junit: "src/test/java/com/ex/calc/ATest.java", rust: "tests/a.rs", xunit: "Calc.Tests/ATest.cs" }[framework];
    const file = inlineRowFile({ mode: "inline", framework, test, package: pkg }, [{ id: "AC-001:1", criterionId: "AC-001", input: 1, expected: 2, source: "1 | 2" }]);
    expect(file.tail).toContain(INLINE_HARNESS[framework]);
    expect(file.tail).not.toMatch(/serde_json|import junit|org\.json|Newtonsoft/);
  });
});

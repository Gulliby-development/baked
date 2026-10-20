import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isNoRow,
  type LanguageRecord,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../src/core/intelligence/language-records.js";
import {
  isManifestFile,
  isTestFile,
  MANIFEST_NAMES,
  TEST_CONVENTIONS,
} from "../src/core/intelligence/language-traits.js";
import { detectLanguageFromPath } from "../src/core/intelligence/types.js";
import { PLACEHOLDERS } from "../src/core/workflows/quality/builtin-rules.js";
import { DEPENDENCY_MANIFESTS, manifestDependencies } from "../src/core/workflows/quality/manifests.js";
import { checkBuiltinRules } from "../src/core/workflows/quality/rules.js";

// Language parity (#1717): every language-bound record has a row for every supported language,
// and every row is exercised by the language's fixture project in `tests/fixtures/languages/`.
// A fixture's `expected` holds the golden output of each record's function over its files:
// `null` where the record's row is `none(reason)`, a non-empty list where the row has data.

type Files = Record<string, string>;
interface Fixture {
  files: Files;
  expected: Record<string, string[] | null>;
}

/** The language-bound records and the public function that reads each, over a fixture's files. */
const RECORDS: Record<
  string,
  { record: LanguageRecord<unknown>; run: (language: SupportedLanguage, files: Files) => string[] }
> = {
  tests: {
    record: TEST_CONVENTIONS,
    run: (language, files) =>
      Object.keys(files).filter((path) => detectLanguageFromPath(path) === language && isTestFile(path)),
  },
  manifests: {
    record: MANIFEST_NAMES,
    run: (_, files) => Object.keys(files).filter(isManifestFile),
  },
  dependencies: {
    record: DEPENDENCY_MANIFESTS,
    run: (_, files) =>
      Object.entries(files).flatMap(([path, text]) =>
        manifestDependencies(path, text).map((d) => `${d.file}: ${d.ecosystem} ${d.name}`),
      ),
  },
  placeholders: {
    record: PLACEHOLDERS,
    run: (language, files) =>
      checkBuiltinRules(
        Object.entries(files)
          .filter(([path]) => detectLanguageFromPath(path) === language)
          .map(([path, content]) => ({ path, content, before: null })),
        {},
      )
        .filter((finding) => finding.rule === "placeholder-body")
        .map((finding) => `${finding.file}:${finding.line}`),
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
    for (const [name, { record, run }] of Object.entries(RECORDS))
      test(name, () => {
        const { files, expected } = fixture(language);
        const golden = expected?.[name];
        const actual = run(language, files);
        const row = record[language];
        // A missing golden prints what the record gives, ready to paste into the fixture.
        expect({ [name]: golden === undefined ? "missing" : golden }).toEqual({
          [name]: isNoRow(row) ? null : actual,
        });
        if (!isNoRow(row)) expect(actual.length).toBeGreaterThan(0);
      });
  });

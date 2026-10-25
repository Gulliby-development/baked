import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LanguageRecord, none, rowOf, SUPPORTED_LANGUAGES } from "./language-records.js";
import { detectLanguageFromPath, type Language } from "./types.js";

/**
 * Test files by each language's own naming, beyond the shared conventions (a test directory,
 * `name.test.ext` or `name.spec.ext`), one row per supported language (#1488, #1717).
 */
export const TEST_CONVENTIONS: LanguageRecord<RegExp> = {
  typescript: none("the shared `name.test.ts`, `name.spec.ts` and test directories cover it"),
  javascript: none("the shared `name.test.js`, `name.spec.js` and test directories cover it"),
  // Django's `startapp` puts an app's tests in `tests.py` (#1683).
  python: /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest|tests)\.py$/i,
  go: /_test\.go$/i,
  // A `#[cfg(test)] mod tests;` module file, and `name_tests.rs` beside its source (#1683).
  rust: /(?:^|\/)tests\.rs$|_tests?\.rs$/,
  java: /(?:Tests?|IT)\.java$/,
  kotlin: /(?:Tests?|IT|Spec)\.kts?$/,
  scala: /(?:Tests?|Spec|Suite)\.scala$/,
  // Every file of a test project (`App.Tests/`, `App.UnitTests/`), whatever its class is called (#1683).
  csharp:
    /Tests?\.cs$|(?:^|\/)[^/]+\.(?:Unit|Integration|Functional|Acceptance|E2E)?Tests?\/(?:[^/]+\/)*[^/]+\.cs$/,
  c: /(?:^|\/)test_[^/]*\.c$|_test\.c$/i,
  cpp: /(?:^|\/)test_[^/]*\.(?:cc|cpp|cxx)$|_(?:unit)?test\.(?:cc|cpp|cxx)$/i,
  ruby: /_(?:spec|test)\.rb$|(?:^|\/)test_[^/]*\.rb$/i,
  php: /Test\.php$/,
  swift: /Tests?\.swift$/,
  lua: /_(?:spec|test)\.luau?$|(?:^|\/)test_[^/]*\.luau?$/i,
  elixir: /_test\.exs?$/i,
  dart: /_test\.dart$/i,
  zig: /_test\.zig$/i,
  bash: /_test\.(?:sh|bash)$/i,
  ocaml: none("dune keeps tests in a `test/` directory, which the shared rule covers"),
  objc: /Tests?\.mm?$/,
  vue: none("Vue components are tested from `.spec.ts` or `.test.ts` files"),
  svelte: none("Svelte components are tested from `.spec.ts` or `.test.ts` files"),
  rescript: /_test\.resi?$|Test\.resi?$/,
  solidity: /\.t\.sol$/,
  // pgTAP and dbt keep tests in a `test/` or `tests/` directory (the shared rule); a file of its
  // own is `test_name.sql` or `name_test.sql`.
  sql: /(?:^|\/)test_[^/]*\.sql$|_test\.sql$/i,
  powershell: /\.Tests\.ps1$/i,
};

/**
 * What a test file of each language holds (a test attribute, a test function, a test framework's
 * import), one row per supported language. A name convention of `TEST_CONVENTIONS` that is a plain
 * word (`PermTest.cs`, `FeatureSpec.kt`, `abtest_test.c`) also names domain code, so an existing
 * file outside a test directory counts as a test only when it holds one of these (#1848: modeplan,
 * bench round 57, a `find -perm` stub `PermTest.cs` was read-only for its own implementer). `none`
 * where the name alone is the language's rule.
 */
export const TEST_MARKERS: LanguageRecord<RegExp> = {
  typescript: none("only the dotted `.test.` and `.spec.` suffixes name tests, never a plain word"),
  javascript: none("only the dotted `.test.` and `.spec.` suffixes name tests, never a plain word"),
  python:
    /\b(?:pytest|unittest|django\.test|hypothesis)\b|^\s*(?:async\s+)?def test_|^\s*class Test/m,
  go: none("the compiler builds `_test.go` files only into tests"),
  rust: /#\[(?:[\w:]+::)?test\b|#\[cfg\(test\)\]|#\[rstest\b/,
  java: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b|\borg\.(?:junit|testng)\b/,
  kotlin:
    /@(?:Test|ParameterizedTest)\b|\b(?:org\.junit|io\.kotest|kotlin\.test|org\.spekframework)\b/,
  scala: /\b(?:org\.scalatest|munit|utest|zio\.test|org\.specs2|weaver)\b|@Test\b/,
  csharp:
    /\[(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod|TestClass|TestFixture)\b|\busing\s+(?:Xunit|NUnit|Microsoft\.VisualStudio\.TestTools)\b/,
  c: /\b(?:START_TEST|TEST_ASSERT\w*|ck_assert\w*|CU_\w+|munit_\w+|cmocka_\w+|assert)\b|\bTEST(?:_F|_P)?\s*\(/,
  cpp: /\b(?:TEST(?:_F|_P|_CASE)?|BOOST_AUTO_TEST_CASE|SECTION|EXPECT_\w+|ASSERT_\w+|assert)\b|<(?:gtest|catch2|doctest)\b/,
  ruby: /\b(?:RSpec|Minitest|Test::Unit|describe|context)\b|^\s*(?:it|test)\s*[("']|^\s*def test_/m,
  php: /\b(?:PHPUnit|TestCase)\b|#\[Test\]|@test\b|function\s+test\w*\s*\(|^\s*(?:it|test)\s*\(/m,
  swift: /\bimport\s+(?:XCTest|Testing)\b|\bXCTestCase\b|@Test\b|@Suite\b/,
  lua: /\b(?:describe|luaunit|busted|lust)\b|^\s*it\s*\(/m,
  elixir: /\bExUnit\b|^\s*test\s+"/m,
  dart: /package:(?:test|flutter_test)\/|^\s*(?:test|group|testWidgets)\s*\(/m,
  zig: /^\s*test\s*(?:"|\{)/m,
  bash: /\b(?:shunit2|bats|assert\w*)\b|@test\b|^\s*test_\w+\s*\(\)/m,
  ocaml: none("dune keeps tests in a `test/` directory, which the shared rule covers"),
  objc: /\bXCTest(?:Case)?\b|\bXCTAssert\w*/,
  vue: none("Vue components are tested from `.spec.ts` or `.test.ts` files"),
  svelte: none("Svelte components are tested from `.spec.ts` or `.test.ts` files"),
  rescript: /\b(?:Jest|Vitest|Zora|Ava|RescriptMocha)\b|^\s*(?:test|describe|it)\s*\(/m,
  solidity: none("`.t.sol` is Foundry's own rule, never a plain word"),
  // pgTAP's plan and assertions, tSQLt's test classes and assertions.
  sql: /\b(?:plan|no_plan)\s*\(\s*\d*\s*\)|\bselect\s+\*?\s*(?:from\s+)?(?:ok|is|isnt|results_eq|throws_ok|lives_ok|has_table|has_column)\s*\(|\btSQLt\.\w+/i,
  powershell: none("Pester's `.Tests.ps1` suffix is never a plain word"),
};

/** Build and package manifests by file name, one row per supported language. */
export const MANIFEST_NAMES: LanguageRecord<RegExp> = {
  typescript: /^(?:tsconfig(?:\.[\w-]+)?\.json|deno\.jsonc?)$/i,
  javascript: /^(?:package\.json|jsconfig\.json|biome\.jsonc?|bunfig\.toml)$/i,
  python: /^(?:pyproject\.toml|requirements(?:[.-][\w-]+)?\.txt|setup\.(?:py|cfg)|Pipfile)$/i,
  go: /^go\.(?:mod|work)$/i,
  rust: /^Cargo\.toml$/i,
  java: /^(?:pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|libs\.versions\.toml)$/i,
  kotlin: none("Kotlin builds with Gradle or Maven, whose files the Java row names"),
  scala: /^build\.sbt$/i,
  csharp:
    /^(?:global\.json|Directory\.(?:Build|Packages)\.(?:props|targets)|[^/]+\.(?:csproj|fsproj|vbproj|sln|slnx))$/i,
  c: none("C builds with CMake, Meson or Make, whose files the C++ and Make rows name"),
  cpp: /^(?:CMakeLists\.txt|meson\.build|conanfile\.(?:txt|py)|vcpkg\.json)$/i,
  ruby: /^(?:Gemfile|[^/]+\.gemspec)$/i,
  php: /^composer\.json$/i,
  swift: /^Package\.swift$/i,
  lua: /^(?:[^/]+\.rockspec|\.busted|\.luacheckrc)$/i,
  elixir: /^mix\.exs$/i,
  dart: /^pubspec\.yaml$/i,
  zig: /^build\.zig(?:\.zon)?$/i,
  bash: none("shell scripts have no package manifest"),
  ocaml: /^(?:dune-project|[^/]+\.opam)$/i,
  objc: none("Objective-C builds through Xcode projects or CocoaPods, not read as manifests"),
  vue: none("a Vue project is an npm package: the JavaScript row names its manifests"),
  svelte: none("a Svelte project is an npm package: the JavaScript row names its manifests"),
  rescript: /^rescript\.json$|^bsconfig\.json$/i,
  solidity: /^(?:foundry\.toml|hardhat\.config\.[cm]?[jt]s|remappings\.txt)$/i,
  sql: /^(?:dbt_project\.yml|\.sqlfluff)$/i,
  // Module manifests, PSScriptAnalyzer settings and PSDepend or PSResourceGet requirements.
  powershell: /^(?!PSScriptAnalyzerSettings\.psd1$)[^/]+\.psd1$/i,
};

/**
 * What the workflow runtime needs to know about a language, so the code, source, test and
 * manifest rules read one table instead of a list each (#1488). The supported languages are
 * code and take their tests and manifests from the records above; the rest are markup, styles,
 * queries and build files.
 */
interface LanguageTraits {
  /**
   * A programming language: linters and formatters read its files, and a task that writes one
   * writes code.
   */
  code?: true;
  /** Project source that is not code (markup, styles, queries): it makes a workspace `source`. */
  source?: true;
  /** Test files by the language's own naming. */
  tests?: RegExp;
  /** What a test file holds, when a name of `tests` can also name domain code (#1848). */
  markers?: RegExp;
  /** Build and package manifests by file name. */
  manifests?: RegExp;
}

const OTHER_LANGUAGE_TRAITS: Partial<Record<Language, LanguageTraits>> = {
  css: { source: true },
  html: { source: true },
  makefile: { manifests: /^(?:GNU)?Makefile$/i },
  just: { manifests: /^\.?justfile$/i },
};

export const LANGUAGE_TRAITS: Partial<Record<Language, LanguageTraits>> = {
  ...Object.fromEntries(
    SUPPORTED_LANGUAGES.map((language) => {
      const tests = rowOf(TEST_CONVENTIONS, language);
      const markers = rowOf(TEST_MARKERS, language);
      const manifests = rowOf(MANIFEST_NAMES, language);
      return [
        language,
        {
          code: true,
          ...(tests ? { tests } : {}),
          ...(markers ? { markers } : {}),
          ...(manifests ? { manifests } : {}),
        },
      ];
    }),
  ),
  ...OTHER_LANGUAGE_TRAITS,
};

const traitsOf = (path: string): LanguageTraits | undefined =>
  LANGUAGE_TRAITS[detectLanguageFromPath(path)];

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const normalize = (path: string): string => path.replaceAll("\\", "/");

/** Source code a linter or formatter reads: a file of a programming language. */
export const isCodeFile = (path: string): boolean => traitsOf(path)?.code === true;

/** Project source of any kind: code, or markup, styles and queries. */
export const isSourceFile = (path: string): boolean => {
  const traits = traitsOf(path);
  return traits?.code === true || traits?.source === true;
};

/** A build or package manifest of any language, by file name. */
export function isManifestFile(path: string): boolean {
  const name = baseName(normalize(path));
  return Object.values(LANGUAGE_TRAITS).some((t) => t.manifests?.test(name));
}

/**
 * Test directories of every convention: `test/`, `tests/`, `__tests__/` and RSpec's and
 * busted's `spec/`. `specs/` is not one: it holds a workflow's specifications.
 */
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|spec)\//i;

/** Whether a path is a test file by the conventions of its language (#1488). */
export function isTestFile(path: string): boolean {
  const normalized = normalize(path);
  if (TEST_DIR.test(normalized)) return true;
  const traits = traitsOf(normalized);
  if (!traits?.code) return false;
  // NestJS end-to-end tests are `name.e2e-spec.ts` (#1683).
  return (
    /\.(?:e2e-)?(?:test|spec)\.\w+$/i.test(normalized) || traits.tests?.test(normalized) === true
  );
}

/**
 * Whether a file is a test given its content: `isTestFile`, except that a file outside a test
 * directory whose only claim is a name its language shares with domain code (`PermTest.cs`) needs
 * a test marker of `TEST_MARKERS` too (#1848). `content` null or undefined (the file does not exist
 * yet, or was not read) leaves the name rule.
 */
export function isTestContent(path: string, content: string | null | undefined): boolean {
  if (!isTestFile(path)) return false;
  if (content == null) return true;
  const normalized = normalize(path);
  if (TEST_DIR.test(normalized) || /\.(?:e2e-)?(?:test|spec)\.\w+$/i.test(normalized)) return true;
  const { tests, markers } = traitsOf(normalized) ?? {};
  if (!tests || !markers) return true;
  // A rule its directory alone meets (C#'s `App.Tests/`) is a directory rule, not a name.
  const dir = normalized.slice(0, normalized.length - baseName(normalized).length);
  const ext = normalized.slice(normalized.lastIndexOf("."));
  if (tests.test(`${dir}probe${ext}`)) return true;
  return markers.test(content);
}

/** `isTestContent` of the file as it is under `root`, by the name alone when it does not exist. */
export function isTestFileAt(root: string, path: string): boolean {
  if (!isTestFile(path)) return false;
  let content: string | null = null;
  try {
    content = readFileSync(join(root, path), "utf8");
  } catch {
    /* absent or unreadable: the name rule */
  }
  return isTestContent(path, content);
}

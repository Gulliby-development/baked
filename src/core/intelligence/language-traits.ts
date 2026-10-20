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
  /** Build and package manifests by file name. */
  manifests?: RegExp;
}

const OTHER_LANGUAGE_TRAITS: Partial<Record<Language, LanguageTraits>> = {
  sql: { source: true },
  css: { source: true },
  html: { source: true },
  makefile: { manifests: /^(?:GNU)?Makefile$/i },
  just: { manifests: /^\.?justfile$/i },
};

export const LANGUAGE_TRAITS: Partial<Record<Language, LanguageTraits>> = {
  ...Object.fromEntries(
    SUPPORTED_LANGUAGES.map((language) => {
      const tests = rowOf(TEST_CONVENTIONS, language);
      const manifests = rowOf(MANIFEST_NAMES, language);
      return [
        language,
        { code: true, ...(tests ? { tests } : {}), ...(manifests ? { manifests } : {}) },
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

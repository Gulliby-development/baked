import { detectLanguageFromPath, type Language } from "./types.js";

/**
 * What the workflow runtime needs to know about a language, keyed by the languages of
 * `EXT_TO_LANGUAGE`, so the code, source, test and manifest rules read one table instead of a
 * list each (#1488). A language missing here is still detected by extension; it only gets no
 * help from the rules below.
 */
interface LanguageTraits {
  /**
   * A programming language: linters and formatters read its files, and a task that writes one
   * writes code.
   */
  code?: true;
  /** Project source that is not code (markup, styles, queries): it makes a workspace `source`. */
  source?: true;
  /**
   * Test files by the language's own naming, beyond the shared conventions (a test directory,
   * `name.test.ext` or `name.spec.ext`).
   */
  tests?: RegExp;
  /** Build and package manifests by file name. */
  manifests?: RegExp;
}

export const LANGUAGE_TRAITS: Partial<Record<Language, LanguageTraits>> = {
  typescript: { code: true, manifests: /^(?:tsconfig(?:\.[\w-]+)?\.json|deno\.jsonc?)$/i },
  javascript: {
    code: true,
    manifests: /^(?:package\.json|jsconfig\.json|biome\.jsonc?|bunfig\.toml)$/i,
  },
  python: {
    code: true,
    // Django's `startapp` puts an app's tests in `tests.py` (#1683).
    tests: /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest|tests)\.py$/i,
    manifests: /^(?:pyproject\.toml|requirements(?:[.-][\w-]+)?\.txt|setup\.(?:py|cfg)|Pipfile)$/i,
  },
  go: { code: true, tests: /_test\.go$/i, manifests: /^go\.(?:mod|work)$/i },
  // A `#[cfg(test)] mod tests;` module file, and `name_tests.rs` beside its source (#1683).
  rust: { code: true, tests: /(?:^|\/)tests\.rs$|_tests?\.rs$/, manifests: /^Cargo\.toml$/i },
  java: {
    code: true,
    tests: /(?:Tests?|IT)\.java$/,
    manifests: /^(?:pom\.xml|(?:build|settings)\.gradle(?:\.kts)?)$/i,
  },
  kotlin: { code: true, tests: /(?:Tests?|IT|Spec)\.kts?$/ },
  scala: { code: true, tests: /(?:Tests?|Spec|Suite)\.scala$/, manifests: /^build\.sbt$/i },
  csharp: {
    code: true,
    // Every file of a test project (`App.Tests/`, `App.UnitTests/`), whatever its class is called (#1683).
    tests:
      /Tests?\.cs$|(?:^|\/)[^/]+\.(?:Unit|Integration|Functional|Acceptance|E2E)?Tests?\/(?:[^/]+\/)*[^/]+\.cs$/,
    manifests:
      /^(?:global\.json|Directory\.(?:Build|Packages)\.(?:props|targets)|[^/]+\.(?:csproj|fsproj|vbproj|sln|slnx))$/i,
  },
  c: { code: true, tests: /(?:^|\/)test_[^/]*\.c$|_test\.c$/i },
  cpp: {
    code: true,
    tests: /(?:^|\/)test_[^/]*\.(?:cc|cpp|cxx)$|_(?:unit)?test\.(?:cc|cpp|cxx)$/i,
    manifests: /^(?:CMakeLists\.txt|meson\.build|conanfile\.(?:txt|py)|vcpkg\.json)$/i,
  },
  ruby: {
    code: true,
    tests: /_(?:spec|test)\.rb$|(?:^|\/)test_[^/]*\.rb$/i,
    manifests: /^(?:Gemfile|[^/]+\.gemspec)$/i,
  },
  php: { code: true, tests: /Test\.php$/, manifests: /^composer\.json$/i },
  swift: { code: true, tests: /Tests?\.swift$/, manifests: /^Package\.swift$/i },
  lua: {
    code: true,
    tests: /_(?:spec|test)\.luau?$|(?:^|\/)test_[^/]*\.luau?$/i,
    manifests: /^(?:[^/]+\.rockspec|\.busted|\.luacheckrc)$/i,
  },
  elixir: { code: true, tests: /_test\.exs?$/i, manifests: /^mix\.exs$/i },
  dart: { code: true, tests: /_test\.dart$/i, manifests: /^pubspec\.yaml$/i },
  zig: { code: true, tests: /_test\.zig$/i, manifests: /^build\.zig(?:\.zon)?$/i },
  bash: { code: true, tests: /_test\.(?:sh|bash)$/i },
  ocaml: { code: true, manifests: /^(?:dune-project|[^/]+\.opam)$/i },
  objc: { code: true },
  vue: { code: true },
  svelte: { code: true },
  rescript: { code: true },
  solidity: { code: true },
  sql: { source: true },
  css: { source: true },
  html: { source: true },
  makefile: { manifests: /^(?:GNU)?Makefile$/i },
  just: { manifests: /^\.?justfile$/i },
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

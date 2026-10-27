import { isNoRow, type LanguageRecord, none } from "../../intelligence/language-records.js";

/**
 * A comment, attribute or pragma that silences a linter, a type checker or a coverage tool.
 * `spelling` is a regular expression source matched on a line whose string content is blanked;
 * `example` is a line of the language it must match, which `tests/language-parity.test.ts` scans.
 * `kind` decides which guard counts it: the test-integrity guard counts every kind, the
 * `lint-suppression` quality rule only `lint` (`@ts-expect-error` has its own rule, and a coverage
 * ignore hides no finding).
 */
export interface Suppression {
  readonly spelling: string;
  readonly example: string;
  readonly kind: "lint" | "ts-check" | "coverage";
}

const lint = (spelling: string, example: string): Suppression => ({
  spelling,
  example,
  kind: "lint",
});
const coverage = (spelling: string, example: string): Suppression => ({
  spelling,
  example,
  kind: "coverage",
});

const ESLINT = lint(String.raw`\beslint-disable`, "// eslint-disable-next-line no-console");
const BIOME = lint(
  String.raw`\bbiome-ignore\b`,
  "// biome-ignore lint/suspicious/noExplicitAny: legacy",
);
const OXLINT = lint(String.raw`\boxlint-disable`, "// oxlint-disable-next-line no-unused-vars");
const PRETTIER = lint(String.raw`\bprettier-ignore\b`, "// prettier-ignore");
const TS_CHECK: Suppression = {
  spelling: String.raw`@ts-(?:ignore|nocheck|expect-error)\b`,
  example: "// @ts-expect-error legacy call",
  kind: "ts-check",
};
// istanbul, c8 and v8 coverage hints: `/* istanbul ignore next */`, `/* c8 ignore next */`.
const JS_COVERAGE = coverage(String.raw`\b(?:istanbul|c8|v8)\s+ignore\b`, "/* c8 ignore next */");
const JS: readonly Suppression[] = [TS_CHECK, ESLINT, BIOME, OXLINT, PRETTIER, JS_COVERAGE];

const SUPPRESS_WARNINGS = lint(String.raw`@SuppressWarnings\b`, '@SuppressWarnings("unchecked")');
const NOSONAR = lint(String.raw`\bNOSONAR\b`, "// NOSONAR");
const SUPPRESS_MESSAGE = lint(
  // PSScriptAnalyzer, and the same attribute in C#: `[Diagnostics.CodeAnalysis.SuppressMessageAttribute(...)]` (#1498).
  String.raw`\[(?:System\.)?(?:Diagnostics\.CodeAnalysis\.)?SuppressMessage(?:Attribute)?\s*\(`,
  "[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]",
);
// clang-tidy, GCC's and Clang's diagnostic pragmas (#1490), MSVC's warning pragma and cppcheck.
const CLANG: readonly Suppression[] = [
  lint(
    String.raw`//\s*NOLINT(?:NEXTLINE|BEGIN)?\b`,
    "int x = y; // NOLINT(bugprone-narrowing-conversions)",
  ),
  lint(
    String.raw`#\s*pragma\s+(?:GCC|clang)\s+diagnostic\s+ignored\b`,
    '#pragma GCC diagnostic ignored "-Wunused"',
  ),
  lint(String.raw`#\s*pragma\s+warning\s*\(\s*disable\b`, "#pragma warning(disable: 4996)"),
  lint(String.raw`//\s*cppcheck-suppress\b`, "// cppcheck-suppress nullPointer"),
];

/**
 * The suppression spellings of each language's linters, type checkers and coverage tools (#2274).
 * A language added with a linter gate gets its row in the same change. Every file is scanned for
 * every row, since one file holds several languages (a Vue file's script, a Markdown example) and
 * a spelling of another language is no less a suppression.
 */
export const SUPPRESSION_SPELLINGS: LanguageRecord<readonly Suppression[]> = {
  typescript: JS,
  javascript: JS,
  vue: JS,
  svelte: [
    ...JS,
    lint(String.raw`\bsvelte-ignore\b`, "<!-- svelte-ignore a11y-click-events-have-key-events -->"),
  ],
  python: [
    lint(String.raw`#\s*type:\s*ignore\b`, "x = f()  # type: ignore[attr-defined]"),
    lint(String.raw`#\s*noqa\b`, "import os  # noqa: F401"),
    lint(String.raw`#\s*pylint:\s*disable`, "x = f()  # pylint: disable=invalid-name"),
    lint(
      String.raw`#\s*pyright:\s*ignore\b`,
      "x = f()  # pyright: ignore[reportGeneralTypeIssues]",
    ),
    lint(String.raw`#\s*mypy:\s*(?:ignore-errors|disable-error-code)\b`, "# mypy: ignore-errors"),
    coverage(String.raw`#\s*pragma:\s*no cover\b`, "if debug:  # pragma: no cover"),
  ],
  go: [
    lint(String.raw`//\s*nolint\b`, "x := f() //nolint:errcheck"),
    // staticcheck: `//lint:ignore SA1019 reason`, `//lint:file-ignore`.
    lint(
      String.raw`//\s*lint:(?:file-)?ignore\b`,
      "//lint:ignore SA1019 the old API is still needed",
    ),
  ],
  rust: [
    lint(String.raw`#!?\[(?:allow|expect)\(`, "#[expect(unused_variables)]"),
    lint(String.raw`#!?\[cfg_attr\(.*\b(?:allow|expect)\(`, "#[cfg_attr(test, allow(dead_code))]"),
  ],
  java: [
    SUPPRESS_WARNINGS,
    lint(String.raw`@SuppressFBWarnings\b`, '@SuppressFBWarnings("EI_EXPOSE_REP")'),
    lint(String.raw`//\s*CHECKSTYLE[:.]?\s*OFF\b`, "// CHECKSTYLE:OFF"),
    lint(String.raw`//\s*NOPMD\b`, "int x = y; // NOPMD"),
    NOSONAR,
  ],
  // Kotlin's own `@Suppress`, which detekt also reads, and ktlint's comment directive.
  kotlin: [
    lint(String.raw`@(?:file:)?Suppress\b`, '@file:Suppress("unused")'),
    SUPPRESS_WARNINGS,
    lint(String.raw`\bktlint-disable\b`, "// ktlint-disable no-wildcard-imports"),
    NOSONAR,
  ],
  scala: [
    lint(String.raw`@nowarn\b`, '@nowarn("cat=deprecation")'),
    lint(String.raw`//\s*scalafix:(?:off|ok)\b`, "// scalafix:off DisableSyntax.null"),
    lint(String.raw`//\s*scalastyle:off\b`, "// scalastyle:off"),
    SUPPRESS_WARNINGS,
  ],
  csharp: [
    lint(String.raw`#pragma\s+warning\s+disable\b`, "#pragma warning disable CS0168"),
    SUPPRESS_MESSAGE,
    lint(String.raw`#nullable\s+disable\b`, "#nullable disable"),
    lint(String.raw`//\s*ReSharper\s+disable\b`, "// ReSharper disable once UnusedVariable"),
    NOSONAR,
  ],
  c: CLANG,
  cpp: CLANG,
  objc: CLANG,
  ruby: [
    lint(
      String.raw`#\s*(?:rubocop|standard):(?:disable|todo)\b`,
      "x = 1 # rubocop:disable Lint/UselessAssignment",
    ),
  ],
  php: [
    lint("@phpstan-ignore", "// @phpstan-ignore-next-line"),
    lint(String.raw`@psalm-suppress\b`, "/** @psalm-suppress MixedAssignment */"),
    lint(String.raw`\bphpcs:(?:ignore|disable)\b`, "// phpcs:ignore Generic.Files.LineLength"),
    coverage("@codeCoverageIgnore", "// @codeCoverageIgnoreStart"),
  ],
  swift: [
    lint(String.raw`//\s*swiftlint:disable\b`, "// swiftlint:disable:next force_cast"),
    lint(String.raw`//\s*swift-format-ignore\b`, "// swift-format-ignore: NeverForceUnwrap"),
  ],
  // luacheck and selene (#1495).
  lua: [
    lint(
      String.raw`--\s*luacheck:\s*(?:ignore|no\s|push\s+ignore)`,
      "local x = 1 -- luacheck: ignore 211",
    ),
    lint(String.raw`--\s*selene:\s*allow\b`, "-- selene: allow(unused_variable)"),
  ],
  elixir: [
    lint(
      String.raw`#\s*credo:disable-for-(?:next-line|previous-line|this-file|lines)\b`,
      "# credo:disable-for-next-line Credo.Check.Readability.Specs",
    ),
    // Any `@dialyzer` attribute turns a Dialyzer warning off: `{:nowarn_function, f: 1}`, `:no_return`.
    lint(String.raw`@dialyzer\b`, "@dialyzer {:nowarn_function, run: 1}"),
  ],
  dart: [lint(String.raw`//\s*ignore(?:_for_file)?:\s*\w`, "// ignore: avoid_print")],
  zig: none(
    "Zig has no inline lint or warning suppression: an unused value is discarded with `_ = x;`, which is code",
  ),
  // ShellCheck (#1497).
  bash: [lint(String.raw`#\s*shellcheck\s+disable=`, "# shellcheck disable=SC2086")],
  ocaml: [lint(String.raw`\[@{1,3}(?:ocaml\.)?warning\b`, '[@@@warning "-32"]')],
  rescript: [lint(String.raw`@@?warning\(`, '@@warning("-27")')],
  solidity: [
    lint(String.raw`//\s*solhint-disable\b`, "// solhint-disable-next-line no-console"),
    lint(String.raw`//\s*slither-disable-`, "// slither-disable-next-line reentrancy-eth"),
  ],
  // SQLFluff (#1499).
  sql: [lint(String.raw`--\s*noqa\b`, "SELECT * FROM t -- noqa: AM04")],
  powershell: [SUPPRESS_MESSAGE],
  // lintr: `# nolint`, `# nolint: object_name_linter.`, `# nolint start` (#1500).
  r: [lint(String.raw`#\s*nolint\b`, "x <- 1 # nolint: object_name_linter.")],
};

/** One global pattern of every spelling of the given kinds, each spelling once. */
export function suppressionPattern(kinds: readonly Suppression["kind"][]): RegExp {
  const spellings = new Set<string>();
  for (const row of Object.values(SUPPRESSION_SPELLINGS))
    if (!isNoRow(row))
      for (const suppression of row)
        if (kinds.includes(suppression.kind)) spellings.add(suppression.spelling);
  return new RegExp([...spellings].join("|"), "g");
}

import type { LanguageRecord } from "../intelligence/language-records.js";

/**
 * A program that analyzes source without running it. `tool` is its command line as words
 * (`rubocop`, `dart analyze`); `prefix` also takes the build-tool tasks named after it
 * (`spotlessCheck`, `ktlintFormat`, `checkstyleMain`). `wholeUnit` marks a tool that resolves
 * every module, import or type of the project, so it fails in a task's own worktree until the
 * sibling tasks' files exist and runs in the checks stage instead (see `isWholeUnitCheck`).
 */
export interface StaticTool {
  readonly tool: string;
  readonly kind: "linter" | "formatter" | "typechecker";
  readonly prefix?: true;
  readonly wholeUnit?: true;
}

const lint = (tool: string, extra: Omit<StaticTool, "tool" | "kind"> = {}): StaticTool => ({
  tool,
  kind: "linter",
  ...extra,
});
const format = (tool: string, extra: Omit<StaticTool, "tool" | "kind"> = {}): StaticTool => ({
  tool,
  kind: "formatter",
  ...extra,
});
const types = (tool: string): StaticTool => ({ tool, kind: "typechecker", wholeUnit: true });
const WHOLE = { wholeUnit: true } as const;
const TASKS = { prefix: true } as const;

const JS: readonly StaticTool[] = [
  lint("eslint"),
  lint("biome"),
  lint("oxlint"),
  format("prettier"),
];
const CLANG: readonly StaticTool[] = [lint("clang-tidy", WHOLE), format("clang-format")];

/**
 * The linters, formatters and type checkers of each language, by the name a check calls them
 * (#2110). A check named after one (`rubocop`, `phpcs`, `scalafmt --test`) is a static check: it
 * runs after every code task that writes a file it covers, its failure is corrected as diagnostics
 * only, and it is never a test check, whatever paths its arguments name (`solhint 'test/**'`).
 * Generic words (`lint`, `format`, `fmt`, `check`, `typecheck`) count for every language; a tool
 * whose name holds one as a whole word needs no row, but gets one when it is the language's own.
 */
export const STATIC_TOOLS: LanguageRecord<readonly StaticTool[]> = {
  typescript: [...JS, types("tsc")],
  javascript: JS,
  python: [
    lint("ruff"),
    lint("flake8"),
    lint("pylint"),
    format("ruff format"),
    format("black"),
    format("isort"),
    types("mypy"),
    types("pyright"),
  ],
  go: [
    lint("go vet", WHOLE),
    lint("golangci-lint"),
    lint("staticcheck"),
    format("gofmt"),
    format("go fmt"),
    format("goimports"),
  ],
  rust: [
    lint("clippy", WHOLE),
    lint("cargo check", WHOLE),
    format("rustfmt", WHOLE),
    format("cargo fmt", WHOLE),
  ],
  java: [
    lint("checkstyle", TASKS),
    lint("pmd", TASKS),
    // SpotBugs reads the compiled classes of the whole project.
    lint("spotbugs", { prefix: true, wholeUnit: true }),
    format("spotless", TASKS),
    format("google-java-format"),
  ],
  kotlin: [
    lint("ktlint", TASKS),
    lint("detekt", TASKS),
    format("ktfmt", TASKS),
    format("spotless", TASKS),
  ],
  // Scalafix's semantic rules read the SemanticDB of the whole compiled project.
  scala: [format("scalafmt", TASKS), lint("scalafix", { prefix: true, wholeUnit: true })],
  csharp: [format("dotnet format"), format("csharpier")],
  c: [...CLANG, lint("cppcheck"), lint("cpplint")],
  cpp: [...CLANG, lint("cppcheck"), lint("cpplint")],
  objc: [...CLANG, lint("oclint")],
  ruby: [lint("rubocop"), lint("standardrb"), lint("reek")],
  // PHPStan and Psalm load every class a file uses (#1491); Pint, PHP-CS-Fixer and phpcbf format one file.
  php: [
    lint("phpstan", WHOLE),
    lint("psalm", WHOLE),
    lint("phpcs"),
    lint("phpmd"),
    format("pint"),
    format("php-cs-fixer"),
    format("phpcbf"),
  ],
  swift: [lint("swiftlint"), format("swiftformat"), format("swift-format")],
  lua: [lint("luacheck"), lint("selene"), format("stylua")],
  // Dialyzer analyzes the whole application's compiled modules.
  elixir: [lint("credo"), lint("dialyzer", WHOLE), format("mix format")],
  // `dart analyze` and `flutter analyze` resolve every import (#1753).
  dart: [lint("dart analyze", WHOLE), lint("flutter analyze", WHOLE), format("dart format")],
  zig: [format("zig fmt")],
  bash: [lint("shellcheck"), format("shfmt")],
  ocaml: [format("ocamlformat")],
  vue: [...JS, types("vue-tsc")],
  svelte: [...JS, types("svelte-check")],
  rescript: [format("rescript format")],
  // Slither compiles the whole project with its framework.
  solidity: [lint("solhint"), lint("slither", WHOLE), format("forge fmt")],
  // SQLFluff with the dbt templater compiles the whole dbt project (`ref()` to other models), so its
  // gate, `sqlfluff-dbt`, is whole-unit (#1499).
  sql: [lint("sqlfluff"), lint("sqlfluff-dbt", WHOLE)],
  powershell: [lint("PSScriptAnalyzer"), lint("ScriptAnalyzer"), format("Invoke-Formatter")],
  // Both run inside an `Rscript -e` expression, which the patterns read as words of the command.
  r: [lint("lintr"), format("styler")],
};

const ALL: readonly StaticTool[] = [
  ...new Map(
    Object.values(STATIC_TOOLS)
      .flatMap((row) => (Array.isArray(row) ? row : []))
      .map((t) => [`${t.tool}/${t.kind}/${t.wholeUnit ?? ""}`, t] as const),
  ).values(),
];

const spelling = (t: StaticTool): string =>
  t.tool
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+") + (t.prefix ? "\\w*" : "");

/** A regular expression matching the named tools, and the extra alternatives, as whole words. */
export function staticToolPattern(
  where: (t: StaticTool) => boolean,
  extra: readonly string[] = [],
): RegExp {
  const names = [...new Set(ALL.filter(where).map(spelling))].sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${[...names, ...extra].join("|")})\\b`, "i");
}

/**
 * The static tool a launched program is: its own name (`rubocop`), or its name with its first
 * argument (`dart analyze`, `mix format`), ignoring case and a `.exe`/`.cmd`/`.bat` suffix.
 */
export function staticToolOf(program: string, args: readonly string[]): StaticTool | null {
  const name = program.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
  const withSub = `${name} ${(args[0] ?? "").toLowerCase()}`;
  return ALL.find((t) => t.tool.toLowerCase() === name || t.tool.toLowerCase() === withSub) ?? null;
}

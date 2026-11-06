import type { SupportedLanguage } from "../intelligence/language-records.js";
import { isCodeFile } from "../intelligence/language-traits.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { programName } from "./launcher.js";
import { toolchainCommand } from "./toolchain.js";

const WEB: readonly SupportedLanguage[] = ["typescript", "javascript", "vue", "svelte"];

/**
 * The code languages each fixer program handles (#2632), by the program the fixer runs behind
 * launchers, environment runners, `python -m` and package runners. A fixer run on a code file of
 * another language fails and changes nothing: R86 binlayer ran `ruff check --fix` and `ruff format`
 * on `.sql` files and `sqlfluff fix` on `.py` files, and the preflight probe that picked a `.sql`
 * file recorded the ruff fixers unusable (12 false `fixer_unusable` would-stops). A program without
 * a row is given every file, as before; a gate detector that adds a fixer adds its row.
 */
export const FIXER_LANGUAGES: Readonly<Record<string, readonly SupportedLanguage[]>> = {
  ruff: ["python"],
  black: ["python"],
  isort: ["python"],
  autopep8: ["python"],
  autoflake: ["python"],
  pyupgrade: ["python"],
  sqlfluff: ["sql"],
  eslint: WEB,
  prettier: WEB,
  biome: WEB,
  gofmt: ["go"],
  goimports: ["go"],
  "golangci-lint": ["go"],
  go: ["go"],
  rubocop: ["ruby"],
  standardrb: ["ruby"],
  pint: ["php"],
  "php-cs-fixer": ["php"],
  phpcbf: ["php"],
  stylua: ["lua"],
  mix: ["elixir"],
  dart: ["dart"],
  flutter: ["dart"],
  zig: ["zig"],
  shfmt: ["bash"],
  "clang-format": ["c", "cpp", "objc"],
  "swift-format": ["swift"],
  swiftformat: ["swift"],
  swiftlint: ["swift"],
  dotnet: ["csharp"],
  pwsh: ["powershell"],
  powershell: ["powershell"],
  rscript: ["r"],
  forge: ["solidity"],
  ocamlformat: ["ocaml"],
  dune: ["ocaml"],
  rescript: ["rescript"],
  cargo: ["rust"],
  rustfmt: ["rust"],
  scalafmt: ["scala"],
  sbt: ["scala"],
  ktlint: ["kotlin"],
  "google-java-format": ["java"],
};

const PYTHON = /^(?:python[\d.]*|py|pypy[\d.]*)$/i;
const PACKAGE_RUNNERS = new Set(["bunx", "npx", "pnpm", "yarn"]);

/** The program a fixer runs, behind `python -m` and package runners (`bunx biome`, `pnpm exec eslint`). */
export function fixerProgram(fix: { executable: string; args: readonly string[] }): string {
  const { program, args } = toolchainCommand(fix.executable, fix.args);
  const name = programName(program)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (PYTHON.test(name) && args[0] === "-m" && args[1]) return programName(args[1]).toLowerCase();
  if (PACKAGE_RUNNERS.has(name)) {
    const inner = args.find((arg) => !arg.startsWith("-") && !/^(?:exec|dlx)$/.test(arg));
    if (inner) return programName(inner.replace(/(?<=.)@[^/]*$/, "")).toLowerCase();
  }
  return name;
}

/**
 * The paths of `paths` a fixer is run on (#2632): every path when its program has no
 * `FIXER_LANGUAGES` row, else the files that are not code (data and documents, as before) and the
 * code files of the languages it handles.
 */
export function fixerPaths(
  fix: { executable: string; args: readonly string[] },
  paths: readonly string[],
): string[] {
  const languages = FIXER_LANGUAGES[fixerProgram(fix)];
  if (!languages) return [...paths];
  return paths.filter(
    (path) =>
      !isCodeFile(path) || (languages as readonly string[]).includes(detectLanguageFromPath(path)),
  );
}

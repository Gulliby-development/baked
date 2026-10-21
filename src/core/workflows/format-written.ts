import { existsSync } from "node:fs";
import { join } from "node:path";
import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { isCodePath } from "./check-policy.js";
import { unresolvedChecks } from "./check-preflight.js";
import { detectGates } from "./gates.js";
import { programName } from "./launcher.js";
import { toolchainCommand } from "./toolchain.js";
import type { Check } from "./types.js";

/**
 * Format-written checks (#1837): the project's formatter in check mode on the files a task writes,
 * with its write mode as the fixer. A repository whose existing files are not formatter-clean gets
 * no whole-tree format gate (it is offered, not preselected, or the operator leaves it out because
 * its baseline fails), so nothing held a new file to the formatter: structpad-update (R55) and
 * logslice-update (R56) shipped a new test file `ruff format` would rewrite although the request
 * asked for it formatted. The files a task creates are wholly the run's, so the scoped check is
 * required; a file it edits keeps the formatting of the lines it did not touch (#1582).
 */

/** A formatter a whole-tree gate runs, and the same formatter on named files. */
export interface FileFormatter {
  /** Whether a gate's program and arguments (behind its launcher) run this formatter. */
  runs: (program: string, args: readonly string[]) => boolean;
  /** The check-mode arguments on `files`, from the gate's own arguments. */
  check: (args: readonly string[], files: readonly string[]) => string[];
  /** The write-mode arguments the fixer appends one file to (`fixerCommand`). */
  fix: (args: readonly string[]) => string[];
}

const ruffFormat: FileFormatter = {
  runs: (program, args) => program === "ruff" && args[0] === "format",
  check: (_, files) => ["format", "--check", ...files],
  fix: () => ["format"],
};
const black: FileFormatter = {
  runs: (program) => program === "black",
  check: (_, files) => ["--check", ...files],
  fix: () => [],
};
const biome: FileFormatter = {
  runs: (program, args) => program === "biome" && args[0] === "format",
  check: (_, files) => ["format", ...files],
  fix: () => ["format", "--write"],
};
const prettier: FileFormatter = {
  runs: (program) => program === "prettier",
  check: (_, files) => ["--check", ...files],
  fix: () => ["--write"],
};
const dprint: FileFormatter = {
  runs: (program, args) => program === "dprint" && args[0] === "check",
  check: (_, files) => ["check", ...files],
  fix: () => ["fmt"],
};
const gofmt: FileFormatter = {
  runs: (program, args) => program === "gofmt" && args.includes("-l"),
  check: (_, files) => ["-l", ...files],
  fix: () => ["-w"],
};
// `dotnet format` keeps the solution or project the gate names and selects files with --include.
const dotnetFormat: FileFormatter = {
  runs: (program, args) => program === "dotnet" && args[0] === "format",
  check: (args, files) => [
    ...args.filter((arg) => arg !== "--verify-no-changes"),
    "--verify-no-changes",
    "--include",
    ...files,
  ],
  fix: (args) => args.filter((arg) => arg !== "--verify-no-changes"),
};

const NPM_FORMATTERS = [biome, prettier, dprint];

/**
 * The formatters whose whole-tree gate `detectGates` offers, by language, in the order a project's
 * own is preferred. A row is `none` where no gate detects a formatter, or where a file-scoped run
 * cannot be told from the whole unit's.
 */
export const FILE_FORMATTERS: LanguageRecord<readonly FileFormatter[]> = {
  typescript: NPM_FORMATTERS,
  javascript: NPM_FORMATTERS,
  vue: [prettier],
  svelte: none("prettier formats Svelte only with prettier-plugin-svelte, which no gate detects"),
  rescript: none("ReScript formats with `rescript format`, which no gate detects"),
  python: [ruffFormat, black],
  go: [gofmt],
  rust: none(
    "cargo fmt and rustfmt follow `mod` declarations, so a file check fails on sibling modules a later task writes (#842); cargo fmt is preselected and the checks stage runs it",
  ),
  csharp: [dotnetFormat],
  java: none(
    "Maven formatters (spotless, google-java-format) run inside `mvn verify`; no gate detects one",
  ),
  kotlin: none("ktlint and spotless run inside Gradle's `check`; no gate detects one"),
  scala: none("scalafmt runs inside sbt; no gate detects it"),
  c: none("clang-format has no gate detector"),
  cpp: none("clang-format has no gate detector"),
  ruby: none("Rake and Bundler have no gate detector yet (#1753)"),
  php: none("Composer has no gate detector yet (#1491)"),
  swift: none("SwiftPM has no gate detector yet (#1753)"),
  lua: none("LuaRocks has no gate detector yet (#1495)"),
  elixir: none("Mix has no gate detector yet (#1753)"),
  dart: none("dart and flutter have no gate detector yet (#1753)"),
  zig: none("zig build has no gate detector yet (#1753)"),
  bash: none("shell scripts have no toolchain"),
  ocaml: none("dune has no gate detector yet (#1753)"),
  objc: none("Xcode projects have no gate detector"),
  solidity: none("Foundry has no gate detector; a Hardhat project is an npm package"),
};

/** Package runners a JavaScript formatter gate starts through: their words before the formatter. */
const PACKAGE_RUNNERS: Record<string, number> = { bunx: 0, npx: 0, yarn: 0, pnpm: 1 };

/**
 * A gate's formatter program and arguments, and the command that runs other arguments through the
 * same launcher, Python environment runner or package runner.
 */
function formatterCommand(check: Pick<Check, "executable" | "args">): {
  program: string;
  args: string[];
  /** Whether a package runner starts it (`bunx biome`), which may download a missing one. */
  packaged: boolean;
  command: (args: string[]) => { executable: string; args: string[] } | null;
} {
  const { program, args, launch } = toolchainCommand(check.executable, check.args);
  const skip = PACKAGE_RUNNERS[program];
  const inner = skip === undefined ? undefined : args[skip];
  if (skip === undefined || inner === undefined)
    return { program, args, packaged: false, command: (next) => launch(next) };
  const prefix = args.slice(0, skip + 1);
  return {
    program: programName(inner),
    args: args.slice(skip + 1),
    packaged: true,
    command: (next) => launch([...prefix, ...next]),
  };
}

/** Whether a check runs one of a language's formatters, whole-tree or scoped. */
const formats = (check: Check, formatters: readonly FileFormatter[]): boolean => {
  const { program, args } = formatterCommand(check);
  return formatters.some((f) => f.runs(program, args));
};

/** How long a format-written check may run. */
export const FORMAT_WRITTEN_TIMEOUT_MS = 120_000;

/**
 * The format-written checks for the code files `writes` creates: per language, the first formatter
 * whose whole-tree gate the project offers but the run's checks leave out, on the language's
 * files only, required, with the formatter's write mode as the fixer. None for a language the
 * checks already format (a `format` script counts for the npm languages), and none whose program
 * does not resolve: a required check that cannot start faults the run.
 */
export function formatWrittenChecks(
  root: string,
  checks: readonly Check[],
  writes: readonly { path: string; action: string }[],
  which?: (command: string, options: { PATH: string; cwd: string }) => string | null,
): Check[] {
  const files = new Map<string, string[]>();
  for (const write of writes) {
    // An edited file keeps its old formatting: a whole-file run reformats lines the request left
    // alone, which a brownfield review rejects (R47 cochange-update, #1582).
    if (write.action !== "create" || !isCodePath(write.path)) continue;
    if (!existsSync(join(root, write.path))) continue;
    const language = detectLanguageFromPath(write.path);
    if (!rowOf(FILE_FORMATTERS, language)) continue;
    files.set(language, [...(files.get(language) ?? []), write.path]);
  }
  if (!files.size) return [];
  const offered = detectGates(root, [...checks]).filter((s) => s.check.fix);
  const out: Check[] = [];
  for (const [language, paths] of files) {
    const formatters = rowOf(FILE_FORMATTERS, language) ?? [];
    const npm = formatters.some((f) => NPM_FORMATTERS.includes(f));
    if (checks.some((c) => formats(c, formatters) || (npm && c.id === "format"))) continue;
    for (const gate of offered) {
      const command = formatterCommand(gate.check);
      const formatter = formatters.find((f) => f.runs(command.program, command.args));
      if (!formatter || !gate.check.fix) continue;
      const fixer = formatterCommand(gate.check.fix);
      const check = command.command(formatter.check(command.args, paths));
      // The fixer runs the checked program, not the gate's (`go fmt ./...` for `gofmt -l .`).
      const fix =
        fixer.program === command.program
          ? fixer.command(formatter.fix(fixer.args))
          : command.command(formatter.fix(command.args));
      if (!check || !fix) continue;
      const scoped: Check = {
        ...gate.check,
        id: `${gate.check.id}-written`,
        ...check,
        fix,
        required: true,
        timeoutMs: Math.min(gate.check.timeoutMs, FORMAT_WRITTEN_TIMEOUT_MS),
      };
      // A JavaScript formatter must be installed: `npx prettier` downloads one otherwise.
      if (
        command.packaged &&
        !existsSync(join(root, "node_modules", ".bin", command.program)) &&
        !(which ?? Bun.which)(command.program, { PATH: process.env.PATH ?? "", cwd: root })
      )
        continue;
      if (unresolvedChecks([scoped], root, which).length) continue;
      out.push(scoped);
      break;
    }
  }
  return out;
}

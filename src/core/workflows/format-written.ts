import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { BUN_FMT } from "../tools/bun-fmt.js";
import { cwdPath, isCodePath } from "./check-policy.js";
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
 * required; a file it edits keeps the formatting of the lines the run did not touch (#1582), so
 * only its changed lines are checked and fixed, by a formatter that formats a range of lines
 * (zonevet-update, R57: a test appended to an already unformatted file).
 */

/** A 1-based, inclusive range of lines. */
export type LineRange = readonly [start: number, end: number];

/** Formatting only some lines of one file. */
export interface RangeFormatter {
  /** Whether one run takes several ranges (black); otherwise one check per range. */
  multiple: boolean;
  /** The check-mode arguments on `file`, limited to `ranges` of its current `text`. */
  check: (
    args: readonly string[],
    file: string,
    ranges: readonly LineRange[],
    text: string,
  ) => string[];
  /** The write-mode arguments the fixer appends the file to. */
  fix: (args: readonly string[], ranges: readonly LineRange[], text: string) => string[];
  /**
   * The range flag and the help arguments that list it, where older releases lack the flag: a
   * range check a formatter rejects fails every attempt, and so does its fixer (#1907).
   */
  probe?: { flag: string; help: string[] };
}

/** A formatter a whole-tree gate runs, and the same formatter on named files. */
export interface FileFormatter {
  /** Whether a gate's program and arguments (behind its launcher) run this formatter. */
  runs: (program: string, args: readonly string[]) => boolean;
  /** The check-mode arguments on `files`, from the gate's own arguments. */
  check: (args: readonly string[], files: readonly string[]) => string[];
  /** The write-mode arguments the fixer appends one file to (`fixerCommand`). */
  fix: (args: readonly string[]) => string[];
  /** The same formatter on lines of a file, where it can format a range. */
  range?: RangeFormatter;
  /**
   * The flag and the help arguments that list it, where the program can lack the formatter
   * altogether: a Bun before 1.4.4 has no `bun fmt`, so every check and fixer would fail (#1920).
   */
  available?: { flag: string; help: string[] };
}

// `ruff format --range=A-B` ends at the start of line B, so a range through line B ends at B+1; one
// that reaches the last line runs to the end of the file. One range per run.
const ruffRange = (text: string, [start, end]: LineRange): string =>
  end + 1 > text.split("\n").length ? `--range=${start}` : `--range=${start}-${end + 1}`;
// Prettier takes character offsets: from the start of the first line to the end of the last.
const offsets = (text: string, [start, end]: LineRange): [number, number] => {
  const lines = text.split("\n");
  const from = lines.slice(0, start - 1).reduce((sum, line) => sum + line.length + 1, 0);
  const to = lines.slice(0, end).reduce((sum, line) => sum + line.length + 1, 0);
  return [from, Math.min(to, text.length)];
};

const ruffFormat: FileFormatter = {
  runs: (program, args) => program === "ruff" && args[0] === "format",
  check: (_, files) => ["format", "--check", ...files],
  fix: () => ["format"],
  range: {
    multiple: false,
    check: (_, file, [range], text) => [
      "format",
      "--check",
      ruffRange(text, range ?? [1, 1]),
      file,
    ],
    fix: (_, [range], text) => ["format", ruffRange(text, range ?? [1, 1])],
    // `ruff format --range` since ruff 0.2.1.
    probe: { flag: "--range", help: ["format", "--help"] },
  },
};
const lineRanges = (ranges: readonly LineRange[]): string[] =>
  ranges.map(([start, end]) => `--line-ranges=${start}-${end}`);
const black: FileFormatter = {
  runs: (program) => program === "black",
  check: (_, files) => ["--check", ...files],
  fix: () => [],
  range: {
    multiple: true,
    check: (_, file, ranges) => ["--check", ...lineRanges(ranges), file],
    fix: (_, ranges) => lineRanges(ranges),
    // `--line-ranges` since black 23.11.
    probe: { flag: "--line-ranges", help: ["--help"] },
  },
};
// No range: `biome format` has no line or offset range, so an edited file is not checked.
const biome: FileFormatter = {
  runs: (program, args) => program === "biome" && args[0] === "format",
  check: (_, files) => ["format", ...files],
  fix: () => ["format", "--write"],
};
const prettierRange = (text: string, range: LineRange): string[] => {
  const [from, to] = offsets(text, range);
  return [`--range-start=${from}`, `--range-end=${to}`];
};
const prettier: FileFormatter = {
  runs: (program) => program === "prettier",
  check: (_, files) => ["--check", ...files],
  fix: () => ["--write"],
  range: {
    multiple: false,
    check: (_, file, [range], text) => ["--check", ...prettierRange(text, range ?? [1, 1]), file],
    fix: (_, [range], text) => ["--write", ...prettierRange(text, range ?? [1, 1])],
    // No probe: `--range-start` and `--range-end` exist since prettier 1.4.
  },
};
// `bun fmt` (Bun 1.4.4) takes Prettier's character offsets; `--no-script` keeps a project's `fmt`
// script from running in its place (#1920).
const BUN_FMT_ARGS = BUN_FMT.split(" ").slice(1);
const bunFmt: FileFormatter = {
  runs: (program, args) => program === "bun" && args[0] === "fmt",
  check: (_, files) => [...BUN_FMT_ARGS, "--check", ...files],
  fix: () => BUN_FMT_ARGS,
  range: {
    multiple: false,
    check: (_, file, [range], text) => [
      ...BUN_FMT_ARGS,
      "--check",
      ...prettierRange(text, range ?? [1, 1]),
      file,
    ],
    fix: (_, [range], text) => [...BUN_FMT_ARGS, ...prettierRange(text, range ?? [1, 1])],
    // No probe of its own: `available` already asks for `--range-start`, there since `bun fmt`.
  },
  available: { flag: "--range-start", help: [...BUN_FMT_ARGS, "--help", "--all"] },
};
// No range: `dprint` formats whole files only.
const dprint: FileFormatter = {
  runs: (program, args) => program === "dprint" && args[0] === "check",
  check: (_, files) => ["check", ...files],
  fix: () => ["fmt"],
};
// No range: gofmt formats whole files; Go files are gofmt-clean by convention, so the whole-tree
// gate is preselected nearly always and this check rarely applies.
const gofmt: FileFormatter = {
  runs: (program, args) => program === "gofmt" && args.includes("-l"),
  check: (_, files) => ["-l", ...files],
  fix: () => ["-w"],
};
// No range: `dotnet format --include` selects files, not lines.
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

// StyLua's range is in bytes, and it formats the statements wholly inside it (#1495).
const styluaRange = (text: string, range: LineRange): string[] => {
  const [from, to] = offsets(text, range);
  const bytes = (end: number) => Buffer.byteLength(text.slice(0, end), "utf8");
  return ["--range-start", String(bytes(from)), "--range-end", String(bytes(to))];
};
const stylua: FileFormatter = {
  runs: (program) => program === "stylua",
  check: (_, files) => ["--check", ...files],
  fix: () => [],
  range: {
    multiple: false,
    check: (_, file, [range], text) => ["--check", ...styluaRange(text, range ?? [1, 1]), file],
    fix: (_, [range], text) => styluaRange(text, range ?? [1, 1]),
    // No probe: `--range-start` and `--range-end` exist since StyLua 0.5.
  },
};
// clang-format takes several `--lines=A:B` ranges of one file, both ends 1-based (#1490). No
// probe: the flag exists since clang-format 3.4.
const clangFormatLines = (ranges: readonly LineRange[]): string[] =>
  ranges.map(([start, end]) => `--lines=${start}:${end}`);
const clangFormat: FileFormatter = {
  runs: (program, args) => program === "clang-format" && args.includes("--dry-run"),
  check: (_, files) => ["--dry-run", "--Werror", ...files],
  fix: () => ["-i"],
  range: {
    multiple: true,
    check: (_, file, ranges) => ["--dry-run", "--Werror", ...clangFormatLines(ranges), file],
    fix: (_, ranges) => ["-i", ...clangFormatLines(ranges)],
  },
};
// No range: shfmt formats whole files (#1497).
const shfmt: FileFormatter = {
  runs: (program, args) => program === "shfmt" && (args.includes("-d") || args.includes("-l")),
  check: (_, files) => ["-d", ...files],
  fix: () => ["-w"],
};
// No range: Pint and PHP-CS-Fixer format whole files (#1491). Both run as `php vendor/bin/NAME`,
// which `toolchainCommand` reads as the tool itself.
const pint: FileFormatter = {
  runs: (program) => program === "pint",
  check: (_, files) => ["--test", ...files],
  fix: () => [],
};
const phpCsFixer: FileFormatter = {
  runs: (program, args) => program === "php-cs-fixer" && args[0] === "fix",
  check: (_, files) => ["fix", "--dry-run", "--diff", ...files],
  fix: () => ["fix"],
};
// No range: RuboCop inspects whole files. Its layout cops are its formatter (#1493); the lint cops
// stay with the gate, since a lint offense has no fixer that always clears it.
const rubocopLayout: FileFormatter = {
  runs: (program) => program === "rubocop",
  check: (_, files) => ["--only", "Layout", ...files],
  fix: () => ["-a", "--only", "Layout"],
};

// No range: `dart format` formats whole files (#1494). A Flutter package formats with `dart` too.
const dartFormat: FileFormatter = {
  runs: (program, args) => program === "dart" && args[0] === "format",
  check: (_, files) => ["format", "--output=none", "--set-exit-if-changed", ...files],
  fix: () => ["format"],
};

const NPM_FORMATTERS = [biome, prettier, dprint, bunFmt];

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
  c: [clangFormat],
  cpp: [clangFormat],
  ruby: [rubocopLayout],
  php: [pint, phpCsFixer],
  swift: none("SwiftPM has no gate detector yet (#1753)"),
  lua: [stylua],
  elixir: none("Mix has no gate detector yet (#1753)"),
  dart: [dartFormat],
  zig: none("zig build has no gate detector yet (#1753)"),
  bash: [shfmt],
  ocaml: none("dune has no gate detector yet (#1753)"),
  objc: none("Xcode projects have no gate detector"),
  solidity: none("Foundry has no gate detector; a Hardhat project is an npm package"),
  sql: none(
    "SQLFluff's layout rules run in the `sqlfluff lint` gate, which covers each task's SQL files; `sqlfluff format` has no check mode",
  ),
  powershell: none(
    "PSScriptAnalyzer's Invoke-Formatter formats a script's text, not files; no gate runs it",
  ),
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

/**
 * The formatter subcommands before a gate's paths (`ruff format`, `dprint check`, `go fmt`,
 * `php-cs-fixer fix`).
 */
const SUBCOMMANDS = new Set(["format", "check", "fmt", "fix"]);
/** Arguments that narrow a formatter to some files or lines of its paths. */
const NARROWING = /^--(include|exclude|range|line-ranges)/;
/** A project or solution file `dotnet format` takes: it formats the files under its directory. */
const PROJECT_FILE = /\.(sln|slnx|csproj|fsproj|vbproj)$/;

/**
 * Whether a check runs one of a language's formatters on `path`: the formatter, unnarrowed, on
 * the path or a directory above it, from its `cwd` (no path runs on the whole of `cwd`). A path
 * operand that cannot be told from a flag's value counts as one, so a coverage it cannot establish
 * leaves the path to the format-written check: `ruff format --check legacy/clean.py` does not hold
 * a new `tests/test_new.py`.
 */
const formatsPath = (check: Check, formatters: readonly FileFormatter[], path: string): boolean => {
  const { program, args } = formatterCommand(check);
  if (!formatters.some((f) => f.runs(program, args))) return false;
  if (args.some((arg) => NARROWING.test(arg))) return false;
  const words = args.filter((arg) => !arg.startsWith("-"));
  const operands = SUBCOMMANDS.has(words[0] ?? "") ? words.slice(1) : words;
  const under = (dir: string) => dir === "." || path === dir || path.startsWith(`${dir}/`);
  if (!operands.length) return under(posix.normalize(check.cwd ?? "."));
  return operands.some((operand) => {
    const target = operand.replace(/\\/g, "/").replace(/\/\.\.\.$/, "");
    const dir = PROJECT_FILE.test(target) ? posix.dirname(target) : target;
    return under(posix.normalize(posix.join(check.cwd ?? ".", dir)).replace(/\/$/, ""));
  });
};

/** Whether a formatter accepts a flag: its help, run once per command and directory. */
export type FlagProbe = (
  command: { executable: string; args: string[] },
  cwd: string,
  flag: string,
) => boolean;

const PROBE_TIMEOUT_MS = 15_000;
const probed = new Map<string, boolean>();

/** The default probe: the flag appears in the output of the formatter's help. */
export const helpListsFlag: FlagProbe = (command, cwd, flag) => {
  const key = JSON.stringify([cwd, command.executable, command.args, flag]);
  let known = probed.get(key);
  if (known === undefined) {
    try {
      const proc = Bun.spawnSync([command.executable, ...command.args], {
        cwd,
        // The current PATH: without `env` the program resolves from the PATH the process began with.
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: PROBE_TIMEOUT_MS,
      });
      known = `${proc.stdout.toString()}${proc.stderr.toString()}`.includes(flag);
    } catch {
      known = false;
    }
    probed.set(key, known);
  }
  return known;
};

/** How long a format-written check may run. */
export const FORMAT_WRITTEN_TIMEOUT_MS = 120_000;

/** Line diffs larger than this many cells count their whole changed middle as one range. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * The 1-based ranges of lines in `after` that are not lines of `before` (added or changed), by the
 * longest common subsequence of the lines between the common head and tail. Deleted lines leave no
 * range.
 */
export function changedLineRanges(before: string, after: string): LineRange[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const old = a.slice(head, a.length - tail);
  const next = b.slice(head, b.length - tail);
  if (!next.length) return [];
  const added: boolean[] = new Array(next.length).fill(true);
  if (old.length && old.length * next.length <= MAX_DIFF_CELLS) {
    const width = next.length + 1;
    const lcs = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--)
      for (let j = next.length - 1; j >= 0; j--)
        lcs[i * width + j] =
          old[i] === next[j]
            ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    for (let i = 0, j = 0; i < old.length && j < next.length; )
      if (old[i] === next[j]) {
        added[j] = false;
        i++;
        j++;
      } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) i++;
      else j++;
  }
  const ranges: [number, number][] = [];
  added.forEach((isAdded, index) => {
    if (!isAdded) return;
    const line = head + index + 1;
    const last = ranges.at(-1);
    if (last && last[1] === line - 1) last[1] = line;
    else ranges.push([line, line]);
  });
  // The empty string after a final newline is no line of its own.
  return ranges
    .map(
      ([start, end]): LineRange => [
        start,
        Math.min(end, Math.max(b.length - (after.endsWith("\n") ? 1 : 0), 1)),
      ],
    )
    .filter(([start, end]) => start <= end);
}

/** A file a task wrote that the format-written checks hold: wholly, or only on `ranges`. */
interface Written {
  path: string;
  /** The lines the run changed in a file it edits, with the file's text; absent for a new file. */
  edited?: { ranges: LineRange[]; text: string };
}

/**
 * The format-written checks for the code files `writes` holds: per language, the first formatter
 * whose whole-tree gate the project offers but the run's checks leave out, on the language's
 * files only, required, with the formatter's write mode as the fixer, limited to those files
 * (`fixPaths`). A file the task creates, or one the run created (`base` gives null), is checked
 * whole. A file it edits is checked on the lines the run changed against `base` (its content before
 * the run's first write), by a formatter that formats a range; with no such formatter, or no base,
 * it is not checked. None for a file the checks already format (a check of the language's formatter
 * on it or a directory above it; a `format` script counts for the npm languages), and none whose
 * program does not resolve: a required check that cannot start
 * faults the run.
 */
export function formatWrittenChecks(
  root: string,
  checks: readonly Check[],
  writes: readonly { path: string; action: string }[],
  which?: (command: string, options: { PATH: string; cwd: string }) => string | null,
  base?: (path: string) => string | null | undefined,
  accepts: FlagProbe = helpListsFlag,
): Check[] {
  const files = new Map<string, Written[]>();
  for (const write of writes) {
    if (write.action === "delete" || !isCodePath(write.path)) continue;
    const absolute = join(root, write.path);
    if (!existsSync(absolute)) continue;
    const language = detectLanguageFromPath(write.path);
    if (!rowOf(FILE_FORMATTERS, language)) continue;
    let written: Written = { path: write.path };
    if (write.action !== "create") {
      // An edited file keeps the formatting of the lines the run did not change: a whole-file
      // run reformats lines the request left alone, which a brownfield review rejects (#1582).
      const before = base?.(write.path);
      if (before === undefined) continue;
      if (before !== null) {
        const text = readFileSync(absolute, "utf8");
        const ranges = changedLineRanges(before, text);
        if (!ranges.length) continue;
        written = { path: write.path, edited: { ranges, text } };
      }
    }
    files.set(language, [...(files.get(language) ?? []), written]);
  }
  if (!files.size) return [];
  // Every gate the project offers, the run's own included: one on other files leaves these to us.
  const offered = detectGates(root).filter((s) => s.check.fix);
  const out: Check[] = [];
  for (const [language, all] of files) {
    const formatters = rowOf(FILE_FORMATTERS, language) ?? [];
    const npm = formatters.some((f) => NPM_FORMATTERS.includes(f));
    if (npm && checks.some((c) => c.id === "format")) continue;
    // A formatter check the run holds on other files leaves these to this check.
    const written = all.filter((w) => !checks.some((c) => formatsPath(c, formatters, w.path)));
    if (!written.length) continue;
    for (const gate of offered) {
      const command = formatterCommand(gate.check);
      const formatter = formatters.find((f) => f.runs(command.program, command.args));
      if (!formatter || !gate.check.fix) continue;
      const fixer = formatterCommand(gate.check.fix);
      // The fixer runs the checked program, not the gate's (`go fmt ./...` for `gofmt -l .`).
      const fixWith = (args: string[]) =>
        fixer.program === command.program ? fixer.command(args) : command.command(args);
      const fixArgs = fixer.program === command.program ? fixer.args : command.args;
      const scoped = (
        id: string,
        args: string[],
        fixArgs: string[],
        paths: string[],
      ): Check | null => {
        const check = command.command(args);
        const fix = fixWith(fixArgs);
        if (!check || !fix) return null;
        return {
          ...gate.check,
          id,
          ...check,
          fix,
          fixPaths: paths,
          required: true,
          timeoutMs: Math.min(gate.check.timeoutMs, FORMAT_WRITTEN_TIMEOUT_MS),
        };
      };
      // A Bun without `bun fmt` would fail every check and fixer.
      const available = formatter.available;
      const helpCommand = available && command.command(available.help);
      if (
        available &&
        !(helpCommand && accepts(helpCommand, join(root, gate.check.cwd ?? "."), available.flag))
      )
        continue;
      const found: Check[] = [];
      // The check runs in the gate's cwd: it holds only the files under it, named from there
      // (`fixPaths` stay workspace paths, as the host matches them).
      const local = (path: string) => cwdPath(gate.check, path);
      const own = written.filter((w) => !local(w.path).startsWith("../"));
      const whole = own.filter((w) => !w.edited).map((w) => w.path);
      if (whole.length) {
        const check = scoped(
          `${gate.check.id}-written`,
          formatter.check(command.args, whole.map(local)),
          formatter.fix(fixArgs),
          whole,
        );
        if (check) found.push(check);
      }
      const range = formatter.range;
      // A formatter release without the range flag checks no edited file, as one with no range.
      const help = range?.probe && command.command(range.probe.help);
      const ranged =
        range &&
        own.some((w) => w.edited) &&
        (!range.probe ||
          (help && accepts(help, join(root, gate.check.cwd ?? "."), range.probe.flag)));
      let lines = 0;
      if (range && ranged)
        for (const { path, edited } of own) {
          if (!edited) continue;
          // Every changed block is checked: one run per block where a run takes one range. The
          // last block comes first, so a fixer that changes a block's line count never moves a
          // block whose fixer runs after it.
          const groups = range.multiple ? [edited.ranges] : edited.ranges.map((r) => [r]).reverse();
          for (const ranges of groups) {
            lines++;
            const check = scoped(
              `${gate.check.id}-lines${lines > 1 ? `-${lines}` : ""}`,
              range.check(command.args, local(path), ranges, edited.text),
              range.fix(fixArgs, ranges, edited.text),
              [path],
            );
            if (check) found.push(check);
          }
        }
      if (!found.length) continue;
      // A JavaScript formatter must be installed: `npx prettier` downloads one otherwise.
      if (
        command.packaged &&
        !existsSync(join(root, gate.check.cwd, "node_modules", ".bin", command.program)) &&
        !(which ?? Bun.which)(command.program, { PATH: process.env.PATH ?? "", cwd: root })
      )
        continue;
      if (unresolvedChecks(found, root, which).length) continue;
      out.push(...found);
      break;
    }
  }
  return out;
}

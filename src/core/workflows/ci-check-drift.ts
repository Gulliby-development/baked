import { fences } from "../verification/doc-examples.js";
import { ciCommandKind, splitCommandLine, workflowRunCommands } from "./gates.js";
import type { Check } from "./types.js";

/**
 * Whether the gate commands a run writes into its CI workflow or README match what its configured
 * checks run (#2284). R73 evalpin delivered a `ci.yml` with `cargo clippy --all-targets` while its
 * `clippy` check ran without `--all-targets`: every feature was accepted and the delivered CI
 * failed on its first push. The decision is pure; the scheduler reads the files the run changed
 * and records each drift as a `ci_check_drift` would-stop.
 */

/** A CI workflow file of the project, by its path from the workspace root. */
export const CI_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** A README of the project root, whose shell blocks repeat the gate commands. */
export const README_FILE = /^readme(?:\.md|\.markdown)?$/i;

/** Programs that launch the tool named after them (`npx eslint`, `uv run mypy`). */
const WRAPPERS: Record<string, readonly string[]> = {
  npx: [],
  bunx: [],
  pnpx: [],
  uvx: [],
  pnpm: ["exec", "dlx"],
  npm: ["exec"],
  yarn: ["exec", "dlx"],
  uv: ["run"],
  poetry: ["run"],
  pipenv: ["run"],
  pdm: ["run"],
  hatch: ["run"],
  rye: ["run"],
  bundle: ["exec"],
  python: ["-m"],
  python3: ["-m"],
  py: ["-m"],
};

/** Tools whose first word after the program names what it runs (`cargo clippy`, `go vet`). */
const SUBCOMMAND_TOOLS = new Set([
  "cargo",
  "go",
  "dotnet",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "swift",
  "mix",
  "dart",
  "flutter",
  "zig",
  "forge",
  "gradle",
  "mvn",
  "ruff",
  "biome",
  "golangci-lint",
  "dune",
  "sbt",
  "stack",
  "cabal",
  "composer",
  "rake",
  "make",
  "just",
  "task",
  "rebar3",
  "lein",
  "R",
]);
/** Package-manager and task-runner subcommands that run a named script (`npm run lint`). */
const RUN_SCRIPT = new Set(["run", "run-script"]);
/** Programs whose own subcommand runs a named script: `deno task lint` (#2416). */
const SCRIPT_SUBCOMMAND: Record<string, string> = { deno: "task" };
/** Program aliases: a wrapper script runs the same tool. */
const ALIASES: Record<string, string> = { gradlew: "gradle", mvnw: "mvn", python3: "python" };

/** Flags that change only output, network or lockfile use, never what the gate enforces. */
const BENIGN_FLAGS = new Set([
  "--offline",
  "--locked",
  "--frozen",
  "--quiet",
  "-q",
  "--verbose",
  "-v",
  "-vv",
  "--no-progress",
  "--ansi",
  "--no-ansi",
  "--no-interaction",
  "--color",
  "--colour",
  "--no-color",
  "--ci",
]);
/** Output-only flags that take a value (`--message-format short`). */
const BENIGN_VALUE_FLAGS = new Set([
  "--color",
  "--colour",
  "--message-format",
  "--output-format",
  "--reporter",
  "--format",
]);
/** Scope words that name the working directory, which a check's `cwd` already is. */
const CURRENT_DIR = new Set([".", "./"]);

export interface ToolCommand {
  /** The tool and its subcommand, lower case: `cargo clippy`, `npm run lint`, `mypy`. */
  tool: string;
  /** The remaining words, with `--flag=value` split, benign flags and `.` dropped. */
  words: string[];
}

const programName = (word: string): string => {
  const base = (word.split(/[\\/]/).pop() ?? word).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  const name = base === "R" ? base : base.toLowerCase();
  return ALIASES[name] ?? name;
};

/** The tool a command runs and the words it gives it, or null when it cannot be read. */
export function toolCommand(executable: string, args: readonly string[]): ToolCommand | null {
  let words = [executable, ...args];
  // Leading wrappers, with their own flags: `uv run --frozen mypy`, `python -m pytest`.
  for (let guard = 0; guard < 4 && words.length; guard++) {
    const program = programName(words[0] ?? "");
    const subs = WRAPPERS[program];
    if (!subs) break;
    let rest = words.slice(1);
    if (subs.length) {
      if (!subs.includes(rest[0] ?? "")) break;
      rest = rest.slice(1);
    }
    while (rest[0]?.startsWith("-")) rest = rest.slice(1);
    if (!rest.length) break;
    words = rest;
  }
  const [first, ...restWords] = words;
  if (!first) return null;
  const program = programName(first);
  let rest = restWords;
  const tool = [program];
  // A toolchain pick (`cargo +nightly clippy`) is not part of the gate.
  if (program === "cargo") rest = rest.filter((w) => !w.startsWith("+"));
  if (SUBCOMMAND_TOOLS.has(program) && rest[0] && !rest[0].startsWith("-")) {
    tool.push(rest[0]);
    rest = rest.slice(1);
    const runs = RUN_SCRIPT.has(tool[1] ?? "") || SCRIPT_SUBCOMMAND[program] === tool[1];
    if (runs && rest[0] && !rest[0].startsWith("-")) {
      tool.push(rest[0]);
      rest = rest.slice(1);
    }
  }
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? "";
    const eq = /^(--[\w-]+)=(.*)$/.exec(word);
    const flag = eq ? (eq[1] ?? word) : word;
    if (BENIGN_VALUE_FLAGS.has(flag)) {
      if (!eq && rest[i + 1] && !rest[i + 1]?.startsWith("-")) i++;
      continue;
    }
    if (BENIGN_FLAGS.has(flag) || CURRENT_DIR.has(word)) continue;
    if (eq) out.push(flag, eq[2] ?? "");
    else out.push(word);
  }
  return { tool: tool.join(" ").toLowerCase(), words: out };
}

/** A command line read from a CI file or README, as a tool command. */
function parsedLine(line: string): ToolCommand | null {
  try {
    const [executable, ...args] = splitCommandLine(line);
    return executable ? toolCommand(executable, args) : null;
  } catch {
    return null;
  }
}

/**
 * The script tables the host can read (#2416): `package.json` `scripts` (npm, pnpm, yarn, bun),
 * `composer.json` `scripts` and `deno.json` `tasks`. A runner whose targets are not a table of
 * command lines (make, just, rake, task) has none: its commands stay unresolved.
 */
export interface ScriptTables {
  package?: Record<string, unknown>;
  composer?: Record<string, unknown>;
  deno?: Record<string, unknown>;
}
type ScriptTable = keyof ScriptTables;

/** The script tables of a directory, from its manifests as `read` returns them (null: missing). */
export function scriptTables(read: (name: string) => string | null): ScriptTables {
  const field = (names: string[], key: string): Record<string, unknown> | undefined => {
    for (const name of names) {
      const text = read(name);
      if (text === null) continue;
      try {
        const value = (JSON.parse(text) as Record<string, unknown>)?.[key];
        return value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const tables: ScriptTables = {};
  const pkg = field(["package.json"], "scripts");
  if (pkg) tables.package = pkg;
  const composer = field(["composer.json"], "scripts");
  if (composer) tables.composer = composer;
  const deno = field(["deno.json", "deno.jsonc"], "tasks");
  if (deno) tables.deno = deno;
  return tables;
}

/**
 * Script runners, one row per program (#2416): the subcommands that name a script (`npm run lint`),
 * the bare script words the program also runs as a script (`npm test`; `*` for any name the table
 * has, as `yarn lint` and `composer test` do), and the table it reads. `bun test` is Bun's own test
 * runner, never the `test` script, so `bun` has no bare words. A new runner adds its row here and a
 * case to `tests/workflow-scenario-ci-check-drift.test.ts`.
 */
const SCRIPT_RUNNERS: Record<
  string,
  { run: readonly string[]; bare: readonly string[] | "*"; table: ScriptTable }
> = {
  npm: { run: ["run", "run-script"], bare: ["test", "start", "stop", "restart"], table: "package" },
  pnpm: { run: ["run", "run-script"], bare: "*", table: "package" },
  yarn: { run: ["run", "run-script"], bare: "*", table: "package" },
  bun: { run: ["run", "run-script"], bare: [], table: "package" },
  deno: { run: ["task"], bare: [], table: "deno" },
  composer: { run: ["run-script", "run"], bare: "*", table: "composer" },
};
/** Runners whose targets the host cannot read as command lines: never resolved (#2416). */
const OPAQUE_RUNNERS = new Set(["make", "just", "rake", "task"]);

/** A command as the comparison reads it: resolved through its script, or opaque. */
interface Resolved {
  /** The tool command it runs: the script's own command when it ran one. */
  parsed: ToolCommand;
  /** The script's command line, when the command ran a script the table names. */
  script?: string;
  /** A script runner whose script the host cannot read: no verdict without the same command. */
  opaque: boolean;
}

/** A table's entry by a tool word, which `toolCommand` lower-cases: `testUnit` for `testunit`. */
function entryOf(tables: ScriptTables, table: ScriptTable, name: string): unknown {
  const entries = tables[table];
  if (!entries) return undefined;
  if (Object.hasOwn(entries, name)) return entries[name];
  const keys = Object.keys(entries).filter((key) => key.toLowerCase() === name);
  return keys.length === 1 ? entries[keys[0] ?? ""] : undefined;
}

/** The script a tool command runs, by table and name, or null when it runs no script. */
function scriptOf(
  parsed: ToolCommand,
  tables: ScriptTables,
): { table: ScriptTable; name: string } | null {
  const [program = "", sub = "", name] = parsed.tool.split(" ");
  const row = SCRIPT_RUNNERS[program];
  if (!row) return null;
  if (row.run.includes(sub)) return name ? { table: row.table, name } : null;
  if (name) return null;
  if (row.bare === "*")
    return entryOf(tables, row.table, sub) !== undefined ? { table: row.table, name: sub } : null;
  return row.bare.includes(sub) ? { table: row.table, name: sub } : null;
}

/** A script's single command line, or null when it is several, a callback or not a string. */
function scriptLine(
  value: unknown,
  table: ScriptTable,
  tables: ScriptTables,
  depth: number,
): string | null {
  const entry =
    table === "deno" && value && typeof value === "object" && !Array.isArray(value)
      ? (value as { command?: unknown }).command
      : value;
  const one = Array.isArray(entry) ? (entry.length === 1 ? entry[0] : null) : entry;
  if (typeof one !== "string") return null;
  // A Composer reference to another script: `"@test:unit"`.
  const ref = table === "composer" ? /^@([^\s]+)$/.exec(one.trim())?.[1] : undefined;
  if (ref !== undefined)
    return depth < 4
      ? scriptLine(entryOf(tables, "composer", ref), table, tables, depth + 1)
      : null;
  // `@php ...` and the other Composer prefixes, and a PHP callback (`App\Setup::run`).
  if (one.trim().startsWith("@") || (table === "composer" && /^[\w\\]+::\w+$/.test(one.trim())))
    return null;
  return one;
}

/** Shell syntax that makes a script more than one command: `tsc && vitest`, `a | b`. */
const COMPOUND = /&&|\|\||[;|`<>]|\$\(|\r|\n/;

/**
 * A tool command resolved through the script tables (#2416): `bun run test` with `"test": "bun
 * test"` is `bun test`, and words after the script name (`npm run lint -- --max-warnings 0`) are
 * the script's words too. A script runner whose script the table does not name, or cannot be read as
 * one command (several commands, a callback, no table), and `make`, `just`, `rake` and `task`
 * targets are opaque.
 */
function resolved(parsed: ToolCommand, tables: ScriptTables): Resolved {
  let current = parsed;
  let script: string | undefined;
  for (let depth = 0; depth < 4; depth++) {
    const target = scriptOf(current, tables);
    if (!target) {
      const program = current.tool.split(" ")[0] ?? "";
      const runner = SCRIPT_RUNNERS[program];
      const [, sub = "", name] = current.tool.split(" ");
      // A runner's script call the host cannot read: `npm run x` with no such script, `yarn lint`
      // with no package.json to tell a script from a built-in command.
      const opaque =
        OPAQUE_RUNNERS.has(program) ||
        (!!runner &&
          (runner.run.includes(sub) || (runner.bare === "*" && !name && !tables[runner.table])));
      return { parsed: current, ...(script === undefined ? {} : { script }), opaque };
    }
    const line = scriptLine(entryOf(tables, target.table, target.name), target.table, tables, 0);
    if (line === null || COMPOUND.test(line)) return { parsed: current, opaque: true };
    let words: string[];
    try {
      words = splitCommandLine(line);
    } catch {
      return { parsed: current, opaque: true };
    }
    // Leading environment assignments (`NODE_ENV=test jest`) are not the tool.
    while (words[0] && /^\w+=/.test(words[0])) words = words.slice(1);
    const extra = current.words[0] === "--" ? current.words.slice(1) : current.words;
    const [executable, ...args] = words;
    const next = executable ? toolCommand(executable, [...args, ...extra]) : null;
    if (!next) return { parsed: current, opaque: true };
    current = next;
    script = line;
  }
  return { parsed: current, opaque: true };
}

/** The gate commands of a changed file: the `run:` steps of a CI workflow, a README's shell lines. */
export function fileGateCommands(path: string, text: string): string[] {
  if (CI_WORKFLOW.test(path)) return workflowRunCommands(text);
  if (!README_FILE.test(path)) return [];
  return fences(text)
    .filter(
      (f) =>
        !f.diff &&
        ["", "sh", "bash", "shell", "console", "zsh", "powershell", "pwsh"].includes(f.lang),
    )
    .flatMap((f) => f.lines)
    .map((line) => line.trim().replace(/^[$>]\s+/, ""))
    .filter((line) => line && !line.startsWith("#"));
}

export interface CiCheckDrift {
  /** The file the run wrote. */
  file: string;
  /** The command as the file has it. */
  command: string;
  /** Its tool, through the script it runs: `cargo clippy`, `bun test` for `bun run test`. */
  tool: string;
  /** The script's command line, when the command runs a package or Composer script (#2416). */
  script?: string;
  /** The closest configured check that runs the same tool, or null when none does. */
  check: { id: string; command: string } | null;
  /** The words of the file's command that check does not give the tool: `--all-targets`. */
  missing: string[];
}

const words = (check: Pick<Check, "executable" | "args">): string =>
  [check.executable, ...check.args].join(" ");

/** A word with glob syntax: `src/*.cpp`, `tests/**\/*.py`, `src/?.c`. */
const GLOB = /[*?[]/;
/** A file or folder argument rather than a flag or a subcommand word: a path, a glob or a file name. */
const isPathWord = (word: string) =>
  !word.startsWith("-") && (GLOB.test(word) || /[/\\]/.test(word) || /\.[A-Za-z]\w*$/.test(word));
/** A glob as a matcher of `/`-separated paths: `**` crosses folders, `*` and `?` do not. */
function globMatcher(glob: string): RegExp {
  let out = "";
  const text = glob.replace(/^\.\//, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "*" && text[i + 1] === "*") {
      out += text[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += text[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * The file and glob words of a command that cover the paths a check lists one by one (#2567): R83
 * pnmforge's README ran `clang-format --dry-run --Werror src/*.cpp src/*.hpp tests/*.cpp
 * tests/*.hpp` while the check listed its files at detection, and the globs read as four missing
 * words. Covered when every listed path matches a glob or a path of the command; the command may
 * name more files (the files written later have their own `-written` checks). Returns the
 * command's path words to drop and the check's paths they cover, or null when a listed path is
 * not covered, so the globs stay a drift.
 */
function coveredPaths(
  command: readonly string[],
  listed: readonly string[],
): { drop: string[]; covered: string[] } | null {
  const paths = command.filter(isPathWord);
  if (!paths.some((word) => GLOB.test(word))) return null;
  const files = listed.filter((word) => isPathWord(word) && !GLOB.test(word));
  if (!files.length) return null;
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const matchers = paths.map((word) =>
    GLOB.test(word)
      ? globMatcher(norm(word))
      : new RegExp(`^${norm(word).replace(/[.+^${}()|[\]\\*?]/g, "\\$&")}(?:/.*)?$`),
  );
  const uncovered = files.filter((file) => !matchers.some((m) => m.test(norm(file))));
  return uncovered.length ? null : { drop: paths, covered: files };
}

/**
 * Each gate command of the changed files that the configured checks do not run as written: a
 * check runs its tool without some of its words (a flag, a scope such as `--all-targets`, `-race`,
 * `./...`, `--strict`), or, for a command of a gate kind (lint, type check, format check, tests),
 * no check runs its tool at all. Words a check adds are fine: the check is the stricter one. Word
 * order and output-only flags (`--offline`, `--color`) do not count.
 *
 * Both sides are compared through the scripts they run (#2416): `scripts` gives the script tables
 * of a directory (the workspace root `.` for the files, a check's `cwd` for the check). A command
 * whose script the host cannot read (`make lint`, `npm run x` with no table) is compared only with
 * checks that run the same command; with none it records nothing, and neither does a gate command
 * no check runs while some check is such an opaque runner, since that check may run it.
 */
export function ciCheckDrift(
  files: readonly { path: string; text: string }[],
  checks: readonly (Pick<Check, "id" | "executable" | "args"> & {
    cwd?: string;
    fix?: Check["fix"];
  })[],
  scripts: (dir: string) => ScriptTables = () => ({}),
): CiCheckDrift[] {
  const tablesOf = new Map<string, ScriptTables>();
  const tables = (dir: string): ScriptTables => {
    const key = dir.replace(/^\.\/?$/, "") || ".";
    let found = tablesOf.get(key);
    if (!found) {
      found = scripts(key);
      tablesOf.set(key, found);
    }
    return found;
  };
  const configured = checks.flatMap((check) => {
    const parsed = toolCommand(check.executable, check.args);
    if (!parsed) return [];
    const own = { check, parsed, resolved: resolved(parsed, tables(check.cwd ?? ".")) };
    // A check's fixer is the same gate in write mode (`clang-format -i`, `gofmt -w`, `cargo fmt`):
    // a README that documents it documents the check's fix, not a drift from it (#2567). It runs
    // on the check's files, so it is compared with them.
    if (!check.fix) return [own];
    const files = check.args.filter(isPathWord);
    const fixed = toolCommand(check.fix.executable, [...check.fix.args, ...files]);
    if (!fixed) return [own];
    const fixer = { check, parsed: fixed, resolved: resolved(fixed, tables(check.cwd ?? ".")) };
    return [own, fixer];
  });
  const opaqueCheck = configured.some((c) => c.resolved.opaque);
  const root = tables(".");
  const out: CiCheckDrift[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const command of fileGateCommands(file.path, file.text)) {
      const raw = parsedLine(command);
      if (!raw) continue;
      const resolvedCommand = resolved(raw, root);
      const parsed = resolvedCommand.parsed;
      const same = resolvedCommand.opaque
        ? configured.filter((c) => c.parsed.tool === raw.tool).map((c) => ({ ...c, cmp: c.parsed }))
        : configured
            .filter((c) => !c.resolved.opaque && c.resolved.parsed.tool === parsed.tool)
            .map((c) => ({ ...c, cmp: c.resolved.parsed }));
      const compared = resolvedCommand.opaque ? raw : parsed;
      const gate =
        ciCommandKind(command) ??
        (resolvedCommand.script ? ciCommandKind(resolvedCommand.script) : undefined);
      if (!same.length && (!gate || resolvedCommand.opaque || opaqueCheck)) continue;
      const key = `${file.path}\n${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const script = resolvedCommand.script === undefined ? {} : { script: resolvedCommand.script };
      if (!same.length) {
        out.push({
          file: file.path,
          command,
          tool: parsed.tool,
          ...script,
          check: null,
          missing: [],
        });
        continue;
      }
      const ranked = same
        .map((c) => {
          let have = [...c.cmp.words];
          let mine = compared.words;
          const cover = coveredPaths(mine, have);
          if (cover) {
            mine = mine.filter((word) => !cover.drop.includes(word));
            have = have.filter((word) => !cover.covered.includes(word));
          }
          const missing: string[] = [];
          for (const word of mine) {
            const at = have.indexOf(word);
            if (at < 0) missing.push(word);
            else have.splice(at, 1);
          }
          return { c, missing };
        })
        .sort((a, b) => a.missing.length - b.missing.length);
      const best = ranked[0];
      if (!best?.missing.length) continue;
      out.push({
        file: file.path,
        command,
        tool: compared.tool,
        ...script,
        check: { id: best.c.check.id, command: words(best.c.check) },
        missing: best.missing,
      });
    }
  }
  return out;
}

/** The would-stop summary of one drift, in the words of the stop enforce would make. */
export function ciCheckDriftSummary(drift: CiCheckDrift): string {
  const runs =
    drift.script === undefined
      ? `"${drift.command}"`
      : `"${drift.command}" (script: "${drift.script}")`;
  // A README documents the gate; only a CI workflow is run on push (#2416).
  const risk = CI_WORKFLOW.test(drift.file)
    ? "the delivered CI can fail on what no configured check ran"
    : "the documented command can fail on what no configured check ran";
  return drift.check
    ? `ci_check_drift: ${drift.file} runs ${runs}, but check ${drift.check.id} runs "${drift.check.command}" without ${drift.missing.join(" ")}; ${risk}`
    : `ci_check_drift: ${drift.file} runs ${runs}, and no configured check runs ${drift.tool}; ${risk}`;
}

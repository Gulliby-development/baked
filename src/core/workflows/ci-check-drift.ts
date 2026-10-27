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
    if (RUN_SCRIPT.has(tool[1] ?? "") && rest[0] && !rest[0].startsWith("-")) {
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
  /** Its tool: `cargo clippy`. */
  tool: string;
  /** The closest configured check that runs the same tool, or null when none does. */
  check: { id: string; command: string } | null;
  /** The words of the file's command that check does not give the tool: `--all-targets`. */
  missing: string[];
}

const words = (check: Pick<Check, "executable" | "args">): string =>
  [check.executable, ...check.args].join(" ");

/**
 * Each gate command of the changed files that the configured checks do not run as written: a
 * check runs its tool without some of its words (a flag, a scope such as `--all-targets`, `-race`,
 * `./...`, `--strict`), or, for a command of a gate kind (lint, type check, format check, tests),
 * no check runs its tool at all. Words a check adds are fine: the check is the stricter one. Word
 * order and output-only flags (`--offline`, `--color`) do not count.
 */
export function ciCheckDrift(
  files: readonly { path: string; text: string }[],
  checks: readonly Pick<Check, "id" | "executable" | "args">[],
): CiCheckDrift[] {
  const configured = checks.flatMap((check) => {
    const parsed = toolCommand(check.executable, check.args);
    return parsed ? [{ check, parsed }] : [];
  });
  const out: CiCheckDrift[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const command of fileGateCommands(file.path, file.text)) {
      const parsed = parsedLine(command);
      if (!parsed) continue;
      const same = configured.filter((c) => c.parsed.tool === parsed.tool);
      if (!same.length && !ciCommandKind(command)) continue;
      const key = `${file.path}\n${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!same.length) {
        out.push({ file: file.path, command, tool: parsed.tool, check: null, missing: [] });
        continue;
      }
      const ranked = same
        .map((c) => {
          const have = [...c.parsed.words];
          const missing: string[] = [];
          for (const word of parsed.words) {
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
        tool: parsed.tool,
        check: { id: best.c.check.id, command: words(best.c.check) },
        missing: best.missing,
      });
    }
  }
  return out;
}

/** The would-stop summary of one drift, in the words of the stop enforce would make. */
export function ciCheckDriftSummary(drift: CiCheckDrift): string {
  return drift.check
    ? `ci_check_drift: ${drift.file} runs "${drift.command}", but check ${drift.check.id} runs "${drift.check.command}" without ${drift.missing.join(" ")}; the delivered CI can fail on what no configured check ran`
    : `ci_check_drift: ${drift.file} runs "${drift.command}", and no configured check runs ${drift.tool}; the delivered CI can fail on what no configured check ran`;
}

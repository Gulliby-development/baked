import { launchedCommand, programName } from "../workflows/launcher.js";
import { ENVIRONMENT_RUNNERS, toolchainCommand } from "../workflows/toolchain.js";

/**
 * What a launcher prints when it starts but cannot find the program it was asked to run (#3040).
 * R109 callfence: cmd.exe printed `'bundle' is not recognized as an internal or external command`
 * and exited 1 on every check, so the check read as a plain failure. The baseline recorded it as
 * the project's debt, and the run implemented every task (1.97M tokens, $6.55) before it stopped
 * at the checks stage. A spawn that throws is a `spawn_error` and stops the run at once; a
 * launcher's own "not found" line is the same fault and is read as one.
 *
 * Each row's `line` builds the pattern for one program name, so a line counts only when it names
 * the check's program or the program behind its launcher (`toolchainCommand`): a test that prints
 * such a line about another command leaves the check a plain failure.
 */
export interface NotStartedLine {
  /** The launcher that prints it. */
  launcher: string;
  /** The line, for one program name (already escaped for a pattern). */
  line: (program: string) => RegExp;
  /** The exit code the launcher gives with it, when the line alone is not specific enough. */
  exitCode?: number;
}

export const PROGRAM_NOT_STARTED_LINES: readonly NotStartedLine[] = [
  {
    launcher: "cmd.exe",
    line: (p) =>
      new RegExp(
        `'${p}(?:\\.(?:exe|bat|cmd|com))?' is not recognized as an internal or external command`,
        "i",
      ),
  },
  {
    launcher: "Bundler (bundle exec)",
    line: (p) => new RegExp(`bundler: command not found: ${p}\\b`),
  },
  { launcher: "uv run", line: (p) => new RegExp(`Failed to spawn: \`${p}\``) },
  { launcher: "poetry run", line: (p) => new RegExp(`Command not found: ${p}\\b`) },
  {
    launcher: "pipenv run",
    line: (p) => new RegExp(`the command ${p} could not be found within PATH`, "i"),
  },
  { launcher: "pdm run", line: (p) => new RegExp(`Command '${p}' is not found in your PATH`) },
  // Last: zsh's form also ends a runner's own line (`bundler: command not found: rspec`).
  // bash `bash: tool: command not found`, dash `sh: 1: tool: not found`, zsh `zsh: command not found: tool`.
  {
    launcher: "POSIX shell",
    line: (p) =>
      new RegExp(`(?:^|[\\s:])${p}: (?:command )?not found\\b|command not found: ${p}\\b`, "m"),
    exitCode: 127,
  },
];

/** The table's row for each environment runner (`ENVIRONMENT_RUNNERS`); a new runner adds one. */
export const RUNNER_LINES: Readonly<Record<string, string>> = {
  "uv run": "uv run",
  "poetry run": "poetry run",
  "pipenv run": "pipenv run",
  "pdm run": "pdm run",
  "bundle exec": "Bundler (bundle exec)",
};

/** Every environment runner the table must cover, as `"<program> <subcommand>"`. */
export const environmentRunners = (): string[] =>
  ENVIRONMENT_RUNNERS.map(([program, sub]) => `${program} ${sub}`);

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The program names a check's command may fail to start: its own, its launcher's, the runner's. */
function programsOf(executable: string, args: readonly string[]): string[] {
  const names = [
    programName(executable),
    launchedCommand(executable, args).program,
    toolchainCommand(executable, args).program,
  ];
  return [...new Set(names.filter(Boolean))];
}

/**
 * The launcher line a failed check's output gives for its own program, or null: the launcher
 * started and could not find the program, so the check never ran.
 */
export function programNotStarted(
  executable: string,
  args: readonly string[],
  output: string,
  exitCode: number | null,
): { launcher: string; program: string; line: string } | null {
  if (exitCode === 0 || exitCode === null) return null;
  for (const program of programsOf(executable, args))
    for (const row of PROGRAM_NOT_STARTED_LINES) {
      if (row.exitCode !== undefined && row.exitCode !== exitCode) continue;
      const match = row.line(escapePattern(program)).exec(output);
      if (match) {
        const at = output.lastIndexOf("\n", match.index) + 1;
        const end = output.indexOf("\n", match.index);
        return {
          launcher: row.launcher,
          program,
          line: output.slice(at, end < 0 ? undefined : end).trim(),
        };
      }
    }
  return null;
}

/** The note a check whose program did not start gets under its output. */
export const notStartedNote = (
  checkId: string,
  found: { launcher: string; program: string; line: string },
) =>
  `Note: ${checkId} never ran: ${found.launcher} could not find ${found.program} (${found.line}). This is the machine's environment, not the project's code: install the tool or fix the PATH, then resume.`;

import stripAnsi from "strip-ansi";

/**
 * A check's output without terminal escape sequences (colours, bold, erase-line and cursor codes,
 * OSC hyperlinks, charset designations) and the shift-out/shift-in bytes (0x0e, 0x0f) that some
 * terminfo entries put in their colour reset, so a `^`-anchored summary pattern sees the line a
 * runner printed (#2615). R85 csp: a coloured vitest summary gave `testCount` null, and a
 * coloured `cargo test` or `bun test` summary gave `testsRan` 0, which failed a passing
 * `requireTests` check as "ran no test". Every parser of check output reads its input through
 * this, never its own escape regex. `executeCheckCommand` applies it to every check command's
 * output, so the stored check artifact, the `decision.would_rerun` input and every prompt get the
 * plain text too (#2830: R90 windowfit's rustfmt coloured its diff under `TERM=xterm-256color`
 * whatever `NO_COLOR` said, and the artifact kept the codes).
 */
export const plainOutput = (output: string): string =>
  output.includes("\u001b") || output.includes("\u009b")
    ? stripAnsi(output).replaceAll("\u000e", "").replaceAll("\u000f", "")
    : output;

/**
 * An environment with the variables that ask a check's tools for plain output (#2615, #2631):
 * `NO_COLOR=1`, which ruff, pytest, sqlfluff and Node's colour libraries (picocolors, tinyrainbow,
 * Node's own) follow, and `CARGO_TERM_COLOR=never` for cargo, which reads neither. `FORCE_COLOR` is
 * removed rather than set to `0`: ruff reads any value as "force colour" and lets it win over
 * `NO_COLOR` (R86: 79 coloured ruff outputs), while a Node tool given no `FORCE_COLOR` prints plain
 * to a pipe anyway. Removing it also drops a parent's `FORCE_COLOR=1`, as on CI. A check that
 * declares one of them in `envNames` gets the parent's value back (`buildCheckEnv`).
 */
export function plainOutputEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    ...env,
    NO_COLOR: "1",
    CARGO_TERM_COLOR: "never",
  };
  delete out.FORCE_COLOR;
  return out;
}

/**
 * JSON text of a stored check record with the escape sequences of its strings removed (#2631): a
 * check artifact written before #2830 holds the raw output, whose escapes JSON writes as
 * `\\u001b[...m`. A prompt builder that sends the record reads it through this, so a tool that
 * coloured anyway costs no prompt bytes.
 */
export const plainJsonText = (text: string): string =>
  text.includes("\\u001b") || text.includes("\\u009b")
    ? text
        .replace(/\\u001b\][^"]*?(?:\\u0007|\\u001b\\\\)/g, "")
        .replace(/(?:\\u001b\[|\\u009b)[0-?]*[ -/]*[@-~]/g, "")
    : text;

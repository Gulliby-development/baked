import stripAnsi from "strip-ansi";

/**
 * A check's output as the parsers read it: without terminal escape sequences (colours, bold,
 * erase-line and cursor codes, OSC hyperlinks), so a `^`-anchored summary pattern sees the line a
 * runner printed (#2615). R85 csp: a coloured vitest summary gave `testCount` null, and a
 * coloured `cargo test` or `bun test` summary gave `testsRan` 0, which failed a passing
 * `requireTests` check as "ran no test". Every parser of check output reads its input through
 * this, never its own escape regex; the stored evidence keeps the raw text.
 */
export const plainOutput = (output: string): string =>
  output.includes("\u001b") || output.includes("\u009b") ? stripAnsi(output) : output;

/**
 * The variables that ask a check's tools for plain output (#2615), as the edit tools already do
 * (`bounded-process.ts`): `NO_COLOR` for the tools that follow no-color.org, `FORCE_COLOR=0` for
 * Node's colour libraries and `CARGO_TERM_COLOR=never` for cargo, which reads neither. A check
 * that declares one of them in `envNames` keeps the parent's value.
 */
export const PLAIN_OUTPUT_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  CARGO_TERM_COLOR: "never",
};

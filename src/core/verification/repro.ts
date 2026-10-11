import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { buildSafeEnv } from "../spawn.js";
import type { ProcessScope } from "../workflows/process-scope.js";
import { type Repro, ReproSchema, type Review } from "../workflows/schemas.js";
import type { HostTool } from "../workflows/types.js";
import { changedPaths, sourceManifest } from "./snapshot.js";

/** Time a repro may run; it shows one input, not a test suite. */
export const REPRO_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4000;
/** Repros one review attempt may try before it submits. */
export const REPRO_TRIES = 8;

export interface ReproOutcome {
  /**
   * `reproduced` when a line of the output is `actual`; `refuted` when the command exited 0
   * without printing it; `inconclusive` when it could not run, failed without printing `actual`,
   * timed out or changed source files.
   */
  status: "reproduced" | "refuted" | "inconclusive";
  reason: string;
  exitCode: number | null;
  output: string;
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/** Whether the output shows `text`: as one of its lines or, for several lines, as a block. */
export function outputShows(output: string, text: string): boolean {
  const out = normalize(output);
  const wanted = normalize(text);
  if (!wanted) return false;
  if (wanted.includes("\n")) return out.includes(wanted);
  return out.split("\n").some((line) => line.trim() === wanted);
}

/**
 * Programs a repro may start: those the run's approved checks start. The approval covers what
 * those programs run on the workspace, so a repro adds no program the user did not approve.
 */
export function reproExecutables(checks: readonly { executable: string }[]): string[] {
  return [...new Set(checks.map((c) => c.executable))];
}

/**
 * The environment of a repro: the safe environment, plus `PYTHONPATH` for a Python project with
 * a `src` layout, so `python -c "import pkg"` finds the package without an install (endfix
 * 2295dbbd: "repro failed to import endfix"; a check cannot install, and a reviewer must not).
 */
export function reproEnv(root: string): Record<string, string | undefined> {
  const env = buildSafeEnv();
  const python = ["pyproject.toml", "setup.py", "setup.cfg"].some((name) =>
    existsSync(join(root, name)),
  );
  if (python && existsSync(join(root, "src")))
    env.PYTHONPATH = [join(root, "src"), root, env.PYTHONPATH].filter(Boolean).join(delimiter);
  return env;
}

/**
 * Runs a finding's repro in the workspace and judges the claim by its output (#155). Run 5b703388
 * corrected a "regex accepts a trailing newline" claim that is true in Python but false in
 * JavaScript, and spent about 200k tokens on it.
 */
export async function runRepro(
  processes: ProcessScope,
  repro: Repro,
  options: {
    root: string;
    executables: readonly string[];
    generated: string[];
    signal: AbortSignal;
  },
): Promise<ReproOutcome> {
  if (!options.executables.includes(repro.executable))
    return {
      status: "inconclusive",
      reason: `${repro.executable} is not a program the run's checks start (${options.executables.join(", ") || "none"})`,
      exitCode: null,
      output: "",
    };
  const before = await sourceManifest(options.root, options.generated, options.signal);
  const executable = repro.executable === "bun" ? process.execPath : repro.executable;
  let result: Awaited<ReturnType<ProcessScope["execute"]>>;
  try {
    result = await processes.execute(executable, repro.args, {
      cwd: options.root,
      env: reproEnv(options.root),
      timeoutMs: REPRO_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    options.signal.throwIfAborted();
    return {
      status: "inconclusive",
      reason: `The command did not start: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: null,
      output: "",
    };
  }
  const output = result.output.slice(-OUTPUT_LIMIT);
  const after = await sourceManifest(options.root, options.generated);
  const inconclusive = (reason: string): ReproOutcome => ({
    status: "inconclusive",
    reason,
    exitCode: result.exitCode,
    output,
  });
  if (changedPaths(before, after).length)
    return inconclusive("The command changed source files; a repro must only read them");
  if (result.timedOut) return inconclusive(`The command ran longer than ${REPRO_TIMEOUT_MS} ms`);
  if (result.cancelled) return inconclusive("The command was cancelled");
  if (outputShows(result.output, repro.actual))
    return {
      status: "reproduced",
      reason: "The output shows the claimed actual value",
      exitCode: result.exitCode,
      output,
    };
  if (result.exitCode === 0)
    return {
      status: "refuted",
      reason: outputShows(result.output, repro.expected)
        ? "The output shows the expected value, not the claimed actual one"
        : "The command exited 0 without printing the claimed actual value",
      exitCode: 0,
      output,
    };
  return inconclusive(
    `The command exited ${result.exitCode ?? "without a code"} without printing the claimed actual value`,
  );
}

/**
 * Whether a finding may start a correction given its repro. A refuted claim is a note. A claim
 * whose repro could not show anything, and a correctness claim without a repro, are notes unless
 * the finding is a security finding or critical. When the run has no program a repro could start,
 * findings keep blocking as before.
 */
export function reproAllows(
  finding: Review["findings"][number],
  outcome: ReproOutcome["status"] | undefined,
  available: boolean,
): boolean {
  if (outcome === "reproduced") return true;
  if (outcome === "refuted") return false;
  if (!available) return true;
  const exempt = finding.kind === "security" || finding.severity === "critical";
  if (outcome === "inconclusive") return exempt;
  return exempt || finding.kind !== "correctness";
}

/** The host tool a reviewer tries a repro with before it attaches the repro to a finding. */
export function reproTool(
  executables: readonly string[],
  run: (repro: Repro) => Promise<ReproOutcome>,
): HostTool {
  let tries = 0;
  return {
    description: `Run a repro the way the runtime will run it for a finding: the program (one of ${executables.join(", ")}) and its arguments, without a shell, in the workspace root, for up to ${REPRO_TIMEOUT_MS / 1000} s. It must print the observed value on its own line and change no file. Returns reproduced when a line of the output equals actual, refuted when it exits 0 without printing actual, inconclusive otherwise, with the output. At most ${REPRO_TRIES} runs.`,
    inputSchema: ReproSchema,
    execute: async (input) => {
      if (++tries > REPRO_TRIES)
        return {
          status: "inconclusive",
          reason: `Only ${REPRO_TRIES} repro runs are allowed per review`,
        };
      return run(ReproSchema.parse(input));
    },
  };
}

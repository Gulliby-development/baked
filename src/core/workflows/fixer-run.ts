import { canonical } from "../specs/hash.js";
import { executeCheckCommand } from "../verification/check-runner.js";
import type { ProcessScope } from "./process-scope.js";
import type { WorkflowStore } from "./store.js";

/**
 * Every run of a check's `fix` command, by the model's `apply_fix` or by the host's fixer pass
 * (`fixFiles`), goes through `runFixer`, which returns the fixer's exit code and the tail of its
 * output (#2436). R77 pairwick: the configured fixer `sbt --server -batch scalafmtAll` got the file
 * appended to its last task and sbt refused the command line (`Expected whitespace character`,
 * exit 1); `apply_fix` returned only `exit 1` and the host pass read nothing, so the models
 * hand-formatted Scala against scalafmt for 17.13M tokens.
 */
export const FIXER_KIND = "fixer-run";
/** One record per host fixer pass and check: `fixers/<check>/<attempt>.json`. */
export const FIXER_DIR = "fixers/";
/**
 * The host fixer runs that failed without a change, by the latest pass over their files:
 * `fixers/failed.json`. A task attempt gets those on the files it writes, so a corrective of
 * another task's file is told too.
 */
export const FAILED_FIXERS_PATH = `${FIXER_DIR}failed.json`;
/** The characters of a fixer's output kept: its tail, where the error is. */
export const FIXER_OUTPUT_LIMIT = 2000;

export interface FixerResult {
  exitCode: number | null;
  timedOut: boolean;
  /** The output's last `FIXER_OUTPUT_LIMIT` characters, color codes removed. */
  output: string;
}

/** One fixer run on its command line; the result is the caller's to report, never dropped. */
export async function runFixer(
  scope: ProcessScope,
  command: { executable: string; args: string[] },
  options: Parameters<ProcessScope["execute"]>[2],
): Promise<FixerResult> {
  const executable = command.executable === "bun" ? process.execPath : command.executable;
  const result = await executeCheckCommand(scope, executable, command.args, options);
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output: fixerOutput(result.output),
  };
}

/** A fixer's output as reported: color codes removed, trimmed, and its tail when long. */
export function fixerOutput(output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes
  const plain = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
  return plain.length <= FIXER_OUTPUT_LIMIT
    ? plain
    : `[... ${String(plain.length - FIXER_OUTPUT_LIMIT)} characters left out]\n${plain.slice(-FIXER_OUTPUT_LIMIT)}`;
}

/** Whether a fixer run failed: a non-zero exit or a timeout. */
export const fixerFailed = (result: Pick<FixerResult, "exitCode" | "timedOut">): boolean =>
  result.timedOut || result.exitCode !== 0;

/** One host fixer run as `fixFiles` records it. */
export interface FixerRun {
  checkId: string;
  /** The task files the run was given (workspace paths). */
  targets: string[];
  /** The command line as run: the program, then its arguments. */
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  /** Whether any of its targets changed. */
  changed: boolean;
  output: string;
}

/** A run whose failure the next attempt is told: it failed and left its files as they were. */
export const unusableRun = (run: FixerRun): boolean => fixerFailed(run) && !run.changed;

/**
 * Records a host fixer pass: `fixers/<check>/<attempt>.json` per check, and `FAILED_FIXERS_PATH`
 * with the pass's failed runs in place of the earlier failures on the files it ran on, so a later
 * clean pass clears them. Called inside the caller's transaction.
 */
export function recordFixerRuns(
  store: WorkflowStore,
  runId: string,
  attempt: string,
  runs: readonly FixerRun[],
): void {
  for (const checkId of new Set(runs.map((run) => run.checkId)))
    store.artifact(
      runId,
      FIXER_KIND,
      `${FIXER_DIR}${checkId}/${attempt}.json`,
      canonical({
        schemaVersion: 1,
        checkId,
        attempt,
        runs: runs.filter((r) => r.checkId === checkId),
      }),
    );
  const ran = new Set(runs.flatMap((run) => run.targets));
  const standing = failedFixerRuns(store, runId);
  const failed = [
    ...standing.filter((run) => !run.targets.some((path) => ran.has(path))),
    ...runs.filter(unusableRun),
  ];
  if (failed.length || standing.length)
    store.artifact(runId, FIXER_KIND, FAILED_FIXERS_PATH, canonical({ schemaVersion: 1, failed }));
}

/** The failed host fixer runs still standing, from `FAILED_FIXERS_PATH`. */
export function failedFixerRuns(store: WorkflowStore, runId: string): FixerRun[] {
  const artifact = store.latestArtifact(runId, FAILED_FIXERS_PATH);
  return artifact
    ? (JSON.parse(store.readArtifact(runId, artifact.id)) as { failed: FixerRun[] }).failed
    : [];
}

/** The note an attempt gets with the fixer runs of its task that failed (#2436). */
export const FAILED_FIXERS_NOTE =
  "The host ran these checks' automatic fixers on this task's files, and each failed without changing them, with this output. A fixer that cannot run as configured (a wrong command line, a missing tool, a lock) will not fix the check: apply_fix fails the same way. Edit what the check's own output names, run the check with request_check, and name the fixer's error in your summary.";
